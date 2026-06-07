import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import type { ChatSession } from "../types";

const SESSIONS_DIR = "sessions";
const INDEX_FILE = `${SESSIONS_DIR}/index.json`;

interface SessionIndex {
  activeId: string;
  order: string[];
  meta: Record<string, { title: string; updatedAt: string }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function titleFromFirstMessage(text: string, maxLen = 28): string {
  const oneLine = text.trim().replace(/\s+/g, " ");
  if (!oneLine) return "新对话";
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 1)}…`;
}

function createSession(title = "新对话"): ChatSession {
  const now = nowIso();
  return {
    id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
    title,
    createdAt: now,
    updatedAt: now,
    history: [],
    display: [],
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    contextTokens: 0,
    cacheHitTokens: 0,
  };
}

async function ensureDir(): Promise<void> {
  try {
    await Filesystem.mkdir({
      path: SESSIONS_DIR,
      directory: Directory.Data,
      recursive: true,
    });
  } catch {
    /* already exists */
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    const result = await Filesystem.readFile({
      path,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    return typeof result.data === "string" ? result.data : null;
  } catch {
    return null;
  }
}

async function writeText(path: string, content: string): Promise<void> {
  await ensureDir();
  await Filesystem.writeFile({
    path,
    directory: Directory.Data,
    data: content,
    encoding: Encoding.UTF8,
    recursive: true,
  });
}

async function loadIndex(): Promise<SessionIndex> {
  const raw = await readText(INDEX_FILE);
  if (!raw) {
    return { activeId: "", order: [], meta: {} };
  }
  try {
    const parsed = JSON.parse(raw) as SessionIndex;
    return {
      activeId: parsed.activeId ?? "",
      order: parsed.order ?? [],
      meta: parsed.meta ?? {},
    };
  } catch {
    return { activeId: "", order: [], meta: {} };
  }
}

async function saveIndex(index: SessionIndex): Promise<void> {
  await writeText(INDEX_FILE, JSON.stringify(index, null, 2));
}

function sessionPath(id: string): string {
  return `${SESSIONS_DIR}/${id}.json`;
}

export async function loadSession(id: string): Promise<ChatSession | null> {
  const raw = await readText(sessionPath(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ChatSession;
  } catch {
    return null;
  }
}

export async function saveSession(session: ChatSession): Promise<void> {
  session.updatedAt = nowIso();
  await writeText(sessionPath(session.id), JSON.stringify(session, null, 2));
  const index = await loadIndex();
  if (!index.order.includes(session.id)) {
    index.order.push(session.id);
  }
  index.meta[session.id] = {
    title: session.title,
    updatedAt: session.updatedAt,
  };
  await saveIndex(index);
}

export async function listSessions(): Promise<
  Array<{ id: string; title: string; updatedAt: string }>
> {
  const index = await loadIndex();
  return [...index.order]
    .reverse()
    .map((id) => {
      const meta = index.meta[id];
      return {
        id,
        title: meta?.title ?? "新对话",
        updatedAt: meta?.updatedAt ?? "",
      };
    });
}

export async function loadActiveSession(): Promise<ChatSession> {
  const index = await loadIndex();
  if (index.activeId) {
    const session = await loadSession(index.activeId);
    if (session) return session;
  }
  if (index.order.length) {
    const session = await loadSession(index.order[index.order.length - 1]);
    if (session) return session;
  }
  return createNewSession();
}

export async function setActiveSession(id: string): Promise<void> {
  const index = await loadIndex();
  index.activeId = id;
  if (!index.order.includes(id)) {
    index.order.push(id);
  }
  await saveIndex(index);
}

export async function createNewSession(title = "新对话"): Promise<ChatSession> {
  const session = createSession(title);
  const index = await loadIndex();
  index.order.push(session.id);
  index.activeId = session.id;
  index.meta[session.id] = {
    title: session.title,
    updatedAt: session.updatedAt,
  };
  await saveSession(session);
  await saveIndex(index);
  return session;
}

export async function deleteSession(id: string): Promise<ChatSession | null> {
  try {
    await Filesystem.deleteFile({
      path: sessionPath(id),
      directory: Directory.Data,
    });
  } catch {
    /* ignore */
  }
  const index = await loadIndex();
  index.order = index.order.filter((sid) => sid !== id);
  delete index.meta[id];
  if (!index.order.length) {
    const session = await createNewSession();
    return session;
  }
  if (index.activeId === id) {
    index.activeId = index.order[index.order.length - 1];
  }
  await saveIndex(index);
  return loadSession(index.activeId);
}

export async function renameSession(
  id: string,
  title: string,
): Promise<ChatSession | null> {
  const session = await loadSession(id);
  if (!session) return null;
  session.title = title.trim() || "新对话";
  await saveSession(session);
  return session;
}
