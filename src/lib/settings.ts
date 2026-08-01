import { Preferences } from "@capacitor/preferences";
import type { AppSettings } from "../types";
import {
  DEEPSEEK_PROVIDER,
  defaultRecentModels,
  normalizeReasoningEffort,
  resolveModel,
} from "./apiProviders";

const LEGACY_MODEL_PRESETS: Record<string, string> = {
  flash: "deepseek-v4-flash",
  pro: "deepseek-v4-pro",
};

const SETTINGS_KEY = "settings";

/** Default max agent tool loops per user message (not user-configurable). */
export const DEFAULT_MAX_TOOL_ROUNDS = 12;

const DEFAULT_WEB_SEARCH_TOP_K = 8;
const DEFAULT_WEB_SEARCH_MAX_TOP_K = 20;

/** Always-on / fixed features — not exposed as settings. */
const FORCED_ON = {
  stream: true,
  showThinking: true,
  toolsEnabled: true,
  toolsWebSearch: true,
  toolsPythonSandbox: true,
  toolsCustomJson: "",
  baseUrl: DEEPSEEK_PROVIDER.baseUrl,
  exportLocation: "documents" as const,
  maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
  webSearchDefaultTopK: DEFAULT_WEB_SEARCH_TOP_K,
  webSearchMaxTopK: DEFAULT_WEB_SEARCH_MAX_TOP_K,
  temperature: 0.7,
} as const;

export const DEFAULT_SETTINGS: AppSettings = {
  apiProvider: "deepseek",
  apiKey: "",
  model: "deepseek-v4-flash",
  maxTokens: null,
  ...FORCED_ON,
  thinkingMode: "enabled",
  reasoningEffort: "high",
  pythonSandboxTimeout: 15,
  webSearchEngine: "mojeek",
  webSearchEndpoint: "",
  webSearchMetasoKey: "",
  webSearchBaiduKey: "",
  httpConnectTimeout: 15,
  httpReadTimeout: 120,
  retryCount: 2,
  retryBackoffMs: 1000,
  systemPrompt:
    "时效问题先 get_current_time 再 web_search；引用搜索结果只用 [1][2]…。",
  appTitle: "AI API Client",
  theme: "light",
  recentModels: defaultRecentModels(),
};

function applyForcedOn(settings: AppSettings): AppSettings {
  return { ...settings, ...FORCED_ON };
}

export function effectiveModel(settings: AppSettings): string {
  return resolveModel(settings);
}

export function thinkingActive(settings: AppSettings): boolean {
  if (settings.thinkingMode !== "enabled") return false;
  const model = effectiveModel(settings).toLowerCase();
  return model.includes("reasoner") || model.includes("v4");
}

/** Whether the chat UI should show streamed / stored reasoning (思考链). */
export function thinkingChainVisible(settings: AppSettings): boolean {
  return settings.showThinking && thinkingActive(settings);
}

export function effectiveMaxToolRounds(settings: AppSettings): number {
  const n = Number(settings.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS);
  if (Number.isNaN(n)) return DEFAULT_MAX_TOOL_ROUNDS;
  return Math.min(64, Math.max(1, Math.round(n)));
}

export function effectiveWebSearchMaxTopK(settings: AppSettings): number {
  const n = Number(settings.webSearchMaxTopK ?? DEFAULT_WEB_SEARCH_MAX_TOP_K);
  if (Number.isNaN(n)) return DEFAULT_WEB_SEARCH_MAX_TOP_K;
  return Math.min(30, Math.max(1, Math.round(n)));
}

export function effectiveWebSearchDefaultTopK(settings: AppSettings): number {
  const max = effectiveWebSearchMaxTopK(settings);
  const n = Number(settings.webSearchDefaultTopK ?? DEFAULT_WEB_SEARCH_TOP_K);
  if (Number.isNaN(n)) return Math.min(DEFAULT_WEB_SEARCH_TOP_K, max);
  return Math.min(max, Math.max(1, Math.round(n)));
}

/** Clamp model-requested topK to settings default/max. */
export function resolveWebSearchTopK(
  settings: AppSettings,
  requested?: unknown,
): number {
  const max = effectiveWebSearchMaxTopK(settings);
  const def = effectiveWebSearchDefaultTopK(settings);
  if (requested == null || requested === "") return def;
  const n = Number(requested);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(1, Math.round(n)));
}

/** User prompt + fixed tool-round hint for the model. */
export function composeSystemPrompt(settings: AppSettings): string {
  const rounds = effectiveMaxToolRounds(settings);
  const tip = `工具调用在单次回复内最多 ${rounds} 轮；达到上限后直接作答，不要继续调用工具。`;
  const user = settings.systemPrompt.trim();
  return user ? `${user}\n${tip}` : tip;
}

export async function loadSettings(): Promise<AppSettings> {
  const { value } = await Preferences.get({ key: SETTINGS_KEY });
  if (!value) return { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(value) as Partial<AppSettings> & {
      modelPreset?: string;
    };
    const merged = applyForcedOn({ ...DEFAULT_SETTINGS, ...raw });
    if (!merged.model?.trim() && raw.modelPreset) {
      merged.model =
        LEGACY_MODEL_PRESETS[raw.modelPreset] ?? merged.model;
    }
    merged.apiProvider = "deepseek";
    if (!merged.recentModels?.length) {
      merged.recentModels = defaultRecentModels();
    }
    if (merged.maxTokens != null) {
      const n = Number(merged.maxTokens);
      merged.maxTokens =
        Number.isNaN(n) || n <= 0
          ? null
          : Math.min(384000, Math.max(256, Math.round(n)));
    }
    // Migrate legacy free default; prefer Metaso when a key is already saved.
    if (!merged.webSearchEngine?.trim() || merged.webSearchEngine === "bing_cn") {
      merged.webSearchEngine = merged.webSearchMetasoKey?.trim()
        ? "metaso"
        : "mojeek";
    } else if (
      merged.webSearchMetasoKey?.trim() &&
      (merged.webSearchEngine === "mojeek" ||
        merged.webSearchEngine === "bing_intl" ||
        merged.webSearchEngine === "bing_rss" ||
        merged.webSearchEngine === "duckduckgo" ||
        merged.webSearchEngine === "ddg_api")
    ) {
      merged.webSearchEngine = "metaso";
    }
    merged.reasoningEffort = normalizeReasoningEffort(
      merged.reasoningEffort,
      merged.model,
    );
    return applyForcedOn(merged);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await Preferences.set({
    key: SETTINGS_KEY,
    value: JSON.stringify(applyForcedOn(settings)),
  });
}

export function rememberModel(settings: AppSettings, model: string): AppSettings {
  const trimmed = model.trim();
  if (!trimmed) return settings;
  const recent = settings.recentModels.filter((m) => m !== trimmed);
  recent.unshift(trimmed);
  return { ...settings, recentModels: recent.slice(0, 12) };
}
