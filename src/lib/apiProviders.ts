import type { AppSettings, ProviderConfig } from "../types";

export interface ApiProvider {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  apiKeyHint: string;
  apiKeyUrl: string;
  thinkingSupport?: boolean;
}

export const DEEPSEEK_PROVIDER: ApiProvider = {
  id: "deepseek",
  label: "DeepSeek API",
  baseUrl: "https://api.deepseek.com",
  defaultModel: "deepseek-v4-flash",
  models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  apiKeyHint: "在 https://platform.deepseek.com/api_keys 创建",
  apiKeyUrl: "https://platform.deepseek.com/api_keys",
  thinkingSupport: true,
};

/** OpenCode Go 订阅（opencode.ai/docs/go），OpenAI 兼容，/v1/models 可自动识别。 */
export const OPENCODE_GO_PROVIDER: ApiProvider = {
  id: "opencode-go",
  label: "OpenCode Go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  defaultModel: "deepseek-v4-flash",
  models: [
    "glm-5.3",
    "glm-5.2",
    "glm-5.1",
    "kimi-k3",
    "kimi-k2.7-code",
    "kimi-k2.6",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "hy3",
  ],
  apiKeyHint: "OpenCode Zen 订阅 Go 后复制 API Key",
  apiKeyUrl: "https://opencode.ai/zen",
  thinkingSupport: false,
};

/** 内置供应商预设（添加供应商时的选项）。 */
export const BUILTIN_PROVIDERS: ApiProvider[] = [
  DEEPSEEK_PROVIDER,
  OPENCODE_GO_PROVIDER,
];

export function providerToConfig(
  provider: ApiProvider,
  apiKey = "",
): ProviderConfig {
  return {
    id: provider.id,
    label: provider.label,
    baseUrl: provider.baseUrl,
    apiKey,
    model: provider.defaultModel,
    models: [...provider.models],
    thinkingSupport: provider.thinkingSupport,
  };
}

export function providerForId(id: string | undefined): ApiProvider {
  return (
    BUILTIN_PROVIDERS.find((provider) => provider.id === id) ??
    DEEPSEEK_PROVIDER
  );
}

/** 当前激活的供应商配置（来自 settings.providers，按 apiProvider 匹配）。 */
export function activeProvider(settings: AppSettings): ProviderConfig {
  const providers = settings.providers;
  if (providers?.length) {
    const found = providers.find(
      (provider) => provider.id === settings.apiProvider,
    );
    if (found) return found;
    return providers[0];
  }
  return providerToConfig(DEEPSEEK_PROVIDER, settings.apiKey);
}

export function getProvider(settingsOrId?: AppSettings | string): ApiProvider {
  if (!settingsOrId) return DEEPSEEK_PROVIDER;
  if (typeof settingsOrId === "string") return providerForId(settingsOrId);
  return providerForId(activeProvider(settingsOrId).id);
}

export function defaultRecentModels(): string[] {
  return [DEEPSEEK_PROVIDER.defaultModel];
}

export function contextLimitForModel(model: string): number {
  const name = model.toLowerCase();
  if (name.includes("v4")) return 1_000_000;
  if (name.includes("reasoner")) return 128_000;
  if (name.includes("deepseek")) return 64_000;
  if (name.includes("kimi")) return 128_000;
  return 128_000;
}

export function modelSupportsThinking(model: string): boolean {
  const name = model.toLowerCase();
  return name.includes("reasoner") || name.includes("v4");
}

/** Official Chat Completions `reasoning_effort` values for the selected model. */
export type ReasoningEffort = "low" | "high" | "max";

/**
 * From DeepSeek Create Chat Completion docs:
 * flash supports low/high/max; pro currently high/max (low treated as high).
 */
export function reasoningEffortsForModel(model: string): ReasoningEffort[] {
  const name = model.toLowerCase();
  if (!modelSupportsThinking(name)) return [];
  if (name.includes("pro")) return ["high", "max"];
  if (name.includes("flash")) return ["low", "high", "max"];
  if (name.includes("v4")) return ["low", "high", "max"];
  return ["high", "max"];
}

export function defaultReasoningEffortForModel(model: string): ReasoningEffort {
  const levels = reasoningEffortsForModel(model);
  if (levels.includes("high")) return "high";
  return levels[0] ?? "high";
}

/** Map compatibility aliases per DeepSeek docs. */
export function normalizeReasoningEffort(
  value: string | undefined,
  model: string,
): ReasoningEffort {
  const levels = reasoningEffortsForModel(model);
  let effort: ReasoningEffort = "high";
  if (value === "low" || value === "high" || value === "max") {
    effort = value;
  } else if (value === "medium") {
    effort = "high";
  } else if (value === "xhigh") {
    effort = "max";
  }
  if (levels.includes(effort)) return effort;
  return defaultReasoningEffortForModel(model);
}

export function resolveModel(settings: AppSettings): string {
  const provider = activeProvider(settings);
  const model = provider.model?.trim();
  if (model) return model;
  return providerForId(provider.id).defaultModel;
}

export interface PooledModel {
  id: string;
  providerId: string;
  providerLabel: string;
}

/** 跨供应商合并模型池：各供应商 enabledModels/models 的并集，同名以供应商区分。 */
export function mergedModelPool(settings: AppSettings): PooledModel[] {
  const pool: PooledModel[] = [];
  const seen = new Set<string>();
  for (const provider of settings.providers ?? []) {
    const enabled = provider.enabledModels;
    const candidates = enabled && enabled.length ? enabled : provider.models;
    for (const model of candidates ?? []) {
      const id = model.trim();
      if (!id) continue;
      const key = `${provider.id}\u0000${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push({
        id,
        providerId: provider.id,
        providerLabel: provider.label,
      });
    }
  }
  return pool;
}

/** 某供应商模型是否勾选启用。 */
export function isModelEnabled(
  provider: { enabledModels?: string[]; models: string[] },
  model: string,
): boolean {
  if (provider.enabledModels && provider.enabledModels.length) {
    return provider.enabledModels.includes(model);
  }
  return provider.models.includes(model);
}

/** 当前供应商是否支持图片输入。 */
export function providerSupportsVision(settings?: AppSettings): boolean {
  void settings;
  return false;
}
