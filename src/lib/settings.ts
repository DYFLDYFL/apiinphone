import { Preferences } from "@capacitor/preferences";
import type { AppSettings } from "../types";
import {
  defaultRecentModels,
  inferProviderId,
  resolveModel,
} from "./apiProviders";

const SETTINGS_KEY = "settings";

export const DEFAULT_SETTINGS: AppSettings = {
  apiProvider: "deepseek",
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  modelPreset: "flash",
  temperature: 0.7,
  maxTokens: 4096,
  stream: true,
  showThinking: true,
  thinkingMode: "enabled",
  reasoningEffort: "high",
  toolsEnabled: true,
  toolsWebSearch: true,
  toolsPythonSandbox: true,
  pythonSandboxTimeout: 15,
  webSearchEngine: "bing_cn",
  webSearchEndpoint: "http://localhost:8080",
  webSearchMetasoKey: "",
  webSearchBaiduKey: "",
  toolsCustomJson: "",
  httpConnectTimeout: 15,
  httpReadTimeout: 120,
  retryCount: 2,
  retryBackoffMs: 1000,
  systemPrompt:
    "你是一个有帮助的助手。回答可使用 Markdown、LaTeX（$...$ 或 $$...$$）以及图片链接。\n" +
    "用户可通过附件发送文件；正文已嵌入在当前用户消息中，请直接阅读并回答，" +
    "不要声称无法访问这些附件。内置 Tool 不能读写本地磁盘，但附件内容已经提供给你。",
  httpReferer: "https://apiinphone.local",
  appTitle: "AI API Client",
  theme: "light",
  recentModels: defaultRecentModels(),
};

export function effectiveModel(settings: AppSettings): string {
  return resolveModel(settings);
}

export function thinkingActive(settings: AppSettings): boolean {
  if (settings.thinkingMode !== "enabled") return false;
  if (settings.apiProvider !== "deepseek") return false;
  const model = effectiveModel(settings).toLowerCase();
  return model.includes("reasoner") || model.includes("v4");
}

export async function loadSettings(): Promise<AppSettings> {
  const { value } = await Preferences.get({ key: SETTINGS_KEY });
  if (!value) return { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(value) as Partial<AppSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...raw };
    merged.apiProvider = inferProviderId(merged.baseUrl, merged.apiProvider);
    if (!merged.recentModels?.length) {
      merged.recentModels = defaultRecentModels();
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await Preferences.set({
    key: SETTINGS_KEY,
    value: JSON.stringify(settings),
  });
}

export function rememberModel(settings: AppSettings, model: string): AppSettings {
  const trimmed = model.trim();
  if (!trimmed) return settings;
  const recent = settings.recentModels.filter((m) => m !== trimmed);
  recent.unshift(trimmed);
  return { ...settings, recentModels: recent.slice(0, 12) };
}
