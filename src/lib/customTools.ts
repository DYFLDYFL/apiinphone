import type { AppSettings } from "../types";
import { ToolError } from "./tools";

export interface HttpToolExtension {
  type: "http";
  url: string;
  method?: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  /** JSONPath-style: send entire args as body when omitted */
  argKeys?: string[];
}

export interface JsToolExtension {
  type: "js";
  /** Safe built-in handlers only */
  handler:
    | "echo"
    | "json_stringify"
    | "format_args";
}

export type CustomToolExtension = HttpToolExtension | JsToolExtension;

export interface ParsedCustomTool {
  name: string;
  extension?: CustomToolExtension;
}

const JS_HANDLERS: Record<
  JsToolExtension["handler"],
  (args: Record<string, unknown>) => Promise<string> | string
> = {
  echo: (args) => JSON.stringify(args, null, 2),
  json_stringify: (args) => JSON.stringify(args),
  format_args: (args) =>
    Object.entries(args)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join("\n"),
};

export function parseCustomTools(settings: AppSettings): ParsedCustomTool[] {
  const raw = settings.toolsCustomJson.trim();
  if (!raw) return [];
  let tools: unknown;
  try {
    tools = JSON.parse(raw);
  } catch (err) {
    throw new ToolError(`自定义工具 JSON 无效：${String(err)}`);
  }
  if (!Array.isArray(tools)) {
    throw new ToolError("自定义工具 JSON 必须是数组。");
  }
  return tools.map((tool) => {
    const row = tool as Record<string, unknown>;
    const fn = row.function as Record<string, unknown> | undefined;
    const name = String(fn?.name ?? "").trim();
    const extension = row["x-apiinphone"] as CustomToolExtension | undefined;
    return { name, extension };
  });
}

export function customToolExtensions(
  settings: AppSettings,
): Map<string, CustomToolExtension> {
  const map = new Map<string, CustomToolExtension>();
  for (const item of parseCustomTools(settings)) {
    if (item.name && item.extension) {
      map.set(item.name, item.extension);
    }
  }
  return map;
}

export async function executeCustomTool(
  name: string,
  args: Record<string, unknown>,
  extension: CustomToolExtension,
): Promise<string> {
  if (extension.type === "js") {
    const handler = JS_HANDLERS[extension.handler];
    if (!handler) {
      throw new ToolError(`未知 JS handler：${extension.handler}`);
    }
    return handler(args);
  }

  const method = extension.method ?? "POST";
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...extension.headers,
  };

  let url = extension.url;
  let body: string | undefined;

  if (method === "GET") {
    const params = new URLSearchParams();
    const keys = extension.argKeys ?? Object.keys(args);
    for (const key of keys) {
      if (args[key] != null) params.set(key, String(args[key]));
    }
    const qs = params.toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  } else {
    headers["Content-Type"] = "application/json";
    const payload =
      extension.argKeys?.length ?
        Object.fromEntries(
          extension.argKeys.map((k) => [k, args[k]]),
        )
      : args;
    body = JSON.stringify(payload);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new ToolError(
        `HTTP 工具 ${name} 失败 (${resp.status})：${text.slice(0, 300)}`,
      );
    }
    return text.slice(0, 12000);
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(`HTTP 工具 ${name} 请求失败：${String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}
