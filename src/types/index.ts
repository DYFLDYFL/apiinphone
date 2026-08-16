/** 一个模型供应商配置（DeepSeek / OpenCode Go / 自定义）。 */
export interface ProviderConfig {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  /** 该供应商当前选中的模型。 */
  model: string;
  /** /models 自动识别缓存（可空）。 */
  models: string[];
  /** 勾选启用的模型 id 列表；未设置 = 全部启用。 */
  enabledModels?: string[];
  /** 是否发送 thinking 参数（DeepSeek 专属方言）。 */
  thinkingSupport?: boolean;
}

export interface AppSettings {
  /** 当前选中的供应商 id（providers 中的一项）。 */
  apiProvider: string;
  /** 模型供应商列表（至少一项）。 */
  providers: ProviderConfig[];
  /** 兼容旧字段：迁移后仍同步 active provider 的 apiKey。 */
  apiKey: string;
  /** 兼容旧字段：迁移后仍同步 active provider 的 baseUrl。 */
  baseUrl: string;
  /** 兼容旧字段：迁移后仍同步 active provider 的 model。 */
  model: string;
  /** 对话网页联网搜索。 */
  webSearchEnabled: boolean;
  /** 游戏网页联网搜索。 */
  gameWebSearchEnabled: boolean;
  /** 扮演时默认本轮交给 AI，无需每次点按钮。 */
  gameAutoDelegateAi: boolean;
  /** 游戏模式独立模型（与对话 model 分离）。 */
  gameModel: string;
  /** 工作区模式独立模型（与对话/游戏分离）。 */
  workspaceModel: string;
  /** 工作区模型所属供应商（缺省跟随 apiProvider）。 */
  workspaceProviderId: string;
  temperature: number;
  maxTokens: number | null;
  /** 上下文压缩阈值（百分比，0=关闭）。达到后发送前用 AI 摘要压缩早期对话。 */
  contextCompressThreshold: number;
  stream: boolean;
  showThinking: boolean;
  thinkingMode: "enabled" | "disabled";
  reasoningEffort: "low" | "high" | "max";
  /** 游戏模式独立思考开关。 */
  gameThinkingMode: "enabled" | "disabled";
  /** 游戏模式独立推理档位。 */
  gameReasoningEffort: "low" | "high" | "max";
  /** 工作区模式独立思考开关。 */
  workspaceThinkingMode: "enabled" | "disabled";
  /** 工作区模式独立推理档位。 */
  workspaceReasoningEffort: "low" | "high" | "max";
  toolsEnabled: boolean;
  toolsWebSearch: boolean;
  toolsPythonSandbox: boolean;
  pythonSandboxTimeout: number;
  maxToolRounds: number;
  webSearchEngine: string;
  webSearchEndpoint: string;
  webSearchMetasoKey: string;
  webSearchBaiduKey: string;
  /** 填了优先用 Exa 语义搜索（ai.exa.ai），留空用免费引擎链。 */
  webSearchExaKey: string;
  /** Default result count per web_search when model omits topK. */
  webSearchDefaultTopK: number;
  /** Maximum topK allowed per web_search call. */
  webSearchMaxTopK: number;
  httpConnectTimeout: number;
  httpReadTimeout: number;
  retryCount: number;
  retryBackoffMs: number;
  systemPrompt: string;
  theme: "dark" | "light";
  recentModels: string[];
  /** 上次所在的界面区（对话/游戏/工作区），启动时恢复。 */
  lastView: "chat" | "game" | "workspace";
  /** GitHub Personal Access Token，用于工作区连接仓库。 */
  githubToken: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | Array<Record<string, unknown>>;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolTraceItem {
  id: string;
  name: string;
  label: string;
  status: "running" | "done" | "error";
  /** Short summary (query, URL, etc.). */
  detail?: string;
  /** Raw tool arguments JSON. */
  args?: string;
  /** Full tool output for expandable UI (search hits, page text, etc.). */
  result?: string;
  /** Structured export info when tool is save_document. */
  exportedFile?: {
    id: string;
    name: string;
    format: "txt" | "docx" | "pdf" | "excalidraw";
    mime: string;
    path: string;
    uri: string;
    directory: string;
    locationLabel: string;
    createdAt: string;
  };
}

export interface NumberedSource {
  n: number;
  title: string;
  url: string;
}

export interface DisplayMessage {
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string;
  toolTrace?: ToolTraceItem[] | string;
  /** Numbered web search hits cited in this reply. */
  sources?: NumberedSource[];
  note?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  history: ChatMessage[];
  display: DisplayMessage[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextTokens: number;
  cacheHitTokens: number;
  /** Cumulative CNY spent this session (from balance deltas when available). */
  spentCny: number;
  /** 该对话独立选用的模型（缺省时跟随全局设置）。 */
  model?: string;
  /** 该对话选用模型所属的供应商 id（与 model 成对）。 */
  providerId?: string;
}

export interface ChatResponse {
  content: string;
  reasoning: string;
  note: string;
  usage: TokenUsage | null;
  apiMessages: ChatMessage[];
}

export interface DeepSeekBalanceEntry {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export interface DeepSeekBalance {
  isAvailable: boolean;
  balanceInfos: DeepSeekBalanceEntry[];
}

export interface AttachmentPreview {
  name: string;
  kind: "image" | "text" | "binary";
  mime: string;
  textContent?: string;
  dataUrl?: string;
}
