import { Preferences } from "@capacitor/preferences";
import type {
  GameAiPreset,
  GameTemplateDraft,
  GameTemplatePreset,
} from "./templates";

export type SavedWorldPreset = GameTemplatePreset & {
  origin: "custom";
  updatedAt: string;
  sourcePresetId?: string;
};

export type SavedAiPreset = GameAiPreset & {
  origin: "custom";
  updatedAt: string;
  sourcePresetId?: string;
};

const WORLD_PRESETS_KEY = "game_world_presets_v1";
const AI_PRESETS_KEY = "game_ai_presets_v1";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function customId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

async function readList<T>(key: string): Promise<T[]> {
  const result = await Preferences.get({ key });
  if (!result.value) return [];
  try {
    const parsed: unknown = JSON.parse(result.value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeList<T>(key: string, values: T[]): Promise<void> {
  await Preferences.set({ key, value: JSON.stringify(values) });
}

export async function loadSavedWorldPresets(): Promise<SavedWorldPreset[]> {
  return readList<SavedWorldPreset>(WORLD_PRESETS_KEY);
}

export async function loadSavedAiPresets(): Promise<SavedAiPreset[]> {
  return readList<SavedAiPreset>(AI_PRESETS_KEY);
}

export async function saveWorldPreset(input: {
  id?: string;
  title: string;
  genre?: string;
  description?: string;
  draft: GameTemplateDraft;
  sourcePresetId?: string;
}): Promise<SavedWorldPreset> {
  const values = await loadSavedWorldPresets();
  const existing = input.id ? values.find((item) => item.id === input.id) : undefined;
  const saved: SavedWorldPreset = {
    id: existing?.id ?? input.id ?? customId("world"),
    title: input.title.trim() || "未命名世界预设",
    genre: input.genre?.trim() || "自定义",
    description: input.description?.trim() || "本地自定义世界预设",
    draft: clone(input.draft),
    origin: "custom",
    updatedAt: new Date().toISOString(),
    sourcePresetId: input.sourcePresetId ?? existing?.sourcePresetId,
  };
  await writeList(
    WORLD_PRESETS_KEY,
    values.filter((item) => item.id !== saved.id).concat(saved),
  );
  return saved;
}

export async function saveAiPreset(input: {
  id?: string;
  title: string;
  genre?: string;
  description?: string;
  draft: GameAiPreset["draft"];
  sourcePresetId?: string;
}): Promise<SavedAiPreset> {
  const values = await loadSavedAiPresets();
  const existing = input.id ? values.find((item) => item.id === input.id) : undefined;
  const saved: SavedAiPreset = {
    id: existing?.id ?? input.id ?? customId("ai"),
    title: input.title.trim() || "未命名 AI 预设",
    genre: input.genre?.trim() || "自定义",
    description: input.description?.trim() || "本地自定义 AI 逻辑预设",
    draft: clone(input.draft),
    origin: "custom",
    updatedAt: new Date().toISOString(),
    sourcePresetId: input.sourcePresetId ?? existing?.sourcePresetId,
  };
  await writeList(
    AI_PRESETS_KEY,
    values.filter((item) => item.id !== saved.id).concat(saved),
  );
  return saved;
}

export async function deleteSavedWorldPreset(id: string): Promise<void> {
  const values = await loadSavedWorldPresets();
  await writeList(
    WORLD_PRESETS_KEY,
    values.filter((item) => item.id !== id),
  );
}

export async function deleteSavedAiPreset(id: string): Promise<void> {
  const values = await loadSavedAiPresets();
  await writeList(
    AI_PRESETS_KEY,
    values.filter((item) => item.id !== id),
  );
}
