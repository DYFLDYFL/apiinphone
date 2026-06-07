import type { ChatMessage, ToolTraceItem } from "../types";

const TOOL_LABELS: Record<string, string> = {
  web_search: "联网搜索",
  web_fetch: "抓取网页",
  get_current_time: "获取时间",
  run_python: "运行 Python",
};

export function toolDisplayName(name: string): string {
  return TOOL_LABELS[name] ?? (name || "工具");
}

function parseArgs(argsJson: string): Record<string, unknown> {
  try {
    const data = JSON.parse((argsJson || "").trim() || "{}") as unknown;
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function toolDetail(name: string, argsJson: string): string {
  const args = parseArgs(argsJson);
  if (name === "web_search") {
    const query = String(args.query ?? "").trim();
    return query.slice(0, 80);
  }
  if (name === "web_fetch") {
    return String(args.url ?? "").trim().slice(0, 120);
  }
  if (name === "run_python") {
    const code = String(args.code ?? "").trim();
    return code.replace(/\s+/g, " ").slice(0, 80);
  }
  return "";
}

export function runningLabel(name: string, argsJson = ""): string {
  const label = toolDisplayName(name);
  const detail = toolDetail(name, argsJson);
  return detail ? `正在 ${label}… · ${detail}` : `正在 ${label}…`;
}

export function doneLabel(name: string): string {
  return `${toolDisplayName(name)} 完成`;
}

export function errorLabel(name: string): string {
  return `${toolDisplayName(name)} 失败`;
}

export function waitingLabel(): string {
  return "联网中，请稍候…";
}

export function traceItem(
  name: string,
  status: ToolTraceItem["status"],
  argsJson = "",
  toolCallId = "",
): ToolTraceItem {
  let label: string;
  if (status === "running") label = runningLabel(name, argsJson);
  else if (status === "done") label = doneLabel(name);
  else if (status === "error") label = errorLabel(name);
  else label = toolDisplayName(name);
  return {
    id: toolCallId || name,
    name,
    label,
    status,
    detail: toolDetail(name, argsJson),
  };
}

export function buildToolTraceFromApiMessages(
  apiMessages: ChatMessage[],
): ToolTraceItem[] {
  const trace: ToolTraceItem[] = [];
  const byId = new Map<string, ToolTraceItem>();
  for (const msg of apiMessages) {
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        const name = tc.function.name;
        const item = traceItem(
          name,
          "running",
          tc.function.arguments,
          tc.id || name,
        );
        trace.push(item);
        byId.set(tc.id || name, item);
      }
    } else if (msg.role === "tool") {
      const item = byId.get(msg.toolCallId ?? "");
      if (!item) continue;
      const content = String(msg.content ?? "");
      if (content.startsWith("工具错误")) {
        item.status = "error";
        item.label = errorLabel(item.name);
        item.detail = content.slice(0, 160);
      } else {
        item.status = "done";
        item.label = doneLabel(item.name);
        const preview = content.trim().replace(/\n/g, " ").slice(0, 160);
        if (preview) item.detail = preview;
      }
    }
  }
  return trace;
}
