import type {
  AppSettings,
  ChatMessage,
  ChatResponse,
  DeepSeekBalance,
  TokenUsage,
  ToolCall,
} from "../types";
import { getProvider, modelSupportsThinking, providerSupportsVision, resolveModel } from "./apiProviders";
import { normalizeMessagesForApi } from "./attachments";
import { renumberSearchOutput } from "./searchSources";
import { effectiveMaxToolRounds, effectiveModel, thinkingActive } from "./settings";
import {
  buildTools,
  executeTool,
  ToolError,
  toolStatusLabel,
  waitingLabel,
} from "./tools";

export class ApiError extends Error {}

export interface StreamControl {
  cancelled: boolean;
  abortController?: AbortController;
  cancel(): void;
}

export function createStreamControl(): StreamControl {
  const control: StreamControl = {
    cancelled: false,
    abortController: undefined,
    cancel() {
      control.cancelled = true;
      control.abortController?.abort();
    },
  };
  return control;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function mergeUsage(
  base: TokenUsage | null,
  extra: TokenUsage | null,
): TokenUsage | null {
  if (!base) return extra;
  if (!extra) return base;
  return {
    promptTokens: base.promptTokens + extra.promptTokens,
    completionTokens: base.completionTokens + extra.completionTokens,
    totalTokens: base.totalTokens + extra.totalTokens,
    promptCacheHitTokens:
      base.promptCacheHitTokens + extra.promptCacheHitTokens,
    promptCacheMissTokens:
      base.promptCacheMissTokens + extra.promptCacheMissTokens,
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
  if (err instanceof ApiError) return err;
  if (err instanceof ToolError) return new ApiError(err.message);
  return new ApiError(String(err));
}

function buildHeaders(settings: AppSettings): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${settings.apiKey.trim()}`,
    "Content-Type": "application/json",
  };
  const provider = getProvider(settings.apiProvider);
  if (provider.usePoeHeaders) {
    headers["HTTP-Referer"] = settings.httpReferer;
    headers["X-Title"] = settings.appTitle;
  }
  return headers;
}

function apiRoot(settings: AppSettings): string {
  const url = settings.baseUrl.replace(/\/$/, "");
  return url.endsWith("/v1") ? url.slice(0, -3) : url;
}

function chatUrl(settings: AppSettings): string {
  const base = settings.baseUrl.replace(/\/$/, "");
  return base.endsWith("/v1")
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
}

function applyThinking(settings: AppSettings, body: Record<string, unknown>) {
  if (settings.apiProvider !== "deepseek") return;
  if (!modelSupportsThinking(resolveModel(settings))) return;
  const extra = { ...(body.extra_body as Record<string, unknown> | undefined) };
  if (settings.thinkingMode === "disabled") {
    extra.thinking = { type: "disabled" };
  } else {
    extra.thinking = { type: "enabled" };
    body.reasoning_effort = settings.reasoningEffort;
  }
  body.extra_body = extra;
}

function buildChatBody(
  settings: AppSettings,
  messages: ChatMessage[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: effectiveModel(settings),
    messages: serializeMessagesForApi(messages),
    stream: settings.stream,
  };
  if (!thinkingActive(settings)) {
    body.temperature = settings.temperature;
  }
  if (settings.maxTokens) {
    body.max_tokens = settings.maxTokens;
  }
  if (settings.stream) {
    body.stream_options = { include_usage: true };
  }
  applyThinking(settings, body);
  try {
    const tools = buildTools(settings);
    if (tools) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
  } catch {
    /* invalid custom tools config — skip tools for this request instead of aborting chat */
  }
  return body;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  settings: AppSettings,
  action: () => Promise<T>,
): Promise<T> {
  const attempts = Math.max(1, settings.retryCount + 1);
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await action();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      const retryable =
        status !== undefined
          ? RETRYABLE_STATUS.has(status)
          : String(err).toLowerCase().includes("network");
      if (attempt >= attempts - 1 || !retryable) throw err;
      await sleep(
        Math.min(30000, (settings.retryBackoffMs / 1000) * 2 ** attempt * 1000),
      );
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

async function streamChat(
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

  const resp = await fetch(chatUrl(settings), {
    method: "POST",
    headers: buildHeaders(settings),
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 200);
    throw new ApiError(`API 错误 (${resp.status})：${detail}`);
  }
  if (!resp.body) throw new ApiError("流式响应不可用");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: TokenUsage | null = null;
  const toolAcc = new ToolCallAccumulator();

  while (true) {
    if (control?.cancelled) break;
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const parsedUsage = parseUsage(chunk);
      if (parsedUsage) usage = parsedUsage;
      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      if (!choice) continue;
      finishReason = String(choice.finish_reason ?? finishReason ?? "");
      const delta = (choice.delta ?? {}) as Record<string, unknown>;
      const reasoningDelta = pickText(delta, "reasoning_content", "reasoning");
      if (reasoningDelta) {
        reasoning += reasoningDelta;
        onReasoningDelta?.(reasoningDelta);
      }
      const textDelta = pickText(delta, "content");
      if (textDelta) {
        content += textDelta;
        onDelta?.(textDelta);
      }
      toolAcc.feed(delta.tool_calls);
    }
  }

  return {
    content,
    reasoning,
    toolCalls:
      finishReason === "stop" ||
      finishReason === "length" ||
      finishReason === "content_filter"
        ? []
        : toolAcc.finish(),
    finishReason,
    usage,
  };
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
  const resp = await fetch(chatUrl(settings), {
    method: "POST",
    headers: buildHeaders(settings),
    body: JSON.stringify({ ...body, stream: false }),
    signal: controller.signal,
  });
  clearTimeout(timeout);
  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 200);
    throw new ApiError(`API 错误 (${resp.status})：${detail}`);
  }
  const data = (await resp.json()) as Record<string, unknown>;
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
  },
): Promise<CompletionResult> {
  const body = buildChatBody(settings, convo);
  if (!includeTools) {
    delete body.tools;
    delete body.tool_choice;
  }
  if (settings.stream) {
    return streamChat(
      settings,
      body,
      options?.onDelta,
      options?.onReasoningDelta,
      options?.control,
    );
  }
  return completeChat(
    settings,
    body,
    options?.onDelta,
    options?.onReasoningDelta,
    options?.control,
  );
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
    control?: StreamControl;
  },
): Promise<{ content: string; reasoning: string; usage: TokenUsage | null }> {
  const wrapUpConvo: ChatMessage[] = [
    ...convo,
    {
      role: "user",
      content:
        "请根据上文所有工具返回的信息，直接给出完整、对用户有用的最终回答，不要再调用任何工具。",
    },
  ];
  try {
    const forced = await withRetry(settings, () =>
      runSingleCompletion(settings, wrapUpConvo, false, options),
    );
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
    onToolStatus?: (
      phase: "start" | "done" | "error" | "waiting",
      id: string,
      label: string,
      meta?: { name?: string; args?: string; result?: string },
    ) => void;
    control?: StreamControl;
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

  try {
    const maxRounds = effectiveMaxToolRounds(settings);
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
      const run = () => runSingleCompletion(settings, convo, true, options);

      const result = await withRetry(settings, run);
      totalUsage = mergeUsage(totalUsage, result.usage);
      if (result.reasoning) lastReasoning = result.reasoning;
      if (round === 0 && result.content.trim()) {
        lastStreamedContent = result.content;
      }

      if (options?.control?.cancelled) {
        note = "已取消";
        break;
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
          try {
            toolOut = await executeTool(name, args, settings);
            options?.onToolStatus?.(
              "done",
              tid,
              toolStatusLabel("done", name, args),
              { name, args, result: toolOut },
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
            content: toolOut,
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
      note: "",
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
  if (!settings.apiKey.trim()) {
    throw new ApiError("请先在设置中填写 API Key");
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    settings.httpConnectTimeout * 1000,
  );
  const resp = await fetch(`${apiRoot(settings)}/user/balance`, {
    headers: {
      Authorization: `Bearer ${settings.apiKey.trim()}`,
      Accept: "application/json",
    },
    signal: controller.signal,
  });
  clearTimeout(timeout);
  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 160);
    throw new ApiError(`查询余额失败 (${resp.status})：${detail}`);
  }
  const data = (await resp.json()) as Record<string, unknown>;
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
  const url = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
  const resp = await fetch(url, { headers: buildHeaders(settings) });
  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 200);
    throw new ApiError(`获取模型列表失败 (${resp.status})：${detail}`);
  }
  const data = (await resp.json()) as {
    data?: Array<{ id?: string }>;
  };
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
