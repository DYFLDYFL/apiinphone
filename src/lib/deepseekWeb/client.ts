import type { AppSettings, ChatMessage } from "../../types";
import { httpText } from "../nativeHttp";
import {
  effectiveWebChatMode,
  effectiveWebSearchEnabled,
} from "../settings";
import { solvePowChallenge } from "./pow";
import {
  DEEPSEEK_WEB_API,
  DEEPSEEK_WEB_HEADERS,
  type PowChallenge,
  type WebCompletionResult,
} from "./types";

export class DeepseekWebError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** 网页通道软限流（HTTP 200 + SSE/正文提示），需当作 429 重试。 */
export function isWebRateLimitText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/消息发送过于频繁/.test(t)) return true;
  if (/finish_reason["'\s:=]+["']?rate_lim/i.test(t)) return true;
  if (
    /rate[_ ]?lim(?:it)?/i.test(t) &&
    /频繁|稍后重试|too\s*many|try\s*again/i.test(t)
  ) {
    return true;
  }
  return false;
}

function extractUserToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as { value?: unknown };
    if (typeof parsed?.value === "string") return parsed.value.trim();
  } catch {
    /* plain token */
  }
  return trimmed.replace(/^Bearer\s+/i, "");
}

function cookieHeader(settings: AppSettings): string {
  const user = settings.webSessionCookies.trim();
  if (user) return user;
  const ts = Date.now();
  const hex = Array.from({ length: 18 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  return `intercom-HWWAFSESTIME=${ts}; HWWAFSESID=${hex}`;
}

function buildHeaders(
  settings: AppSettings,
  accessToken: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...DEEPSEEK_WEB_HEADERS,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Cookie: cookieHeader(settings),
    ...extra,
  };
  return headers;
}

function clientStreamId(): string {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hex = Math.random().toString(16).slice(2, 18).padEnd(16, "0");
  return `${y}${m}${d}-${hex}`;
}

function messageText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content ?? "");
}

/** Flatten OpenAI-style messages into DeepSeek web single prompt. */
export function messagesToWebPrompt(messages: ChatMessage[]): string {
  const systems: string[] = [];
  const turns: string[] = [];
  for (const msg of messages) {
    const text = messageText(msg.content).trim();
    if (!text) continue;
    if (msg.role === "system") systems.push(text);
    else if (msg.role === "user") turns.push(`User: ${text}`);
    else if (msg.role === "assistant") turns.push(`Assistant: ${text}`);
    else if (msg.role === "tool") turns.push(`Tool: ${text}`);
  }
  const parts: string[] = [];
  if (systems.length) parts.push(systems.join("\n\n"));
  if (turns.length) parts.push(turns.join("\n\n"));
  return parts.join("\n\n").trim();
}

function bizData(json: Record<string, unknown>): Record<string, unknown> | null {
  const data = json.data as Record<string, unknown> | undefined;
  const nested = (data?.biz_data ?? json.biz_data) as
    | Record<string, unknown>
    | undefined;
  return nested && typeof nested === "object" ? nested : null;
}

function assertBizOk(json: Record<string, unknown>, label: string): void {
  const code = Number(json.code ?? 0);
  if (code !== 0) {
    const data = json.data as Record<string, unknown> | undefined;
    const msg = String(
      json.msg ?? data?.biz_msg ?? `${label} 失败 (code ${code})`,
    );
    throw new DeepseekWebError(msg, code === 401 ? 401 : undefined);
  }
}

async function postJson(
  settings: AppSettings,
  path: string,
  body: unknown,
  accessToken: string,
  timeoutMs: number,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const { status, text } = await httpText(
    `${DEEPSEEK_WEB_API}${path}`,
    {
      method: "POST",
      headers: buildHeaders(settings, accessToken, extraHeaders),
      body: JSON.stringify(body ?? {}),
      signal,
    },
    timeoutMs,
  );
  if (status === 401 || status === 403) {
    throw new DeepseekWebError(
      "网页会话 Token 无效或已过期，请从 chat.deepseek.com 重新复制。",
      status,
    );
  }
  if (status === 429) {
    throw new DeepseekWebError(
      "消息发送过于频繁，稍后自动重试…",
      status,
    );
  }
  if (status < 200 || status >= 300) {
    const snippet = text.slice(0, 180);
    if (/just a moment|cloudflare|waf/i.test(snippet)) {
      throw new DeepseekWebError(
        "触发 WAF/人机验证，请更新浏览器 Cookie（含 aws-waf-token）后重试。",
        status,
      );
    }
    throw new DeepseekWebError(`网页通道错误 (${status})：${snippet}`, status);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new DeepseekWebError(`网页通道返回非 JSON：${text.slice(0, 120)}`);
  }
}

async function createSession(
  settings: AppSettings,
  accessToken: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const json = await postJson(
    settings,
    "/v0/chat_session/create",
    {},
    accessToken,
    timeoutMs,
    signal,
  );
  assertBizOk(json, "创建会话");
  const biz = bizData(json);
  const session = biz?.chat_session as Record<string, unknown> | undefined;
  const id = String(session?.id ?? biz?.id ?? "");
  if (!id) throw new DeepseekWebError("创建网页会话失败：未返回 session id");
  return id;
}

async function fetchPowChallenge(
  settings: AppSettings,
  accessToken: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PowChallenge> {
  const json = await postJson(
    settings,
    "/v0/chat/create_pow_challenge",
    { target_path: "/api/v0/chat/completion" },
    accessToken,
    timeoutMs,
    signal,
  );
  assertBizOk(json, "PoW");
  const biz = bizData(json);
  const challenge = biz?.challenge as PowChallenge | undefined;
  if (!challenge?.challenge || !challenge.algorithm) {
    throw new DeepseekWebError("未获取到 PoW challenge");
  }
  return challenge;
}

function isWebStatusToken(v: string): boolean {
  const t = v.trim();
  return (
    t === "FINISHED" ||
    t === "FINISHED_WITH_ERROR" ||
    t === "[DONE]" ||
    t === "DONE"
  );
}

function parseSsePayload(text: string): WebCompletionResult {
  let content = "";
  let reasoning = "";
  let currentPath: "thinking" | "content" | "" = "";
  /** SSE 当前 APPEND 目标路径（与官网流一致）。 */
  let activeAppendPath = "";

  const append = (raw: string) => {
    if (!raw || isWebStatusToken(raw)) return;
    if (currentPath === "thinking") reasoning += raw;
    else content += raw;
  };

  const handleFragment = (frag: Record<string, unknown>) => {
    const type = String(frag.type ?? "").toUpperCase();
    if (type === "THINK") currentPath = "thinking";
    else if (type === "ANSWER" || type === "RESPONSE") currentPath = "content";
    if (typeof frag.content === "string" && frag.content) {
      append(frag.content);
    }
  };

  const pathIsContent = (path: string) =>
    path.endsWith("/content") || /fragments\/-?\d+\/content$/.test(path);

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const p = typeof data.p === "string" ? data.p : "";
    const v = data.v;

    if (v && typeof v === "object" && !Array.isArray(v)) {
      const response = (v as Record<string, unknown>).response as
        | Record<string, unknown>
        | undefined;
      if (response) {
        if (response.thinking_enabled === true) currentPath = "thinking";
        else if (response.thinking_enabled === false) currentPath = "content";
        const fragments = response.fragments;
        if (Array.isArray(fragments)) {
          for (const frag of fragments) {
            if (frag && typeof frag === "object") {
              handleFragment(frag as Record<string, unknown>);
            }
          }
        }
      }
      continue;
    }

    if (p === "response/fragments") {
      if (Array.isArray(v)) {
        for (const frag of v) {
          if (frag && typeof frag === "object") {
            handleFragment(frag as Record<string, unknown>);
          }
        }
      } else if (v && typeof v === "object") {
        handleFragment(v as Record<string, unknown>);
      }
      continue;
    }

    if (p) {
      activeAppendPath = p;
      if (p.includes("thinking") || p.endsWith("/thinking_content")) {
        currentPath = "thinking";
      } else if (pathIsContent(p)) {
        currentPath = "content";
      }
    }

    // status / 其它元数据绝不能进正文
    if (p === "response/status" || p.endsWith("/status")) continue;
    if (typeof v === "string" && isWebStatusToken(v)) continue;

    if (typeof v === "string") {
      if (p && pathIsContent(p)) {
        append(v);
      } else if (!p && activeAppendPath && pathIsContent(activeAppendPath)) {
        // 路径已在上一帧设定，本帧仅 APPEND 字符串
        append(v);
      }
    }
  }

  return {
    content: stripWebTailNoise(content),
    reasoning: stripWebTailNoise(reasoning),
  };
}

/** 去掉误拼进正文的流结束标记。 */
export function stripWebTailNoise(text: string): string {
  return text
    .replace(/(?:\r?\n)?\s*FINISHED(?:_WITH_ERROR)?\s*$/gi, "")
    .replace(/(?:\r?\n)?\s*\[DONE\]\s*$/g, "")
    .trimEnd();
}

async function pumpText(
  text: string,
  onChunk?: (delta: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!onChunk || !text) return;
  const step = Math.max(1, Math.min(24, Math.ceil(text.length / 64)));
  for (let i = 0; i < text.length; i += step) {
    if (signal?.aborted) {
      onChunk(text.slice(i));
      return;
    }
    onChunk(text.slice(i, i + step));
    await new Promise((r) => setTimeout(r, 8));
  }
}

/**
 * One-shot chat via chat.deepseek.com (native HTTP to bypass CORS).
 * Tools are not supported on this transport.
 */
export async function completeViaDeepseekWeb(
  settings: AppSettings,
  messages: ChatMessage[],
  options?: {
    onDelta?: (text: string) => void;
    onReasoningDelta?: (text: string) => void;
    signal?: AbortSignal;
  },
): Promise<WebCompletionResult> {
  const userToken = extractUserToken(settings.webSessionToken);
  if (!userToken) {
    throw new DeepseekWebError("请先在设置中粘贴 chat.deepseek.com 的网页会话 Token");
  }

  const timeoutMs = Math.max(
    30000,
    (settings.httpReadTimeout || 120) * 1000,
  );
  const signal = options?.signal;
  const accessToken = userToken;

  const sessionId = await createSession(
    settings,
    accessToken,
    timeoutMs,
    signal,
  );
  const challenge = await fetchPowChallenge(
    settings,
    accessToken,
    timeoutMs,
    signal,
  );
  const powHeader = await solvePowChallenge({
    ...challenge,
    target_path: challenge.target_path || "/api/v0/chat/completion",
  });

  const prompt = messagesToWebPrompt(messages);
  if (!prompt) throw new DeepseekWebError("消息为空，无法发送");

  const mode = effectiveWebChatMode(settings);
  const thinking = mode === "deep" || mode === "expert";
  const search = effectiveWebSearchEnabled(settings);
  const body: Record<string, unknown> = {
    chat_session_id: sessionId,
    parent_message_id: null,
    prompt,
    ref_file_ids: [] as string[],
    thinking_enabled: thinking,
    search_enabled: search,
    // Instant=default；专家=expert（社区逆向与 DeadBranches 一致）
    model_type: mode === "expert" ? "expert" : "default",
    client_stream_id: clientStreamId(),
  };

  const { status, text } = await httpText(
    `${DEEPSEEK_WEB_API}/v0/chat/completion`,
    {
      method: "POST",
      headers: buildHeaders(settings, accessToken, {
        "x-ds-pow-response": powHeader,
        ...(thinking ? { "x-thinking-enabled": "1" } : {}),
      }),
      body: JSON.stringify(body),
      signal,
    },
    timeoutMs,
  );

  if (status === 401 || status === 403) {
    throw new DeepseekWebError(
      "网页会话 Token 无效或已过期，请从 chat.deepseek.com 重新复制。",
      status,
    );
  }
  if (status === 429) {
    throw new DeepseekWebError(
      "消息发送过于频繁，稍后自动重试…",
      status,
    );
  }
  if (status < 200 || status >= 300) {
    throw new DeepseekWebError(
      `网页补全失败 (${status})：${text.slice(0, 200)}`,
      status,
    );
  }

  if (isWebRateLimitText(text)) {
    throw new DeepseekWebError("消息发送过于频繁，稍后自动重试…", 429);
  }

  // Prefer SSE parse; fall back to JSON content fields.
  let result = parseSsePayload(text);
  if (!result.content && !result.reasoning) {
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      assertBizOk(json, "补全");
      const biz = bizData(json);
      result = {
        content: String(biz?.content ?? biz?.response ?? ""),
        reasoning: String(biz?.reasoning ?? ""),
      };
    } catch {
      // 勿把整段 SSE（event:/data:）当正文，否则会污染时间线
      if (/^\s*event\s*:/m.test(text) || /(^|\n)data\s*:/.test(text)) {
        throw new DeepseekWebError(
          "网页通道返回无法解析的流式响应，请稍后重试。",
          502,
        );
      }
      if (text.trim()) result = { content: text.trim(), reasoning: "" };
    }
  }

  if (
    isWebRateLimitText(result.content) ||
    isWebRateLimitText(result.reasoning)
  ) {
    throw new DeepseekWebError("消息发送过于频繁，稍后自动重试…", 429);
  }

  if (!result.content.trim() && !result.reasoning.trim()) {
    throw new DeepseekWebError("网页通道返回空内容，请稍后重试。", 502);
  }

  await pumpText(result.reasoning, options?.onReasoningDelta, signal);
  await pumpText(result.content, options?.onDelta, signal);
  return result;
}

/** Lightweight probe for Settings「测试连接」. */
export async function testDeepseekWebConnection(
  settings: AppSettings,
): Promise<string> {
  const result = await completeViaDeepseekWeb(settings, [
    { role: "user", content: "请只回复：ok" },
  ]);
  return (result.content || result.reasoning || "").trim() || "连接成功（空回复）";
}
