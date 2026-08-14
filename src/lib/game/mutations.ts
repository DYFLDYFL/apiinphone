import { ATTR_LABELS } from "./templates";
import { isValidAttributeNumber } from "./templates";
import type {
  GameAgent,
  GameAttributeDefinition,
  GameContextFileEdit,
  GameEvent,
  GameSheet,
  GameState,
  JudgeResult,
  GameWorldMap,
} from "./types";
import {
  effectiveMapProperties,
  terrainDefinitions,
  terrainNameAt,
} from "./map";

function evtId(): string {
  return `evt_${Math.random().toString(36).slice(2, 10)}`;
}

export function applySheetPatches(
  game: GameState,
  patches: NonNullable<JudgeResult["sheetPatches"]>,
  actor?: GameAgent,
): Array<{ sheetId: string; patch: Record<string, unknown> }> {
  const diffs: Array<{ sheetId: string; patch: Record<string, unknown> }> = [];
  const denied: string[] = [];
  const judge = actor ?? game.agents.find((item) => item.capabilities.includes("judge"));
  const definitionFor = (key: string): GameAttributeDefinition | undefined =>
    game.attributeDefinitions.find((definition) => definition.key === key);
  const can = (key: string, operation: "set" | "add" | "remove") =>
    Boolean(judge?.attributePermissions?.[key]?.[operation]);
  const validValue = (definition: GameAttributeDefinition, value: unknown) => {
    if (definition.valueType === "number") {
      if (
        typeof value !== "number" ||
        !isValidAttributeNumber(value)
      ) {
        return false;
      }
      return true;
    }
    return (
      typeof value === "string" &&
      (!definition.textOptions?.length || definition.textOptions.includes(value))
    );
  };
  for (const p of patches) {
    const sheet = game.sheets.find((s) => s.id === p.sheetId);
    if (!sheet) continue;
    if (actor?.kind === "character" && actor.sheetId !== sheet.id) {
      denied.push(`${sheet.name}（角色 AI 只能修改自身面板）`);
      continue;
    }
    const before = snapshotSheet(sheet);
    if (p.attrs) {
      for (const [key, value] of Object.entries(p.attrs)) {
        const definition = definitionFor(key);
        if (!definition || !can(key, "set") || !validValue(definition, value)) {
          denied.push(`${sheet.name}.${key}`);
          continue;
        }
        sheet.attrs[key] = value;
      }
    }
    if (p.attrsAdd) {
      for (const [key, rawDelta] of Object.entries(p.attrsAdd)) {
        const definition = definitionFor(key);
        const current = sheet.attrs[key];
        if (!definition || !can(key, "add")) {
          denied.push(`${sheet.name}.${key}（增加）`);
          continue;
        }
        if (definition.valueType === "number" && typeof rawDelta === "number" && typeof current === "number") {
          const next = current + rawDelta;
          if (validValue({ ...definition, numberOptions: [] }, next)) sheet.attrs[key] = next;
          else denied.push(`${sheet.name}.${key}（增加越界）`);
        } else if (definition.valueType === "text" && typeof rawDelta === "string" && validValue(definition, rawDelta)) {
          sheet.attrs[key] = rawDelta;
        } else {
          denied.push(`${sheet.name}.${key}（增加值无效）`);
        }
      }
    }
    if (p.attrsRemove) {
      for (const [key, rawDelta] of Object.entries(p.attrsRemove)) {
        const definition = definitionFor(key);
        const current = sheet.attrs[key];
        if (!definition || !can(key, "remove")) {
          denied.push(`${sheet.name}.${key}（删除）`);
          continue;
        }
        if (definition.valueType === "number" && typeof rawDelta === "number" && typeof current === "number") {
          const next = current - rawDelta;
          if (validValue({ ...definition, numberOptions: [] }, next)) sheet.attrs[key] = next;
          else denied.push(`${sheet.name}.${key}（删除越界）`);
        } else if (definition.valueType === "text" && current === rawDelta) {
          sheet.attrs[key] = "";
        } else {
          denied.push(`${sheet.name}.${key}（删除值无效）`);
        }
      }
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
  if (denied.length && judge) {
    pushEvent(game, {
      tick: game.worldClock.tick,
      interactionRound: game.tickBuffer?.interactionRound ?? 0,
      kind: "system",
      actorId: judge.id,
      actorName: judge.name,
      summary: `已拦截 ${denied.length} 项未授权属性修改。`,
      detail: denied.join("、"),
      audience: "private",
      visibleTo: [judge.id],
    });
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
  set("world_map", worldMapText(game));
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
  set("god_story", game.godStory || "");
  const personalStories = game.personalStories ?? {};
  set(
    "personal_stories",
    Object.entries(personalStories)
      .filter(([key, value]) => key !== "__all__" && value.trim())
      .map(([key, value]) => `【${key}】\n${value}`)
      .concat(
        personalStories.__all__?.trim()
          ? [`【全个人剧情补充】\n${personalStories.__all__}`]
          : [],
      )
      .join("\n\n"),
  );
  Object.entries(personalStories).forEach(([key, content]) => {
    if (key !== "__all__") set(`personal_story_${key}`, content || "");
  });
}

export function worldMapText(game: GameState): string {
  const map = game.worldMap;
  const cells = Object.values(map?.cells ?? {}).sort(
    (a, b) => a.y - b.y || a.x - b.x,
  );
  const terrains = terrainDefinitions(map);
  const terrainText = terrains.length
    ? terrains
        .map(
          (terrain) =>
            `${terrain.id}=${terrain.displayName}（默认属性：${
              Object.entries(terrain.defaultProperties)
                .map(([key, value]) => `${key}=${value}`)
                .join("，") || "无"
            }）`,
        )
        .join("；")
    : "无";
  const regionText = (map?.terrainRegions ?? [])
    .map((region) => {
      const terrain = terrains.find((item) => item.id === region.terrainId);
      const coordinates = region.coordinates?.length
        ? `坐标 ${region.coordinates
            .map(([x, y]) => `(${x},${y})`)
            .join("、")}`
        : "";
      const ranges = region.ranges?.length
        ? `范围 ${region.ranges
            .map(
              (range) =>
                `(${range.x},${range.y}) ${range.width}×${range.height}`,
            )
            .join("、")}`
        : "";
      return `[地形区 ${region.id}] ${terrain?.displayName ?? region.terrainId} · ${
        [coordinates, ranges].filter(Boolean).join("；") || "空"
      }`;
    })
    .join("\n");
  const cellText = cells
    .map((cell) => {
      const position = { x: cell.x, y: cell.y };
      const properties = effectiveMapProperties(map, position);
      return `[${cell.x},${cell.y}] ${
        cell.zoneName || "位置点"
      } · 地形：${terrainNameAt(map, position)} · 属性：${
        Object.entries(properties)
          .map(([key, value]) => `${key}=${value}`)
          .join("，") || "无"
      } · 物件：${cell.objects.join("、") || "无"}`;
    })
    .join("\n");
  if (!terrains.length && !regionText && !cellText) {
    return "（地图暂无已记录区域）";
  }
  return [
    `地形注册表：${terrainText}`,
    regionText ? `稀疏地形区：\n${regionText}` : "",
    cellText ? `重点坐标/覆盖：\n${cellText}` : "",
    "空白背景为未持久化的虚拟区域，不代表已知地点。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function mapDistance(
  from: { x: number; y: number },
  to: { x: number; y: number },
): number {
  return Math.abs(Math.round(from.x) - Math.round(to.x)) +
    Math.abs(Math.round(from.y) - Math.round(to.y));
}

export function mapMovementReference(
  map: GameWorldMap,
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const movementCosts = [from, to]
    .map((position) => effectiveMapProperties(map, position).movementCost)
    .filter((value): value is number => typeof value === "number");
  const averageCost = movementCosts.length
    ? `；端点平均地形成本约 ${(
        movementCosts.reduce((sum, value) => sum + value, 0) /
        movementCosts.length
      ).toFixed(2)}`
    : "";
  return `距离 ${mapDistance(from, to)} 格；起点（${Math.round(
    from.x,
  )},${Math.round(from.y)}）${terrainNameAt(map, from)}；终点（${Math.round(
    to.x,
  )},${Math.round(to.y)}）${terrainNameAt(map, to)}${averageCost}`;
}

export function readableContextFiles(
  game: GameState,
  agent: GameAgent,
): string {
  const allowed = new Set(agent.readableFileIds ?? []);
  return game.contextFiles
    .filter((file) => allowed.has(file.id))
    .map((file) => {
      if (
        agent.kind === "character" &&
        file.id === "characters" &&
        !allowed.has("characters")
      ) {
        const content = game.sheets
          .map((sheet) =>
            sheet.id === agent.sheetId
              ? sheetPublicView(sheet)
              : `姓名: ${sheet.name}`,
          )
          .join("\n\n");
        return `【${file.title} · ${file.id}】\n${content || "（暂无内容）"}`;
      }
      return `【${file.title} · ${file.id}】\n${file.content || "（暂无内容）"}`;
    })
    .join("\n\n");
}

export function readableSheets(
  game: GameState,
  agent: GameAgent,
): string {
  const permissions = agent.attributePermissions;
  const hasConfiguredPermissions = Boolean(
    permissions && Object.keys(permissions).length,
  );
  const sheets =
    agent.kind === "character" && !agent.readableFileIds?.includes("characters")
      ? game.sheets.filter((sheet) => sheet.id === agent.sheetId)
      : game.sheets;
  return sheets
    .map((sheet) => {
      const attrs = Object.fromEntries(
        Object.entries(sheet.attrs).filter(([key]) =>
          hasConfiguredPermissions ? Boolean(permissions?.[key]?.read) : true,
        ),
      );
      return sheetPublicView({ ...sheet, attrs });
    })
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
    const nextContent =
      typeof edit.content === "string"
        ? edit.content
        : typeof edit.append === "string"
          ? `${file.content}\n${edit.append}`.trim()
          : null;
    if (nextContent === null) {
      continue;
    }
    file.content = nextContent;
    if (fileId === "god_story") {
      game.godStory = nextContent;
    } else if (fileId === "personal_stories") {
      game.personalStories = {
        ...(game.personalStories ?? {}),
        __all__: nextContent,
      };
    } else if (fileId.startsWith("personal_story_")) {
      const characterId = fileId.slice("personal_story_".length);
      game.personalStories = {
        ...(game.personalStories ?? {}),
        [characterId]: nextContent,
      };
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
    .filter((e) => (e.audience ?? "public") === "public")
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
    .filter((a) => a.kind === "character" || a.capabilities.includes("world_open"))
    .map((a) =>
      a.capabilities.includes("world_open")
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
