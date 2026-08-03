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

export interface GameAttributeDefinition {
  key: string;
  label: string;
  valueType: "number" | "text";
  numberOptions?: number[];
  textOptions?: string[];
}

export interface GameDateTime {
  description: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export interface GameContextFile {
  id: string;
  title: string;
  content: string;
}

export interface GameContextFileEdit {
  fileId: string;
  content?: string;
  append?: string;
}

export type AgentFeatureKey =
  | "propose"
  | "respond"
  | "judge"
  | "chronicle"
  | "advance_clock";

/** Per-agent model override; omitted fields inherit global game model settings. */
export interface AgentModelOverride {
  model?: string;
  thinkingMode?: "enabled" | "disabled";
  reasoningEffort?: "low" | "high" | "max";
}

/** 仅供废弃的隐藏编辑器代码编译，当前建局流程不再读取这些字段。 */
export type ProposeOrderMode = "template" | "random" | "custom";
export type ProposeMode = "serial" | "parallel";

export type PipelineNodeKind =
  | "agent"
  | "world_open"
  | "propose"
  | "respond"
  | "judge"
  | "chronicle"
  | "advance_clock";

export type PipelineEdgeWhen =
  | "always"
  | "has_intents"
  | "no_intents"
  | "judge_accept"
  | "judge_redo"
  | "judge_reject";

export interface PipelineNode {
  id: string;
  kind: PipelineNodeKind;
  label?: string;
  agentIds?: string[];
  targetIds?: string[];
  dispatchMode?: "serial" | "parallel";
}

export interface PipelineEdge {
  from: string;
  to: string;
  when: PipelineEdgeWhen;
}

export interface GamePipeline {
  entry: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}

export interface GameAgent {
  id: string;
  kind: GameAgentKind;
  name: string;
  /** Character sheet id when kind === character. */
  sheetId?: string;
  persona: string;
  systemPrompt: string;
  /**
   * If non-empty, used as systemPrompt and not regenerated from persona on load.
   */
  systemPromptOverride?: string;
  modelOverride?: AgentModelOverride;
  readableFileIds?: string[];
  editableFileIds?: string[];
  disabledFeatures?: AgentFeatureKey[];
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
  /** need_open=本时段尚未世界开场；running=交互中；completed=本时段已收束待/已拨钟 */
  status: "need_open" | "running" | "completed" | "interrupted";
  worldBrief?: string;
  intents?: InteractionIntent[];
  responses?: InteractionResponse[];
  lastJudge?: JudgeResult;
}

export interface GameSettings {
  characterCount: number;
  /** 推进一轮流水线图；缺省用默认图。 */
  pipeline: GamePipeline;
  /** 书记提示词覆盖（空 = 默认）。 */
  chroniclerGodPrompt?: string;
  chroniclerPlayerPrompt?: string;
  chroniclerModel?: AgentModelOverride;
  chroniclerReadableFileIds?: string[];
  chroniclerEditableFileIds?: string[];
  chroniclerDisabledFeatures?: AgentFeatureKey[];
}

export interface GameState {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 世界观说明（可编辑）。 */
  worldview: string;
  worldClock: {
    /** 时段序号（事件/归档内部用）。 */
    tick: number;
    /** 展示用，与 timeText 同步。 */
    label: string;
    /** 具体世界时刻（叙事字符串，如「三月初二 05:30」）。 */
    timeText: string;
    description?: string;
    dateTime: GameDateTime;
    sceneSummary: string;
    /** tick → 该时段的 timeText（时间线展示用）。 */
    history?: Record<string, string>;
  };
  agents: GameAgent[];
  sheets: GameSheet[];
  contextFiles: GameContextFile[];
  /** 本局模板定义的属性集合；旧存档可由 attrs 推导。 */
  attributeDefinitions: GameAttributeDefinition[];
  events: GameEvent[];
  tickBuffer: TickBuffer | null;
  settings: GameSettings;
  /** 上帝视角 / 扮演角色。 */
  playMode: GamePlayMode;
  /** play 时扮演的角色 agent id。 */
  playerCharacterId: string | null;
  /** 上帝视角剧情正文（累积）。 */
  godStory: string;
  /** 玩家视角剧情/个人经历（累积）。 */
  playerStory: string;
  /** 已写入「时段剧情」的 tick（开场种子可为 -1）。 */
  storyTick: number;
  /**
   * 是否已解锁时间线/上帝剧情。
   * 上帝视角创建即为 true；扮演默认 false，解锁一次后不可再锁。
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
