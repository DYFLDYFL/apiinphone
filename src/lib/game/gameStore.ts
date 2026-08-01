import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import type { GameIndex, GameState } from "./types";
import { createTemplateGame } from "./templates";

const GAMES_DIR = "games";
const INDEX_FILE = `${GAMES_DIR}/index.json`;

async function ensureDir(): Promise<void> {
  try {
    await Filesystem.mkdir({
      path: GAMES_DIR,
      directory: Directory.Data,
      recursive: true,
    });
  } catch {
    /* exists */
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    const { data } = await Filesystem.readFile({
      path,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    return typeof data === "string" ? data : null;
  } catch {
    return null;
  }
}

async function writeText(path: string, text: string): Promise<void> {
  await ensureDir();
  await Filesystem.writeFile({
    path,
    directory: Directory.Data,
    data: text,
    encoding: Encoding.UTF8,
  });
}

function emptyIndex(): GameIndex {
  return { activeId: "", order: [], meta: {} };
}

async function loadIndex(): Promise<GameIndex> {
  const raw = await readText(INDEX_FILE);
  if (!raw) return emptyIndex();
  try {
    const parsed = JSON.parse(raw) as GameIndex;
    return {
      activeId: parsed.activeId ?? "",
      order: Array.isArray(parsed.order) ? parsed.order : [],
      meta: parsed.meta ?? {},
    };
  } catch {
    return emptyIndex();
  }
}

async function saveIndex(index: GameIndex): Promise<void> {
  await writeText(INDEX_FILE, JSON.stringify(index, null, 2));
}

function gamePath(id: string): string {
  return `${GAMES_DIR}/${id}.json`;
}

function normalizeGame(game: GameState): GameState {
  if (!Array.isArray(game.events)) game.events = [];
  if (!Array.isArray(game.agents)) game.agents = [];
  if (!Array.isArray(game.sheets)) game.sheets = [];
  if (!game.settings) {
    game.settings = { maxInteractionRounds: 6, characterCount: 3 };
  }
  if (typeof game.worldview !== "string") {
    game.worldview = "";
  }
  if (!game.worldClock) {
    game.worldClock = { tick: 0, label: "第 0 时", sceneSummary: "" };
  }
  if (game.tickBuffer === undefined) game.tickBuffer = null;
  return game;
}

export async function listGames(): Promise<
  Array<{ id: string; title: string; updatedAt: string; tick: number }>
> {
  const index = await loadIndex();
  return index.order
    .map((id) => {
      const m = index.meta[id];
      if (!m) return null;
      return {
        id,
        title: m.title,
        updatedAt: m.updatedAt,
        tick: m.tick ?? 0,
      };
    })
    .filter(Boolean) as Array<{
    id: string;
    title: string;
    updatedAt: string;
    tick: number;
  }>;
}

export async function loadGame(id: string): Promise<GameState | null> {
  const raw = await readText(gamePath(id));
  if (!raw) return null;
  try {
    return normalizeGame(JSON.parse(raw) as GameState);
  } catch {
    return null;
  }
}

export async function saveGame(game: GameState): Promise<void> {
  game.updatedAt = new Date().toISOString();
  await writeText(gamePath(game.id), JSON.stringify(game, null, 2));
  const index = await loadIndex();
  if (!index.order.includes(game.id)) index.order.unshift(game.id);
  index.activeId = game.id;
  index.meta[game.id] = {
    title: game.title,
    updatedAt: game.updatedAt,
    tick: game.worldClock.tick,
  };
  await saveIndex(index);
}

export async function createGame(
  draftOrTitle: import("./templates").GameTemplateDraft | string = "新游戏",
  characterCount = 3,
): Promise<GameState> {
  const game = createTemplateGame(draftOrTitle, characterCount);
  await saveGame(game);
  return game;
}

export async function deleteGame(id: string): Promise<void> {
  try {
    await Filesystem.deleteFile({
      path: gamePath(id),
      directory: Directory.Data,
    });
  } catch {
    /* ignore */
  }
  const index = await loadIndex();
  index.order = index.order.filter((gid) => gid !== id);
  delete index.meta[id];
  if (index.activeId === id) {
    index.activeId = index.order[0] ?? "";
  }
  await saveIndex(index);
}

export async function loadActiveGame(): Promise<GameState | null> {
  const index = await loadIndex();
  if (index.activeId) {
    const g = await loadGame(index.activeId);
    if (g) return g;
  }
  if (index.order.length) {
    return loadGame(index.order[0]);
  }
  return null;
}

export async function setActiveGame(id: string): Promise<GameState | null> {
  const game = await loadGame(id);
  if (!game) return null;
  const index = await loadIndex();
  index.activeId = id;
  await saveIndex(index);
  return game;
}
