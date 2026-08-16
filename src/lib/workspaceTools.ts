import type { ToolExecutionResult } from "./tools";
import type { AppSettings } from "../types";
import {
  deleteLocalFile,
  listLocalFiles,
  listLocalFilesRecursive,
  readLocalFile,
  writeLocalFile,
} from "./workspaceStore";
import {
  getFileContent,
  getFileTree,
  gitBlobSha,
  pullFiles,
  pushFiles,
  putFileContent,
} from "./githubApi";
import type { WorkspaceRepo } from "./workspaceStore";

export interface WorkspaceToolsOptions {
  workspaceId: string;
  repo?: WorkspaceRepo | null;
  githubToken?: string;
  allowRead?: boolean;
  allowWrite?: boolean;
  allowGithub?: boolean;
}

interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 工作区文件工具声明（与内置工具一起注入 chatStream）。 */
export function buildWorkspaceToolDefs(
  options: WorkspaceToolsOptions,
): ToolSpec[] {
  const defs: ToolSpec[] = [];
  if (options.allowRead !== false) {
    defs.push({
      type: "function",
      function: {
        name: "workspace_list",
        description:
          "列出工作区项目内某目录下的文件与子目录（单层）。dir 留空列出根目录。",
        parameters: {
          type: "object",
          properties: { dir: { type: "string", description: "子目录路径，可空" } },
        },
      },
    });
    defs.push({
      type: "function",
      function: {
        name: "workspace_read",
        description:
          "读取工作区项目内一个文本文件的内容（UTF-8）。path 是相对项目根的文件路径，如 src/main.ts。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件相对路径" },
          },
          required: ["path"],
        },
      },
    });
  }
  if (options.allowWrite !== false) {
    defs.push({
      type: "function",
      function: {
        name: "workspace_write",
        description:
          "写入（新建或覆盖）工作区项目内一个文本文件。path 相对项目根，自动创建父目录。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件相对路径" },
            content: { type: "string", description: "完整文件内容" },
          },
          required: ["path", "content"],
        },
      },
    });
    defs.push({
      type: "function",
      function: {
        name: "workspace_delete",
        description: "删除工作区项目内的一个文件。path 相对项目根。",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "文件相对路径" } },
          required: ["path"],
        },
      },
    });
  }
  if (options.allowGithub && options.repo && options.githubToken) {
    defs.push({
      type: "function",
      function: {
        name: "github_commit",
        description:
          "把工作区本地文件内容提交到已连接的 GitHub 仓库的当前分支（按路径覆盖或新建，自动带提交信息）。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "仓库内文件路径" },
            content: { type: "string", description: "完整文件内容" },
            message: { type: "string", description: "提交信息，可空" },
          },
          required: ["path", "content"],
        },
      },
    });
    defs.push({
      type: "function",
      function: {
        name: "github_pull",
        description:
          "把已连接 GitHub 仓库当前分支的全部文本文件拉取到工作区本地文件夹（覆盖同名文件，保留本地独有的文件）。二进制文件跳过。",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    });
    defs.push({
      type: "function",
      function: {
        name: "github_push",
        description:
          "把工作区本地文件夹的全部文本文件与 GitHub 仓库对比，有变化或新增的文件一次性批量提交（一条 commit）。本地删除的文件不会在仓库删除。",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "提交信息，可空" },
          },
        },
      },
    });
  }
  return defs;
}

/** 工作区文件工具执行器（与工具声明一一对应）。 */
export function buildWorkspaceToolHandlers(
  options: WorkspaceToolsOptions,
): Record<
  string,
  (
    args: Record<string, unknown>,
    settings: AppSettings,
    signal?: AbortSignal,
  ) => Promise<ToolExecutionResult>
> {
  const handlers: Record<
    string,
    (
      args: Record<string, unknown>,
      settings: AppSettings,
      signal?: AbortSignal,
    ) => Promise<ToolExecutionResult>
  > = {};
  const { workspaceId, repo, githubToken } = options;

  if (options.allowRead !== false) {
    handlers.workspace_list = async (args) => {
      const dir = String(args.dir ?? "").trim();
      const entries = await listLocalFiles(workspaceId, dir);
      if (!entries.length) return { content: "（目录为空）" };
      return {
        content: entries
          .map((entry) => `${entry.type === "directory" ? "[目录]" : "[文件]"} ${entry.name}`)
          .join("\n"),
      };
    };
    handlers.workspace_read = async (args) => {
      const path = String(args.path ?? "").trim();
      if (!path) return { content: "错误：缺少 path 参数" };
      const content = await readLocalFile(workspaceId, path);
      if (content === null) return { content: `错误：文件不存在（${path}）` };
      return { content };
    };
  }

  if (options.allowWrite !== false) {
    handlers.workspace_write = async (args) => {
      const path = String(args.path ?? "").trim();
      const content = String(args.content ?? "");
      if (!path) return { content: "错误：缺少 path 参数" };
      await writeLocalFile(workspaceId, path, content);
      return { content: `已写入 ${path}（${content.length} 字符）` };
    };
    handlers.workspace_delete = async (args) => {
      const path = String(args.path ?? "").trim();
      if (!path) return { content: "错误：缺少 path 参数" };
      await deleteLocalFile(workspaceId, path);
      return { content: `已删除 ${path}` };
    };
  }

  if (options.allowGithub && repo && githubToken) {
    handlers.github_commit = async (args) => {
      const path = String(args.path ?? "").trim();
      const content = String(args.content ?? "");
      const message = String(args.message ?? "").trim() || `Update ${path}`;
      if (!path) return { content: "错误：缺少 path 参数" };
      let sha: string | undefined;
      try {
        const existing = await getFileContent(
          githubToken,
          repo.owner,
          repo.repo,
          path,
          repo.branch,
        );
        sha = existing.sha || undefined;
      } catch {
        /* 新文件无 sha */
      }
      await putFileContent(githubToken, repo.owner, repo.repo, path, message, content, sha);
      return { content: `已提交到 ${repo.owner}/${repo.repo}（${repo.branch}）: ${path}` };
    };

    handlers.github_pull = async () => {
      const files = await pullFiles(
        githubToken,
        repo.owner,
        repo.repo,
        repo.branch,
      );
      let written = 0;
      for (const file of files) {
        await writeLocalFile(workspaceId, file.path, file.content);
        written += 1;
      }
      return {
        content: `已从 ${repo.owner}/${repo.repo}（${repo.branch}）拉取 ${written} 个文件到本地`,
      };
    };

    handlers.github_push = async (args) => {
      const message =
        String(args.message ?? "").trim() ||
        "Update workspace from apiinphone";
      const localPaths = await listLocalFilesRecursive(workspaceId);
      const tree = await getFileTree(
        githubToken,
        repo.owner,
        repo.repo,
        repo.branch,
      );
      const repoBlobs = new Map(
        tree
          .filter((entry) => entry.type === "blob" && entry.sha)
          .map((entry) => [entry.path, entry.sha] as const),
      );
      const changed: Array<{ path: string; content: string }> = [];
      for (const path of localPaths) {
        const content = await readLocalFile(workspaceId, path);
        if (content === null) continue;
        const localSha = await gitBlobSha(content);
        if (repoBlobs.get(path) === localSha) continue;
        changed.push({ path, content });
      }
      if (!changed.length) {
        return { content: "本地与仓库一致，无改动可推送" };
      }
      const commitSha = await pushFiles(
        githubToken,
        repo.owner,
        repo.repo,
        repo.branch,
        message,
        changed,
      );
      return {
        content: `已推送 ${changed.length} 个文件到 ${repo.owner}/${repo.repo}（${repo.branch}）\n提交：${commitSha ?? ""}\n${changed
          .map((file) => `- ${file.path}`)
          .join("\n")}`,
      };
    };
  }

  return handlers;
}
