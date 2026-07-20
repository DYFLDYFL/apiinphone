import { Preferences } from "@capacitor/preferences";
import type { ExportedFile } from "./documentExport";

const KEY = "exportHistory";
const MAX = 20;

export async function loadExportHistory(): Promise<ExportedFile[]> {
  const { value } = await Preferences.get({ key: KEY });
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as ExportedFile[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function pushExportHistory(
  file: ExportedFile,
): Promise<ExportedFile[]> {
  const prev = await loadExportHistory();
  const next = [file, ...prev.filter((f) => f.uri !== file.uri)].slice(0, MAX);
  await Preferences.set({ key: KEY, value: JSON.stringify(next) });
  return next;
}
