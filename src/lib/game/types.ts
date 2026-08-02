import type { ChatMessage } from "../../types";

export type GameAgentKind = "world" | "character" | "referee";

export type GamePlayMode = "spectate" | "play";

export type GameEventAudience = "public" | "private";

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
  /** public = 全员可见；private = 仅 visibleTo 内 agent。缺省按 public。 */
  audience?: GameEventAudience;
  /** agent id 列表；audience=private 时生效。 */
  visibleTo?: string[];
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

export interface JudgeNotify {
  /** 角色中文名、世界、或 agent id。 */
  toId: string;
  message: string;
}

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
  /**
   * true = 本轮作废并重做（不改面板）。
   * reject 时若未显式 false，也视为需要重做。
   */
  redo?: boolean;
  /** 突发事件私讯，写入 private 事件。 */
  notify?: JudgeNotify[];
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
  /** 旁观斗蛐蛐 / 扮演角色。 */
  playMode: GamePlayMode;
  /** play 时扮演的角色 agent id。 */
  playerCharacterId: string | null;
  /** 上帝视角剧情正文（累积）。 */
  godStory: string;
  /** 玩家视角剧情/个人经历（累积）。 */
  playerStory: string;
  /** 已写入剧情的时刻（避免重复追加）。 */
  storyTick: number;
  /**
   * 是否已解锁时间线/上帝剧情。
   * 旁观创建即为 true；扮演默认 false，解锁一次后不可再锁。
   */
  godViewUnlocked: boolean;
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
