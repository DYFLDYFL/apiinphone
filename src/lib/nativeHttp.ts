import { Capacitor, CapacitorHttp } from "@capacitor/core";

export class HttpError extends Error {
  status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
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

/** Native HTTP on Android/iOS; fetch on web. Community fix for WebView fetch failures. */
export async function httpText(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<{ status: number; text: string }> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = normalizeHeaders(init);
  const data = bodyToString(init.body);

  if (Capacitor.isNativePlatform()) {
    const options = {
      url,
      headers,
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
      responseType: "text" as const,
      ...(data !== undefined ? { data } : {}),
    };
    const resp =
      method === "GET"
        ? await CapacitorHttp.get(options)
        : await CapacitorHttp.request({ ...options, method });
    return { status: resp.status, text: responseText(resp.data) };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const text = await resp.text();
    return { status: resp.status, text };
  } finally {
    clearTimeout(timer);
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
