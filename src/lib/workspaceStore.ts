import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import type { ChatMessage } from "../types";

export const WORKSPACES_DIR = "Workspaces";
const META_FILE = `${WORKSPACES_DIR}/.meta.json`;

export interface WorkspaceRepo {
  owner: string;
  repo: string;
  branch: string;
}

export interface WorkspaceAgentTools {
  read: boolean;
  write: boolean;
  github: boolean;
  search: boolean;
  python: boolean;
}

export interface WorkspaceAgent {
  id: string;
  name: string;
  persona: string;
  providerId: string;
  model: string;
  /** 该助手的思考开关（缺省跟随工作区/全局）。 */
  thinkingMode?: "enabled" | "disabled";
  /** 该助手的推理档位（缺省跟随工作区/全局）。 */
  reasoningEffort?: "low" | "high" | "max";
  tools: WorkspaceAgentTools;
  history: ChatMessage[];
}

export interface WorkspaceMeta {
  id: string;
  name: string;
  createdAt: string;
  repo?: WorkspaceRepo;
  agents?: WorkspaceAgent[];
}

interface WorkspaceIndex {
  items: WorkspaceMeta[];
}

function nowIso(): string {
  return new Date().toISOString();
}

export function workspaceFolder(id: string): string {
  return `${WORKSPACES_DIR}/${id}`;
}

async function ensureRoot(): Promise<void> {
  try {
    await Filesystem.mkdir({
      path: WORKSPACES_DIR,
      directory: Directory.Documents,
      recursive: true,
    });
  } catch {
    /* exists */
  }
}

async function readIndex(): Promise<WorkspaceIndex> {
  try {
    const { data } = await Filesystem.readFile({
      path: META_FILE,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
    });
    const parsed = JSON.parse(String(data)) as Partial<WorkspaceIndex>;
    return { items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return { items: [] };
  }
}

async function writeIndex(index: WorkspaceIndex): Promise<void> {
  await ensureRoot();
  await Filesystem.writeFile({
    path: META_FILE,
    directory: Directory.Documents,
    data: JSON.stringify(index, null, 2),
    encoding: Encoding.UTF8,
    recursive: true,
  });
}

function sanitizeName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
}

export async function listWorkspaces(): Promise<WorkspaceMeta[]> {
  const index = await readIndex();
  return index.items;
}

export async function createWorkspace(rawName: string): Promise<WorkspaceMeta> {
  const name = sanitizeName(rawName);
  if (!name) throw new Error("工作区名称不能为空");
  const index = await readIndex();
  if (index.items.some((item) => item.name === name)) {
    throw new Error(`工作区「${name}」已存在`);
  }
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const meta: WorkspaceMeta = { id, name, createdAt: nowIso() };
  await Filesystem.mkdir({
    path: workspaceFolder(id),
    directory: Directory.Documents,
    recursive: true,
  });
  index.items = [...index.items, meta];
  await writeIndex(index);
  return meta;
}

export async function renameWorkspace(
  id: string,
  rawName: string,
): Promise<WorkspaceMeta> {
  const name = sanitizeName(rawName);
  if (!name) throw new Error("工作区名称不能为空");
  const index = await readIndex();
  const target = index.items.find((item) => item.id === id);
  if (!target) throw new Error("工作区不存在");
  if (index.items.some((item) => item.id !== id && item.name === name)) {
    throw new Error(`工作区「${name}」已存在`);
  }
  target.name = name;
  await writeIndex(index);
  return target;
}

export async function deleteWorkspace(id: string): Promise<void> {
  const index = await readIndex();
  index.items = index.items.filter((item) => item.id !== id);
  await writeIndex(index);
  try {
    await Filesystem.rmdir({
      path: workspaceFolder(id),
      directory: Directory.Documents,
      recursive: true,
    });
  } catch {
    /* folder may be missing */
  }
}

export async function setWorkspaceRepo(
  id: string,
  repo: WorkspaceRepo,
): Promise<void> {
  const index = await readIndex();
  const target = index.items.find((item) => item.id === id);
  if (!target) throw new Error("工作区不存在");
  target.repo = repo;
  await writeIndex(index);
}

export async function clearWorkspaceRepo(id: string): Promise<void> {
  const index = await readIndex();
  const target = index.items.find((item) => item.id === id);
  if (!target) throw new Error("工作区不存在");
  delete target.repo;
  await writeIndex(index);
}

function localPath(id: string, path: string): string {
  const clean = path.replace(/^\/+/, "").replace(/\/+/g, "/");
  return workspaceFolder(id) + (clean ? `/${clean}` : "");
}

export interface LocalFileEntry {
  name: string;
  type: "file" | "directory";
}

/** 列出工作区本地目录内容（单层，目录按需加载）。 */
export async function listLocalFiles(
  id: string,
  dir = "",
): Promise<LocalFileEntry[]> {
  try {
    const { files } = await Filesystem.readdir({
      path: localPath(id, dir),
      directory: Directory.Documents,
    });
    return files
      .map((entry) => ({
        name: entry.name,
        type: entry.type === "directory" ? ("directory" as const) : ("file" as const),
      }))
      .sort((a, b) =>
        a.type === b.type
          ? a.name.localeCompare(b.name)
          : a.type === "directory"
            ? -1
            : 1,
      );
  } catch {
    return [];
  }
}

/** 递归枚举工作区本地全部文件（相对路径列表，用于 push 同步）。 */
export async function listLocalFilesRecursive(
  id: string,
  dir = "",
): Promise<string[]> {
  const entries = await listLocalFiles(id, dir);
  const files: string[] = [];
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.type === "directory") {
      files.push(...(await listLocalFilesRecursive(id, rel)));
    } else {
      files.push(rel);
    }
  }
  return files;
}

/** 读取工作区本地文件内容（UTF-8），不存在返回 null。 */
export async function readLocalFile(
  id: string,
  path: string,
): Promise<string | null> {
  try {
    const { data } = await Filesystem.readFile({
      path: localPath(id, path),
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
    });
    return typeof data === "string" ? data : null;
  } catch {
    return null;
  }
}

/** 写入工作区本地文件（自动建目录）。 */
export async function writeLocalFile(
  id: string,
  path: string,
  content: string,
): Promise<void> {
  await Filesystem.writeFile({
    path: localPath(id, path),
    directory: Directory.Documents,
    data: content,
    encoding: Encoding.UTF8,
    recursive: true,
  });
}

/** 新建工作区本地文件（默认空内容）。 */
export async function createLocalFile(
  id: string,
  path: string,
  content = "",
): Promise<void> {
  await writeLocalFile(id, path, content);
}

/** 删除工作区本地文件。 */
export async function deleteLocalFile(id: string, path: string): Promise<void> {
  await Filesystem.deleteFile({
    path: localPath(id, path),
    directory: Directory.Documents,
  });
}

/** 新建工作区本地目录（自动建父目录）。 */
export async function createLocalDirectory(
  id: string,
  path: string,
): Promise<void> {
  await Filesystem.mkdir({
    path: localPath(id, path),
    directory: Directory.Documents,
    recursive: true,
  });
}

async function updateMeta(
  id: string,
  fn: (meta: WorkspaceMeta) => WorkspaceMeta,
): Promise<WorkspaceMeta> {
  const index = await readIndex();
  const target = index.items.find((item) => item.id === id);
  if (!target) throw new Error("工作区不存在");
  const next = fn(target);
  index.items = index.items.map((item) => (item.id === id ? next : item));
  await writeIndex(index);
  return next;
}

export async function listWorkspaceAgents(id: string): Promise<WorkspaceAgent[]> {
  const index = await readIndex();
  return index.items.find((item) => item.id === id)?.agents ?? [];
}

export async function saveWorkspaceAgent(
  id: string,
  agent: WorkspaceAgent,
): Promise<WorkspaceMeta> {
  return updateMeta(id, (meta) => {
    const agents = meta.agents ?? [];
    const existing = agents.findIndex((item) => item.id === agent.id);
    const nextAgents =
      existing >= 0
        ? agents.map((item) => (item.id === agent.id ? agent : item))
        : [...agents, agent];
    return { ...meta, agents: nextAgents };
  });
}

export async function deleteWorkspaceAgent(
  id: string,
  agentId: string,
): Promise<WorkspaceMeta> {
  return updateMeta(id, (meta) => ({
    ...meta,
    agents: (meta.agents ?? []).filter((item) => item.id !== agentId),
  }));
}

export async function appendWorkspaceAgentHistory(
  id: string,
  agentId: string,
  messages: ChatMessage[],
): Promise<void> {
  await updateMeta(id, (meta) => ({
    ...meta,
    agents: (meta.agents ?? []).map((agent) =>
      agent.id === agentId
        ? { ...agent, history: [...agent.history, ...messages].slice(-80) }
        : agent,
    ),
  }));
}
