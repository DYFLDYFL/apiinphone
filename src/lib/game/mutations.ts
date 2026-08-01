import { ATTR_LABELS } from "./templates";
import type { GameEvent, GameSheet, GameState, JudgeResult } from "./types";

function evtId(): string {
  return `evt_${Math.random().toString(36).slice(2, 10)}`;
}

export function applySheetPatches(
  game: GameState,
  patches: NonNullable<JudgeResult["sheetPatches"]>,
): Array<{ sheetId: string; patch: Record<string, unknown> }> {
  const diffs: Array<{ sheetId: string; patch: Record<string, unknown> }> = [];
  for (const p of patches) {
    const sheet = game.sheets.find((s) => s.id === p.sheetId);
    if (!sheet) continue;
    const before = snapshotSheet(sheet);
    if (p.attrs) {
      sheet.attrs = { ...sheet.attrs, ...p.attrs };
    }
    if (p.inventoryAdd?.length) {
      sheet.inventory = [...sheet.inventory, ...p.inventoryAdd];
    }
    if (p.inventoryRemove?.length) {
      const remove = new Set(p.inventoryRemove);
      sheet.inventory = sheet.inventory.filter((x) => !remove.has(x));
    }
    if (p.flagsAdd?.length) {
      sheet.flags = [...new Set([...sheet.flags, ...p.flagsAdd])];
    }
    if (p.flagsRemove?.length) {
      const remove = new Set(p.flagsRemove);
      sheet.flags = sheet.flags.filter((x) => !remove.has(x));
    }
    if (p.notesAppend) {
      sheet.notes = `${sheet.notes}\n${p.notesAppend}`.trim();
    }
    diffs.push({ sheetId: sheet.id, patch: { before, after: snapshotSheet(sheet) } });
  }
  return diffs;
}

function snapshotSheet(sheet: GameSheet): Record<string, unknown> {
  return {
    attrs: { ...sheet.attrs },
    inventory: [...sheet.inventory],
    flags: [...sheet.flags],
    notes: sheet.notes,
  };
}

export function pushEvent(
  game: GameState,
  partial: Omit<GameEvent, "id" | "at"> & { id?: string; at?: string },
): GameEvent {
  const event: GameEvent = {
    id: partial.id ?? evtId(),
    at: partial.at ?? new Date().toISOString(),
    tick: partial.tick,
    interactionRound: partial.interactionRound,
    kind: partial.kind,
    actorId: partial.actorId,
    actorName: partial.actorName,
    summary: partial.summary,
    detail: partial.detail,
    sheetDiffs: partial.sheetDiffs,
  };
  game.events.push(event);
  if (game.events.length > 200) {
    game.events = game.events.slice(-200);
  }
  return event;
}

export function formatAttrLines(sheet: GameSheet): string {
  return Object.entries(sheet.attrs)
    .map(([k, v]) => `${ATTR_LABELS[k] ?? k}: ${String(v)}`)
    .join(" · ");
}

export function sheetPublicView(sheet: GameSheet): string {
  const attrs = Object.entries(sheet.attrs)
    .map(([k, v]) => `${ATTR_LABELS[k] ?? k}=${String(v)}`)
    .join("，");
  return [
    `姓名: ${sheet.name}`,
    `属性: ${attrs}`,
    `物品: ${sheet.inventory.join("、") || "无"}`,
    `标记: ${sheet.flags.join("、") || "无"}`,
    sheet.notes ? `备注: ${sheet.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function recentEventsText(game: GameState, limit = 12): string {
  return game.events
    .slice(-limit)
    .map(
      (e) =>
        `[第${e.tick}时·第${e.interactionRound}轮] ${e.actorName}: ${e.summary}`,
    )
    .join("\n");
}

export function agentDirectory(game: GameState): string {
  return game.agents
    .filter((a) => a.kind === "character" || a.kind === "world")
    .map((a) =>
      a.kind === "world"
        ? `- 世界（对世界/环境作用时 toId 填「世界」）`
        : `- ${a.name}（toId 填「${a.name}」）`,
    )
    .join("\n");
}

export function agentDisplayName(game: GameState, idOrName: string): string {
  const key = idOrName.trim();
  if (!key || key === "world" || key === "世界") return "世界";
  const byId = game.agents.find((a) => a.id === key);
  if (byId) return byId.name;
  const byName = game.agents.find((a) => a.name === key);
  if (byName) return byName.name;
  return key;
}

/** Strip accidental JSON wrappers from model output for timeline display. */
export function formatEventSummary(text: string): string {
  const raw = text.trim();
  if (!raw) return "";
  if (raw.startsWith("{") && raw.includes("}")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const key of [
        "content",
        "publicEvent",
        "sceneSummary",
        "publicSummary",
        "action",
      ]) {
        if (typeof obj[key] === "string" && String(obj[key]).trim()) {
          return String(obj[key]).trim();
        }
      }
    } catch {
      const m = raw.match(/"content"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (m?.[1]) {
        try {
          return JSON.parse(`"${m[1]}"`) as string;
        } catch {
          return m[1];
        }
      }
    }
  }
  return raw;
}

export function plainTextFromModel(
  json: Record<string, unknown> | null,
  text: string,
): string {
  if (json) {
    for (const key of ["content", "publicEvent", "sceneSummary"]) {
      if (typeof json[key] === "string" && String(json[key]).trim()) {
        return String(json[key]).trim();
      }
    }
  }
  return formatEventSummary(text);
}
