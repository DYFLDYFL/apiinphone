import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import type {
  GameAttributeDefinition,
  GameIndex,
  GameSettings,
  GameState,
} from "./types";
import {
  characterSystemPrompt,
  chroniclerSystemPrompt,
  refereeSystemPrompt,
  worldSystemPrompt,
} from "./prompts";
import {
  createTemplateGame,
  defaultContextFiles,
  defaultGameRunSettings,
  formatGameClock,
  defaultWorldMapForGenre,
  normalizeGameDateTime,
  inferAttributeDefinitions,
} from "./templates";
import { normalizePipeline } from "./pipeline";
import { normalizeWorldMap } from "./map";

function sanitizeStoryText(text: string): string {
  return text
    .replace(/\s*FINISHED(?:_WITH_ERROR)?\s*/gi, "")
    .replace(/\s*\[DONE\]\s*/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trimEnd();
}

export { sanitizeStoryText };

const GAMES_DIR = "games";
const INDEX_FILE = `${GAMES_DIR}/index.json`;

async function ensureDir(path = GAMES_DIR): Promise<void> {
  try {
    await Filesystem.mkdir({
      path,
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
    recursive: true,
  });
}

async function removePath(path: string, dir = false): Promise<void> {
  try {
    if (dir) {
      await Filesystem.rmdir({
        path,
        directory: Directory.Data,
        recursive: true,
      });
    } else {
      await Filesystem.deleteFile({
        path,
        directory: Directory.Data,
      });
    }
  } catch {
    /* ignore */
  }
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

/** 每局一个文件夹：games/{id}/ */
function gameDir(id: string): string {
  return `${GAMES_DIR}/${id}`;
}

function gameJsonPath(id: string): string {
  return `${gameDir(id)}/game.json`;
}

function tickPad(tick: number): string {
  return String(Math.max(0, Math.round(tick))).padStart(3, "0");
}

function tickStoryPath(
  id: string,
  tick: number,
  kind: "god" | "player" | `personal-${string}`,
): string {
  return `${gameDir(id)}/ticks/${tickPad(tick)}-${kind}.txt`;
}

function normalizeGameSettings(raw: Partial<GameSettings> | undefined): GameSettings {
  const base = defaultGameRunSettings(
    typeof raw?.characterCount === "number" ? raw.characterCount : 3,
  );
  return {
    characterCount: base.characterCount,
    weekCycleEnabled: Boolean(raw?.weekCycleEnabled),
    pipeline: normalizePipeline(raw?.pipeline),
  };
}

function normalizeGame(game: GameState): GameState {
  if (!Array.isArray(game.events)) game.events = [];
  if (!Array.isArray(game.agents)) game.agents = [];
  if (!Array.isArray(game.sheets)) game.sheets = [];
  const inferredAttributes = inferAttributeDefinitions(
    game.sheets.map((sheet) => sheet.attrs ?? {}),
  );
  const savedAttributes = Array.isArray(
    (game as Partial<GameState>).attributeDefinitions,
  )
    ? (game as Partial<GameState>).attributeDefinitions ?? []
    : [];
  game.attributeDefinitions = inferredAttributes.map((fallback) => {
    const saved = savedAttributes.find((item) => item.key === fallback.key);
    return saved
      ? {
          key: fallback.key,
          label: saved.label?.trim() || fallback.label,
          valueType: saved.valueType === "text" ? "text" : fallback.valueType,
          numberOptions: undefined,
          textOptions:
            saved.valueType === "text"
              ? Array.isArray(saved.textOptions)
                ? Array.from(
                    new Set([
                      ...(fallback.textOptions ?? []),
                      ...saved.textOptions.filter((value) => typeof value === "string"),
                    ]),
                  )
                : fallback.textOptions
              : undefined,
        }
      : fallback;
  });
  for (const saved of savedAttributes as GameAttributeDefinition[]) {
    if (
      saved &&
      typeof saved.key === "string" &&
      saved.key.trim() &&
      !game.attributeDefinitions.some((item) => item.key === saved.key)
    ) {
      game.attributeDefinitions.push({
        key: saved.key.trim(),
        label: saved.label?.trim() || saved.key.trim(),
        valueType: saved.valueType === "text" ? "text" : "number",
        numberOptions: undefined,
        textOptions:
          saved.valueType === "text" && Array.isArray(saved.textOptions)
            ? saved.textOptions.filter((value) => typeof value === "string")
            : undefined,
      });
    }
  }
  game.settings = normalizeGameSettings(game.settings);
  if (typeof game.worldview !== "string") {
    game.worldview = "";
  }
  if (
    !game.worldMap ||
    typeof game.worldMap !== "object" ||
    !game.worldMap.cells
  ) {
    game.worldMap = defaultWorldMapForGenre(game.worldview);
  } else {
    game.worldMap = normalizeWorldMap(game.worldMap);
  }
  if (!game.worldClock) {
    const dateTime = normalizeGameDateTime(undefined);
    const timeText = formatGameClock(
      dateTime,
      game.settings.weekCycleEnabled,
    );
    game.worldClock = {
      tick: 0,
      label: timeText,
      timeText,
      description: dateTime.description,
      dateTime,
      sceneSummary: "",
    };
  } else {
    const tick = Number(game.worldClock.tick);
    game.worldClock.tick = Number.isNaN(tick) || tick < 0 ? 0 : Math.round(tick);
    if (typeof game.worldClock.sceneSummary !== "string") {
      game.worldClock.sceneSummary = "";
    }
    game.worldClock.dateTime = normalizeGameDateTime(game.worldClock.dateTime);
    const timeText = formatGameClock(
      game.worldClock.dateTime,
      game.settings.weekCycleEnabled,
    );
    game.worldClock.timeText = timeText;
    game.worldClock.label = timeText;
    if (
      !game.worldClock.history ||
      typeof game.worldClock.history !== "object"
    ) {
      game.worldClock.history = {};
    }
    const key = String(game.worldClock.tick);
    if (!game.worldClock.history[key]) {
      game.worldClock.history[key] = timeText;
    }
    game.worldClock.description =
      game.worldClock.dateTime.description || "当前时刻";
  }
  if (!Array.isArray(game.contextFiles)) {
    game.contextFiles = defaultContextFiles(
      game.worldview,
      game.worldClock.timeText || game.worldClock.label,
    );
  } else {
    game.contextFiles = game.contextFiles
      .filter(
        (file) =>
          file &&
          typeof file.id === "string" &&
          typeof file.title === "string" &&
          typeof file.content === "string",
      )
      .map((file) => ({ id: file.id, title: file.title, content: file.content }));
    if (!game.contextFiles.length) {
      game.contextFiles = defaultContextFiles(
        game.worldview,
        game.worldClock.timeText || game.worldClock.label,
      );
    }
  }
  const allFileIds = game.contextFiles.map((file) => file.id);
  const publicFileIds = game.contextFiles
    .filter((file) => file.id !== "clues")
    .map((file) => file.id);
  for (const agent of game.agents) {
    agent.readableFileIds =
      Array.isArray(agent.readableFileIds)
        ? agent.readableFileIds.filter((id) => allFileIds.includes(id))
        : [...publicFileIds];
    agent.editableFileIds = Array.isArray(agent.editableFileIds)
      ? agent.editableFileIds.filter((id) => agent.readableFileIds?.includes(id))
      : [];
  }
  if (game.tickBuffer === undefined) game.tickBuffer = null;
  if (game.tickBuffer) {
    const st = game.tickBuffer.status as string;
    if (
      st !== "need_open" &&
      st !== "running" &&
      st !== "completed" &&
      st !== "interrupted"
    ) {
      game.tickBuffer.status = "running";
    }
  }
  if (game.playMode !== "play") game.playMode = "spectate";
  if (typeof game.playerCharacterId !== "string") {
    game.playerCharacterId = null;
  } else {
    const ok = game.agents.some(
      (a) => a.kind === "character" && a.id === game.playerCharacterId,
    );
    if (!ok) game.playerCharacterId = null;
  }
  if (game.playMode === "play" && !game.playerCharacterId) {
    const first = game.agents.find((a) => a.kind === "character");
    game.playerCharacterId = first?.id ?? null;
    if (!game.playerCharacterId) game.playMode = "spectate";
  }
  if (typeof game.godStory !== "string") game.godStory = "";
  if (typeof game.playerStory !== "string") game.playerStory = "";
  game.godStory = sanitizeStoryText(game.godStory);
  game.playerStory = sanitizeStoryText(game.playerStory);
  if (
    !game.personalStories ||
    typeof game.personalStories !== "object" ||
    Array.isArray(game.personalStories)
  ) {
    game.personalStories = {};
  } else {
    game.personalStories = Object.fromEntries(
      Object.entries(game.personalStories).map(([key, value]) => [
        key,
        sanitizeStoryText(typeof value === "string" ? value : ""),
      ]),
    );
  }
  for (const agent of game.agents) {
    if (agent.kind === "character" && agent.characterId) {
      if (typeof game.personalStories[agent.characterId] !== "string") {
        game.personalStories[agent.characterId] = "";
      }
    }
  }
  {
    const n = Number(game.storyTick);
    // -1 = 仅有开场种子、尚未归档任何时段剧情
    game.storyTick = Number.isNaN(n) ? -1 : Math.max(-1, Math.round(n));
  }
  if (typeof game.godViewUnlocked !== "boolean") {
    game.godViewUnlocked = game.playMode !== "play";
  }
  if (game.playMode === "spectate") {
    game.godViewUnlocked = true;
  }
  for (const e of game.events) {
    if (e.audience !== "private") e.audience = "public";
    if (!Array.isArray(e.visibleTo)) e.visibleTo = [];
  }
  for (const a of game.agents) {
    const rawCapabilities = (a as GameState["agents"][number]).capabilities;
    a.capabilities = Array.isArray(rawCapabilities)
      ? rawCapabilities.filter((feature) =>
          [
            "world_open",
            "propose",
            "respond",
            "judge",
            "chronicle",
            "advance_clock",
          ].includes(feature),
        )
      : [];
    if (a.attributePermissions && typeof a.attributePermissions === "object") {
      a.attributePermissions = Object.fromEntries(
        Object.entries(a.attributePermissions).map(([key, value]) => [
          key,
          {
            read: Boolean(value?.read),
            set: Boolean(value?.set),
            add: Boolean(value?.add),
            remove: Boolean(value?.remove),
          },
        ]),
      );
    }
    const override = a.systemPromptOverride?.trim();
    if (override) {
      a.systemPrompt = override;
      continue;
    }
    if (a.capabilities.includes("judge")) {
      a.systemPrompt = refereeSystemPrompt(a.persona);
    } else if (a.kind === "character") {
      a.systemPrompt = characterSystemPrompt(a.name, a.persona);
    } else if (a.capabilities.includes("world_open")) {
      a.systemPrompt = worldSystemPrompt(game.worldview || a.persona);
    } else if (a.capabilities.includes("chronicle")) {
      a.systemPrompt = chroniclerSystemPrompt("god");
    }
  }
  return game;
}

/** 从 ticks/*.txt 重建剧情（按 tick 归档，推进时只增不删）。 */
async function loadStoriesFromTicks(
  id: string,
): Promise<{ godStory: string; playerStory: string } | null> {
  let names: string[] = [];
  try {
    const listing = await Filesystem.readdir({
      path: `${gameDir(id)}/ticks`,
      directory: Directory.Data,
    });
    names = (listing.files ?? [])
      .map((f) => (typeof f === "string" ? f : f.name))
      .filter(Boolean);
  } catch {
    return null;
  }
  if (!names.length) return null;

  const readParts = async (files: string[]) => {
    const parts: string[] = [];
    for (const name of files) {
      const text = await readText(`${gameDir(id)}/ticks/${name}`);
      if (text?.trim()) parts.push(text.trim());
    }
    return parts.join("\n\n");
  };

  const openingGod = names.includes("opening-god.txt")
    ? ["opening-god.txt"]
    : [];
  const openingPlayer = names.includes("opening-player.txt")
    ? ["opening-player.txt"]
    : [];
  const gods = [
    ...openingGod,
    ...names.filter((n) => /^\d+-god\.txt$/.test(n)).sort(),
  ];
  const players = [
    ...openingPlayer,
    ...names.filter((n) => /^\d+-player\.txt$/.test(n)).sort(),
  ];

  if (!gods.length && !players.length) return null;
  return {
    godStory: sanitizeStoryText(await readParts(gods)),
    playerStory: sanitizeStoryText(await readParts(players)),
  };
}

/**
 * 归档某一时的剧情片段（只写/覆盖该 tick 文件，不碰其它时）。
 */
export async function archiveStoryTick(options: {
  gameId: string;
  tick: number;
  label: string;
  kind: "god" | "player" | `personal-${string}`;
  body: string;
}): Promise<void> {
  const body = sanitizeStoryText(options.body).trim();
  if (!body) return;
  const label = options.label.trim() || `时刻 ${options.tick}`;
  const hasHeader = /——\s*.+\s*——/.test(body);
  const text = hasHeader ? `${body}\n` : `—— ${label} ——\n${body}\n`;
  await writeText(tickStoryPath(options.gameId, options.tick, options.kind), text);
}

export async function archiveOpeningStory(options: {
  gameId: string;
  label: string;
  kind: "god" | "player";
  body: string;
}): Promise<void> {
  const body = sanitizeStoryText(options.body).trim();
  if (!body) return;
  const label = options.label.trim() || "开场";
  const hasHeader = /——\s*.+\s*——/.test(body);
  const text = hasHeader ? `${body}\n` : `—— ${label} ——\n${body}\n`;
  await writeText(
    `${gameDir(options.gameId)}/ticks/opening-${options.kind}.txt`,
    text,
  );
}

/** 若尚无 ticks，把已有长文按「—— … ——」拆成归档，避免之后只有新 tick。 */
export async function ensureStoryTicksBootstrapped(game: GameState): Promise<void> {
  const existing = await loadStoriesFromTicks(game.id);
  if (existing && (existing.godStory.trim() || existing.playerStory.trim())) {
    return;
  }
  const splitSync = async (full: string, kind: "god" | "player") => {
    const text = full.trim();
    if (!text) return;
    const parts = text
      .split(/(?=——\s*.+?\s*——)/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) {
      await archiveOpeningStory({
        gameId: game.id,
        label: game.worldClock.timeText || "开场",
        kind,
        body: text,
      });
      return;
    }
    await archiveOpeningStory({
      gameId: game.id,
      label: "开场",
      kind,
      body: parts[0],
    });
    for (let i = 1; i < parts.length; i++) {
      await archiveStoryTick({
        gameId: game.id,
        tick: i - 1,
        label: `时刻 ${i - 1}`,
        kind,
        body: parts[i],
      });
    }
  };
  await splitSync(game.godStory, "god");
  await splitSync(game.playerStory, "player");
}

async function writeStoryMirrors(game: GameState): Promise<void> {
  const dir = gameDir(game.id);
  await writeText(`${dir}/god-story.txt`, game.godStory || "");
  await writeText(`${dir}/player-story.txt`, game.playerStory || "");
  await writeText(
    `${dir}/personal-stories.json`,
    JSON.stringify(game.personalStories ?? {}, null, 2),
  );
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
  const raw = await readText(gameJsonPath(id));
  if (!raw) return null;
  try {
    const game = normalizeGame(JSON.parse(raw) as GameState);
    const fromTicks = await loadStoriesFromTicks(id);
    if (fromTicks) {
      // 仅当归档不短于内存/json 时才采用，避免半截 ticks 冲掉旧剧情
      if (
        fromTicks.godStory.trim().length >= game.godStory.trim().length
      ) {
        game.godStory = fromTicks.godStory;
      }
      if (
        fromTicks.playerStory.trim().length >= game.playerStory.trim().length
      ) {
        game.playerStory = fromTicks.playerStory;
      }
    } else {
      // 镜像文件兜底
      const godMirror = await readText(`${gameDir(id)}/god-story.txt`);
      const playerMirror = await readText(`${gameDir(id)}/player-story.txt`);
      if (godMirror && godMirror.trim().length >= game.godStory.trim().length) {
        game.godStory = sanitizeStoryText(godMirror);
      }
      if (
        playerMirror &&
        playerMirror.trim().length >= game.playerStory.trim().length
      ) {
        game.playerStory = sanitizeStoryText(playerMirror);
      }
    }
    return game;
  } catch {
    return null;
  }
}

export async function saveGame(game: GameState): Promise<void> {
  game.updatedAt = new Date().toISOString();
  await ensureDir(gameDir(game.id));
  await ensureDir(`${gameDir(game.id)}/ticks`);
  await writeText(gameJsonPath(game.id), JSON.stringify(game, null, 2));
  await writeStoryMirrors(game);
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
  await removePath(gameDir(id), true);
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
