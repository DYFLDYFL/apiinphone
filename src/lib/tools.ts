import type { AppSettings, ChatMessage } from "../types";
import {
  customToolExtensions,
  executeCustomTool,
} from "./customTools";
import { runPython, SandboxError } from "./sandbox/pythonSandbox";
import {
  buildToolTraceFromApiMessages,
  doneLabel,
  errorLabel,
  runningLabel,
  waitingLabel,
} from "./toolStatus";
import {
  effectiveWebSearchDefaultTopK,
  effectiveWebSearchMaxTopK,
  resolveWebSearchTopK,
} from "./settings";
import { webFetchForTool, webSearchForTool } from "./webSearch";

export class ToolError extends Error {}

/** Default max agent tool loops per user message. */
export const DEFAULT_MAX_TOOL_ROUNDS = 24;

export { waitingLabel, buildToolTraceFromApiMessages as buildToolTrace };

const BUILTIN_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description:
        "获取当前本地日期时间（ISO）。回答时效性问题前应先调用，再与 web_search 结果对照。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

function buildWebSearchTool(settings: AppSettings) {
  const def = effectiveWebSearchDefaultTopK(settings);
  const max = effectiveWebSearchMaxTopK(settings);
  return {
    type: "function",
    function: {
      name: "web_search",
      description:
        "搜索公开互联网，返回标题、链接与摘要。时事、新闻、政策、价格等时效问题应优先调用。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language search query." },
          topK: {
            type: "integer",
            description: `Number of results (1-${max}, default ${def}).`,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  };
}

const WEB_FETCH_TOOL = {
  type: "function",
  function: {
    name: "web_fetch",
    description: "抓取 URL 页面正文。web_search 摘要不够时使用。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http:// or https:// URL." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
};

const RUN_PYTHON_TOOL = {
  type: "function",
  function: {
    name: "run_python",
    description:
      "在受限沙盒中运行 Python 3（标准库白名单，禁止读写文件与联网）。" +
      "用于数学计算、统计分析、验证逻辑；可用 print() 输出，" +
      "或写表达式作为最后一行自动返回结果。",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Python source code to run. Use print() for output.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
};

type ToolHandler = (
  args: Record<string, unknown>,
  settings: AppSettings,
) => Promise<string>;

const BUILTIN_HANDLERS: Record<string, ToolHandler> = {
  get_current_time: async () => new Date().toISOString(),
  web_search: async (args, settings) => {
    const query = String(args.query ?? "").trim();
    const topK = resolveWebSearchTopK(settings, args.topK);
    return webSearchForTool(query, settings, topK);
  },
  web_fetch: async (args) => {
    const url = String(args.url ?? "").trim();
    return webFetchForTool(url);
  },
  run_python: async (args, settings) => {
    const code = String(args.code ?? "");
    try {
      return await runPython(code, settings.pythonSandboxTimeout);
    } catch (err) {
      if (err instanceof SandboxError) {
        throw new ToolError(err.message);
      }
      throw new ToolError(String(err));
    }
  },
};

function parseToolArgs(argumentsJson: string): Record<string, unknown> {
  try {
    const payload = JSON.parse(argumentsJson.trim() || "{}") as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new ToolError("工具参数必须是 JSON 对象。");
    }
    return payload as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError("工具参数不是合法 JSON。");
  }
}

export function buildTools(
  settings: AppSettings,
): Array<Record<string, unknown>> | null {
  if (!settings.toolsEnabled) return null;
  const tools: Array<Record<string, unknown>> = [...BUILTIN_TOOLS];
  if (settings.toolsWebSearch) {
    tools.push(buildWebSearchTool(settings), WEB_FETCH_TOOL);
    if (settings.apiProvider === "poe") {
      tools.push({ type: "web_search_preview" });
    }
  }
  if (settings.toolsPythonSandbox) {
    tools.push(RUN_PYTHON_TOOL);
  }
  const raw = settings.toolsCustomJson.trim();
  if (raw) {
    try {
      const extra = JSON.parse(raw) as unknown;
      if (!Array.isArray(extra)) {
        throw new ToolError("自定义工具 JSON 必须是数组。");
      }
      tools.push(...(extra as Array<Record<string, unknown>>));
    } catch (err) {
      throw new ToolError(
        err instanceof ToolError
          ? err.message
          : `自定义工具 JSON 无效：${String(err)}`,
      );
    }
  }
  return tools.length ? tools : null;
}

export async function executeTool(
  name: string,
  argumentsJson: string,
  settings: AppSettings,
): Promise<string> {
  const payload = parseToolArgs(argumentsJson);

  const custom = customToolExtensions(settings).get(name);
  if (custom) {
    return executeCustomTool(name, payload, custom);
  }

  const handler = BUILTIN_HANDLERS[name];
  if (handler) {
    return handler(payload, settings);
  }

  throw new ToolError(
    `未知工具：${name}。可在自定义工具 JSON 中添加 x-apiinphone 扩展以配置 HTTP/JS 处理器。`,
  );
}

export function toolStatusLabel(
  phase: "start" | "done" | "error",
  name: string,
  args = "",
): string {
  if (phase === "start") return runningLabel(name, args);
  if (phase === "done") return doneLabel(name);
  return errorLabel(name);
}

export type { ChatMessage };
