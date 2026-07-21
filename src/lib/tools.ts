import type { AppSettings, ChatMessage } from "../types";
import {
  customToolExtensions,
  executeCustomTool,
} from "./customTools";
import {
  formatExportToolResult,
  saveExportedFile,
  type ExportFormat,
  type ExportedFile,
} from "./documentExport";
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

export interface ToolExecutionResult {
  content: string;
  exportedFile?: ExportedFile;
}

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

const SAVE_DOCUMENT_TOOL = {
  type: "function",
  function: {
    name: "save_document",
    description:
      "将内容保存到手机本地导出目录。" +
      "支持 txt / docx / pdf，以及 excalidraw（表格白板，生成 .excalidraw 文件）。" +
      "用户要求导出、保存、下载、生成 Word/PDF/文本/Excalidraw 表格时必须调用。" +
      "Excalidraw 表格请传 format=excalidraw，并用 rows 二维数组（首行可为表头）；也可用 content 传 JSON 二维数组或 TSV。" +
      "保存后用户可在界面点击「打开」或「发送」。手机端可发送到电脑后在 https://excalidraw.com 打开。",
    parameters: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "文件名（可无扩展名）",
        },
        format: {
          type: "string",
          enum: ["txt", "docx", "pdf", "excalidraw"],
          description: "文件格式；excalidraw 用于表格白板",
        },
        content: {
          type: "string",
          description:
            "正文。format=excalidraw 时可省略（若已传 rows）；也可为 JSON 二维数组或 TSV 文本。",
        },
        rows: {
          type: "array",
          description:
            "仅 excalidraw：二维字符串数组，如 [[\"姓名\",\"分数\"],[\"张三\",\"90\"]]",
          items: {
            type: "array",
            items: { type: "string" },
          },
        },
        title: {
          type: "string",
          description: "可选标题（docx/pdf/excalidraw 表格上方标题）",
        },
      },
      required: ["filename", "format"],
      additionalProperties: false,
    },
  },
};

function buildWebSearchTool(settings: AppSettings) {
  const def = effectiveWebSearchDefaultTopK(settings);
  const max = effectiveWebSearchMaxTopK(settings);
  return {
    type: "function",
    function: {
      name: "web_search",
      description:
        "搜索公开互联网，返回带 [1][2]… 编号的标题、链接与摘要。回答正文只能用 [1][2] 引用，不要用 [标题](url)。",
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
) => Promise<string | ToolExecutionResult>;

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
  save_document: async (args, settings) => {
    const format = String(args.format ?? "txt").toLowerCase() as ExportFormat;
    if (
      format !== "txt" &&
      format !== "docx" &&
      format !== "pdf" &&
      format !== "excalidraw"
    ) {
      throw new ToolError("format 必须是 txt、docx、pdf 或 excalidraw。");
    }
    const filename = String(args.filename ?? "").trim();
    if (!filename) throw new ToolError("缺少 filename。");
    const content = args.content != null ? String(args.content) : "";
    const rows = args.rows;
    if (format === "excalidraw") {
      if (
        rows == null &&
        !content.trim()
      ) {
        throw new ToolError("excalidraw 需提供 rows 二维数组或 content（JSON/TSV）。");
      }
    } else if (!content.trim()) {
      throw new ToolError("content 不能为空。");
    }
    try {
      const file = await saveExportedFile(settings, {
        filename,
        format,
        content,
        title: args.title != null ? String(args.title) : undefined,
        rows,
      });
      return {
        content: formatExportToolResult(file),
        exportedFile: file,
      };
    } catch (err) {
      throw new ToolError(
        err instanceof Error ? err.message : `保存失败：${String(err)}`,
      );
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
  const tools: Array<Record<string, unknown>> = [
    ...BUILTIN_TOOLS,
    SAVE_DOCUMENT_TOOL,
  ];
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
): Promise<ToolExecutionResult> {
  const payload = parseToolArgs(argumentsJson);

  const custom = customToolExtensions(settings).get(name);
  if (custom) {
    return { content: await executeCustomTool(name, payload, custom) };
  }

  const handler = BUILTIN_HANDLERS[name];
  if (handler) {
    const out = await handler(payload, settings);
    if (typeof out === "string") return { content: out };
    return out;
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
  if (phase === "done") return doneLabel(name, args);
  return errorLabel(name);
}

export type { ChatMessage };
