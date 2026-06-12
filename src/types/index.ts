export interface AppSettings {
  apiProvider: "poe" | "deepseek";
  apiKey: string;
  baseUrl: string;
  model: string;
  modelPreset: "flash" | "pro" | "custom";
  temperature: number;
  maxTokens: number | null;
  stream: boolean;
  showThinking: boolean;
  thinkingMode: "enabled" | "disabled";
  reasoningEffort: "high" | "max";
  toolsEnabled: boolean;
  toolsWebSearch: boolean;
  toolsPythonSandbox: boolean;
  pythonSandboxTimeout: number;
  maxToolRounds: number;
  webSearchEngine: string;
  webSearchEndpoint: string;
  webSearchMetasoKey: string;
  webSearchBaiduKey: string;
  /** Default result count per web_search when model omits topK. */
  webSearchDefaultTopK: number;
  /** Maximum topK allowed per web_search call. */
  webSearchMaxTopK: number;
  toolsCustomJson: string;
  httpConnectTimeout: number;
  httpReadTimeout: number;
  retryCount: number;
  retryBackoffMs: number;
  systemPrompt: string;
  httpReferer: string;
  appTitle: string;
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
}

export interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  toolTrace?: ToolTraceItem[] | string;
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
