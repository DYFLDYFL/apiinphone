import type { AppSettings } from "../types";

export interface ApiProvider {
  id: "deepseek";
  label: string;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  apiKeyHint: string;
  apiKeyUrl: string;
}

export const DEEPSEEK_PROVIDER: ApiProvider = {
  id: "deepseek",
  label: "DeepSeek API",
  baseUrl: "https://api.deepseek.com",
  defaultModel: "deepseek-v4-flash",
  models: [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-chat",
    "deepseek-reasoner",
  ],
  apiKeyHint: "在 https://platform.deepseek.com/api_keys 创建",
  apiKeyUrl: "https://platform.deepseek.com/api_keys",
};

/** @deprecated Use DEEPSEEK_PROVIDER; kept for call sites that keyed by id. */
export const PROVIDERS: Record<"deepseek", ApiProvider> = {
  deepseek: DEEPSEEK_PROVIDER,
};

export function defaultRecentModels(): string[] {
  return [DEEPSEEK_PROVIDER.defaultModel];
}

export function getProvider(_providerId?: string): ApiProvider {
  return DEEPSEEK_PROVIDER;
}

/** Normalize legacy saved provider ids (e.g. poe) to deepseek. */
export function inferProviderId(
  _baseUrl?: string,
  _saved?: string,
): "deepseek" {
  return "deepseek";
}

export function contextLimitForModel(model: string): number {
  const name = model.toLowerCase();
  if (name.includes("v4")) return 1_000_000;
  if (name.includes("reasoner")) return 128_000;
  if (name.includes("deepseek")) return 64_000;
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
  const model = settings.model?.trim();
  if (model) return model;
  return DEEPSEEK_PROVIDER.defaultModel;
}

/** DeepSeek chat API does not accept image inputs. */
export function providerSupportsVision(_settings?: AppSettings): boolean {
  return false;
}

export function applyDeepSeekPreset(settings: AppSettings): AppSettings {
  return {
    ...settings,
    apiProvider: "deepseek",
    baseUrl: DEEPSEEK_PROVIDER.baseUrl,
    model: settings.model?.trim() || DEEPSEEK_PROVIDER.defaultModel,
  };
}
