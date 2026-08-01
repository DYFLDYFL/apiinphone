import type { ChatMessage } from "../../types";

export type GameAgentKind = "world" | "character" | "referee";

export interface GameSheet {
  id: string;
  name: string;
  /** Free-form numeric / string attrs (hp, strength, location, …). */
  attrs: Record<string, string | number | boolean>;
  inventory: string[];
  flags: string[];
  notes: string;
}

export interface GameAgent {
  id: string;
  kind: GameAgentKind;
  name: string;
  /** Character sheet id when kind === character. */
  sheetId?: string;
  persona: string;
  systemPrompt: string;
  history: ChatMessage[];
}

export interface GameEvent {
  id: string;
  tick: number;
  interactionRound: number;
  at: string;
  kind: "world" | "propose" | "respond" | "judge" | "system" | "inject";
  actorId: string;
  actorName: string;
  summary: string;
  detail?: string;
  sheetDiffs?: Array<{ sheetId: string; patch: Record<string, unknown> }>;
}

export interface InteractionIntent {
  fromId: string;
  /** Target agent id, or "world". */
  toId: string;
  action: string;
  rationale?: string;
}

export interface InteractionResponse {
  fromId: string;
  toIntentFromId: string;
  content: string;
}

export type JudgeVerdict = "accept" | "reject" | "revise";

export interface JudgeResult {
  verdict: JudgeVerdict;
  reason: string;
  revisedAction?: string;
  sheetPatches?: Array<{
    sheetId: string;
    attrs?: Record<string, string | number | boolean>;
    inventoryAdd?: string[];
    inventoryRemove?: string[];
    flagsAdd?: string[];
    flagsRemove?: string[];
    notesAppend?: string;
  }>;
  periodComplete: boolean;
  publicSummary: string;
}

export interface TickBuffer {
  tick: number;
  interactionRound: number;
  status: "running" | "completed" | "interrupted";
  worldBrief?: string;
  intents?: InteractionIntent[];
  responses?: InteractionResponse[];
  lastJudge?: JudgeResult;
}

export interface GameSettings {
  maxInteractionRounds: number;
  characterCount: number;
}

export interface GameState {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 世界观说明（可编辑）。 */
  worldview: string;
  worldClock: {
    tick: number;
    label: string;
    sceneSummary: string;
  };
  agents: GameAgent[];
  sheets: GameSheet[];
  events: GameEvent[];
  tickBuffer: TickBuffer | null;
  settings: GameSettings;
}

export interface GameIndexMeta {
  title: string;
  updatedAt: string;
  tick: number;
}

export interface GameIndex {
  activeId: string;
  order: string[];
  meta: Record<string, GameIndexMeta>;
}
