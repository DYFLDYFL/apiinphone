import type { AppSettings } from "../types";

export interface ApiProvider {
  id: "poe" | "deepseek";
  label: string;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  apiKeyHint: string;
  apiKeyUrl: string;
  usePoeHeaders: boolean;
}

export const PROVIDERS: Record<string, ApiProvider> = {
  poe: {
    id: "poe",
    label: "Poe API",
    baseUrl: "https://api.poe.com/v1",
    defaultModel: "Claude-Sonnet-4.5",
    models: [
      "Claude-Sonnet-4.5",
      "GPT-4o",
      "Gemini-3.0-Pro",
      "Claude-Opus-4.8",
      "GPT-Image-2",
    ],
    apiKeyHint: "在 https://poe.com/api_key 创建",
    apiKeyUrl: "https://poe.com/api_key",
    usePoeHeaders: true,
  },
  deepseek: {
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
    usePoeHeaders: false,
  },
};

export const PROVIDER_ORDER: Array<"poe" | "deepseek"> = ["deepseek", "poe"];

const MODEL_PRESETS: Record<string, string> = {
  flash: "deepseek-v4-flash",
  pro: "deepseek-v4-pro",
};

export function defaultRecentModels(): string[] {
  const models: string[] = [];
  for (const pid of PROVIDER_ORDER) {
    models.push(...PROVIDERS[pid].models);
  }
  return [...new Set(models)];
}

export function getProvider(providerId: string): ApiProvider {
  return PROVIDERS[providerId] ?? PROVIDERS.deepseek;
}

export function inferProviderId(
  baseUrl: string,
  saved = "",
): "poe" | "deepseek" {
  if (saved in PROVIDERS) return saved as "poe" | "deepseek";
  const url = baseUrl.toLowerCase();
  if (url.includes("deepseek")) return "deepseek";
  if (url.includes("poe")) return "poe";
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

export function resolveModel(settings: AppSettings): string {
  if (
    settings.apiProvider === "deepseek" &&
    settings.modelPreset in MODEL_PRESETS
  ) {
    return MODEL_PRESETS[settings.modelPreset];
  }
  return settings.model;
}

export function providerSupportsVision(settings: AppSettings): boolean {
  return settings.apiProvider === "poe";
}

export function applyProviderPreset(
  settings: AppSettings,
  providerId: "poe" | "deepseek",
): AppSettings {
  const provider = getProvider(providerId);
  return {
    ...settings,
    apiProvider: providerId,
    baseUrl: provider.baseUrl,
    model: provider.defaultModel,
    modelPreset: providerId === "deepseek" ? "flash" : "custom",
  };
}
