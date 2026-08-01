import type { AppSettings } from "../../types";
import type { StreamControl } from "../apiClient";
import { effectiveGameMaxInteractionRounds } from "../settings";
import { runGameAgent } from "./agentRunner";
import { saveGame } from "./gameStore";
import {
  agentDirectory,
  agentDisplayName,
  applySheetPatches,
  plainTextFromModel,
  pushEvent,
  recentEventsText,
  sheetPublicView,
} from "./mutations";
import type {
  GameAgent,
  GameState,
  InteractionIntent,
  InteractionResponse,
  JudgeResult,
} from "./types";

export type TickProgress = {
  phase: string;
  interactionRound: number;
  maxRounds: number;
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

function parseJudge(json: Record<string, unknown> | null, text: string): JudgeResult {
  if (!json) {
    return {
      verdict: "reject",
      reason: "裁判未返回 JSON",
      periodComplete: false,
      publicSummary: plainTextFromModel(null, text).slice(0, 120) || "裁定失败",
    };
  }
  const verdictRaw = String(json.verdict ?? "reject");
  const verdict =
    verdictRaw === "accept" || verdictRaw === "revise" || verdictRaw === "reject"
      ? verdictRaw
      : "reject";
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
  };
}

async function persist(
  game: GameState,
  onPersist?: (g: GameState) => void | Promise<void>,
): Promise<void> {
  await saveGame(game);
  await onPersist?.(game);
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
    `近期事件：\n${recentEventsText(game)}`,
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
  });
  game.tickBuffer.worldBrief = publicEvent;
  await persist(game, options?.onPersist);

  let periodComplete = false;
  let round = 0;

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
      const sheet = sheetFor(game, ch);
      const prompt = [
        `时刻 ${game.worldClock.label} · 交互轮 ${round}/${maxRounds}`,
        `场景：${game.worldClock.sceneSummary}`,
        `本时段公开事件：${publicEvent}`,
        `你的面板：\n${sheet ? sheetPublicView(sheet) : "无"}`,
        `可互动对象：\n${agentDirectory(game)}`,
        `近期事件：\n${recentEventsText(game, 8)}`,
        "提出 1～2 条意图 JSON。toId 填「世界」或角色中文名。",
      ].join("\n\n");
      const res = await runGameAgent(settings, game, ch, prompt, control);
      const intents = parseIntents(game, ch, res.json, res.text);
      allIntents.push(...intents);
      for (const intent of intents) {
        const targetName = agentDisplayName(game, intent.toId);
        pushEvent(game, {
          tick: game.worldClock.tick,
          interactionRound: round,
          kind: "propose",
          actorId: ch.id,
          actorName: ch.name,
          summary: `对「${targetName}」：${intent.action}`,
          detail: intent.rationale,
        });
      }
      await persist(game, options?.onPersist);
    }
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
      forceComplete ? "已达交互上限，请尽量 periodComplete=true 收束。" : "",
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
      "请输出裁定 JSON。publicSummary 用中文。",
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
    if (forceComplete) judge.periodComplete = true;
    game.tickBuffer.lastJudge = judge;

    let diffs: ReturnType<typeof applySheetPatches> = [];
    if (judge.verdict === "accept" || judge.verdict === "revise") {
      if (judge.sheetPatches?.length) {
        diffs = applySheetPatches(game, judge.sheetPatches);
      }
    }
    pushEvent(game, {
      tick: game.worldClock.tick,
      interactionRound: round,
      kind: "judge",
      actorId: referee.id,
      actorName: referee.name,
      summary: `[${verdictZh(judge.verdict)}] ${judge.publicSummary}`,
      detail: judge.reason,
      sheetDiffs: diffs.length ? diffs : undefined,
    });
    await persist(game, options?.onPersist);

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
  });
  await saveGame(game);
  return game;
}
