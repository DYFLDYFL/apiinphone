import { ATTR_LABELS } from "./templates";
import type {
  GameAgent,
  GameContextFileEdit,
  GameEvent,
  GameSheet,
  GameState,
  JudgeResult,
} from "./types";

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

export function syncContextFiles(game: GameState): void {
  const set = (id: string, content: string) => {
    const file = game.contextFiles.find((item) => item.id === id);
    if (file) file.content = content;
  };
  set("worldview", game.worldview);
  set(
    "clock",
    game.worldClock.timeText || game.worldClock.label || "未标注时刻",
  );
  set("scene", game.worldClock.sceneSummary || "");
  set("timeline", recentEventsText(game, 40));
  set(
    "characters",
    game.sheets.map(sheetPublicView).join("\n\n"),
  );
}

export function readableContextFiles(
  game: GameState,
  agent: GameAgent,
): string {
  const allowed = new Set(agent.readableFileIds ?? []);
  return game.contextFiles
    .filter((file) => allowed.has(file.id))
    .map((file) => `【${file.title} · ${file.id}】\n${file.content || "（暂无内容）"}`)
    .join("\n\n");
}

export function applyAuthorizedContextFileEdits(
  game: GameState,
  agent: GameAgent,
  rawEdits: unknown,
): { applied: string[]; denied: string[] } {
  if (!Array.isArray(rawEdits)) return { applied: [], denied: [] };
  const readable = new Set(agent.readableFileIds ?? []);
  const editable = new Set(
    (agent.editableFileIds ?? []).filter((id) => readable.has(id)),
  );
  const applied: string[] = [];
  const denied: string[] = [];
  for (const raw of rawEdits) {
    if (!raw || typeof raw !== "object") continue;
    const edit = raw as Partial<GameContextFileEdit>;
    const fileId = String(edit.fileId ?? "");
    const file = game.contextFiles.find((item) => item.id === fileId);
    if (!file || !editable.has(fileId)) {
      if (fileId) denied.push(fileId);
      continue;
    }
    if (typeof edit.content === "string") {
      file.content = edit.content;
    } else if (typeof edit.append === "string") {
      file.content = `${file.content}\n${edit.append}`.trim();
    } else {
      continue;
    }
    applied.push(fileId);
  }
  if (denied.length) {
    pushEvent(game, {
      tick: game.worldClock.tick,
      interactionRound: game.tickBuffer?.interactionRound ?? 0,
      kind: "system",
      actorId: agent.id,
      actorName: agent.name,
      summary: `已拦截 ${denied.length} 项无权限的文档修改。`,
      detail: denied.join("、"),
      audience: "private",
      visibleTo: [agent.id],
    });
  }
  return { applied, denied };
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
    audience: partial.audience ?? "public",
    visibleTo: partial.visibleTo ?? [],
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
        `[轮${e.interactionRound}·tick${e.tick}] ${e.actorName}: ${e.summary}`,
    )
    .join("\n");
}

/** 某 agent 可见的事件（公开 + 私讯名单含自己）。 */
export function eventsVisibleTo(
  game: GameState,
  agentId: string,
  limit = 12,
): GameEvent[] {
  const filtered = game.events.filter((e) => {
    const audience = e.audience ?? "public";
    if (audience !== "private") return true;
    return (e.visibleTo ?? []).includes(agentId);
  });
  return filtered.slice(-limit);
}

export function recentEventsTextFor(
  game: GameState,
  agentId: string,
  limit = 12,
): string {
  return eventsVisibleTo(game, agentId, limit)
    .map(
      (e) =>
        `[轮${e.interactionRound}·tick${e.tick}] ${e.actorName}: ${e.summary}`,
    )
    .join("\n");
}

/** 中文摘要：裁判私讯。 */
export function notifySummary(toName: string, message: string): string {
  return `裁判告知·${toName}：${message}`;
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
  // 网页软限流/原始 SSE 误入时间线时，折叠成可读提示
  if (
    /消息发送过于频繁/.test(raw) ||
    /finish_reason["'\s:=]+["']?rate_lim/i.test(raw)
  ) {
    return "（消息过于频繁，已跳过；请稍后继续）";
  }
  if (
    (/(^|\n)event\s*:/i.test(raw) || /(^|\n)data\s*:/.test(raw)) &&
    raw.length > 200
  ) {
    return "（异常流式响应，已隐藏）";
  }
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
        const v = String(json[key]).trim();
        if (/消息发送过于频繁/.test(v)) continue;
        return v;
      }
    }
  }
  return formatEventSummary(text);
}
