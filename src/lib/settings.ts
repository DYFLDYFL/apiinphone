import { Capacitor } from "@capacitor/core";
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
  maxToolRounds: 24,
  webSearchEngine: Capacitor.isNativePlatform() ? "bing_rss" : "bing_cn",
  webSearchEndpoint: "http://localhost:8080",
  webSearchMetasoKey: "",
  webSearchBaiduKey: "",
  webSearchDefaultTopK: 8,
  webSearchMaxTopK: 20,
  toolsCustomJson: "",
  httpConnectTimeout: 15,
  httpReadTimeout: 120,
  retryCount: 2,
  retryBackoffMs: 1000,
  systemPrompt:
    "你是一个有帮助的助手，用 Markdown、LaTeX（$...$ / $$...$$）作答。\n" +
    "涉及新闻、政策、价格、赛事、产品版本等时效信息时：先 get_current_time 获取当前时间，再 web_search 检索网页并对照时间作答，勿仅凭训练数据断言「最新」。\n" +
    "使用 web_search 后，正文引用必须只用方括号编号 [1][2]…（与搜索结果编号一致），不要用 [网站名](链接) 或纯文字来源名；勿在文末重复列出来源列表（界面会自动显示参考来源）。\n" +
    "用户消息中的附件正文已提供，可直接阅读。",
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

/** Whether the chat UI should show streamed / stored reasoning (思考链). */
export function thinkingChainVisible(settings: AppSettings): boolean {
  return settings.showThinking && thinkingActive(settings);
}

export function effectiveMaxToolRounds(settings: AppSettings): number {
  const n = Number(settings.maxToolRounds ?? 24);
  if (Number.isNaN(n)) return 24;
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
    const raw = JSON.parse(value) as Partial<AppSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...raw };
    merged.apiProvider = inferProviderId(merged.baseUrl, merged.apiProvider);
    if (!merged.recentModels?.length) {
      merged.recentModels = defaultRecentModels();
    }
    merged.webSearchMaxTopK = effectiveWebSearchMaxTopK(merged);
    merged.webSearchDefaultTopK = effectiveWebSearchDefaultTopK(merged);
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
