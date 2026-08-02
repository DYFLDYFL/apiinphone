import type { AppSettings } from "../../types";
import type { StreamControl } from "../apiClient";
import { effectiveGameMaxInteractionRounds } from "../settings";
import { runGameAgent } from "./agentRunner";
import { saveGame } from "./gameStore";
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
import type {
  GameAgent,
  GameState,
  InteractionIntent,
  InteractionResponse,
  JudgeNotify,
  JudgeResult,
} from "./types";

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
};

function characters(game: GameState): GameAgent[] {
  return game.agents.filter((a) => a.kind === "character");
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

function parseJudge(json: Record<string, unknown> | null, text: string): JudgeResult {
  if (!json) {
    return {
      verdict: "reject",
      reason: "裁判未返回 JSON",
      periodComplete: false,
      publicSummary: plainTextFromModel(null, text).slice(0, 120) || "裁定失败",
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
  return {
    verdict,
    reason: String(json.reason ?? ""),
    revisedAction:
      json.revisedAction != null ? String(json.revisedAction) : undefined,
    sheetPatches: Array.isArray(json.sheetPatches)
      ? (json.sheetPatches as JudgeResult["sheetPatches"])
      : [],
    periodComplete: Boolean(json.periodComplete),
    publicSummary: String(json.publicSummary ?? json.reason ?? "裁定"),
    redo,
    notify: parseNotify(json.notify),
  };
}

/** reject 默认重做；显式 redo=true 也重做。 */
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

/**
 * Advance one time period: world opens → multi-round character↔character/world
 * interactions judged by referee until periodComplete or max rounds.
 */
export async function advanceGameTick(
  settings: AppSettings,
  game: GameState,
  options?: {
    control?: StreamControl;
    onProgress?: (p: TickProgress) => void;
    inject?: string;
    /** Called after each persist (event written). */
    onPersist?: (g: GameState) => void | Promise<void>;
    /** 扮演模式下轮到玩家角色提案时等待 UI。返回 null 表示中断。 */
    awaitPlayerIntent?: (
      req: PlayerIntentRequest,
    ) => Promise<PlayerIntentDraft | null>;
  },
): Promise<GameState> {
  const control = options?.control;
  const maxRounds = effectiveGameMaxInteractionRounds(
    settings,
    game.settings.maxInteractionRounds || 6,
  );
  const chars = characters(game);
  const world = worldAgent(game);
  const referee = refereeAgent(game);
  const stopped = () => Boolean(control?.cancelled);

  game.worldClock.tick += 1;
  game.worldClock.label = `第 ${game.worldClock.tick} 时`;
  game.tickBuffer = {
    tick: game.worldClock.tick,
    interactionRound: 0,
    status: "running",
  };

  options?.onProgress?.({
    phase: "世界开场",
    interactionRound: 0,
    maxRounds,
  });

  const openPrompt = [
    `当前时刻：${game.worldClock.label}`,
    `上一场景：${game.worldClock.sceneSummary}`,
    `世界观：${game.worldview || world.persona}`,
    `近期事件（你可见）：\n${recentEventsTextFor(game, world.id)}`,
    options?.inject ? `玩家神谕：${options.inject}` : "",
    "请输出开周期 JSON。",
  ]
    .filter(Boolean)
    .join("\n\n");

  if (stopped()) {
    game.tickBuffer.status = "interrupted";
    await persist(game, options?.onPersist);
    return game;
  }

  const open = await runGameAgent(settings, game, world, openPrompt, control);
  const sceneSummary = String(
    open.json?.sceneSummary ?? game.worldClock.sceneSummary,
  );
  const publicEvent = plainTextFromModel(
    open.json,
    open.text.slice(0, 200),
  );
  game.worldClock.sceneSummary = sceneSummary;
  pushEvent(game, {
    tick: game.worldClock.tick,
    interactionRound: 0,
    kind: "world",
    actorId: world.id,
    actorName: world.name,
    summary: publicEvent || String(open.json?.publicEvent ?? "世界开场"),
    detail: sceneSummary,
    audience: "public",
  });
  game.tickBuffer.worldBrief = publicEvent;
  await persist(game, options?.onPersist);

  let periodComplete = false;
  let round = 0;
  let redoHint = "";

  while (!periodComplete && round < maxRounds) {
    if (stopped()) {
      game.tickBuffer.status = "interrupted";
      await persist(game, options?.onPersist);
      return game;
    }
    round += 1;
    game.tickBuffer.interactionRound = round;
    options?.onProgress?.({
      phase: "角色提案",
      interactionRound: round,
      maxRounds,
    });

    const allIntents: InteractionIntent[] = [];
    for (const ch of chars) {
      if (stopped()) break;

      const isPlayer =
        game.playMode === "play" &&
        game.playerCharacterId === ch.id &&
        Boolean(options?.awaitPlayerIntent);

      if (isPlayer && options?.awaitPlayerIntent) {
        options.onProgress?.({
          phase: "等待玩家行动",
          interactionRound: round,
          maxRounds,
        });
        const draft = await options.awaitPlayerIntent({
          characterId: ch.id,
          characterName: ch.name,
          round,
          maxRounds,
          sceneSummary: game.worldClock.sceneSummary,
          redoHint: redoHint || undefined,
        });
        if (!draft || stopped()) {
          game.tickBuffer.status = "interrupted";
          await persist(game, options?.onPersist);
          return game;
        }
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
        await persist(game, options?.onPersist);
        continue;
      }

      const sheet = sheetFor(game, ch);
      const prompt = [
        `时刻 ${game.worldClock.label} · 交互轮 ${round}/${maxRounds}`,
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
      const res = await runGameAgent(settings, game, ch, prompt, control);
      const intents = parseIntents(game, ch, res.json, res.text);
      allIntents.push(...intents);
      for (const intent of intents) {
        pushProposeEvent(game, ch, intent, round);
      }
      await persist(game, options?.onPersist);
    }
    redoHint = "";
    game.tickBuffer.intents = allIntents;

    if (!allIntents.length) {
      periodComplete = true;
      pushEvent(game, {
        tick: game.worldClock.tick,
        interactionRound: round,
        kind: "system",
        actorId: "system",
        actorName: "系统",
        summary: "无人提案，本周期结束。",
        audience: "public",
      });
      await persist(game, options?.onPersist);
      break;
    }

    options?.onProgress?.({
      phase: "对端回应",
      interactionRound: round,
      maxRounds,
    });

    const responses: InteractionResponse[] = [];
    for (const intent of allIntents) {
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
        `时刻 ${game.worldClock.label} · 交互轮 ${round}`,
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
      const res = await runGameAgent(settings, game, target, prompt, control);
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
    game.tickBuffer.responses = responses;

    if (stopped()) {
      game.tickBuffer.status = "interrupted";
      await persist(game, options?.onPersist);
      return game;
    }

    options?.onProgress?.({
      phase: "裁判裁定",
      interactionRound: round,
      maxRounds,
    });

    const forceComplete = round >= maxRounds;
    const judgePrompt = [
      `时刻 ${game.worldClock.label} · 交互轮 ${round}/${maxRounds}`,
      forceComplete ? "已达交互上限，请尽量 periodComplete=true 收束；仍可 reject，但本轮后不再重做。" : "",
      `场景：${game.worldClock.sceneSummary}`,
      `角色面板：\n${game.sheets.map(sheetPublicView).join("\n---\n")}`,
      `本轮意图：\n${allIntents
        .map(
          (i) =>
            `${agentDisplayName(game, i.fromId)} → ${agentDisplayName(game, i.toId)}：${i.action}`,
        )
        .join("\n")}`,
      `本轮回应：\n${responses
        .map(
          (r) =>
            `${agentDisplayName(game, r.fromId)}：${r.content}`,
        )
        .join("\n")}`,
      `近期事件：\n${recentEventsText(game, 10)}`,
      "请输出裁定 JSON。publicSummary 用中文。不合理须 reject+redo；突发私讯用 notify。",
    ]
      .filter(Boolean)
      .join("\n\n");

    const judgeRes = await runGameAgent(
      settings,
      game,
      referee,
      judgePrompt,
      control,
    );
    const judge = parseJudge(judgeRes.json, judgeRes.text);
    const redo = shouldRedoRound(judge) && !forceComplete;
    if (forceComplete) judge.periodComplete = true;
    if (redo) judge.periodComplete = false;
    game.tickBuffer.lastJudge = judge;

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
    pushEvent(game, {
      tick: game.worldClock.tick,
      interactionRound: round,
      kind: "judge",
      actorId: referee.id,
      actorName: referee.name,
      summary: `${tag} ${judge.publicSummary}`,
      detail: judge.reason,
      sheetDiffs: diffs.length ? diffs : undefined,
      audience: "public",
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
      periodComplete = false;
      continue;
    }

    periodComplete = judge.periodComplete;
  }

  game.tickBuffer = {
    tick: game.worldClock.tick,
    interactionRound: round,
    status: stopped() ? "interrupted" : "completed",
    worldBrief: game.tickBuffer?.worldBrief,
  };
  await persist(game, options?.onPersist);
  return game;
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
