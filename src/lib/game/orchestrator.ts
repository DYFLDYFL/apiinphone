import type { AppSettings } from "../../types";
import type { StreamControl } from "../apiClient";
import { runGameAgent } from "./agentRunner";
import { saveGame, archiveStoryTick, archiveOpeningStory, ensureStoryTicksBootstrapped } from "./gameStore";
import {
  agentDirectory,
  agentDisplayName,
  applySheetPatches,
  notifySummary,
  plainTextFromModel,
  pushEvent,
  recentEventsText,
  recentEventsTextFor,
  sheetPublicView,
} from "./mutations";
import { chroniclerSystemPrompt, pickPromptOverride } from "./prompts";
import {
  defaultPipeline,
  MAX_PIPELINE_STEPS,
  normalizePipeline,
  selectNextNodeId,
  type PipelineRouteFlags,
} from "./pipeline";
import type {
  GameAgent,
  GameEvent,
  GameState,
  InteractionIntent,
  InteractionResponse,
  JudgeNotify,
  JudgeResult,
} from "./types";

function cleanStoryBody(text: string): string {
  return text
    .replace(/\s*FINISHED(?:_WITH_ERROR)?\s*/gi, "")
    .replace(/\s*\[DONE\]\s*/g, "")
    .trim();
}

export type TickProgress = {
  phase: string;
  interactionRound: number;
  maxRounds: number;
};

export type PlayerIntentRequest = {
  characterId: string;
  characterName: string;
  round: number;
  maxRounds: number;
  sceneSummary: string;
  redoHint?: string;
};

export type PlayerIntentDraft = {
  toId: string;
  action: string;
  rationale?: string;
  /** true = 本轮交给 AI 提案，忽略 action。 */
  delegateToAi?: boolean;
};

function clockText(game: GameState): string {
  return (
    game.worldClock.timeText?.trim() ||
    game.worldClock.label?.trim() ||
    "未标注时刻"
  );
}

function rememberClock(game: GameState): void {
  if (!game.worldClock.history) game.worldClock.history = {};
  game.worldClock.history[String(game.worldClock.tick)] = clockText(game);
}

function setClockText(game: GameState, timeText: string): void {
  const t = timeText.trim() || clockText(game);
  game.worldClock.timeText = t;
  game.worldClock.label = t;
  rememberClock(game);
}

function periodNeedsOpen(game: GameState): boolean {
  const tick = game.worldClock.tick;
  return !game.events.some((e) => e.tick === tick && e.kind === "world");
}

function characters(game: GameState): GameAgent[] {
  return game.agents.filter((a) => a.kind === "character");
}

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 按局设置决定本轮角色提案顺序。 */
function orderedCharacters(game: GameState): GameAgent[] {
  const chars = characters(game);
  const mode = game.settings?.proposeOrder ?? "template";
  if (mode === "random") {
    return shuffleInPlace([...chars]);
  }
  if (mode === "custom") {
    const order = game.settings.customProposeOrder ?? [];
    const byId = new Map(chars.map((c) => [c.id, c]));
    const out: GameAgent[] = [];
    const seen = new Set<string>();
    for (const id of order) {
      const ch = byId.get(id);
      if (ch && !seen.has(ch.id)) {
        out.push(ch);
        seen.add(ch.id);
      }
    }
    for (const ch of chars) {
      if (!seen.has(ch.id)) out.push(ch);
    }
    return out;
  }
  return chars;
}

function makeChroniclerAgent(
  game: GameState,
  mode: "god" | "player",
  name: string,
): GameAgent {
  const override =
    mode === "god"
      ? game.settings.chroniclerGodPrompt
      : game.settings.chroniclerPlayerPrompt;
  return {
    id: mode === "god" ? "chronicler_god" : "chronicler_player",
    kind: mode === "god" ? "world" : "character",
    name,
    persona: "",
    systemPrompt: pickPromptOverride(
      override,
      chroniclerSystemPrompt(mode),
    ),
    modelOverride: game.settings.chroniclerModel,
    history: [],
  };
}

function worldAgent(game: GameState): GameAgent {
  const w = game.agents.find((a) => a.kind === "world");
  if (!w) throw new Error("缺少世界代理");
  return w;
}

function refereeAgent(game: GameState): GameAgent {
  const r = game.agents.find((a) => a.kind === "referee");
  if (!r) throw new Error("缺少裁判代理");
  return r;
}

function sheetFor(game: GameState, agent: GameAgent) {
  if (!agent.sheetId) return null;
  return game.sheets.find((s) => s.id === agent.sheetId) ?? null;
}

function resolveTargetId(game: GameState, toId: string): string {
  const key = toId.trim();
  if (!key || key === "world" || key === "世界") {
    return worldAgent(game).id;
  }
  const byId = game.agents.find((a) => a.id === key);
  if (byId) return byId.id;
  const byName = game.agents.find((a) => a.name === key);
  if (byName) return byName.id;
  return key;
}

function parseIntents(
  game: GameState,
  agent: GameAgent,
  json: Record<string, unknown> | null,
  text: string,
): InteractionIntent[] {
  const intents: InteractionIntent[] = [];
  const raw = json?.intents;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const toRaw = String(row.toId ?? "世界").trim() || "世界";
      const action = String(row.action ?? "").trim();
      if (!action) continue;
      intents.push({
        fromId: agent.id,
        toId: resolveTargetId(game, toRaw),
        action,
        rationale:
          row.rationale != null ? String(row.rationale) : undefined,
      });
    }
  }
  if (!intents.length && text.trim()) {
    intents.push({
      fromId: agent.id,
      toId: worldAgent(game).id,
      action: plainTextFromModel(null, text).slice(0, 200),
    });
  }
  return intents.slice(0, 2);
}

function verdictZh(v: string): string {
  if (v === "accept") return "接受";
  if (v === "revise") return "修正";
  return "驳回";
}

function parseNotify(raw: unknown): JudgeNotify[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list: JudgeNotify[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const toId = String(row.toId ?? "").trim();
    const message = String(row.message ?? "").trim();
    if (!toId || !message) continue;
    list.push({ toId, message });
  }
  return list.length ? list : undefined;
}

function parseJudge(json: Record<string, unknown> | null, _text: string): JudgeResult {
  if (!json) {
    return {
      verdict: "reject",
      reason: "裁判未返回 JSON",
      periodComplete: false,
      publicSummary: "本轮交互已裁定：驳回",
      redo: true,
    };
  }
  const verdictRaw = String(json.verdict ?? "reject");
  const verdict =
    verdictRaw === "accept" || verdictRaw === "revise" || verdictRaw === "reject"
      ? verdictRaw
      : "reject";
  let redo: boolean | undefined;
  if (json.redo === true) redo = true;
  else if (json.redo === false) redo = false;
  const publicSummary = String(
    json.publicSummary ?? `本轮交互已裁定：${verdictZh(verdict)}`,
  );
  return {
    verdict,
    reason: String(json.reason ?? ""),
    revisedAction:
      json.revisedAction != null ? String(json.revisedAction) : undefined,
    sheetPatches: Array.isArray(json.sheetPatches)
      ? (json.sheetPatches as JudgeResult["sheetPatches"])
      : [],
    periodComplete: Boolean(json.periodComplete),
    publicSummary,
    redo,
    notify: parseNotify(json.notify),
  };
}

function shouldRedoRound(judge: JudgeResult): boolean {
  if (judge.redo === true) return true;
  if (judge.verdict === "reject" && judge.redo !== false) return true;
  return false;
}

async function persist(
  game: GameState,
  onPersist?: (g: GameState) => void | Promise<void>,
): Promise<void> {
  await saveGame(game);
  await onPersist?.(game);
}

function pushProposeEvent(
  game: GameState,
  ch: GameAgent,
  intent: InteractionIntent,
  round: number,
): void {
  const targetName = agentDisplayName(game, intent.toId);
  pushEvent(game, {
    tick: game.worldClock.tick,
    interactionRound: round,
    kind: "propose",
    actorId: ch.id,
    actorName: ch.name,
    summary: `对「${targetName}」：${intent.action}`,
    detail: intent.rationale,
    audience: "private",
    visibleTo: [ch.id, intent.toId],
  });
}

function proposePrompt(
  game: GameState,
  ch: GameAgent,
  _round: number,
  publicEvent: string,
  redoHint: string,
): string {
  const sheet = sheetFor(game, ch);
  return [
    `当前时刻 ${clockText(game)} · 本轮交互`,
    `场景：${game.worldClock.sceneSummary}`,
    `本时段公开事件：${publicEvent}`,
    redoHint ? `上轮裁判驳回，请调整：${redoHint}` : "",
    `你的面板：\n${sheet ? sheetPublicView(sheet) : "无"}`,
    `可互动对象：\n${agentDirectory(game)}`,
    `近期事件（仅你可见）：\n${recentEventsTextFor(game, ch.id, 8)}`,
    "提出 1～2 条意图 JSON。toId 填「世界」或角色中文名。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function proposeWithAi(
  settings: AppSettings,
  game: GameState,
  ch: GameAgent,
  round: number,
  publicEvent: string,
  redoHint: string,
  control?: StreamControl,
  onStatus?: (text: string) => void,
): Promise<InteractionIntent[]> {
  const res = await runGameAgent(
    settings,
    game,
    ch,
    proposePrompt(game, ch, round, publicEvent, redoHint),
    control,
    onStatus,
  );
  return parseIntents(game, ch, res.json, res.text);
}

/** 本时事件：先按 tick 切，再按可见性过滤（避免先 slice 全局再滤 tick 丢早期本时事件）。 */
function eventsForTick(
  game: GameState,
  tick: number,
  agentId?: string,
): GameEvent[] {
  const inTick = game.events.filter((e) => e.tick === tick);
  if (!agentId) return inTick;
  return inTick.filter((e) => {
    const audience = e.audience ?? "public";
    if (audience !== "private") return true;
    return (e.visibleTo ?? []).includes(agentId);
  });
}

function lineEvent(e: {
  interactionRound: number;
  actorName: string;
  summary: string;
}): string {
  return `[第${e.interactionRound}轮·${e.actorName}] ${e.summary}`;
}

function eventsTextForTick(
  game: GameState,
  tick: number,
  agentId?: string,
): string {
  const list = eventsForTick(game, tick, agentId);
  if (!list.length) return "（本时无事件）";
  return list.map(lineEvent).join("\n");
}

/** 玩家剧情材料：分栏标出「你的行动」，避免模型只写公开见闻或编造无关情节。 */
function playerChronicleSource(
  game: GameState,
  tick: number,
  playerId: string,
): string {
  const list = eventsForTick(game, tick, playerId);
  if (!list.length) return "（本时无可见事件）";

  const ownActions = list.filter(
    (e) => e.actorId === playerId && (e.kind === "propose" || e.kind === "inject"),
  );
  const replies = list.filter(
    (e) =>
      e.kind === "respond" &&
      (e.visibleTo ?? []).includes(playerId) &&
      e.actorId !== playerId,
  );
  const publicSeen = list.filter(
    (e) =>
      (e.audience ?? "public") !== "private" &&
      e.kind !== "propose" &&
      !(e.kind === "judge" && e.summary.startsWith("本轮交互已裁定")),
  );
  const outcomes = list.filter(
    (e) =>
      e.audience === "private" &&
      (e.kind === "judge" || e.kind === "system") &&
      (e.visibleTo ?? []).includes(playerId),
  );

  const sections: string[] = [];
  if (publicSeen.length) {
    sections.push(
      `【公开见闻】\n${publicSeen.map(lineEvent).join("\n")}`,
    );
  }
  if (ownActions.length) {
    sections.push(
      `【你的行动】（正文必须写入）\n${ownActions.map(lineEvent).join("\n")}`,
    );
  } else {
    sections.push("【你的行动】（本时你未留下可记行动）");
  }
  if (replies.length) {
    sections.push(
      `【你得到的回应】\n${replies.map(lineEvent).join("\n")}`,
    );
  }
  if (outcomes.length) {
    sections.push(
      `【你得知的结果】\n${outcomes.map(lineEvent).join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

async function appendChronicles(
  settings: AppSettings,
  game: GameState,
  control?: StreamControl,
  onProgress?: (p: TickProgress) => void,
  onPersist?: (g: GameState) => void | Promise<void>,
): Promise<void> {
  const tick = game.worldClock.tick;
  if (game.storyTick >= tick) return;
  if (control?.cancelled) return;

  // 旧存档尚无 ticks 时，先把已有剧情拆档，推进只追加新时
  await ensureStoryTicksBootstrapped(game);

  onProgress?.({
    phase: "整理剧情",
    interactionRound: game.tickBuffer?.interactionRound ?? 0,
    maxRounds: 0,
  });

  const sectionHeader = `\n\n—— ${clockText(game)} ——\n`;
  const label = clockText(game);
  let godBodyThisTick = "";
  let playerBodyThisTick = "";

  const godAgent = makeChroniclerAgent(game, "god", "叙事书记");
  try {
    const godRes = await runGameAgent(
      settings,
      game,
      godAgent,
      `请根据下列本时事件写一节全知剧情：\n${eventsTextForTick(game, tick)}`,
      control,
      (text) =>
        onProgress?.({
          phase: text,
          interactionRound: game.tickBuffer?.interactionRound ?? 0,
          maxRounds: 0,
        }),
    );
    const body = cleanStoryBody(godRes.text || "") || "（本时剧情生成失败）";
    godBodyThisTick = body;
    game.godStory = `${game.godStory}${sectionHeader}${body}`.trim();
  } catch {
    godBodyThisTick = "（本时剧情生成失败）";
    game.godStory = `${game.godStory}${sectionHeader}${godBodyThisTick}`.trim();
  }

  if (
    game.playMode === "play" &&
    game.playerCharacterId &&
    !control?.cancelled
  ) {
    const player = game.agents.find((a) => a.id === game.playerCharacterId);
    const playerId = game.playerCharacterId;
    const playerAgent = makeChroniclerAgent(
      game,
      "player",
      player?.name ?? "玩家",
    );
    try {
      const source = playerChronicleSource(game, tick, playerId);
      const pRes = await runGameAgent(
        settings,
        game,
        playerAgent,
        [
          `角色「${player?.name ?? "你"}」。请根据下列本时可见材料写一节个人经历。`,
          "要求：以你的行动与见闻为主线；【你的行动】不可省略；不要写材料之外的新线索。",
          source,
        ].join("\n\n"),
        control,
        (text) =>
          onProgress?.({
            phase: text,
            interactionRound: game.tickBuffer?.interactionRound ?? 0,
            maxRounds: 0,
          }),
      );
      const body = cleanStoryBody(pRes.text || "") || "（本时经历生成失败）";
      playerBodyThisTick = body;
      game.playerStory = `${game.playerStory}${sectionHeader}${body}`.trim();
    } catch {
      playerBodyThisTick = "（本时经历生成失败）";
      game.playerStory =
        `${game.playerStory}${sectionHeader}${playerBodyThisTick}`.trim();
    }
  }

  if (godBodyThisTick) {
    await archiveStoryTick({
      gameId: game.id,
      tick,
      label,
      kind: "god",
      body: godBodyThisTick,
    });
  }
  if (playerBodyThisTick) {
    await archiveStoryTick({
      gameId: game.id,
      tick,
      label,
      kind: "player",
      body: playerBodyThisTick,
    });
  }

  game.storyTick = tick;
  await persist(game, onPersist);
}

function rosterBrief(game: GameState): string {
  return game.sheets
    .map((s) => {
      const loc = s.attrs.location != null ? String(s.attrs.location) : "";
      const mood = s.attrs.mood != null ? String(s.attrs.mood) : "";
      return `- ${s.name}（${loc}${mood ? ` · ${mood}` : ""}）`;
    })
    .join("\n");
}

/**
 * 开局生成初始剧情（开场种子），便于扮演/旁观立刻有可读正文。
 * 若已有剧情则跳过。
 */
export async function seedInitialChronicles(
  settings: AppSettings,
  game: GameState,
  options?: {
    control?: StreamControl;
    onPersist?: (g: GameState) => void | Promise<void>;
  },
): Promise<GameState> {
  const needGod = !game.godStory.trim();
  const needPlayer =
    game.playMode === "play" &&
    Boolean(game.playerCharacterId) &&
    !game.playerStory.trim();
  if (!needGod && !needPlayer) return game;

  const control = options?.control;
  const header = `—— 开场 · ${clockText(game)} ——\n`;
  const worldview = game.worldview || "";
  const scene = game.worldClock.sceneSummary || "";

  if (needGod && !control?.cancelled) {
    const godAgent = makeChroniclerAgent(game, "god", "叙事书记");
    try {
      const godRes = await runGameAgent(
        settings,
        game,
        godAgent,
        [
          "请写开场全知剧情（故事开始，尚无后续交互）。",
          `世界观：\n${worldview}`,
          `当前场景：${scene}`,
          `在场角色：\n${rosterBrief(game)}`,
        ].join("\n\n"),
        control,
      );
      const body = cleanStoryBody(godRes.text || "") || "（开场剧情生成失败）";
      game.godStory = `${header}${body}`.trim();
    } catch {
      game.godStory = `${header}（开场剧情生成失败）`.trim();
    }
  }

  if (needPlayer && game.playerCharacterId && !control?.cancelled) {
    const player = game.agents.find((a) => a.id === game.playerCharacterId);
    const sheet = player?.sheetId
      ? game.sheets.find((s) => s.id === player.sheetId)
      : null;
    const playerAgent = makeChroniclerAgent(
      game,
      "player",
      player?.name ?? "玩家",
    );
    try {
      const pRes = await runGameAgent(
        settings,
        game,
        playerAgent,
        [
          `请为角色「${player?.name ?? "你"}」写开场个人经历（仅其可知）。`,
          `人设：${player?.persona ?? ""}`,
          sheet
            ? `面板摘要：位置=${String(sheet.attrs.location ?? "")}，心情=${String(sheet.attrs.mood ?? "")}，物品=${sheet.inventory.join("、") || "无"}`
            : "",
          `你所在场景氛围：${scene}`,
          "不要写其他角色的私密心思；可写你能看见/听见的晨间日常。",
        ]
          .filter(Boolean)
          .join("\n\n"),
        control,
      );
      const body = cleanStoryBody(pRes.text || "") || "（开场经历生成失败）";
      game.playerStory = `${header}${body}`.trim();
    } catch {
      game.playerStory = `${header}（开场经历生成失败）`.trim();
    }
  }

  if (typeof game.storyTick !== "number" || Number.isNaN(game.storyTick)) {
    game.storyTick = -1;
  }
  game.storyTick = -1;
  rememberClock(game);
  const openLabel = `开场 · ${clockText(game)}`;
  if (game.godStory.trim()) {
    const godBody = game.godStory.replace(/^——\s*.+?\s*——\s*/m, "").trim();
    await archiveOpeningStory({
      gameId: game.id,
      label: openLabel,
      kind: "god",
      body: godBody || game.godStory,
    });
  }
  if (game.playerStory.trim()) {
    const playerBody = game.playerStory
      .replace(/^——\s*.+?\s*——\s*/m, "")
      .trim();
    await archiveOpeningStory({
      gameId: game.id,
      label: openLabel,
      kind: "player",
      body: playerBody || game.playerStory,
    });
  }
  await persist(game, options?.onPersist);
  return game;
}

/**
 * 每次推进一轮：按局内流水线图解释节点（默认图等价于旧写死顺序）。
 */
export async function advanceOneRound(
  settings: AppSettings,
  game: GameState,
  options?: {
    control?: StreamControl;
    onProgress?: (p: TickProgress) => void;
    inject?: string;
    onPersist?: (g: GameState) => void | Promise<void>;
    awaitPlayerIntent?: (
      req: PlayerIntentRequest,
    ) => Promise<PlayerIntentDraft | null>;
  },
): Promise<GameState> {
  const control = options?.control;
  const world = worldAgent(game);
  const referee = refereeAgent(game);
  const stopped = () => Boolean(control?.cancelled);
  const onAgentStatus = (text: string) => {
    options?.onProgress?.({
      phase: text,
      interactionRound: game.tickBuffer?.interactionRound ?? 0,
      maxRounds: 0,
    });
  };

  rememberClock(game);
  if (
    !game.tickBuffer ||
    game.tickBuffer.tick !== game.worldClock.tick ||
    game.tickBuffer.status === "completed"
  ) {
    game.tickBuffer = {
      tick: game.worldClock.tick,
      interactionRound: 0,
      status: "need_open",
    };
  }

  const pipeline = normalizePipeline(
    game.settings?.pipeline ?? defaultPipeline(),
  );
  const nodeById = new Map(pipeline.nodes.map((n) => [n.id, n]));

  let redoHint = "";
  let publicEvent =
    game.tickBuffer.worldBrief ||
    game.events
      .filter((e) => e.tick === game.worldClock.tick && e.kind === "world")
      .slice(-1)[0]?.summary ||
    "";
  let allIntents: InteractionIntent[] = game.tickBuffer.intents ?? [];
  let responses: InteractionResponse[] = game.tickBuffer.responses ?? [];
  let round = game.tickBuffer.interactionRound || 0;

  type StageResult = {
    halt?: boolean;
    done?: boolean;
    flags: PipelineRouteFlags;
  };

  const runWorldOpen = async (): Promise<StageResult> => {
    if (!periodNeedsOpen(game)) {
      return { flags: {} };
    }
    options?.onProgress?.({
      phase: "世界开场",
      interactionRound: 0,
      maxRounds: 0,
    });
    const openPrompt = [
      `当前时刻（已给定，禁止改钟）：${clockText(game)}`,
      `上一场景：${game.worldClock.sceneSummary}`,
      `世界观：${game.worldview || world.persona}`,
      `近期事件（你可见）：\n${recentEventsTextFor(game, world.id)}`,
      options?.inject ? `玩家神谕：${options.inject}` : "",
      '请输出开场 JSON：{"sceneSummary":"...","publicEvent":"..."}。',
    ]
      .filter(Boolean)
      .join("\n\n");

    if (stopped()) {
      game.tickBuffer!.status = "interrupted";
      await persist(game, options?.onPersist);
      return { halt: true, flags: {} };
    }

    const open = await runGameAgent(
      settings,
      game,
      world,
      openPrompt,
      control,
      onAgentStatus,
    );
    const sceneSummary = String(
      open.json?.sceneSummary ?? game.worldClock.sceneSummary,
    );
    const pe = plainTextFromModel(open.json, open.text.slice(0, 200));
    game.worldClock.sceneSummary = sceneSummary;
    pushEvent(game, {
      tick: game.worldClock.tick,
      interactionRound: 0,
      kind: "world",
      actorId: world.id,
      actorName: world.name,
      summary: pe || String(open.json?.publicEvent ?? "世界开场"),
      detail: sceneSummary,
      audience: "public",
    });
    publicEvent = pe;
    game.tickBuffer = {
      tick: game.worldClock.tick,
      interactionRound: 0,
      status: "running",
      worldBrief: pe,
    };
    await persist(game, options?.onPersist);
    return { flags: {} };
  };

  const runPropose = async (): Promise<StageResult> => {
    round = (game.tickBuffer!.interactionRound || 0) + 1;
    game.tickBuffer!.interactionRound = round;
    game.tickBuffer!.status = "running";
    options?.onProgress?.({
      phase: "角色提案",
      interactionRound: round,
      maxRounds: 0,
    });

    allIntents = [];
    const ordered = orderedCharacters(game);
    const parallel = game.settings?.proposeMode === "parallel";
    publicEvent =
      game.tickBuffer!.worldBrief ||
      game.events
        .filter((e) => e.tick === game.worldClock.tick && e.kind === "world")
        .slice(-1)[0]?.summary ||
      publicEvent;

    const runPlayerPropose = async (ch: GameAgent): Promise<boolean> => {
      if (!options?.awaitPlayerIntent) return false;
      options.onProgress?.({
        phase: "等待玩家行动",
        interactionRound: round,
        maxRounds: 0,
      });
      const draft = await options.awaitPlayerIntent({
        characterId: ch.id,
        characterName: ch.name,
        round,
        maxRounds: 1,
        sceneSummary: game.worldClock.sceneSummary,
        redoHint: redoHint || undefined,
      });
      if (!draft || stopped()) {
        game.tickBuffer!.status = "interrupted";
        await persist(game, options?.onPersist);
        return false;
      }
      if (draft.delegateToAi) {
        options.onProgress?.({
          phase: "AI 代提",
          interactionRound: round,
          maxRounds: 0,
        });
        const intents = await proposeWithAi(
          settings,
          game,
          ch,
          round,
          publicEvent,
          redoHint,
          control,
          onAgentStatus,
        );
        allIntents.push(...intents);
        for (const intent of intents) {
          pushProposeEvent(game, ch, intent, round);
        }
      } else {
        const action = draft.action.trim();
        if (action) {
          const intent: InteractionIntent = {
            fromId: ch.id,
            toId: resolveTargetId(game, draft.toId || "世界"),
            action,
            rationale: draft.rationale?.trim() || undefined,
          };
          allIntents.push(intent);
          pushProposeEvent(game, ch, intent, round);
        }
      }
      await persist(game, options?.onPersist);
      return true;
    };

    const isAwaitingPlayer = (ch: GameAgent) =>
      game.playMode === "play" &&
      game.playerCharacterId === ch.id &&
      Boolean(options?.awaitPlayerIntent);

    if (parallel) {
      for (const ch of ordered) {
        if (!isAwaitingPlayer(ch)) continue;
        if (stopped()) break;
        const ok = await runPlayerPropose(ch);
        if (!ok) return { halt: true, flags: { hasIntents: false } };
      }
      const aiChars = ordered.filter((ch) => !isAwaitingPlayer(ch));
      if (aiChars.length && !stopped()) {
        options?.onProgress?.({
          phase: "角色并行提案",
          interactionRound: round,
          maxRounds: 0,
        });
        const batches = await Promise.all(
          aiChars.map(async (ch) => {
            if (stopped()) {
              return [] as Array<{ ch: GameAgent; intent: InteractionIntent }>;
            }
            const intents = await proposeWithAi(
              settings,
              game,
              ch,
              round,
              publicEvent,
              redoHint,
              control,
              onAgentStatus,
            );
            return intents.map((intent) => ({ ch, intent }));
          }),
        );
        for (const batch of batches) {
          for (const { ch, intent } of batch) {
            allIntents.push(intent);
            pushProposeEvent(game, ch, intent, round);
          }
        }
        await persist(game, options?.onPersist);
      }
    } else {
      for (const ch of ordered) {
        if (stopped()) break;
        if (isAwaitingPlayer(ch)) {
          const ok = await runPlayerPropose(ch);
          if (!ok) return { halt: true, flags: { hasIntents: false } };
          continue;
        }
        const intents = await proposeWithAi(
          settings,
          game,
          ch,
          round,
          publicEvent,
          redoHint,
          control,
          onAgentStatus,
        );
        allIntents.push(...intents);
        for (const intent of intents) {
          pushProposeEvent(game, ch, intent, round);
        }
        await persist(game, options?.onPersist);
      }
    }

    redoHint = "";
    game.tickBuffer!.intents = allIntents;
    if (!allIntents.length) {
      pushEvent(game, {
        tick: game.worldClock.tick,
        interactionRound: round,
        kind: "system",
        actorId: "system",
        actorName: "系统",
        summary: "无人提案，本轮结束。",
        audience: "public",
      });
      await persist(game, options?.onPersist);
    }
    return { flags: { hasIntents: allIntents.length > 0 } };
  };

  const runRespond = async (): Promise<StageResult> => {
    options?.onProgress?.({
      phase: "对端回应",
      interactionRound: round,
      maxRounds: 0,
    });
    responses = [];
    const intents = game.tickBuffer?.intents ?? allIntents;
    for (const intent of intents) {
      if (stopped()) break;
      const from = game.agents.find((a) => a.id === intent.fromId);
      if (!from) continue;
      let target: GameAgent | undefined;
      if (intent.toId === world.id) {
        target = world;
      } else {
        target = game.agents.find((a) => a.id === intent.toId);
      }
      if (!target) {
        responses.push({
          fromId: world.id,
          toIntentFromId: intent.fromId,
          content: "目标不存在，无回应。",
        });
        continue;
      }
      const prompt = [
        `当前时刻 ${clockText(game)} · 本轮交互`,
        `${from.name} 对你发起：${intent.action}`,
        intent.rationale ? `理由：${intent.rationale}` : "",
        target.kind === "character"
          ? `你的面板：\n${sheetFor(game, target) ? sheetPublicView(sheetFor(game, target)!) : ""}`
          : `当前场景：${game.worldClock.sceneSummary}`,
        `近期事件（仅你可见）：\n${recentEventsTextFor(game, target.id, 6)}`,
        '请以 JSON {"content":"..."} 回应（世界可加 environmentChange）。',
      ]
        .filter(Boolean)
        .join("\n\n");
      const res = await runGameAgent(
        settings,
        game,
        target,
        prompt,
        control,
        onAgentStatus,
      );
      const content = plainTextFromModel(res.json, res.text).slice(0, 800);
      responses.push({
        fromId: target.id,
        toIntentFromId: intent.fromId,
        content,
      });
      pushEvent(game, {
        tick: game.worldClock.tick,
        interactionRound: round,
        kind: "respond",
        actorId: target.id,
        actorName: target.name,
        summary: content.slice(0, 160),
        detail: content,
        audience: "private",
        visibleTo: [intent.fromId, target.id],
      });
      if (target.kind === "world" && res.json?.environmentChange) {
        game.worldClock.sceneSummary = String(res.json.environmentChange);
      }
      await persist(game, options?.onPersist);
    }
    game.tickBuffer!.responses = responses;
    allIntents = intents;
    if (stopped()) {
      game.tickBuffer!.status = "interrupted";
      await persist(game, options?.onPersist);
      return { halt: true, flags: {} };
    }
    return { flags: { hasIntents: intents.length > 0 } };
  };

  const runJudge = async (): Promise<StageResult> => {
    options?.onProgress?.({
      phase: "裁判裁定",
      interactionRound: round,
      maxRounds: 0,
    });
    const intents = game.tickBuffer?.intents ?? allIntents;
    const resps = game.tickBuffer?.responses ?? responses;
    const judgePrompt = [
      `当前时刻 ${clockText(game)} · 本轮交互`,
      `场景：${game.worldClock.sceneSummary}`,
      `角色面板：\n${game.sheets.map(sheetPublicView).join("\n---\n")}`,
      `本轮意图：\n${intents
        .map(
          (i) =>
            `${agentDisplayName(game, i.fromId)} → ${agentDisplayName(game, i.toId)}：${i.action}`,
        )
        .join("\n")}`,
      `本轮回应：\n${resps
        .map((r) => `${agentDisplayName(game, r.fromId)}：${r.content}`)
        .join("\n")}`,
      `近期事件：\n${recentEventsText(game, 10)}`,
      "请输出裁定 JSON。publicSummary 仅写公开可察后果；细因放 reason；突发用 notify。",
    ]
      .filter(Boolean)
      .join("\n\n");

    const judgeRes = await runGameAgent(
      settings,
      game,
      referee,
      judgePrompt,
      control,
      onAgentStatus,
    );
    const judge = parseJudge(judgeRes.json, judgeRes.text);
    const redo = shouldRedoRound(judge);
    game.tickBuffer!.lastJudge = judge;

    let diffs: ReturnType<typeof applySheetPatches> = [];
    if (
      !redo &&
      (judge.verdict === "accept" || judge.verdict === "revise") &&
      judge.sheetPatches?.length
    ) {
      diffs = applySheetPatches(game, judge.sheetPatches);
    }

    const tag = redo
      ? `[${verdictZh(judge.verdict)}·重做]`
      : `[${verdictZh(judge.verdict)}]`;
    const publicBlurb = `本轮交互已裁定：${verdictZh(judge.verdict)}${
      redo ? "（将重做）" : ""
    }`;
    pushEvent(game, {
      tick: game.worldClock.tick,
      interactionRound: round,
      kind: "judge",
      actorId: referee.id,
      actorName: referee.name,
      summary: publicBlurb,
      audience: "public",
    });

    const involved = new Set<string>();
    for (const i of intents) {
      involved.add(i.fromId);
      involved.add(i.toId);
    }
    for (const r of resps) involved.add(r.fromId);
    pushEvent(game, {
      tick: game.worldClock.tick,
      interactionRound: round,
      kind: "judge",
      actorId: referee.id,
      actorName: referee.name,
      summary: `${tag} ${judge.publicSummary}`,
      detail: judge.reason,
      sheetDiffs: diffs.length ? diffs : undefined,
      audience: "private",
      visibleTo: [...involved],
    });
    await persist(game, options?.onPersist);

    if (judge.notify?.length) {
      for (const n of judge.notify) {
        const toId = resolveTargetId(game, n.toId);
        const toName = agentDisplayName(game, toId);
        pushEvent(game, {
          tick: game.worldClock.tick,
          interactionRound: round,
          kind: "system",
          actorId: referee.id,
          actorName: referee.name,
          summary: notifySummary(toName, n.message),
          detail: n.message,
          audience: "private",
          visibleTo: [toId],
        });
      }
      await persist(game, options?.onPersist);
    }

    if (redo) {
      redoHint = judge.reason || judge.publicSummary || "请调整行动后重试";
      return { flags: { judgeOutcome: "redo", hasIntents: true } };
    }
    if (judge.verdict === "reject") {
      return { flags: { judgeOutcome: "reject", hasIntents: true } };
    }
    return { flags: { judgeOutcome: "accept", hasIntents: true } };
  };

  const runChronicle = async (): Promise<StageResult> => {
    options?.onProgress?.({
      phase: "整理剧情",
      interactionRound: round,
      maxRounds: 0,
    });
    await appendChronicles(
      settings,
      game,
      control,
      options?.onProgress,
      options?.onPersist,
    );
    if (stopped()) {
      game.tickBuffer!.status = "interrupted";
      await persist(game, options?.onPersist);
      return { halt: true, flags: {} };
    }
    return { flags: {} };
  };

  const runAdvanceClock = async (): Promise<StageResult> => {
    options?.onProgress?.({
      phase: "推进时刻…",
      interactionRound: round,
      maxRounds: 0,
    });
    const closedTick = game.worldClock.tick;
    const closedTime = clockText(game);
    rememberClock(game);

    const advancePrompt = [
      `本轮交互已结束。刚才的世界时刻是：${closedTime}`,
      `场景：${game.worldClock.sceneSummary}`,
      `本轮事件：\n${eventsTextForTick(game, closedTick)}`,
      `世界观：${game.worldview || world.persona}`,
      "请根据本轮事件疏密给出下一精确时刻：事件紧凑则只推进数十分钟～一两小时；平静则可推到半天、入夜或次日。",
      'nextTime 必须写成「日期 + 时:分」（例：三月初二 14:20），禁止地支时辰与「第 N 时」。',
      '输出 JSON：{"nextTime":"...","sceneSummary":"...","publicEvent":"..."}。',
    ].join("\n\n");

    try {
      const adv = await runGameAgent(
        settings,
        game,
        world,
        advancePrompt,
        control,
        onAgentStatus,
      );
      const nextTime = String(
        adv.json?.nextTime ?? adv.json?.timeText ?? "",
      ).trim();
      const nextScene = String(
        adv.json?.sceneSummary ?? game.worldClock.sceneSummary,
      );
      const nextPublic = plainTextFromModel(adv.json, adv.text.slice(0, 200));
      game.worldClock.tick = closedTick + 1;
      setClockText(game, nextTime || `${closedTime}（之后）`);
      game.worldClock.sceneSummary = nextScene;
      pushEvent(game, {
        tick: game.worldClock.tick,
        interactionRound: 0,
        kind: "system",
        actorId: world.id,
        actorName: world.name,
        summary: `时刻推进至「${clockText(game)}」${
          nextPublic ? `：${nextPublic.slice(0, 120)}` : ""
        }`,
        detail: nextScene,
        audience: "public",
      });
    } catch {
      game.worldClock.tick = closedTick + 1;
      setClockText(game, `${closedTime}（之后）`);
      pushEvent(game, {
        tick: game.worldClock.tick,
        interactionRound: 0,
        kind: "system",
        actorId: "system",
        actorName: "系统",
        summary: `时刻推进至「${clockText(game)}」（自动）`,
        audience: "public",
      });
    }

    game.tickBuffer = {
      tick: game.worldClock.tick,
      interactionRound: 0,
      status: "need_open",
    };
    await persist(game, options?.onPersist);
    return { done: true, flags: {} };
  };

  let currentId: string | null = pipeline.entry;
  let steps = 0;
  while (currentId && !stopped()) {
    steps += 1;
    if (steps > MAX_PIPELINE_STEPS) {
      pushEvent(game, {
        tick: game.worldClock.tick,
        interactionRound: round,
        kind: "system",
        actorId: "system",
        actorName: "系统",
        summary: `流水线步数超过 ${MAX_PIPELINE_STEPS}，已中断。`,
        audience: "public",
      });
      game.tickBuffer!.status = "interrupted";
      await persist(game, options?.onPersist);
      break;
    }

    const node = nodeById.get(currentId);
    if (!node) {
      pushEvent(game, {
        tick: game.worldClock.tick,
        interactionRound: round,
        kind: "system",
        actorId: "system",
        actorName: "系统",
        summary: `流水线节点缺失：${currentId}`,
        audience: "public",
      });
      await persist(game, options?.onPersist);
      break;
    }

    let result: StageResult = { flags: {} };
    switch (node.kind) {
      case "world_open":
        result = await runWorldOpen();
        break;
      case "propose":
        result = await runPropose();
        break;
      case "respond":
        result = await runRespond();
        break;
      case "judge":
        result = await runJudge();
        break;
      case "chronicle":
        result = await runChronicle();
        break;
      case "advance_clock":
        result = await runAdvanceClock();
        break;
      default:
        result = { flags: {} };
    }

    if (result.halt) return game;
    if (result.done) return game;

    if (stopped()) {
      game.tickBuffer!.status = "interrupted";
      await persist(game, options?.onPersist);
      return game;
    }

    currentId = selectNextNodeId(pipeline, node.id, result.flags);
  }

  if (stopped()) {
    game.tickBuffer!.status = "interrupted";
    await persist(game, options?.onPersist);
  }
  return game;
}

/** @deprecated 使用 advanceOneRound；保留别名以免旧引用断裂。 */
export async function advanceGameTick(
  settings: AppSettings,
  game: GameState,
  options?: {
    control?: StreamControl;
    onProgress?: (p: TickProgress) => void;
    inject?: string;
    onPersist?: (g: GameState) => void | Promise<void>;
    awaitPlayerIntent?: (
      req: PlayerIntentRequest,
    ) => Promise<PlayerIntentDraft | null>;
  },
): Promise<GameState> {
  return advanceOneRound(settings, game, options);
}

export async function injectPlayerEvent(
  game: GameState,
  text: string,
): Promise<GameState> {
  const msg = text.trim();
  if (!msg) return game;
  pushEvent(game, {
    tick: game.worldClock.tick,
    interactionRound: game.tickBuffer?.interactionRound ?? 0,
    kind: "inject",
    actorId: "player",
    actorName: "玩家",
    summary: msg,
    audience: "public",
  });
  await saveGame(game);
  return game;
}

