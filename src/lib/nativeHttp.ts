import {
  Capacitor,
  CapacitorHttp,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";

interface HttpNativePlugin {
  httpText(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }): Promise<{ status?: number; text?: string; error?: string }>;
  httpStream(options: {
    requestId: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }): Promise<{ done?: boolean; error?: string }>;
  httpAbort(options: { requestId: string }): Promise<void>;
  addListener(
    eventName: string,
    listenerFunc: (data: unknown) => void,
  ): Promise<PluginListenerHandle>;
}

interface HttpChunkEvent {
  requestId: string;
  chunk: string;
}

const HttpNative = registerPlugin<HttpNativePlugin>("HttpNative");

/** httpChunk 事件按 requestId 分流到各流式请求。 */
const streamHandlers = new Map<string, (chunk: string) => void>();
let streamListener: Promise<PluginListenerHandle> | null = null;

function ensureStreamListener(): Promise<PluginListenerHandle> {
  let listener = streamListener;
  if (!listener) {
    listener = HttpNative.addListener("httpChunk", (data: unknown) => {
      const event = data as HttpChunkEvent;
      const handler = streamHandlers.get(event.requestId);
      if (handler) handler(event.chunk);
    });
    streamListener = listener;
  }
  return listener;
}

export class HttpError extends Error {
  status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

/**
 * 原生增量流式（Android 专用）：OkHttp 逐行推送 SSE 到 onChunk。
 * 取消时向插件发 httpAbort 立即断开，并抛 AbortedError。
 */
export async function httpStreamText(options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  requestId: string;
  onChunk: (chunk: string) => void;
  signal?: AbortSignal | null;
}): Promise<void> {
  const {
    url,
    method = "GET",
    headers,
    body,
    timeoutMs = 15000,
    requestId,
    onChunk,
    signal,
  } = options;
  throwIfAborted(signal);
  await ensureStreamListener();
  streamHandlers.set(requestId, onChunk);
  const abortRelay = () => {
    void HttpNative.httpAbort({ requestId }).catch(() => undefined);
  };
  signal?.addEventListener("abort", abortRelay);
  try {
    const result = await HttpNative.httpStream({
      requestId,
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      timeoutMs,
    });
    if (result.error != null) {
      throw new HttpError(result.error, 0);
    }
    throwIfAborted(signal);
  } finally {
    signal?.removeEventListener("abort", abortRelay);
    streamHandlers.delete(requestId);
  }
}

function normalizeHeaders(
  init: RequestInit,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const raw = init.headers;
  if (!raw) return headers;
  if (raw instanceof Headers) {
    raw.forEach((v, k) => {
      headers[k] = v;
    });
    return headers;
  }
  if (Array.isArray(raw)) {
    for (const [k, v] of raw) headers[k] = v;
    return headers;
  }
  return { ...(raw as Record<string, string>) };
}

function bodyToString(body: RequestInit["body"]): string | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return String(body);
}

function responseText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data == null) return "";
  if (typeof data === "object") return JSON.stringify(data);
  return String(data);
}

export class AbortedError extends Error {
  constructor() {
    super("已取消");
  }
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw new AbortedError();
}

/** Native HTTP on Android/iOS; fetch on web. Community fix for WebView fetch failures. */
export async function httpText(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<{ status: number; text: string }> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = normalizeHeaders(init);
  const data = bodyToString(init.body);
  const outerSignal = init.signal ?? undefined;
  throwIfAborted(outerSignal);

  if (Capacitor.isNativePlatform()) {
    const options = {
      url,
      headers,
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
      responseType: "text" as const,
      ...(data !== undefined ? { data } : {}),
    };
    // OkHttp 原生请求（Android）优先于 CapacitorHttp：插件内先 HTTP/1.1、
    // 网络层异常再回退 HTTP/2 兜底（opencode go 网关实测接受 HTTP/1.1，
    // 曾误诊为「只接受 HTTP/2」）。
    try {
      const native = await HttpNative.httpText({
        url,
        method,
        headers,
        ...(data !== undefined ? { body: data } : {}),
        timeoutMs,
      });
      if (native.error != null) {
        // 网络层失败（DNS/超时/连接重置等）：透出原始原因，便于诊断。
        throw new HttpError(native.error, 0);
      }
      throwIfAborted(outerSignal);
      return { status: native.status ?? 0, text: native.text ?? "" };
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      if (err instanceof HttpError) throw err;
      // 插件缺失/调用异常：兜底 CapacitorHttp。
    }
    const resp =
      method === "GET"
        ? await CapacitorHttp.get(options)
        : await CapacitorHttp.request({ ...options, method });
    // CapacitorHttp has no abort support: discard a result the caller no longer wants.
    throwIfAborted(outerSignal);
    return { status: resp.status, text: responseText(resp.data) };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relay = () => controller.abort();
  outerSignal?.addEventListener("abort", relay);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const text = await resp.text();
    return { status: resp.status, text };
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", relay);
  }
}

export async function httpJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<{ status: number; data: T }> {
  const { status, text } = await httpText(url, init, timeoutMs);
  try {
    return { status, data: JSON.parse(text) as T };
  } catch {
    throw new HttpError(`无效 JSON 响应 (HTTP ${status})`, status);
  }
}
