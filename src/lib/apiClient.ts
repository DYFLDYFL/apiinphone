import { Capacitor } from "@capacitor/core";
import type {
  AppSettings,
  ChatMessage,
  ChatResponse,
  DeepSeekBalance,
  TokenUsage,
  ToolCall,
} from "../types";
import { getProvider, modelSupportsThinking, normalizeReasoningEffort, providerSupportsVision, resolveModel } from "./apiProviders";
import { normalizeMessagesForApi } from "./attachments";
import { httpJson, httpStreamText, httpText } from "./nativeHttp";
import { renumberSearchOutput } from "./searchSources";
import { effectiveMaxToolRounds, effectiveModel } from "./settings";
import {
  buildTools,
  executeTool,
  ToolError,
  toolStatusLabel,
  waitingLabel,
  type ToolExecutionResult,
} from "./tools";

export class ApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface StreamControl {
  cancelled: boolean;
  abortController?: AbortController;
  /** Aborted for the whole turn — tool calls and searches included, not just the HTTP stream. */
  signal: AbortSignal;
  cancel(): void;
}

export function createStreamControl(): StreamControl {
  const turn = new AbortController();
  const control: StreamControl = {
    cancelled: false,
    abortController: undefined,
    signal: turn.signal,
    cancel() {
      control.cancelled = true;
      control.abortController?.abort();
      turn.abort();
    },
  };
  return control;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Tool output is replayed in every later round, so uncapped results (search hits,
 * fetched pages, python stdout) compound into the context window.
 */
const MAX_TOOL_RESULT_CHARS = 8000;

function capToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const dropped = text.length - MAX_TOOL_RESULT_CHARS;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n…（内容过长，已截断 ${dropped} 字符）`;
}

/** Accumulate billed tokens across rounds: sum completions; keep last-round prompt/cache. */
function mergeUsage(
  base: TokenUsage | null,
  extra: TokenUsage | null,
): TokenUsage | null {
  if (!base) return extra;
  if (!extra) return base;
  return {
    promptTokens: extra.promptTokens,
    completionTokens: base.completionTokens + extra.completionTokens,
    totalTokens:
      extra.promptTokens + base.completionTokens + extra.completionTokens,
    promptCacheHitTokens: extra.promptCacheHitTokens,
    promptCacheMissTokens: extra.promptCacheMissTokens,
  };
}

function parseUsage(data: Record<string, unknown>): TokenUsage | null {
  const usage = data.usage as Record<string, unknown> | undefined;
  if (!usage) return null;
  const prompt = Number(usage.prompt_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? 0);
  const total = Number(usage.total_tokens ?? 0);
  if (total <= 0 && prompt <= 0 && completion <= 0) return null;
  const details = usage.prompt_tokens_details as
    | Record<string, unknown>
    | undefined;
  const hit =
    Number(usage.prompt_cache_hit_tokens ?? 0) ||
    Number(details?.cached_tokens ?? 0);
  const miss = Number(usage.prompt_cache_miss_tokens ?? 0);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total || prompt + completion,
    promptCacheHitTokens: hit,
    promptCacheMissTokens: miss,
  };
}

function friendlyApiError(err: unknown): ApiError {
  const raw = String(err).toLowerCase();
  if (raw.includes("aborted") || raw.includes("abort")) {
    return new ApiError("已取消");
  }
  if (raw.includes("failed to fetch") || raw.includes("network")) {
    return new ApiError("无法连接 API 服务器，请检查网络或 API 地址。");
  }
  if (
    raw.includes("unknown host") ||
    raw.includes("unable to resolve host") ||
    raw.includes("err_name_not_resolved") ||
    raw.includes("connect timed out") ||
    raw.includes("timeout") ||
    raw.includes("failed to connect") ||
    raw.includes("connection reset") ||
    raw.includes("econnrefused") ||
    raw.includes("connection refused") ||
    raw.includes("cleartext") ||
    raw.includes("ssl")
  ) {
    const detail = String(err).slice(0, 200);
    return new ApiError(`无法连接 API 服务器：${detail}`);
  }
  if (err instanceof ApiError) return err;
  if (err instanceof ToolError) return new ApiError(err.message);
  return new ApiError(String(err));
}

function buildHeaders(settings: AppSettings): Record<string, string> {
  return {
    Authorization: `Bearer ${settings.apiKey.trim()}`,
    "Content-Type": "application/json",
  };
}

/** GET/POST JSON under one deadline that also covers reading the response body. */
async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  errorLabel: string,
): Promise<Record<string, unknown>> {
  if (Capacitor.isNativePlatform()) {
    // 原生平台直走 OkHttp（HTTP/1.1 优先），WebView fetch 无原生降级且跨域不可靠。
    const { status, data } = await httpJson<Record<string, unknown>>(
      url,
      init,
      timeoutMs,
    );
    if (status < 200 || status >= 300) {
      throw new ApiError(`${errorLabel} (${status})`, status);
    }
    return data;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 200);
      throw new ApiError(`${errorLabel} (${resp.status})：${detail}`, resp.status);
    }
    return (await resp.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

function apiRoot(settings: AppSettings): string {
  const url = settings.baseUrl.replace(/\/$/, "");
  return url.endsWith("/v1") ? url.slice(0, -3) : url;
}

function chatUrl(settings: AppSettings): string {
  const base = settings.baseUrl.replace(/\/$/, "");
  const url = base.endsWith("/v1")
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
  return gatewayUrl(url);
}

/**
 * 浏览器模式下把 opencode.ai 直连改写为同源 Vite 代理（绕过 CORS 拦截）；
 * 原生平台（Android OkHttp 回退）不需要，保持直连。
 */
function gatewayUrl(url: string): string {
  if (Capacitor.isNativePlatform()) return url;
  return url.replace("https://opencode.ai", "/go-gateway");
}

function applyThinking(settings: AppSettings, body: Record<string, unknown>) {
  const provider = settings.providers?.find(
    (item) => item.id === settings.apiProvider,
  );
  const supportsThinking = provider?.thinkingSupport ?? false;
  if (!supportsThinking || !modelSupportsThinking(resolveModel(settings))) {
    return;
  }
  const extra = { ...(body.extra_body as Record<string, unknown> | undefined) };
  if (settings.thinkingMode === "disabled") {
    extra.thinking = { type: "disabled" };
  } else {
    extra.thinking = { type: "enabled" };
    body.reasoning_effort = normalizeReasoningEffort(
      settings.reasoningEffort,
      resolveModel(settings),
    );
  }
  body.extra_body = extra;
}

function buildChatBody(
  settings: AppSettings,
  messages: ChatMessage[],
  extraTools?: Array<{ type: string; function: Record<string, unknown> }>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: effectiveModel(settings),
    messages: serializeMessagesForApi(messages),
    stream: settings.stream,
  };
  if (settings.maxTokens != null && settings.maxTokens > 0) {
    body.max_tokens = settings.maxTokens;
  }
  if (settings.stream) {
    body.stream_options = { include_usage: true };
  }
  applyThinking(settings, body);
  try {
    const tools = buildTools(settings);
    const all = tools
      ? [...tools, ...(extraTools ?? [])]
      : [...(extraTools ?? [])];
    if (all.length) {
      body.tools = all;
      body.tool_choice = "auto";
    }
  } catch {
    /* invalid custom tools config — skip tools for this request instead of aborting chat */
  }
  return body;
}

/** Backoff sleep that gives up early when the user stops generation. */
async function sleep(ms: number, control?: StreamControl): Promise<void> {
  if (!control) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  const step = 100;
  for (let waited = 0; waited < ms; waited += step) {
    if (control.cancelled) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - waited)));
  }
}

function errorStatus(err: unknown): number | undefined {
  if (err instanceof ApiError) return err.status;
  return (err as { status?: number }).status;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isRateLimitError(err: unknown): boolean {
  const status = errorStatus(err);
  if (status === 429) return true;
  const msg = errorMessage(err);
  return /过于频繁|rate.?lim|限流|稍后自动重试/i.test(msg);
}

function isRetryableError(err: unknown): boolean {
  const status = errorStatus(err);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  const msg = errorMessage(err).toLowerCase();
  if (isRateLimitError(err)) return true;
  return msg.includes("network") || msg.includes("failed to fetch");
}

function retryDelayMs(
  settings: AppSettings,
  attempt: number,
  err: unknown,
): number {
  const rateLimited = isRateLimitError(err);
  const base = rateLimited
    ? Math.max(settings.retryBackoffMs || 1000, 4000)
    : Math.max(settings.retryBackoffMs || 1000, 500);
  const cap = rateLimited ? 60000 : 30000;
  return Math.min(cap, base * 2 ** attempt);
}

interface RetryOptions<T> {
  control?: StreamControl;
  /** Fired before every retry so the UI can drop text streamed by the failed attempt. */
  onAttemptStart?: (attempt: number) => void;
  /** Optional status for UI（如游戏「限流，稍后重试」）。 */
  onRetryWait?: (info: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
  }) => void;
  action: () => Promise<T>;
}

async function withRetry<T>(
  settings: AppSettings,
  options: RetryOptions<T>,
): Promise<T> {
  const baseAttempts = Math.max(1, settings.retryCount + 1);
  let lastErr: unknown;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) options.onAttemptStart?.(attempt);
    try {
      return await options.action();
    } catch (err) {
      lastErr = err;
      if (options.control?.cancelled) throw err;
      if (!isRetryableError(err)) throw err;
      const rateLimited = isRateLimitError(err);
      const maxAttempts = rateLimited
        ? Math.max(baseAttempts, 5)
        : baseAttempts;
      if (attempt >= maxAttempts - 1) throw err;
      const delayMs = retryDelayMs(settings, attempt, err);
      options.onRetryWait?.({
        attempt: attempt + 1,
        maxAttempts,
        delayMs,
        reason: rateLimited
          ? "消息过于频繁，稍后自动重试…"
          : "请求失败，稍后重试…",
      });
      await sleep(delayMs, options.control);
      if (options.control?.cancelled) throw err;
    }
  }
  throw lastErr;
}

interface CompletionResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: TokenUsage | null;
}

class ToolCallAccumulator {
  private calls = new Map<number, ToolCall>();

  feed(deltaToolCalls: unknown) {
    if (!Array.isArray(deltaToolCalls)) return;
    for (const tc of deltaToolCalls) {
      const item = tc as Record<string, unknown>;
      const idx = Number(item.index ?? 0);
      if (!this.calls.has(idx)) {
        this.calls.set(idx, {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        });
      }
      const entry = this.calls.get(idx)!;
      if (item.id) entry.id = String(item.id);
      const fn = item.function as Record<string, unknown> | undefined;
      if (fn?.name) entry.function.name += String(fn.name);
      if (fn?.arguments) entry.function.arguments += String(fn.arguments);
    }
  }

  finish(): ToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => v)
      .filter((tc) => tc.function.name.trim());
  }
}

function pickText(delta: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = delta[key];
    if (value != null && String(value)) return String(value);
  }
  return "";
}

/** 解析一行 SSE（`data:` 开头）并累积到各字段；返回是否成功消费。 */
function feedSseLine(
  line: string,
  state: {
    content: string;
    reasoning: string;
    finishReason: string | null;
    usage: TokenUsage | null;
    toolAcc: ToolCallAccumulator;
    /** 是否收到过 `[DONE]` 结束标记（断流保护用）。 */
    sawDone?: boolean;
    onDelta?: (text: string) => void;
    onReasoningDelta?: (text: string) => void;
  },
): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return false;
  const payload = trimmed.slice(5).trim();
  if (!payload) return false;
  if (payload === "[DONE]") {
    // 标记流已以 [DONE] 正常收尾，供断流保护判断
    state.sawDone = true;
    return false;
  }
  let chunk: Record<string, unknown>;
  try {
    chunk = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return false;
  }
  const parsedUsage = parseUsage(chunk);
  if (parsedUsage) state.usage = parsedUsage;
  const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  if (!choice) return true;
  state.finishReason = String(choice.finish_reason ?? state.finishReason ?? "");
  const delta = (choice.delta ?? {}) as Record<string, unknown>;
  const reasoningDelta = pickText(delta, "reasoning_content", "reasoning");
  if (reasoningDelta) {
    state.reasoning += reasoningDelta;
    state.onReasoningDelta?.(reasoningDelta);
  }
  const textDelta = pickText(delta, "content");
  if (textDelta) {
    state.content += textDelta;
    state.onDelta?.(textDelta);
  }
  state.toolAcc.feed(delta.tool_calls);
  return true;
}

async function streamChat(
  settings: AppSettings,
  body: Record<string, unknown>,
  onDelta?: (text: string) => void,
  onReasoningDelta?: (text: string) => void,
  control?: StreamControl,
): Promise<CompletionResult> {
  const controller = new AbortController();
  if (control) control.abortController = controller;

  const timeoutMs = settings.httpReadTimeout * 1000;
  let timeout = setTimeout(() => controller.abort(), timeoutMs);
  const bumpTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(), timeoutMs);
  };

  const url = chatUrl(settings);
  const headers = buildHeaders(settings);
  const bodyText = JSON.stringify(body);
  const init: RequestInit = {
    method: "POST",
    headers,
    body: bodyText,
    signal: controller.signal,
  };

  // Android 主通道：OkHttp 原生流式（HTTP/1.1 优先）。WebView fetch 对跨域
  // （go 网关无 CORS）与流式响应体支持不可靠，不再作为手机端主路径。
  if (Capacitor.isNativePlatform()) {
    const toolAcc = new ToolCallAccumulator();
    const state = {
      content: "",
      reasoning: "",
      finishReason: null as string | null,
      usage: null as TokenUsage | null,
      toolAcc,
      sawDone: false,
      onDelta,
      onReasoningDelta,
    };
    const requestId = `chat_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    let buffer = "";
    try {
      await httpStreamText({
        url,
        method: "POST",
        headers,
        body: bodyText,
        timeoutMs,
        requestId,
        signal: controller.signal,
        onChunk: (chunk) => {
          bumpTimeout();
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            feedSseLine(line, state);
          }
        },
      });
    } finally {
      clearTimeout(timeout);
    }
    const streamCut =
      !state.sawDone && !state.finishReason && !control?.cancelled;
    if (streamCut) {
      if (!state.content.trim()) {
        throw new ApiError("连接中断：流未正常结束，请重试", 502);
      }
      return {
        content: state.content,
        reasoning: state.reasoning,
        toolCalls: [],
        finishReason: state.finishReason,
        usage: state.usage,
      };
    }
    const tools = toolAcc.finish();
    return {
      content: state.content,
      reasoning: state.reasoning,
      toolCalls: tools.length ? tools : [],
      finishReason: state.finishReason,
      usage: state.usage,
    };
  }

  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }

  try {
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 200);
      throw new ApiError(`API 错误 (${resp.status})：${detail}`, resp.status);
    }
    if (!resp.body) throw new ApiError("流式响应不可用");

    bumpTimeout();
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    let finishReason: string | null = null;
    let usage: TokenUsage | null = null;
    const toolAcc = new ToolCallAccumulator();
    const state = {
      content,
      reasoning,
      finishReason,
      usage,
      toolAcc,
      sawDone: false,
      onDelta,
      onReasoningDelta,
    };

    try {
      while (true) {
        if (control?.cancelled) {
          await reader.cancel().catch(() => undefined);
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        bumpTimeout();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          feedSseLine(line, state);
        }
      }
    } finally {
      clearTimeout(timeout);
      await reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        /* already released by cancel() */
      }
    }

    // 断流保护：正常流一定以 [DONE] 或某 chunk 的 finish_reason 收尾；
    // 两者皆无（且非用户取消）说明连接被网关切断（clean-FIN）。
    // 此时 tool_calls 的 arguments 往往是截断的 JSON（如 `{"q`），
    // 一旦写入会话历史，后续每轮请求都会回放这段坏 JSON，导致上游 400 卡死
    // （reasonix 的 DeepSeek-Reasonix PR #3957 修复的正是该问题）。
    // 因此断流时丢弃本次累积的工具调用、不写入历史；正文已收到的部分保留，
    // 若一个字都没收到则抛 502（可重试状态），让上层 withRetry 重试。
    const streamCut =
      !state.sawDone && !state.finishReason && !control?.cancelled;
    if (streamCut) {
      if (!state.content.trim()) {
        throw new ApiError("连接中断：流未正常结束，请重试", 502);
      }
      return {
        content: state.content,
        reasoning: state.reasoning,
        toolCalls: [],
        finishReason: state.finishReason,
        usage: state.usage,
      };
    }

    const tools = toolAcc.finish();
    return {
      content: state.content,
      reasoning: state.reasoning,
      toolCalls: tools.length ? tools : [],
      finishReason: state.finishReason,
      usage: state.usage,
    };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/** Simulate token streaming when API returns one JSON blob (stream off). */
async function pumpDeltas(
  text: string,
  onChunk?: (delta: string) => void,
  control?: StreamControl,
): Promise<void> {
  if (!onChunk || !text) return;
  const step = Math.max(1, Math.min(16, Math.ceil(text.length / 72)));
  for (let i = 0; i < text.length; i += step) {
    if (control?.cancelled) {
      onChunk(text.slice(i));
      return;
    }
    onChunk(text.slice(i, i + step));
    await new Promise((r) => setTimeout(r, 12));
  }
}

async function completeChat(
  settings: AppSettings,
  body: Record<string, unknown>,
  onDelta?: (text: string) => void,
  onReasoningDelta?: (text: string) => void,
  control?: StreamControl,
): Promise<CompletionResult> {
  const controller = new AbortController();
  if (control) control.abortController = controller;
  const timeout = setTimeout(
    () => controller.abort(),
    settings.httpReadTimeout * 1000,
  );
  let data: Record<string, unknown>;
  // The deadline has to cover reading the body too, not just the response headers.
  try {
    const url = chatUrl(settings);
    const init: RequestInit = {
      method: "POST",
      headers: buildHeaders(settings),
      body: JSON.stringify({ ...body, stream: false }),
      signal: controller.signal,
    };
    if (Capacitor.isNativePlatform()) {
      // 原生平台直走 OkHttp 整包取回（HTTP/1.1 优先），绕开 WebView fetch。
      const { status, text } = await httpText(
        url,
        init,
        settings.httpReadTimeout * 1000,
      );
      if (status < 200 || status >= 300) {
        throw new ApiError(`API 错误 (${status})：${text.slice(0, 200)}`, status);
      }
      data = JSON.parse(text) as Record<string, unknown>;
    } else {
      const resp = await fetch(url, init);
      if (!resp.ok) {
        const detail = (await resp.text()).slice(0, 200);
        throw new ApiError(`API 错误 (${resp.status})：${detail}`, resp.status);
      }
      data = (await resp.json()) as Record<string, unknown>;
    }
  } finally {
    clearTimeout(timeout);
  }
  return buildCompleteResult(data, onDelta, onReasoningDelta, control);
}

/** 把非流式响应体解析为 CompletionResult 并模拟打字。 */
async function buildCompleteResult(
  data: Record<string, unknown>,
  onDelta?: (text: string) => void,
  onReasoningDelta?: (text: string) => void,
  control?: StreamControl,
): Promise<CompletionResult> {
  const choices = data.choices as Array<Record<string, unknown>>;
  const message = (choices?.[0]?.message ?? {}) as Record<string, unknown>;
  const content = String(message.content ?? "");
  const reasoning = pickText(message, "reasoning_content", "reasoning");
  await pumpDeltas(reasoning, onReasoningDelta, control);
  await pumpDeltas(content, onDelta, control);
  const toolCalls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as ToolCall[])
    : [];
  return {
    content,
    reasoning,
    toolCalls,
    finishReason: String(choices?.[0]?.finish_reason ?? ""),
    usage: parseUsage(data),
  };
}

function assistantMessage(
  content: string,
  reasoning: string,
  toolCalls?: ToolCall[],
): ChatMessage {
  const msg: ChatMessage = { role: "assistant", content };
  if (reasoning) msg.reasoningContent = reasoning;
  if (toolCalls?.length) msg.toolCalls = toolCalls;
  return msg;
}

function normalizeToolCallIds(toolCalls: ToolCall[], round: number): ToolCall[] {
  return toolCalls.map((tc, index) => ({
    ...tc,
    id: tc.id || `call_${round}_${index}_${tc.function.name || "tool"}`,
    type: tc.type || "function",
  }));
}

/** OpenAI-compatible APIs expect snake_case message fields in JSON bodies. */
function serializeMessagesForApi(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let pendingToolCallIds: string[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      pendingToolCallIds = msg.toolCalls.map((tc, index) =>
        tc.id || `call_legacy_${index}_${tc.function.name || "tool"}`,
      );
      out.push({
        role: "assistant",
        content: msg.content,
        ...(msg.reasoningContent
          ? { reasoning_content: msg.reasoningContent }
          : {}),
        tool_calls: msg.toolCalls.map((tc, index) => ({
          id: pendingToolCallIds[index],
          type: tc.type || "function",
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      });
      continue;
    }

    if (msg.role === "tool") {
      const callId = msg.toolCallId || pendingToolCallIds.shift() || "";
      out.push({
        role: "tool",
        content: msg.content,
        tool_call_id: callId,
      });
      continue;
    }

    pendingToolCallIds = [];
    const row: Record<string, unknown> = {
      role: msg.role,
      content: msg.content,
    };
    if (msg.reasoningContent) {
      row.reasoning_content = msg.reasoningContent;
    }
    out.push(row);
  }

  return out;
}

async function runSingleCompletion(
  settings: AppSettings,
  convo: ChatMessage[],
  includeTools: boolean,
  options?: {
    onDelta?: (text: string) => void;
    onReasoningDelta?: (text: string) => void;
    control?: StreamControl;
    extraTools?: Array<{ type: string; function: Record<string, unknown> }>;
  },
): Promise<CompletionResult> {
  const body = buildChatBody(settings, convo, options?.extraTools);
  if (!includeTools) {
    delete body.tools;
    delete body.tool_choice;
  }
  const action = () =>
    settings.stream
      ? streamChat(
          settings,
          body,
          options?.onDelta,
          options?.onReasoningDelta,
          options?.control,
        )
      : completeChat(
          settings,
          body,
          options?.onDelta,
          options?.onReasoningDelta,
          options?.control,
        );
  return action();
}

function summarizeFromToolMessages(
  apiMessages: ChatMessage[],
  fallback = "",
): string {
  const toolTexts = apiMessages
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content ?? "").trim())
    .filter(Boolean);
  if (!toolTexts.length) {
    return fallback.trim() || "请根据上文工具结果继续提问，或点击重试。";
  }
  const body = toolTexts
    .map((text, i) => `### 工具结果 ${i + 1}\n${text.slice(0, 2000)}`)
    .join("\n\n");
  return `以下为已收集的信息，供你参考：\n\n${body}`;
}

async function finalizeAfterToolLimit(
  settings: AppSettings,
  convo: ChatMessage[],
  apiMessages: ChatMessage[],
  lastStreamedContent: string,
  lastReasoning: string,
  options?: {
    onDelta?: (text: string) => void;
    onReasoningDelta?: (text: string) => void;
    onStreamRoundStart?: (round: number) => void;
    control?: StreamControl;
  },
): Promise<{ content: string; reasoning: string; usage: TokenUsage | null }> {
  if (options?.control?.cancelled) {
    return {
      content: lastStreamedContent.trim() || summarizeFromToolMessages(apiMessages),
      reasoning: lastReasoning,
      usage: null,
    };
  }
  const wrapUpConvo: ChatMessage[] = [
    ...convo,
    {
      role: "user",
      content:
        "请根据上文所有工具返回的信息，直接给出完整、对用户有用的最终回答，不要再调用任何工具。",
    },
  ];
  try {
    const forced = await withRetry(settings, {
      control: options?.control,
      onAttemptStart: () => options?.onStreamRoundStart?.(1),
      action: () => runSingleCompletion(settings, wrapUpConvo, false, options),
    });
    const content =
      forced.content.trim() ||
      lastStreamedContent.trim() ||
      summarizeFromToolMessages(apiMessages, lastStreamedContent);
    return {
      content,
      reasoning: forced.reasoning || lastReasoning,
      usage: forced.usage,
    };
  } catch {
    return {
      content:
        lastStreamedContent.trim() ||
        summarizeFromToolMessages(apiMessages),
      reasoning: lastReasoning,
      usage: null,
    };
  }
}

export async function chatStream(
  settings: AppSettings,
  messages: ChatMessage[],
  options?: {
    onDelta?: (text: string) => void;
    onReasoningDelta?: (text: string) => void;
    /** Fired before round > 0 so UI can clear interim assistant text. */
    onStreamRoundStart?: (round: number) => void;
    onRetryWait?: (info: {
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
    }) => void;
    onToolStatus?: (
      phase: "start" | "done" | "error" | "waiting",
      id: string,
      label: string,
      meta?: {
        name?: string;
        args?: string;
        result?: string;
        exportedFile?: import("./documentExport").ExportedFile;
      },
    ) => void;
    control?: StreamControl;
    /** 附加工具声明（如工作区文件工具），与内置工具一起注入。 */
    extraTools?: Array<{ type: string; function: Record<string, unknown> }>;
    /** 附加工具执行器（如工作区文件工具），优先于内置 BUILTIN_HANDLERS。 */
    extraToolHandlers?: Record<
      string,
      (args: Record<string, unknown>, settings: AppSettings, signal?: AbortSignal) => Promise<ToolExecutionResult>
    >;
  },
): Promise<ChatResponse> {
  if (!settings.apiKey.trim()) {
    const provider = getProvider(settings.apiProvider);
    throw new ApiError(`请先在设置中填写 API Key（${provider.apiKeyHint}）`);
  }

  const convo = normalizeMessagesForApi(
    [...messages],
    providerSupportsVision(settings),
  );
  let totalUsage: TokenUsage | null = null;
  const apiMessages: ChatMessage[] = [];
  let lastReasoning = "";
  let note = "";
  let lastStreamedContent = "";
  let searchCitationNext = 1;

  const maxRounds = effectiveMaxToolRounds(settings);

  try {
    for (let round = 0; round < maxRounds; round++) {
      if (options?.control?.cancelled) {
        return {
          content: "",
          reasoning: lastReasoning,
          note: "已取消",
          usage: totalUsage,
          apiMessages,
        };
      }

      if (round > 0) {
        options?.onStreamRoundStart?.(round);
      }
      const result = await withRetry(settings, {
        control: options?.control,
        onAttemptStart: () => options?.onStreamRoundStart?.(round),
        onRetryWait: options?.onRetryWait,
        action: () => runSingleCompletion(settings, convo, true, options),
      });
      totalUsage = mergeUsage(totalUsage, result.usage);
      if (result.reasoning) lastReasoning = result.reasoning;
      if (result.content.trim()) {
        lastStreamedContent = result.content;
      }

      if (options?.control?.cancelled) {
        return {
          content: lastStreamedContent,
          reasoning: lastReasoning,
          note: "已取消",
          usage: totalUsage,
          apiMessages,
        };
      }

      if (result.toolCalls.length) {
        if (round > 0) {
          options?.onToolStatus?.("waiting", "", waitingLabel());
        }
        const toolCalls = normalizeToolCallIds(result.toolCalls, round);
        const assistant = assistantMessage(
          result.content,
          result.reasoning,
          toolCalls,
        );
        convo.push(assistant);
        apiMessages.push(assistant);

        for (const tc of toolCalls) {
          const name = tc.function.name;
          const args = tc.function.arguments;
          const tid = tc.id;
          options?.onToolStatus?.(
            "start",
            tid,
            toolStatusLabel("start", name, args),
            { name, args },
          );
          let toolOut: string;
          let exportedFile: import("./documentExport").ExportedFile | undefined;
          try {
            const executed = await executeTool(
              name,
              args,
              settings,
              options?.control?.signal,
              options?.extraToolHandlers,
            );
            toolOut = executed.content;
            exportedFile = executed.exportedFile;
            options?.onToolStatus?.(
              "done",
              tid,
              toolStatusLabel("done", name, args),
              { name, args, result: toolOut, exportedFile },
            );
          } catch (err) {
            toolOut = `工具错误：${err instanceof Error ? err.message : String(err)}`;
            options?.onToolStatus?.(
              "error",
              tid,
              toolStatusLabel("error", name, args),
              { name, args, result: toolOut },
            );
          }
          if (!toolOut.trim()) {
            toolOut = "工具未返回内容。";
          }
          if (name === "web_search") {
            const numbered = renumberSearchOutput(toolOut, searchCitationNext);
            toolOut = numbered.text;
            searchCitationNext = numbered.nextIndex;
          }
          const toolMsg: ChatMessage = {
            role: "tool",
            content: capToolResult(toolOut),
            toolCallId: tc.id,
          };
          convo.push(toolMsg);
          apiMessages.push(toolMsg);
        }
        continue;
      }

      const final = assistantMessage(result.content, result.reasoning);
      if (result.content.trim() || !apiMessages.length) {
        apiMessages.push(final);
      }
      return {
        content: result.content,
        reasoning: lastReasoning,
        note,
        usage: totalUsage,
        apiMessages,
      };
    }

    const finalized = await finalizeAfterToolLimit(
      settings,
      convo,
      apiMessages,
      lastStreamedContent,
      lastReasoning,
      options,
    );
    totalUsage = mergeUsage(totalUsage, finalized.usage);
    if (finalized.reasoning) lastReasoning = finalized.reasoning;
    const final = assistantMessage(finalized.content, finalized.reasoning);
    apiMessages.push(final);
    return {
      content: finalized.content,
      reasoning: lastReasoning,
      note: `已达工具调用上限（${maxRounds} 轮），已让模型直接总结现有结果。`,
      usage: totalUsage,
      apiMessages,
    };
  } catch (err) {
    if (options?.control?.cancelled) {
      return {
        content: "",
        reasoning: lastReasoning,
        note: "已取消",
        usage: totalUsage,
        apiMessages,
      };
    }
    throw friendlyApiError(err);
  }
}

export async function fetchDeepseekBalance(
  settings: AppSettings,
): Promise<DeepSeekBalance> {
  // 余额接口是 DeepSeek 专有端点；其他供应商不支持时返回不可用而非报错。
  if (settings.apiProvider !== "deepseek") {
    return { isAvailable: false, balanceInfos: [] };
  }
  if (!settings.apiKey.trim()) {
    throw new ApiError("请先在设置中填写 API Key");
  }
  const data = await fetchJson(
    `${apiRoot(settings)}/user/balance`,
    {
      headers: {
        Authorization: `Bearer ${settings.apiKey.trim()}`,
        Accept: "application/json",
      },
    },
    settings.httpConnectTimeout * 1000,
    "查询余额失败",
  );
  const infos = Array.isArray(data.balance_infos)
    ? data.balance_infos.map((item) => {
        const row = item as Record<string, unknown>;
        return {
          currency: String(row.currency ?? ""),
          totalBalance: String(row.total_balance ?? "0"),
          grantedBalance: String(row.granted_balance ?? "0"),
          toppedUpBalance: String(row.topped_up_balance ?? "0"),
        };
      })
    : [];
  return {
    isAvailable: Boolean(data.is_available ?? true),
    balanceInfos: infos,
  };
}

export async function listModels(settings: AppSettings): Promise<string[]> {
  if (!settings.apiKey.trim()) {
    throw new ApiError("请先在设置中填写 API Key");
  }
  const base = settings.baseUrl.replace(/\/$/, "");
  const url = gatewayUrl(
    base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`,
  );
  const data = (await fetchJson(
    url,
    { headers: buildHeaders(settings) },
    settings.httpConnectTimeout * 1000,
    "获取模型列表失败",
  )) as { data?: Array<{ id?: string }> };
  const ids = (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => Boolean(id));
  if (!ids.length) {
    throw new ApiError("API 未返回可用模型");
  }
  return [...ids].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

/**
 * 供上下文压缩使用：非流式单轮生成摘要（不跑工具循环）。
 * 任何失败返回 null，由调用方决定是否继续。
 */
export async function summarizeText(
  settings: AppSettings,
  messages: ChatMessage[],
  maxTokens = 500,
): Promise<string | null> {
  try {
    const body = buildChatBody(settings, messages);
    body.stream = false;
    body.max_tokens = maxTokens;
    delete body.tools;
    delete body.tool_choice;
    const result = await completeChat(settings, body);
    const text = (result.content ?? "").trim();
    return text || null;
  } catch {
    return null;
  }
}
