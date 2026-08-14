import type {
  GameMapCell,
  GameMapPosition,
  GameMapPropertyValue,
  GameTerrainRange,
  GameTerrainRegion,
  GameTerrainType,
  GameWorldMap,
} from "./types";

export const DEFAULT_TERRAIN_COLORS = [
  "#4ade80",
  "#facc15",
  "#38bdf8",
  "#a78bfa",
  "#fb7185",
  "#f97316",
  "#2dd4bf",
  "#94a3b8",
];

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteInteger(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function positiveInteger(value: unknown): number {
  return Math.max(1, finiteInteger(value, 1));
}

function propertyValue(value: unknown): GameMapPropertyValue | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return undefined;
}

function normalizedProperties(value: unknown): Record<string, GameMapPropertyValue> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, raw]) => {
        const normalized = propertyValue(raw);
        return normalized === undefined
          ? null
          : [key.trim(), normalized] as const;
      })
      .filter(
        (entry): entry is readonly [string, GameMapPropertyValue] =>
          Boolean(entry && entry[0]),
      ),
  );
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Deterministic id for legacy names and newly created definitions. */
export function stableTerrainId(displayName: string): string {
  const normalized = displayName.trim().toLocaleLowerCase();
  return `terrain_${hashText(normalized || "unnamed")}`;
}

export function mapCellKey(x: number, y: number): string {
  return `${Math.round(x)},${Math.round(y)}`;
}

function terrainSourceEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  const nested =
    value.types ?? value.definitions ?? value.entries ?? value.byId;
  if (nested !== undefined) return terrainSourceEntries(nested);
  return Object.entries(value).map(([id, item]) =>
    isRecord(item) ? { ...item, id: item.id ?? id } : { id, displayName: item },
  );
}

function terrainDisplayName(value: UnknownRecord, fallback: string): string {
  const displayName = value.displayName ?? value.name ?? value.label;
  return String(displayName ?? fallback).trim() || fallback;
}

function normalizeTerrainType(
  value: unknown,
  index: number,
  usedIds: Set<string>,
): GameTerrainType | null {
  const raw =
    typeof value === "string"
      ? { displayName: value }
      : isRecord(value)
        ? value
        : null;
  if (!raw) return null;
  const displayName = terrainDisplayName(raw, `地形${index + 1}`);
  const requestedId = String(raw.id ?? "").trim();
  let id = requestedId || stableTerrainId(displayName);
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${requestedId || stableTerrainId(displayName)}_${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return {
    id,
    displayName,
    color:
      typeof raw.color === "string" && raw.color.trim()
        ? raw.color.trim()
        : DEFAULT_TERRAIN_COLORS[index % DEFAULT_TERRAIN_COLORS.length],
    passable: true,
    defaultProperties: normalizedProperties(
      raw.defaultProperties ?? raw.defaultProps ?? raw.properties,
    ),
  };
}

function coordinateFromUnknown(value: unknown): [number, number] | null {
  if (Array.isArray(value) && value.length >= 2) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    return Number.isFinite(x) && Number.isFinite(y)
      ? [Math.round(x), Math.round(y)]
      : null;
  }
  if (!isRecord(value)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  return Number.isFinite(x) && Number.isFinite(y)
    ? [Math.round(x), Math.round(y)]
    : null;
}

function coordinateArray(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const coordinates: Array<[number, number]> = [];
  for (const item of value) {
    const coordinate = coordinateFromUnknown(item);
    if (!coordinate) continue;
    const key = mapCellKey(coordinate[0], coordinate[1]);
    if (seen.has(key)) continue;
    seen.add(key);
    coordinates.push(coordinate);
  }
  return coordinates;
}

function rangeFromUnknown(value: unknown): GameTerrainRange | null {
  if (Array.isArray(value)) {
    if (value.length >= 4) {
      return {
        x: finiteInteger(value[0]),
        y: finiteInteger(value[1]),
        width: positiveInteger(value[2]),
        height: positiveInteger(value[3]),
      };
    }
    if (
      value.length >= 2 &&
      coordinateFromUnknown(value[0]) &&
      coordinateFromUnknown(value[1])
    ) {
      const start = coordinateFromUnknown(value[0])!;
      const end = coordinateFromUnknown(value[1])!;
      return {
        x: Math.min(start[0], end[0]),
        y: Math.min(start[1], end[1]),
        width: Math.abs(end[0] - start[0]) + 1,
        height: Math.abs(end[1] - start[1]) + 1,
      };
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (
    value.width !== undefined &&
    value.height !== undefined &&
    value.x !== undefined &&
    value.y !== undefined
  ) {
    return {
      x: finiteInteger(value.x),
      y: finiteInteger(value.y),
      width: positiveInteger(value.width),
      height: positiveInteger(value.height),
    };
  }
  const minX = value.minX ?? value.xMin ?? value.x1 ?? value.left;
  const minY = value.minY ?? value.yMin ?? value.y1 ?? value.top;
  const maxX = value.maxX ?? value.xMax ?? value.x2 ?? value.right;
  const maxY = value.maxY ?? value.yMax ?? value.y2 ?? value.bottom;
  if (
    minX === undefined ||
    minY === undefined ||
    maxX === undefined ||
    maxY === undefined
  ) {
    return null;
  }
  const x = finiteInteger(minX);
  const y = finiteInteger(minY);
  return {
    x,
    y,
    width: Math.max(1, finiteInteger(maxX) - x + 1),
    height: Math.max(1, finiteInteger(maxY) - y + 1),
  };
}

function rangeArray(value: unknown): GameTerrainRange[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(rangeFromUnknown)
    .filter((range): range is GameTerrainRange => Boolean(range));
}

function regionEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([id, item]) =>
    isRecord(item) ? { ...item, id: item.id ?? id } : item,
  );
}

function asCellEntries(value: unknown): Array<[string, UnknownRecord]> {
  if (Array.isArray(value)) {
    return value
      .filter(isRecord)
      .map((cell, index) => [String(index), cell]);
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).filter(
    (entry): entry is [string, UnknownRecord] => isRecord(entry[1]),
  );
}

function coordinateFromKey(key: string): [number, number] | null {
  const match = key.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  return [Math.round(Number(match[1])), Math.round(Number(match[2]))];
}

function hasCellContent(cell: GameMapCell): boolean {
  return Boolean(
    cell.zoneName?.trim() ||
      cell.terrainId ||
      cell.terrain ||
      cell.objects.length ||
      Object.keys(cell.properties).length ||
      typeof cell.passable === "boolean",
  );
}

function terrainValueMatches(
  terrain: GameTerrainType,
  value: string,
): boolean {
  return terrain.id === value || terrain.displayName === value;
}

/**
 * Normalizes both the current registry format and old maps containing
 * terrainTypes: string[] plus cell.terrain display names.
 */
export function normalizeWorldMap(raw: unknown): GameWorldMap {
  const source = isRecord(raw) ? raw : {};
  const rawCells = asCellEntries(source.cells);
  const rawRegions = regionEntries(
    source.terrainRegions ?? source.regions,
  );
  const rawTypes = terrainSourceEntries(
    source.terrainTypes ?? source.terrainRegistry ?? source.terrainIndex,
  );
  const terrains: GameTerrainType[] = [];
  const usedIds = new Set<string>();
  for (const [index, value] of rawTypes.entries()) {
    const normalized = normalizeTerrainType(value, index, usedIds);
    if (normalized) terrains.push(normalized);
  }

  const ensureTerrain = (value: unknown): string | undefined => {
    const text = String(value ?? "").trim();
    if (!text) return undefined;
    const existing = terrains.find((terrain) =>
      terrainValueMatches(terrain, text),
    );
    if (existing) return existing.id;
    const normalized = normalizeTerrainType(
      { displayName: text },
      terrains.length,
      usedIds,
    );
    if (!normalized) return undefined;
    terrains.push(normalized);
    return normalized.id;
  };

  const terrainRegions: GameTerrainRegion[] = [];
  for (const [index, value] of rawRegions.entries()) {
    if (!isRecord(value)) continue;
    const terrainId = ensureTerrain(
      value.terrainId ?? value.terrain ?? value.typeId ?? value.type,
    );
    if (!terrainId) continue;
    const coordinates = coordinateArray(
      value.coordinates ?? value.coords ?? value.points ?? value.cells,
    );
    const ranges = rangeArray(
      value.ranges ?? value.rectangles ?? value.rects,
    );
    if (!coordinates.length && !ranges.length) continue;
    terrainRegions.push({
      id: String(value.id ?? `region_${index + 1}`).trim() || `region_${index + 1}`,
      terrainId,
      ...(coordinates.length ? { coordinates } : {}),
      ...(ranges.length ? { ranges } : {}),
    });
  }

  const cells: Record<string, GameMapCell> = {};
  for (const [key, rawCell] of rawCells) {
    const keyCoordinate = coordinateFromKey(key);
    const x = finiteInteger(rawCell.x, keyCoordinate?.[0] ?? 0);
    const y = finiteInteger(rawCell.y, keyCoordinate?.[1] ?? 0);
    const terrainId = ensureTerrain(rawCell.terrainId ?? rawCell.terrain);
    const zoneName = String(rawCell.zoneName ?? "").trim();
    const objects = Array.isArray(rawCell.objects)
      ? rawCell.objects.map(String).map((item) => item.trim()).filter(Boolean)
      : [];
    const cell: GameMapCell = {
      x,
      y,
      ...(zoneName ? { zoneName } : {}),
      ...(terrainId ? { terrainId } : {}),
      properties: normalizedProperties(rawCell.properties),
      objects,
    };
    if (hasCellContent(cell)) cells[mapCellKey(x, y)] = cell;
  }

  const defaultTerrainId = ensureTerrain(
    source.defaultTerrainId ?? source.defaultTerrain,
  );

  return {
    terrainTypes: terrains,
    terrainRegions,
    terrainIndex: Object.fromEntries(
      terrains.map((terrain, index) => [terrain.id, index]),
    ),
    ...(defaultTerrainId ? { defaultTerrainId } : {}),
    cells,
  };
}

export function terrainDefinitions(map: GameWorldMap): GameTerrainType[] {
  return map.terrainTypes
    .map((terrain, index) =>
      typeof terrain === "string"
        ? normalizeTerrainType(terrain, index, new Set())
        : terrain,
    )
    .filter((terrain): terrain is GameTerrainType => Boolean(terrain));
}

export function terrainById(
  map: GameWorldMap,
  terrainId: string | undefined,
): GameTerrainType | undefined {
  if (!terrainId) return undefined;
  return terrainDefinitions(map).find((terrain) =>
    terrainValueMatches(terrain, terrainId),
  );
}

export function terrainRegionContains(
  region: GameTerrainRegion,
  position: GameMapPosition,
): boolean {
  const x = Math.round(position.x);
  const y = Math.round(position.y);
  if (region.coordinates?.some(([cx, cy]) => cx === x && cy === y)) {
    return true;
  }
  return Boolean(
    region.ranges?.some(
      (range) =>
        x >= range.x &&
        x < range.x + range.width &&
        y >= range.y &&
        y < range.y + range.height,
    ),
  );
}

/** 从矩形范围列表里挖掉一个格子：返回不含 (x,y) 的最多 4 个子矩形。 */
export function removePointFromRanges(
  ranges: GameTerrainRange[],
  x: number,
  y: number,
): GameTerrainRange[] {
  const result: GameTerrainRange[] = [];
  for (const range of ranges) {
    const right = range.x + range.width;
    const bottom = range.y + range.height;
    const contains =
      x >= range.x && x < right && y >= range.y && y < bottom;
    if (!contains) {
      result.push(range);
      continue;
    }
    if (range.y < y) {
      result.push({
        x: range.x,
        y: range.y,
        width: range.width,
        height: y - range.y,
      });
    }
    if (y + 1 < bottom) {
      result.push({
        x: range.x,
        y: y + 1,
        width: range.width,
        height: bottom - y - 1,
      });
    }
    if (range.x < x) {
      result.push({ x: range.x, y, width: x - range.x, height: 1 });
    }
    if (x + 1 < right) {
      result.push({ x: x + 1, y, width: right - x - 1, height: 1 });
    }
  }
  return result.filter((range) => range.width > 0 && range.height > 0);
}

/** 枚举地形区覆盖的所有格子 key（"x,y" 格式）。 */
export function cellsCoveredByRegion(
  region: GameTerrainRegion,
): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  for (const [cx, cy] of region.coordinates ?? []) {
    result.push([cx, cy]);
  }
  for (const range of region.ranges ?? []) {
    for (let dx = 0; dx < range.width; dx += 1) {
      for (let dy = 0; dy < range.height; dy += 1) {
        result.push([range.x + dx, range.y + dy]);
      }
    }
  }
  return result;
}

/** 从区域中移除 (x,y)，保持原数组索引位置；移除后若为空则整个区域丢弃。 */
export function regionWithoutPoint(
  map: GameWorldMap,
  region: GameTerrainRegion,
  x: number,
  y: number,
): GameWorldMap {
  if (region.ranges?.length) {
    const ranges = removePointFromRanges(region.ranges, x, y);
    const nextRegion =
      ranges.length > 0 ? { ...region, ranges } : undefined;
    return {
      ...map,
      terrainRegions: (nextRegion
        ? map.terrainRegions.map((item) =>
            item.id === region.id ? nextRegion : item,
          )
        : map.terrainRegions.filter((item) => item.id !== region.id)
      ) as GameTerrainRegion[],
    };
  }
  const coordinates = (region.coordinates ?? []).filter(
    ([cx, cy]) => !(cx === x && cy === y),
  );
  const nextRegion =
    coordinates.length > 0 ? { ...region, coordinates } : undefined;
  return {
    ...map,
    terrainRegions: (nextRegion
      ? map.terrainRegions.map((item) =>
          item.id === region.id ? nextRegion : item,
        )
      : map.terrainRegions.filter((item) => item.id !== region.id)
    ) as GameTerrainRegion[],
  };
}

/**
 * 从新区域覆盖的所有旧区域中挖掉重叠格，保证区域互不重叠。
 * 返回含 newRegion 前插的完整地图。
 */
export function subtractRegionOverlap(
  map: GameWorldMap,
  newRegion: GameTerrainRegion,
): GameWorldMap {
  let next = map;
  for (const oldRegion of map.terrainRegions) {
    if (oldRegion.id === newRegion.id) continue;
    for (const [x, y] of cellsCoveredByRegion(newRegion)) {
      if (terrainRegionContains(oldRegion, { x, y })) {
        next = regionWithoutPoint(next, oldRegion, x, y);
      }
    }
  }
  return {
    ...next,
    terrainRegions: [newRegion, ...next.terrainRegions],
  };
}

function containsRange(
  outer: GameTerrainRange,
  inner: GameTerrainRange,
): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** 两个矩形能否精确合并成一个矩形（并集仍是矩形才可）。 */
export function rangesMergeable(
  a: GameTerrainRange,
  b: GameTerrainRange,
): boolean {
  if (containsRange(a, b) || containsRange(b, a)) return true;
  const overlapX = a.x < b.x + b.width && b.x < a.x + a.width;
  const overlapY = a.y < b.y + b.height && b.y < a.y + a.height;
  if (overlapX && overlapY) {
    return (
      (a.x === b.x && a.width === b.width) ||
      (a.y === b.y && a.height === b.height)
    );
  }
  return (
    (a.x === b.x &&
      a.width === b.width &&
      (a.y + a.height === b.y || b.y + b.height === a.y)) ||
    (a.y === b.y &&
      a.height === b.height &&
      (a.x + a.width === b.x || b.x + b.width === a.x))
  );
}

export function mergeRangePair(
  a: GameTerrainRange,
  b: GameTerrainRange,
): GameTerrainRange {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x),
    height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y),
  };
}

/** 收敛合并到不动点；不可合并的矩形并列保留。 */
export function normalizeRanges(
  ranges: GameTerrainRange[],
): GameTerrainRange[] {
  let result = ranges.filter((range) => range.width > 0 && range.height > 0);
  let changed = true;
  while (changed) {
    changed = false;
    const next: GameTerrainRange[] = [];
    for (const range of result) {
      const index = next.findIndex((other) => rangesMergeable(range, other));
      if (index >= 0) {
        next[index] = mergeRangePair(range, next[index]);
        changed = true;
      } else {
        next.push(range);
      }
    }
    result = next;
  }
  return result;
}

function mergeCoordinates(
  a: Array<[number, number]>,
  b: Array<[number, number]>,
): Array<[number, number]> {
  const seen = new Set<string>();
  const result: Array<[number, number]> = [];
  for (const point of [...a, ...b]) {
    const key = mapCellKey(point[0], point[1]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(point);
  }
  return result;
}

/** 两区域是否重叠或 4-邻接（有公共边）。 */
export function regionsTouching(
  a: GameTerrainRegion,
  b: GameTerrainRegion,
): boolean {
  for (const [x, y] of cellsCoveredByRegion(b)) {
    if (
      terrainRegionContains(a, { x, y }) ||
      terrainRegionContains(a, { x: x + 1, y }) ||
      terrainRegionContains(a, { x: x - 1, y }) ||
      terrainRegionContains(a, { x, y: y + 1 }) ||
      terrainRegionContains(a, { x, y: y - 1 })
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 提交一个地形区：存在同 terrainId 且相邻/重叠的区域时并入它（合并成单一条目）；
 * 否则维持"挖洞 + 前插"。
 */
export function commitTerrainRegion(
  map: GameWorldMap,
  newRegion: GameTerrainRegion,
): GameWorldMap {
  const target = map.terrainRegions.find(
    (region) =>
      region.terrainId === newRegion.terrainId &&
      regionsTouching(region, newRegion),
  );
  if (!target) return subtractRegionOverlap(map, newRegion);

  // 只从其他地形的区域中挖掉新格，跳过 target
  let next = map;
  for (const other of map.terrainRegions) {
    if (other.id === target.id) continue;
    for (const [x, y] of cellsCoveredByRegion(newRegion)) {
      if (terrainRegionContains(other, { x, y })) {
        next = regionWithoutPoint(next, other, x, y);
      }
    }
  }
  const mergedRegion: GameTerrainRegion = {
    ...target,
    coordinates: mergeCoordinates(
      target.coordinates ?? [],
      newRegion.coordinates ?? [],
    ),
    ranges: normalizeRanges([...(target.ranges ?? []), ...(newRegion.ranges ?? [])]),
  };
  return {
    ...next,
    terrainRegions: next.terrainRegions.map((region) =>
      region.id === target.id ? mergedRegion : region,
    ),
  };
}

/** Resolves point overrides first, then the first matching region, then default terrain. */
export function terrainAt(
  map: GameWorldMap,
  position: GameMapPosition,
): GameTerrainType | undefined {
  const cell = map.cells[mapCellKey(position.x, position.y)];
  const cellTerrain =
    terrainById(map, cell?.terrainId) ??
    terrainById(map, cell?.terrain);
  if (cellTerrain) return cellTerrain;
  for (const region of map.terrainRegions ?? []) {
    if (region && terrainRegionContains(region, position)) {
      const terrain = terrainById(map, region.terrainId);
      if (terrain) return terrain;
    }
  }
  return terrainById(map, map.defaultTerrainId);
}

export function terrainIdAt(
  map: GameWorldMap,
  position: GameMapPosition,
): string | undefined {
  return terrainAt(map, position)?.id;
}

export function mapCellAt(
  map: GameWorldMap,
  position: GameMapPosition,
): GameMapCell | undefined {
  return map.cells[mapCellKey(position.x, position.y)];
}

export function effectiveMapProperties(
  map: GameWorldMap,
  position: GameMapPosition,
): Record<string, GameMapPropertyValue> {
  const terrain = terrainAt(map, position);
  const cell = mapCellAt(map, position);
  return {
    ...(terrain?.defaultProperties ?? {}),
    ...(cell?.properties ?? {}),
  };
}

export interface GameMapBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function worldMapBounds(map: GameWorldMap): GameMapBounds {
  const points: Array<[number, number]> = Object.values(map.cells).map((cell) => [
    cell.x,
    cell.y,
  ]);
  for (const region of map.terrainRegions ?? []) {
    for (const [x, y] of region.coordinates ?? []) points.push([x, y]);
    for (const range of region.ranges ?? []) {
      points.push([range.x, range.y]);
      points.push([
        range.x + range.width - 1,
        range.y + range.height - 1,
      ]);
    }
  }
  if (!points.length) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return points.reduce(
    (bounds, [x, y]) => ({
      minX: Math.min(bounds.minX, x),
      maxX: Math.max(bounds.maxX, x),
      minY: Math.min(bounds.minY, y),
      maxY: Math.max(bounds.maxY, y),
    }),
    {
      minX: points[0]?.[0] ?? 0,
      maxX: points[0]?.[0] ?? 0,
      minY: points[0]?.[1] ?? 0,
      maxY: points[0]?.[1] ?? 0,
    },
  );
}

export function terrainNameAt(
  map: GameWorldMap,
  position: GameMapPosition,
): string {
  return terrainAt(map, position)?.displayName ?? "未标注地形";
}

export function terrainColorAt(
  map: GameWorldMap,
  position: GameMapPosition,
): string {
  return terrainAt(map, position)?.color ?? "#94a3b8";
}

export function terrainRange(
  x: number,
  y: number,
  width: number,
  height: number,
): GameTerrainRange {
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

