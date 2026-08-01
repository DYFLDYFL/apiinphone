import { Preferences } from "@capacitor/preferences";
import type { AppSettings } from "../types";
import {
  defaultRecentModels,
  normalizeReasoningEffort,
  resolveModel,
} from "./apiProviders";

const LEGACY_MODEL_PRESETS: Record<string, string> = {
  flash: "deepseek-v4-flash",
  pro: "deepseek-v4-pro",
};

const SETTINGS_KEY = "settings";

/** Default max agent tool loops per user message. */
export const DEFAULT_MAX_TOOL_ROUNDS = 12;

/** Always-on features — no longer exposed as settings toggles. */
const FORCED_ON = {
  stream: true,
  showThinking: true,
  toolsEnabled: true,
  toolsWebSearch: true,
  toolsPythonSandbox: true,
  toolsCustomJson: "",
} as const;

export const DEFAULT_SETTINGS: AppSettings = {
  apiProvider: "deepseek",
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  temperature: 0.7,
  maxTokens: 4096,
  ...FORCED_ON,
  thinkingMode: "enabled",
  reasoningEffort: "high",
  pythonSandboxTimeout: 15,
  maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
  webSearchEngine: "bing_cn",
  webSearchEndpoint: "",
  webSearchMetasoKey: "",
  webSearchBaiduKey: "",
  webSearchDefaultTopK: 8,
  webSearchMaxTopK: 20,
  httpConnectTimeout: 15,
  httpReadTimeout: 120,
  retryCount: 2,
  retryBackoffMs: 1000,
  systemPrompt:
    "时效问题先 get_current_time 再 web_search；引用搜索结果只用 [1][2]…。",
  appTitle: "AI API Client",
  theme: "light",
  recentModels: defaultRecentModels(),
  exportLocation: "documents",
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
  const n = Number(settings.webSearchMaxTopK ?? 20);
  if (Number.isNaN(n)) return 20;
  return Math.min(30, Math.max(1, Math.round(n)));
}

export function effectiveWebSearchDefaultTopK(settings: AppSettings): number {
  const max = effectiveWebSearchMaxTopK(settings);
  const n = Number(settings.webSearchDefaultTopK ?? 8);
  if (Number.isNaN(n)) return Math.min(8, max);
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
    // Drop legacy Poe (and any other) provider; always DeepSeek.
    merged.apiProvider = "deepseek";
    if (
      !merged.baseUrl?.trim() ||
      merged.baseUrl.toLowerCase().includes("poe.com")
    ) {
      merged.baseUrl = DEFAULT_SETTINGS.baseUrl;
    }
    if (!merged.recentModels?.length) {
      merged.recentModels = defaultRecentModels();
    }
    merged.webSearchMaxTopK = effectiveWebSearchMaxTopK(merged);
    merged.webSearchDefaultTopK = effectiveWebSearchDefaultTopK(merged);
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
