import { Preferences } from "@capacitor/preferences";
import type { AppSettings } from "../types";
import {
  DEEPSEEK_PROVIDER,
  defaultRecentModels,
  normalizeReasoningEffort,
  providerToConfig,
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
  maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
  webSearchDefaultTopK: DEFAULT_WEB_SEARCH_TOP_K,
  webSearchMaxTopK: DEFAULT_WEB_SEARCH_MAX_TOP_K,
  temperature: 0.7,
} as const;

export const DEFAULT_SETTINGS: AppSettings = {
  apiProvider: "deepseek",
  providers: [providerToConfig(DEEPSEEK_PROVIDER)],
  apiKey: "",
  baseUrl: DEEPSEEK_PROVIDER.baseUrl,
  webSearchEnabled: false,
  gameWebSearchEnabled: false,
  gameAutoDelegateAi: false,
  model: "deepseek-v4-flash",
  gameModel: "deepseek-v4-flash",
  workspaceModel: "deepseek-v4-flash",
  workspaceProviderId: "deepseek",
  maxTokens: null,
  contextCompressThreshold: 80,
  ...FORCED_ON,
  thinkingMode: "enabled",
  reasoningEffort: "high",
  gameThinkingMode: "enabled",
  gameReasoningEffort: "high",
  workspaceThinkingMode: "enabled",
  workspaceReasoningEffort: "high",
  pythonSandboxTimeout: 15,
  webSearchEngine: "mojeek",
  webSearchEndpoint: "",
  webSearchMetasoKey: "",
  webSearchBaiduKey: "",
  webSearchExaKey: "",
  httpConnectTimeout: 15,
  httpReadTimeout: 120,
  retryCount: 2,
  retryBackoffMs: 1000,
  systemPrompt:
    "时效问题先 get_current_time 再 web_search；引用搜索结果只用 [1][2]…。",
  theme: "light",
  recentModels: defaultRecentModels(),
  lastView: "chat",
  githubToken: "",
};

function applyForcedOn(settings: AppSettings): AppSettings {
  return { ...settings, ...FORCED_ON };
}

export function effectiveModel(settings: AppSettings): string {
  return resolveModel(settings);
}

/**
 * 会话级模型覆写：对话若记录了独立模型（session.model / providerId），
 * 返回覆写后的设置视图，供请求与顶栏显示统一使用；否则原样返回。
 */
export function sessionEffectiveSettings(
  settings: AppSettings | null,
  session: { model?: string; providerId?: string } | null | undefined,
): AppSettings | null {
  if (!settings) return null;
  const model = session?.model?.trim();
  const providerId = session?.providerId?.trim();
  if (!model) return settings;
  const target =
    settings.providers?.find((item) => item.id === providerId) ??
    settings.providers?.find((item) => item.id === settings.apiProvider) ??
    settings.providers?.[0];
  if (!target) return settings;
  return {
    ...settings,
    apiProvider: target.id,
    apiKey: target.apiKey,
    baseUrl: target.baseUrl,
    model,
    providers: settings.providers.map((item) =>
      item.id === target.id ? { ...item, model } : item,
    ),
  };
}

/** Settings view used for game completions (independent model fields). Always official API. */
export function settingsForGame(settings: AppSettings): AppSettings {
  const gameModel =
    settings.gameModel?.trim() ||
    settings.model?.trim() ||
    DEEPSEEK_PROVIDER.defaultModel;
  return {
    ...settings,
    model: gameModel,
    providers: settings.providers?.map((provider) =>
      provider.id === settings.apiProvider
        ? { ...provider, model: gameModel }
        : provider,
    ),
    thinkingMode: settings.gameThinkingMode ?? settings.thinkingMode,
    reasoningEffort: normalizeReasoningEffort(
      settings.gameReasoningEffort ?? settings.reasoningEffort,
      gameModel,
    ),
    webSearchEnabled: Boolean(
      settings.gameWebSearchEnabled ?? settings.webSearchEnabled,
    ),
  };
}

export function effectiveGameModel(settings: AppSettings): string {
  return resolveModel(settingsForGame(settings));
}

/** 工作区模式设置视图：独立模型/供应商/思考档位，供应商配置沿用全局 providers。 */
export function settingsForWorkspace(settings: AppSettings): AppSettings {
  const workspaceModel =
    settings.workspaceModel?.trim() ||
    settings.model?.trim() ||
    DEEPSEEK_PROVIDER.defaultModel;
  const providerId =
    settings.workspaceProviderId?.trim() || settings.apiProvider || "deepseek";
  const target =
    settings.providers?.find((item) => item.id === providerId) ??
    settings.providers?.[0] ??
    settings.providers?.find((item) => item.id === settings.apiProvider);
  const provider = target ?? providerToConfig(DEEPSEEK_PROVIDER);
  return {
    ...settings,
    apiProvider: provider.id,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    model: workspaceModel,
    providers: settings.providers?.map((item) =>
      item.id === provider.id ? { ...item, model: workspaceModel } : item,
    ),
    thinkingMode: settings.workspaceThinkingMode ?? settings.thinkingMode,
    reasoningEffort: normalizeReasoningEffort(
      settings.workspaceReasoningEffort ?? settings.reasoningEffort,
      workspaceModel,
    ),
  };
}

export function effectiveWorkspaceModel(settings: AppSettings): string {
  return resolveModel(settingsForWorkspace(settings));
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
    // 多供应商迁移：旧版本只有 apiKey/baseUrl/model（无 providers）。
    if (!merged.providers?.length) {
      merged.providers = [
        {
          id: "deepseek",
          label: DEEPSEEK_PROVIDER.label,
          baseUrl: merged.baseUrl || DEEPSEEK_PROVIDER.baseUrl,
          apiKey: merged.apiKey ?? "",
          model: merged.model || DEEPSEEK_PROVIDER.defaultModel,
          models: [...DEEPSEEK_PROVIDER.models],
          thinkingSupport: true,
        },
      ];
      merged.apiProvider = "deepseek";
    } else {
      // 迁移后 apiKey/baseUrl/model 与 active provider 同步，供旧调用兼容。
      const active = merged.providers.find(
        (provider) => provider.id === merged.apiProvider,
      );
      if (active) {
        merged.apiKey = active.apiKey;
        merged.baseUrl = active.baseUrl;
        merged.model = active.model;
      }
      merged.apiProvider = active
        ? active.id
        : merged.providers[0].id;
    }
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
    if (!merged.gameModel?.trim()) {
      merged.gameModel = merged.model;
    }
    if (
      merged.gameThinkingMode !== "enabled" &&
      merged.gameThinkingMode !== "disabled"
    ) {
      merged.gameThinkingMode = merged.thinkingMode;
    }
    merged.gameReasoningEffort = normalizeReasoningEffort(
      merged.gameReasoningEffort ?? merged.reasoningEffort,
      merged.gameModel,
    );
    if (!merged.workspaceModel?.trim()) {
      merged.workspaceModel = merged.model;
    }
    if (!merged.workspaceProviderId?.trim()) {
      merged.workspaceProviderId = merged.apiProvider;
    }
    if (
      merged.workspaceThinkingMode !== "enabled" &&
      merged.workspaceThinkingMode !== "disabled"
    ) {
      merged.workspaceThinkingMode = merged.thinkingMode;
    }
    merged.workspaceReasoningEffort = normalizeReasoningEffort(
      merged.workspaceReasoningEffort ?? merged.reasoningEffort,
      merged.workspaceModel,
    );
    merged.webSearchEnabled = Boolean(merged.webSearchEnabled);
    merged.gameWebSearchEnabled = Boolean(
      merged.gameWebSearchEnabled ?? merged.webSearchEnabled,
    );
    merged.gameAutoDelegateAi = Boolean(merged.gameAutoDelegateAi);
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

export function rememberGameModel(
  settings: AppSettings,
  model: string,
): AppSettings {
  return rememberModel(settings, model);
}
