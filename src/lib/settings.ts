import { Preferences } from "@capacitor/preferences";
import type { AppSettings } from "../types";
import {
  defaultRecentModels,
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
  toolsCustomJson: "",
  httpConnectTimeout: 15,
  httpReadTimeout: 120,
  retryCount: 2,
  retryBackoffMs: 1000,
  systemPrompt:
    "你是一个有帮助的助手，用 Markdown、LaTeX（$...$ / $$...$$）作答。\n" +
    "涉及新闻、政策、价格、赛事、产品版本等时效信息时：先 get_current_time 获取当前时间，再 web_search 检索网页并对照时间作答，勿仅凭训练数据断言「最新」。\n" +
    "使用 web_search 后，正文引用必须只用方括号编号 [1][2]…（与搜索结果编号一致），不要用 [网站名](链接) 或纯文字来源名；勿在文末重复列出来源列表（界面会自动显示参考来源）。\n" +
    "用户要求导出、保存、生成文件（txt / Word / PDF / Excalidraw 表格）时，调用 save_document；Excalidraw 用 format=excalidraw 并传 rows 二维数组；保存后提示用户在界面点击「打开」或「发送」。\n" +
    "用户消息中的附件正文已提供，可直接阅读。",
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
