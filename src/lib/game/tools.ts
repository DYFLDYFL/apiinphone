import {
  applySheetPatches,
  pushEvent,
  sheetPublicView,
} from "./mutations";
import type { GameSheet, GameState, JudgeResult, JudgeVerdict } from "./types";

/** Game-facing tool names (applied by orchestrator via JSON; kept for docs & future wiring). */
export const GAME_TOOL_NAMES = [
  "get_sheet",
  "list_sheets",
  "apply_sheet_patch",
  "append_event",
  "get_world_clock",
  "resolve_interaction",
  "complete_period",
] as const;

export type GameToolName = (typeof GAME_TOOL_NAMES)[number];

export function getSheet(game: GameState, sheetId: string): GameSheet | null {
  return game.sheets.find((s) => s.id === sheetId) ?? null;
}

export function listSheets(game: GameState): string {
  return game.sheets.map(sheetPublicView).join("\n---\n");
}

export function applySheetPatch(
  game: GameState,
  patches: NonNullable<JudgeResult["sheetPatches"]>,
): Array<{ sheetId: string; patch: Record<string, unknown> }> {
  return applySheetPatches(game, patches);
}

export function appendEvent(
  game: GameState,
  partial: Parameters<typeof pushEvent>[1],
) {
  return pushEvent(game, partial);
}

export function getWorldClock(game: GameState) {
  return { ...game.worldClock };
}

export function resolveInteraction(
  game: GameState,
  input: {
    tick: number;
    interactionRound: number;
    verdict: JudgeVerdict;
    reason: string;
    publicSummary: string;
    sheetPatches?: NonNullable<JudgeResult["sheetPatches"]>;
  },
) {
  let diffs: Array<{ sheetId: string; patch: Record<string, unknown> }> = [];
  if (
    (input.verdict === "accept" || input.verdict === "revise") &&
    input.sheetPatches?.length
  ) {
    diffs = applySheetPatches(game, input.sheetPatches);
  }
  const referee = game.agents.find((a) => a.capabilities.includes("judge"));
  return pushEvent(game, {
    tick: input.tick,
    interactionRound: input.interactionRound,
    kind: "judge",
    actorId: referee?.id ?? "ref",
    actorName: referee?.name ?? "裁判",
    summary: `[${input.verdict}] ${input.publicSummary}`,
    detail: input.reason,
    sheetDiffs: diffs.length ? diffs : undefined,
  });
}

/** Mark period complete in tick buffer (orchestrator exits loop). */
export function completePeriod(game: GameState): void {
  if (game.tickBuffer) {
    game.tickBuffer.status = "completed";
  }
}
