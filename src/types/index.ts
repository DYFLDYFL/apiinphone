export interface AppSettings {
  apiProvider: "deepseek";
  apiKey: string;
  baseUrl: string;
  /** 对话网页联网搜索。 */
  webSearchEnabled: boolean;
  /** 游戏网页联网搜索。 */
  gameWebSearchEnabled: boolean;
  /** 扮演时默认本轮交给 AI，无需每次点按钮。 */
  gameAutoDelegateAi: boolean;
  model: string;
  /** 游戏模式独立模型（与对话 model 分离）。 */
  gameModel: string;
  temperature: number;
  maxTokens: number | null;
  stream: boolean;
  showThinking: boolean;
  thinkingMode: "enabled" | "disabled";
  reasoningEffort: "low" | "high" | "max";
  /** 游戏模式独立思考开关。 */
  gameThinkingMode: "enabled" | "disabled";
  /** 游戏模式独立推理档位。 */
  gameReasoningEffort: "low" | "high" | "max";
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
  role: "user" | "assistant";
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
