import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  DEFAULT_TERRAIN_COLORS,
  effectiveMapProperties,
  effectivePassableAt,
  normalizeWorldMap,
  stableTerrainId,
  terrainAt,
  terrainDefinitions,
  terrainNameAt,
  terrainRange,
  worldMapBounds,
} from "../../lib/game/map";
import type {
  GameMapCell,
  GameMapPropertyValue,
  GameTerrainRange,
  GameTerrainRegion,
  GameTerrainType,
  GameWorldMap,
} from "../../lib/game/types";
import type { GameTemplateDraft } from "../../lib/game/templates";

type DrawMode = "pan" | "region" | "paint";
type RegionShape = "range" | "coordinates";

interface WorldMapStepEditorProps {
  draft: GameTemplateDraft;
  onChange: (draft: GameTemplateDraft) => void;
}

interface PanDrag {
  mode: "pan";
  pointerId: number;
  clientX: number;
  clientY: number;
  panX: number;
  panY: number;
}

interface RegionDrag {
  mode: "region";
  pointerId: number;
  start: [number, number];
  current: [number, number];
}

type MapDrag = PanDrag | RegionDrag;

const GRID_SIZE = 76;
const VIEWBOX_WIDTH = 800;
const VIEWBOX_HEIGHT = 420;

function parseProperties(value: string): Record<string, GameMapPropertyValue> {
  return Object.fromEntries(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        const key = index < 0 ? line : line.slice(0, index);
        const raw = index < 0 ? "" : line.slice(index + 1).trim();
        if (raw === "true") return [key.trim(), true];
        if (raw === "false") return [key.trim(), false];
        const number = Number(raw);
        return [
          key.trim(),
          raw !== "" && Number.isFinite(number) ? number : raw,
        ];
      }),
  );
}

function propertiesText(
  properties: Record<string, GameMapPropertyValue> | undefined,
): string {
  return Object.entries(properties ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function cellHasContent(cell: GameMapCell): boolean {
  return Boolean(
    cell.zoneName?.trim() ||
      cell.terrainId ||
      cell.terrain ||
      cell.objects.length ||
      Object.keys(cell.properties).length ||
      typeof cell.passable === "boolean",
  );
}

function copyCell(cell: GameMapCell, patch: Partial<GameMapCell>): GameMapCell {
  const next: GameMapCell = {
    ...cell,
    ...patch,
    properties: patch.properties
      ? { ...patch.properties }
      : { ...cell.properties },
    objects: patch.objects ? [...patch.objects] : [...cell.objects],
  };
  if ("terrainId" in patch && patch.terrainId === undefined) {
    delete next.terrainId;
  }
  if ("terrain" in patch && patch.terrain === undefined) delete next.terrain;
  if (patch.zoneName !== undefined) {
    const zoneName = patch.zoneName.trim();
    if (zoneName) next.zoneName = zoneName;
    else delete next.zoneName;
  }
  if ("passable" in patch && patch.passable === undefined) {
    delete next.passable;
  }
  return next;
}

function mapWith(
  map: GameWorldMap,
  patch: Partial<GameWorldMap>,
): GameWorldMap {
  return normalizeWorldMap({ ...map, ...patch });
}

function regionCoordinateCount(region: GameTerrainRegion): number {
  const explicit = region.coordinates?.length ?? 0;
  const ranges = (region.ranges ?? []).reduce(
    (total, range) => total + range.width * range.height,
    0,
  );
  return explicit + ranges;
}

function regionBounds(
  start: [number, number],
  end: [number, number],
): { minX: number; maxX: number; minY: number; maxY: number } {
  return {
    minX: Math.min(start[0], end[0]),
    maxX: Math.max(start[0], end[0]),
    minY: Math.min(start[1], end[1]),
    maxY: Math.max(start[1], end[1]),
  };
}

export function WorldMapStepEditor({
  draft,
  onChange,
}: WorldMapStepEditorProps) {
  const map = normalizeWorldMap(draft.worldMap ?? { terrainTypes: [], terrainRegions: [], cells: {} });
  const terrainTypes = terrainDefinitions(map);
  const cells = Object.entries(map.cells)
    .map(([key, cell]) => ({ key, cell }))
    .sort((a, b) => a.cell.y - b.cell.y || a.cell.x - b.cell.x);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [newX, setNewX] = useState("0");
  const [newY, setNewY] = useState("0");
  const [newTerrain, setNewTerrain] = useState("");
  const [newTerrainColor, setNewTerrainColor] = useState(
    DEFAULT_TERRAIN_COLORS[terrainTypes.length % DEFAULT_TERRAIN_COLORS.length] ??
      "#4ade80",
  );
  const [newTerrainPassable, setNewTerrainPassable] = useState(true);
  const [newTerrainProperties, setNewTerrainProperties] = useState("");
  const [activeTerrainId, setActiveTerrainId] = useState(
    terrainTypes[0]?.id ?? "",
  );
  const [drawMode, setDrawMode] = useState<DrawMode>("pan");
  const [regionShape, setRegionShape] = useState<RegionShape>("range");
  const [terrainRenameDrafts, setTerrainRenameDrafts] = useState<
    Record<string, string>
  >({});
  const [mapNotice, setMapNotice] = useState("");
  const dragRef = useRef<MapDrag | null>(null);
  const hoverCloseTimer = useRef<number | undefined>(undefined);
  const [regionPreview, setRegionPreview] = useState<
    { start: [number, number]; end: [number, number] } | undefined
  >();

  useEffect(() => {
    if (!activeTerrainId || !terrainTypes.some((item) => item.id === activeTerrainId)) {
      setActiveTerrainId(terrainTypes[0]?.id ?? "");
    }
  }, [activeTerrainId, terrainTypes]);

  const clampZoom = (value: number) => Math.min(2.5, Math.max(0.45, value));
  const updateMap = (nextMap: GameWorldMap) =>
    onChange({ ...draft, worldMap: normalizeWorldMap(nextMap) });
  const updateCells = (cellsByKey: Record<string, GameMapCell>) => {
    const compactCells = Object.fromEntries(
      Object.entries(cellsByKey).filter(([, cell]) => cellHasContent(cell)),
    );
    updateMap(mapWith(map, { cells: compactCells }));
  };
  const updateCell = (oldKey: string, patch: Partial<GameMapCell>) => {
    const current = map.cells[oldKey];
    if (!current) return;
    const cellsByKey = { ...map.cells };
    const next = copyCell(current, patch);
    const nextKey = `${next.x},${next.y}`;
    delete cellsByKey[oldKey];
    if (cellHasContent(next)) cellsByKey[nextKey] = next;
    updateCells(cellsByKey);
    if (nextKey !== oldKey) {
      setSelectedKey(nextKey);
      setEditingKey(nextKey);
    }
  };
  const selectedCell = selectedKey ? map.cells[selectedKey] : undefined;
  const selectedTerrain = selectedCell
    ? terrainAt(map, selectedCell)
    : undefined;
  const popoverKey =
    hoveredKey && map.cells[hoveredKey] ? hoveredKey : null;
  const popoverCell = popoverKey ? map.cells[popoverKey] : undefined;

  const selectCell = (key: string) => {
    setSelectedKey(key);
    setEditingKey(null);
    setMapNotice("");
  };
  const editCell = (key: string) => {
    setSelectedKey(key);
    setEditingKey(key);
    setMapNotice("");
  };
  const showPopover = (key: string) => {
    if (hoverCloseTimer.current !== undefined) {
      window.clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = undefined;
    }
    setHoveredKey(key);
  };
  const hidePopoverLater = (key: string) => {
    if (hoverCloseTimer.current !== undefined) {
      window.clearTimeout(hoverCloseTimer.current);
    }
    hoverCloseTimer.current = window.setTimeout(() => {
      setHoveredKey((current) => (current === key ? null : current));
    }, 220);
  };
  const updateSelectedCell = (patch: Partial<GameMapCell>) => {
    if (selectedKey) updateCell(selectedKey, patch);
  };
  const removeSelectedCell = () => {
    if (!selectedKey) return;
    const cellsByKey = { ...map.cells };
    delete cellsByKey[selectedKey];
    updateCells(cellsByKey);
    setSelectedKey(null);
    setEditingKey(null);
    setHoveredKey(null);
  };
  const addPoint = () => {
    const parsedX = Number(newX);
    const parsedY = Number(newY);
    if (!Number.isFinite(parsedX) || !Number.isFinite(parsedY)) {
      setMapNotice("请输入有效的整数坐标。");
      return;
    }
    const x = Math.round(parsedX);
    const y = Math.round(parsedY);
    const key = `${x},${y}`;
    if (map.cells[key]) {
      editCell(key);
      setMapNotice(`坐标（${x}, ${y}）已经存在，已选中它。`);
      return;
    }
    const cell: GameMapCell = {
      x,
      y,
      zoneName: "未命名重点",
      properties: {},
      objects: [],
    };
    updateCells({ ...map.cells, [key]: cell });
    setSelectedKey(key);
    setEditingKey(key);
    setMapNotice("");
  };
  const parseTerrainProperties = (text: string) => parseProperties(text);
  const addTerrainType = () => {
    const displayName = newTerrain.trim();
    if (!displayName) {
      setMapNotice("请输入地形显示名称。");
      return;
    }
    if (terrainTypes.some((terrain) => terrain.displayName === displayName)) {
      setMapNotice(`地形「${displayName}」已经存在。`);
      return;
    }
    const baseId = stableTerrainId(displayName);
    let id = baseId;
    let suffix = 2;
    while (terrainTypes.some((terrain) => terrain.id === id)) {
      id = `${baseId}_${suffix}`;
      suffix += 1;
    }
    const definition: GameTerrainType = {
      id,
      displayName,
      color: newTerrainColor,
      passable: newTerrainPassable,
      defaultProperties: parseTerrainProperties(newTerrainProperties),
    };
    updateMap(mapWith(map, { terrainTypes: [...terrainTypes, definition] }));
    setActiveTerrainId(id);
    setNewTerrain("");
    setNewTerrainProperties("");
    setMapNotice("");
  };
  const renameTerrain = (terrainId: string) => {
    const terrain = terrainTypes.find((item) => item.id === terrainId);
    if (!terrain) return;
    const displayName = (
      terrainRenameDrafts[terrainId] ?? terrain.displayName
    ).trim();
    if (!displayName) {
      setMapNotice("地形显示名称不能为空。");
      return;
    }
    if (
      terrainTypes.some(
        (item) => item.id !== terrainId && item.displayName === displayName,
      )
    ) {
      setMapNotice(`地形「${displayName}」已经存在，不能重名。`);
      return;
    }
    updateMap(
      mapWith(map, {
        terrainTypes: terrainTypes.map((item) =>
          item.id === terrainId ? { ...item, displayName } : item,
        ),
      }),
    );
    setTerrainRenameDrafts((current) => ({
      ...current,
      [terrainId]: displayName,
    }));
    setMapNotice("");
  };
  const updateTerrain = (
    terrainId: string,
    patch: Partial<GameTerrainType>,
  ) => {
    updateMap(
      mapWith(map, {
        terrainTypes: terrainTypes.map((item) =>
          item.id === terrainId ? { ...item, ...patch } : item,
        ),
      }),
    );
  };
  const deleteTerrain = (terrainId: string) => {
    const terrain = terrainTypes.find((item) => item.id === terrainId);
    if (!terrain) return;
    const cellUsage = cells.filter(
      ({ cell }) => cell.terrainId === terrainId,
    ).length;
    const regionUsage = map.terrainRegions.filter(
      (region) => region.terrainId === terrainId,
    ).length;
    const replacement = terrainTypes.find((item) => item.id !== terrainId);
    const usage = cellUsage + regionUsage;
    const warning = usage
      ? replacement
        ? `有 ${cellUsage} 个重点坐标和 ${regionUsage} 个地形区使用「${terrain.displayName}」。删除后替换为「${replacement.displayName}」，继续吗？`
        : `有 ${usage} 处使用「${terrain.displayName}」。删除后将清除这些覆盖，继续吗？`
      : `确定删除地形「${terrain.displayName}」吗？`;
    if (!window.confirm(warning)) return;
    const nextCells = Object.fromEntries(
      Object.entries(map.cells).map(([key, cell]) => {
        if (cell.terrainId !== terrainId) return [key, cell];
        if (!replacement) {
          const next = copyCell(cell, { terrainId: undefined, terrain: undefined });
          return [key, next];
        }
        return [key, copyCell(cell, { terrainId: replacement.id, terrain: undefined })];
      }),
    );
    const nextRegions = map.terrainRegions
      .filter((region) => replacement || region.terrainId !== terrainId)
      .map((region) =>
        region.terrainId === terrainId && replacement
          ? { ...region, terrainId: replacement.id }
          : region,
      );
    updateMap(
      mapWith(map, {
        terrainTypes: terrainTypes.filter((item) => item.id !== terrainId),
        terrainRegions: nextRegions,
        cells: nextCells,
      }),
    );
    if (activeTerrainId === terrainId) setActiveTerrainId(replacement?.id ?? "");
    setMapNotice("");
  };

  const mapBounds = worldMapBounds(map);
  const mapCenterX = (mapBounds.minX + mapBounds.maxX) / 2;
  const mapCenterY = (mapBounds.minY + mapBounds.maxY) / 2;
  const viewTransform = `translate(${VIEWBOX_WIDTH / 2 + pan.x} ${
    VIEWBOX_HEIGHT / 2 + pan.y
  }) scale(${zoom}) translate(${-mapCenterX * GRID_SIZE} ${
    -mapCenterY * GRID_SIZE
  })`;
  const colorForTerrain = (terrainId: string | undefined) =>
    terrainTypes.find((item) => item.id === terrainId)?.color ?? "#94a3b8";
  const coordinateAtPointer = (
    event: ReactPointerEvent<SVGSVGElement>,
  ): [number, number] => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const screenX =
      ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) *
      VIEWBOX_WIDTH;
    const screenY =
      ((event.clientY - bounds.top) / Math.max(bounds.height, 1)) *
      VIEWBOX_HEIGHT;
    const worldX =
      ((screenX - (VIEWBOX_WIDTH / 2 + pan.x)) / zoom + mapCenterX * GRID_SIZE) /
      GRID_SIZE;
    const worldY =
      ((screenY - (VIEWBOX_HEIGHT / 2 + pan.y)) / zoom + mapCenterY * GRID_SIZE) /
      GRID_SIZE;
    return [Math.round(worldX), Math.round(worldY)];
  };
  const commitRegion = (start: [number, number], end: [number, number]) => {
    if (!activeTerrainId) {
      setMapNotice("请先在地形注册表中添加并选择一种地形。");
      return;
    }
    const bounds = regionBounds(start, end);
    const idBase = `region_${Date.now().toString(36)}`;
    const id = map.terrainRegions.some((region) => region.id === idBase)
      ? `${idBase}_${map.terrainRegions.length + 1}`
      : idBase;
    const nextRegion: GameTerrainRegion =
      regionShape === "range"
        ? {
            id,
            terrainId: activeTerrainId,
            ranges: [
              terrainRange(
                bounds.minX,
                bounds.minY,
                bounds.maxX - bounds.minX + 1,
                bounds.maxY - bounds.minY + 1,
              ),
            ],
          }
        : {
            id,
            terrainId: activeTerrainId,
            coordinates: Array.from(
              { length: bounds.maxY - bounds.minY + 1 },
              (_, yOffset) =>
                Array.from(
                  { length: bounds.maxX - bounds.minX + 1 },
                  (_, xOffset) => [bounds.minX + xOffset, bounds.minY + yOffset] as [
                    number,
                    number,
                  ],
                ),
            ).flat(),
          };
    updateMap(
      mapWith(map, {
        // New drawings take precedence over older broad background regions.
        terrainRegions: [nextRegion, ...map.terrainRegions],
      }),
    );
    setMapNotice(
      `已创建「${
        terrainTypes.find((item) => item.id === activeTerrainId)?.displayName ??
        activeTerrainId
      }」地形区。`,
    );
  };
  const handleMapPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    if (drawMode === "region") {
      const coordinate = coordinateAtPointer(event);
      dragRef.current = {
        mode: "region",
        pointerId: event.pointerId,
        start: coordinate,
        current: coordinate,
      };
      setRegionPreview({ start: coordinate, end: coordinate });
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (drawMode === "paint") {
      const coordinate = coordinateAtPointer(event);
      paintRegionCell(coordinate[0], coordinate[1]);
      return;
    }
    dragRef.current = {
      mode: "pan",
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handleMapPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.mode === "region") {
      const current = coordinateAtPointer(event);
      drag.current = current;
      setRegionPreview({ start: drag.start, end: current });
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const xScale = VIEWBOX_WIDTH / Math.max(bounds.width, 1);
    const yScale = VIEWBOX_HEIGHT / Math.max(bounds.height, 1);
    setPan({
      x: drag.panX + (event.clientX - drag.clientX) * xScale,
      y: drag.panY + (event.clientY - drag.clientY) * yScale,
    });
  };
  const handleMapPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    if (drag.mode === "region") {
      commitRegion(drag.start, drag.current);
      setRegionPreview(undefined);
    }
  };
  const handleMapWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    setZoom((current) =>
      clampZoom(current * (event.deltaY < 0 ? 1.12 : 0.88)),
    );
  };
  const removeRegion = (regionId: string) => {
    updateMap(
      mapWith(map, {
        terrainRegions: map.terrainRegions.filter(
          (region) => region.id !== regionId,
        ),
      }),
    );
  };
  const updateRegionTerrain = (regionId: string, terrainId: string) => {
    updateMap(
      mapWith(map, {
        terrainRegions: map.terrainRegions.map((region) =>
          region.id === regionId ? { ...region, terrainId } : region,
        ),
      }),
    );
  };
  const updateRegionRange = (
    regionId: string,
    rangeIndex: number,
    patch: Partial<GameTerrainRange>,
  ) => {
    updateMap(
      mapWith(map, {
        terrainRegions: map.terrainRegions.map((region) =>
          region.id === regionId
            ? {
                ...region,
                ranges: (region.ranges ?? []).map((range, index) =>
                  index === rangeIndex ? { ...range, ...patch } : range,
                ),
              }
            : region,
        ),
      }),
    );
  };
  const removeRegionRange = (regionId: string, rangeIndex: number) => {
    updateMap(
      mapWith(map, {
        terrainRegions: map.terrainRegions.map((region) => {
          if (region.id !== regionId) return region;
          const ranges = (region.ranges ?? []).filter(
            (_, index) => index !== rangeIndex,
          );
          return { ...region, ...(ranges.length ? { ranges } : {}) };
        }),
      }),
    );
  };
  const addRegionCoordinate = (regionId: string, x: number, y: number) => {
    const region = map.terrainRegions.find((item) => item.id === regionId);
    if (!region) return;
    const coordinates = region.coordinates ?? [];
    const key = (px: number, py: number) => `${px},${py}`;
    if (coordinates.some(([px, py]) => key(px, py) === key(x, y))) return;
    updateMap(
      mapWith(map, {
        terrainRegions: map.terrainRegions.map((item) =>
          item.id === regionId
            ? { ...item, coordinates: [...coordinates, [x, y] as [number, number]] }
            : item,
        ),
      }),
    );
  };
  const removeRegionCoordinate = (regionId: string, index: number) => {
    updateMap(
      mapWith(map, {
        terrainRegions: map.terrainRegions.map((region) => {
          if (region.id !== regionId) return region;
          const coordinates = (region.coordinates ?? []).filter(
            (_, itemIndex) => itemIndex !== index,
          );
          return { ...region, ...(coordinates.length ? { coordinates } : {}) };
        }),
      }),
    );
  };
  /** 点选模式：给目标区域增删一个格子（若已存在则移除）。 */
  const paintRegionCell = (x: number, y: number) => {
    if (!activeTerrainId) {
      setMapNotice("请先在地形注册表中添加并选择一种地形。");
      return;
    }
    const key = (px: number, py: number) => `${px},${py}`;
    const existing = map.terrainRegions.find(
      (region) =>
        region.terrainId === activeTerrainId &&
        (region.coordinates ?? []).some(([px, py]) => key(px, py) === key(x, y)),
    );
    if (existing) {
      removeRegionCoordinate(
        existing.id,
        (existing.coordinates ?? []).findIndex(
          ([px, py]) => key(px, py) === key(x, y),
        ),
      );
      return;
    }
    const targetId = selectedRegionId;
    if (targetId) {
      addRegionCoordinate(targetId, x, y);
      return;
    }
    const id = `region_${Date.now().toString(36)}_${map.terrainRegions.length}`;
    updateMap(
      mapWith(map, {
        terrainRegions: [
          { id, terrainId: activeTerrainId, coordinates: [[x, y] as [number, number]] },
          ...map.terrainRegions,
        ],
      }),
    );
    setSelectedRegionId(id);
    setMapNotice("已创建点选地形区，可继续点击格子加入或移出。");
  };

  const selectedPassability =
    selectedCell?.passable === undefined
      ? "inherit"
      : selectedCell.passable
        ? "true"
        : "false";
  const regionPreviewBounds = regionPreview
    ? regionBounds(regionPreview.start, regionPreview.end)
    : undefined;

  return (
    <section className="game-editor-section game-card game-map-editor-card">
      <div className="game-map-editor-header">
        <div className="game-section-title">
          <h3>世界地图</h3>
          <span>
            只保存重点坐标与稀疏地形区；空白背景是虚拟的，不会写入整张网格。
          </span>
        </div>
        <button
          type="button"
          className="game-map-collapse-btn"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((current) => !current)}
        >
          {collapsed ? "展开" : "收起"}
        </button>
      </div>
      {!collapsed ? (
        <div className="game-map-editor-body">
          <div className="game-map-toolbar">
            <div className="game-map-zoom-controls" aria-label="地图缩放">
              <button
                type="button"
                className="game-map-control-btn"
                aria-label="缩小地图"
                onClick={() => setZoom((current) => clampZoom(current * 0.82))}
              >
                −
              </button>
              <span className="game-map-zoom-label">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                className="game-map-control-btn"
                aria-label="放大地图"
                onClick={() => setZoom((current) => clampZoom(current * 1.22))}
              >
                +
              </button>
              <button
                type="button"
                className="game-map-reset-btn"
                onClick={() => {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
              >
                重置视图
              </button>
            </div>
            <span className="game-map-toolbar-meta">
              {cells.length} 个重点 · {map.terrainRegions.length} 个地形区 ·{" "}
              {terrainTypes.length} 种地形
            </span>
          </div>

          <div className="game-map-drawing-toolbar">
            <label className="game-field">
              绘制模式
              <select
                value={drawMode}
                onChange={(event) =>
                  setDrawMode(event.target.value as DrawMode)
                }
              >
                <option value="pan">平移 / 选点</option>
                <option value="region">拖拽创建地形区</option>
                <option value="paint">点选地形格子</option>
              </select>
            </label>
            <label className="game-field">
              批量地形
              <select
                value={activeTerrainId}
                onChange={(event) => setActiveTerrainId(event.target.value)}
                disabled={!terrainTypes.length}
              >
                {!terrainTypes.length ? <option value="">暂无地形</option> : null}
                {terrainTypes.map((terrain) => (
                  <option value={terrain.id} key={terrain.id}>
                    {terrain.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="game-field">
              保存形状
              <select
                value={regionShape}
                onChange={(event) =>
                  setRegionShape(event.target.value as RegionShape)
                }
                disabled={drawMode !== "region"}
              >
                <option value="range">紧凑矩形范围</option>
                <option value="coordinates">坐标数组</option>
              </select>
            </label>
            <p>
              {drawMode === "region"
                ? "在地图上拖拽，松开后创建一块稀疏地形区。"
                : drawMode === "paint"
                  ? "点击格子加入当前地形区（有选中区域则并入它，否则新建）；再点一次移出。"
                  : "拖动空白处平移；点击重点坐标查看或编辑；空点是位置参考。"}
            </p>
          </div>

          <div className="game-map-viewport">
            <svg
              className="game-map-svg"
              viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
              role="img"
              aria-label="可缩放、可平移并可批量绘制地形区的世界地图"
              onPointerDown={handleMapPointerDown}
              onPointerMove={handleMapPointerMove}
              onPointerUp={handleMapPointerUp}
              onPointerCancel={handleMapPointerUp}
              onWheel={handleMapWheel}
            >
              <defs>
                <pattern
                  id="game-map-grid-pattern-v2"
                  width={GRID_SIZE}
                  height={GRID_SIZE}
                  patternUnits="userSpaceOnUse"
                >
                  <path
                    d={`M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}`}
                    fill="none"
                    className="game-map-grid-line"
                  />
                </pattern>
              </defs>
              <g transform={viewTransform}>
                <rect
                  x={-10000}
                  y={-10000}
                  width={20000}
                  height={20000}
                  className="game-map-canvas-backdrop"
                  fill="url(#game-map-grid-pattern-v2)"
                />
                <line
                  x1={-10000}
                  y1={0}
                  x2={10000}
                  y2={0}
                  className="game-map-axis"
                />
                <line
                  x1={0}
                  y1={-10000}
                  x2={0}
                  y2={10000}
                  className="game-map-axis"
                />
                {map.terrainRegions.map((region) => (
                  <g
                    key={region.id}
                    className={
                      region.id === selectedRegionId
                        ? "game-map-terrain-region selected"
                        : "game-map-terrain-region"
                    }
                  >
                    {(region.ranges ?? []).map((range, index) => (
                      <rect
                        key={`${region.id}-range-${index}`}
                        x={range.x * GRID_SIZE - GRID_SIZE / 2}
                        y={range.y * GRID_SIZE - GRID_SIZE / 2}
                        width={range.width * GRID_SIZE}
                        height={range.height * GRID_SIZE}
                        fill={colorForTerrain(region.terrainId)}
                        className="game-map-region-fill"
                        pointerEvents="none"
                      />
                    ))}
                    {(region.coordinates ?? []).map(([x, y], index) => (
                      <rect
                        key={`${region.id}-coordinate-${index}`}
                        x={x * GRID_SIZE - GRID_SIZE / 2 + 3}
                        y={y * GRID_SIZE - GRID_SIZE / 2 + 3}
                        width={GRID_SIZE - 6}
                        height={GRID_SIZE - 6}
                        fill={colorForTerrain(region.terrainId)}
                        className="game-map-region-fill"
                        pointerEvents="none"
                      />
                    ))}
                  </g>
                ))}
                {regionPreviewBounds ? (
                  <rect
                    x={regionPreviewBounds.minX * GRID_SIZE - GRID_SIZE / 2}
                    y={regionPreviewBounds.minY * GRID_SIZE - GRID_SIZE / 2}
                    width={
                      (regionPreviewBounds.maxX - regionPreviewBounds.minX + 1) *
                      GRID_SIZE
                    }
                    height={
                      (regionPreviewBounds.maxY - regionPreviewBounds.minY + 1) *
                      GRID_SIZE
                    }
                    fill={colorForTerrain(activeTerrainId)}
                    className="game-map-region-preview"
                    pointerEvents="none"
                  />
                ) : null}
                {cells.map(({ key, cell }) => {
                  const isNamed = Boolean(cell.zoneName?.trim());
                  const nodeTitle =
                    cell.zoneName?.trim() || `位置点（${cell.x}, ${cell.y}）`;
                  const isSelected = selectedKey === key;
                  const effectiveTerrain = terrainAt(map, cell);
                  const passable = effectivePassableAt(map, cell);
                  if (!isNamed) {
                    return (
                      <g
                        key={key}
                        className="game-map-empty-point"
                        data-map-node="true"
                        transform={`translate(${cell.x * GRID_SIZE} ${
                          cell.y * GRID_SIZE
                        })`}
                        pointerEvents="none"
                      >
                        <title>
                          {nodeTitle} · 地形：{" "}
                          {effectiveTerrain?.displayName || "未设置地形"}
                        </title>
                        <circle
                          r={5}
                          fill={effectiveTerrain?.color ?? "#94a3b8"}
                        />
                      </g>
                    );
                  }
                  return (
                    <g
                      key={key}
                      className={
                        isSelected ? "game-map-node selected" : "game-map-node"
                      }
                      data-map-node="true"
                      role="button"
                      tabIndex={0}
                      aria-label={`${nodeTitle}，坐标 ${cell.x}, ${cell.y}`}
                      transform={`translate(${cell.x * GRID_SIZE} ${
                        cell.y * GRID_SIZE
                      })`}
                      onPointerDown={(event) => {
                        if (drawMode === "region" || drawMode === "paint") return;
                        event.stopPropagation();
                      }}
                      onClick={() => {
                        if (drawMode === "region") return;
                        if (drawMode === "paint") {
                          paintRegionCell(cell.x, cell.y);
                          return;
                        }
                        selectCell(key);
                      }}
                      onKeyDown={(event) => {
                        if (
                          drawMode !== "region" &&
                          drawMode !== "paint" &&
                          (event.key === "Enter" || event.key === " ")
                        ) {
                          event.preventDefault();
                          selectCell(key);
                        }
                      }}
                      onMouseEnter={() => showPopover(key)}
                      onMouseLeave={() => hidePopoverLater(key)}
                      onFocus={() => showPopover(key)}
                      onBlur={() => hidePopoverLater(key)}
                    >
                      <title>
                        {nodeTitle} · （{cell.x}, {cell.y}） ·{" "}
                        {effectiveTerrain?.displayName || "未设置地形"}
                      </title>
                      <rect
                        x={-31}
                        y={-25}
                        width={62}
                        height={50}
                        rx={14}
                        className="game-map-node-card"
                        fill={effectiveTerrain?.color ?? "#94a3b8"}
                      />
                      <circle
                        cx={-20}
                        cy={-14}
                        r={4}
                        className={
                          passable === false
                            ? "game-map-node-status blocked"
                            : "game-map-node-status"
                        }
                      />
                      <text
                        x={0}
                        y={1}
                        textAnchor="middle"
                        className="game-map-node-label"
                        pointerEvents="none"
                      >
                        {nodeTitle.slice(0, 10)}
                      </text>
                      <text
                        x={0}
                        y={15}
                        textAnchor="middle"
                        className="game-map-node-terrain"
                        pointerEvents="none"
                      >
                        {(effectiveTerrain?.displayName || "未设地形").slice(0, 9)}
                      </text>
                      <text
                        x={0}
                        y={42}
                        textAnchor="middle"
                        className="game-map-node-coordinate"
                        pointerEvents="none"
                      >
                        {cell.x}, {cell.y}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
            {!cells.length && !map.terrainRegions.length ? (
              <div className="game-map-empty">
                <strong>还没有地图重点或地形区</strong>
                <span>添加重点坐标，或选择地形后拖拽创建区域。</span>
              </div>
            ) : null}
            {popoverCell && popoverKey ? (
              <div
                className="game-map-popover"
                role="dialog"
                aria-label="地图坐标信息"
                onMouseEnter={() => showPopover(popoverKey)}
                onMouseLeave={() => hidePopoverLater(popoverKey)}
                onFocus={() => showPopover(popoverKey)}
                onBlur={() => hidePopoverLater(popoverKey)}
              >
                <div className="game-map-popover-heading">
                  <strong>
                    {popoverCell.zoneName?.trim() ||
                      `坐标（${popoverCell.x}, ${popoverCell.y}）`}
                  </strong>
                  <span>
                    {popoverCell.x}, {popoverCell.y}
                  </span>
                </div>
                <p>
                  {terrainNameAt(map, popoverCell)} ·{" "}
                  {effectivePassableAt(map, popoverCell) === false
                    ? "不可通行"
                    : "可通行"}
                </p>
                <p>
                  {popoverCell.objects.length} 个物件 ·{" "}
                  {Object.keys(effectiveMapProperties(map, popoverCell)).length} 项有效属性
                </p>
                <div className="game-map-popover-actions">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => selectCell(popoverKey)}
                  >
                    查看
                  </button>
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={() => {
                      editCell(popoverKey);
                      setHoveredKey(null);
                    }}
                  >
                    编辑
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <p className="game-map-help">
            拖动空白处平移 · 滚轮或「− / +」缩放 · 点击或触摸重点选中 ·
            选择「拖拽创建地形区」可批量绘制
          </p>

          <form
            className="game-map-add-coordinate"
            onSubmit={(event) => {
              event.preventDefault();
              addPoint();
            }}
          >
            <label className="game-field">
              X
              <input
                type="number"
                step={1}
                value={newX}
                onChange={(event) => setNewX(event.target.value)}
              />
            </label>
            <label className="game-field">
              Y
              <input
                type="number"
                step={1}
                value={newY}
                onChange={(event) => setNewY(event.target.value)}
              />
            </label>
            <button type="submit" className="secondary-btn">
              添加重点坐标
            </button>
          </form>

          {selectedCell && selectedKey ? (
            <div className="game-map-selection-card">
              <div className="game-map-selection-header">
                <div>
                  <h4>{selectedCell.zoneName?.trim() || "未命名重点"}</h4>
                  <span>
                    坐标（{selectedCell.x}, {selectedCell.y}） · 当前地形：
                    {selectedTerrain?.displayName ?? "未标注"}
                  </span>
                </div>
                <span
                  className={
                    effectivePassableAt(map, selectedCell) === false
                      ? "game-map-passability blocked"
                      : "game-map-passability"
                  }
                >
                  {effectivePassableAt(map, selectedCell) === false
                    ? "不可通行"
                    : "可通行"}
                </span>
              </div>
              {editingKey === selectedKey ? (
                <div className="game-map-selected-editor">
                  <div className="game-map-editor-fields">
                    <label className="game-field">
                      区域名称
                      <input
                        value={selectedCell.zoneName ?? ""}
                        placeholder="例如：北门集市"
                        onChange={(event) =>
                          updateSelectedCell({ zoneName: event.target.value })
                        }
                      />
                    </label>
                    <label className="game-field">
                      点覆盖地形
                      <select
                        value={selectedCell.terrainId ?? ""}
                        onChange={(event) =>
                          updateSelectedCell({
                            terrainId: event.target.value || undefined,
                            terrain: undefined,
                          })
                        }
                      >
                        <option value="">继承地形区</option>
                        {terrainTypes.map((terrain) => (
                          <option value={terrain.id} key={terrain.id}>
                            {terrain.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="game-field">
                      通行性覆盖
                      <select
                        value={selectedPassability}
                        onChange={(event) =>
                          updateSelectedCell({
                            passable:
                              event.target.value === "inherit"
                                ? undefined
                                : event.target.value === "true",
                          })
                        }
                      >
                        <option value="inherit">继承地形默认</option>
                        <option value="true">强制可通行</option>
                        <option value="false">强制不可通行</option>
                      </select>
                    </label>
                    <label className="game-field game-map-editor-wide">
                      点属性（每行一个 key=value）
                      <textarea
                        rows={3}
                        value={propertiesText(selectedCell.properties)}
                        placeholder={"危险等级=2\n所属势力=北境"}
                        onChange={(event) =>
                          updateSelectedCell({
                            properties: parseProperties(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label className="game-field game-map-editor-wide">
                      存在物件（逗号分隔）
                      <input
                        value={selectedCell.objects.join("、")}
                        placeholder="例如：水井、告示牌"
                        onChange={(event) =>
                          updateSelectedCell({
                            objects: event.target.value
                              .split(/[,，、]/)
                              .map((item) => item.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                  </div>
                  <div className="game-map-selection-actions">
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => setEditingKey(null)}
                    >
                      完成编辑
                    </button>
                    <button
                      type="button"
                      className="link-btn game-map-delete-btn"
                      onClick={removeSelectedCell}
                    >
                      删除此重点
                    </button>
                  </div>
                </div>
              ) : (
                <div className="game-map-selection-summary">
                  <p>
                    {terrainNameAt(map, selectedCell)} ·{" "}
                    {selectedCell.objects.length} 个物件 ·{" "}
                    {Object.keys(effectiveMapProperties(map, selectedCell)).length} 项有效属性
                  </p>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => setEditingKey(selectedKey)}
                  >
                    编辑所选重点
                  </button>
                </div>
              )}
            </div>
          ) : (
            <p className="game-map-no-selection">
              选择一个地图重点后，可查看详情或编辑点覆盖。
            </p>
          )}

          <div className="game-map-region-manager">
            <div className="game-map-subsection-heading">
              <div>
                <h4>地形区</h4>
                <span>
                  地形区只保存坐标数组或矩形范围；新绘制区域优先于旧背景。
                </span>
              </div>
              <span>{map.terrainRegions.length} 个</span>
            </div>
            {map.terrainRegions.length ? (
              <div className="game-map-region-list">
                {map.terrainRegions.map((region) => (
                  <div key={region.id} className="game-map-region-item">
                    <div
                      className={
                        region.id === selectedRegionId
                          ? "game-map-region-row selected"
                          : "game-map-region-row"
                      }
                      role="button"
                      tabIndex={0}
                      onClick={() =>
                        setSelectedRegionId((current) =>
                          current === region.id ? null : region.id,
                        )
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedRegionId((current) =>
                            current === region.id ? null : region.id,
                          );
                        }
                      }}
                    >
                      <code>{region.id}</code>
                      <select
                        value={region.terrainId}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          updateRegionTerrain(region.id, event.target.value)
                        }
                      >
                        {terrainTypes.map((terrain) => (
                          <option value={terrain.id} key={terrain.id}>
                            {terrain.displayName}
                          </option>
                        ))}
                      </select>
                      <span>{regionCoordinateCount(region)} 格</span>
                      <button
                        type="button"
                        className="link-btn game-map-delete-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          removeRegion(region.id);
                          if (selectedRegionId === region.id) {
                            setSelectedRegionId(null);
                          }
                        }}
                      >
                        删除
                      </button>
                    </div>
                    {region.id === selectedRegionId ? (
                      <div className="game-map-region-edit">
                        {(region.ranges ?? []).length ? (
                          <div className="game-map-region-ranges">
                            <strong>矩形范围</strong>
                            {(region.ranges ?? []).map((range, index) => (
                              <div
                                className="game-map-region-range-row"
                                key={`${region.id}-range-${index}`}
                              >
                                <label className="game-field">
                                  x
                                  <input
                                    type="number"
                                    value={range.x}
                                    onChange={(event) =>
                                      updateRegionRange(
                                        region.id,
                                        index,
                                        { x: Number(event.target.value) },
                                      )
                                    }
                                  />
                                </label>
                                <label className="game-field">
                                  y
                                  <input
                                    type="number"
                                    value={range.y}
                                    onChange={(event) =>
                                      updateRegionRange(
                                        region.id,
                                        index,
                                        { y: Number(event.target.value) },
                                      )
                                    }
                                  />
                                </label>
                                <label className="game-field">
                                  宽
                                  <input
                                    type="number"
                                    min={1}
                                    value={range.width}
                                    onChange={(event) =>
                                      updateRegionRange(
                                        region.id,
                                        index,
                                        { width: Math.max(1, Number(event.target.value)) },
                                      )
                                    }
                                  />
                                </label>
                                <label className="game-field">
                                  高
                                  <input
                                    type="number"
                                    min={1}
                                    value={range.height}
                                    onChange={(event) =>
                                      updateRegionRange(
                                        region.id,
                                        index,
                                        { height: Math.max(1, Number(event.target.value)) },
                                      )
                                    }
                                  />
                                </label>
                                <button
                                  type="button"
                                  className="link-btn game-map-delete-btn"
                                  onClick={() => removeRegionRange(region.id, index)}
                                >
                                  删矩形
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {(region.coordinates ?? []).length ? (
                          <div className="game-map-region-coords">
                            <strong>坐标点</strong>
                            <div className="game-map-region-coords-list">
                              {(region.coordinates ?? []).map(
                                ([x, y], index) => (
                                  <span
                                    className="game-map-region-coord"
                                    key={`${region.id}-coord-${index}`}
                                  >
                                    ({x}, {y})
                                    <button
                                      type="button"
                                      className="link-btn game-map-delete-btn"
                                      onClick={() =>
                                        removeRegionCoordinate(region.id, index)
                                      }
                                    >
                                      删
                                    </button>
                                  </span>
                                ),
                              )}
                            </div>
                          </div>
                        ) : null}
                        <p className="settings-hint">
                          切换到"点选地形"模式，可在地图上点击格子加入或移出本区域。
                        </p>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="game-map-no-selection">还没有稀疏地形区。</p>
            )}
          </div>

          <div className="game-map-terrain-manager">
            <div className="game-map-subsection-heading">
              <div>
                <h4>地形注册表</h4>
                <span>
                  id 永久稳定；显示名、颜色、通行性和默认属性可独立调整。
                </span>
              </div>
              <span>{terrainTypes.length} 种</span>
            </div>
            {terrainTypes.length > 0 ? (
              <div className="game-map-terrain-list">
                {terrainTypes.map((terrain) => (
                  <div className="game-map-terrain-row game-map-terrain-row-rich" key={terrain.id}>
                    <input
                      aria-label={`地形${terrain.displayName}的新显示名称`}
                      value={
                        terrainRenameDrafts[terrain.id] ?? terrain.displayName
                      }
                      onChange={(event) =>
                        setTerrainRenameDrafts((current) => ({
                          ...current,
                          [terrain.id]: event.target.value,
                        }))
                      }
                      onBlur={() => renameTerrain(terrain.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          renameTerrain(terrain.id);
                        }
                      }}
                    />
                    <input
                      type="color"
                      aria-label={`${terrain.displayName}颜色`}
                      value={terrain.color}
                      onChange={(event) =>
                        updateTerrain(terrain.id, { color: event.target.value })
                      }
                    />
                    <select
                      aria-label={`${terrain.displayName}通行性`}
                      value={terrain.passable ? "true" : "false"}
                      onChange={(event) =>
                        updateTerrain(terrain.id, {
                          passable: event.target.value === "true",
                        })
                      }
                    >
                      <option value="true">可通行</option>
                      <option value="false">不可通行</option>
                    </select>
                    <code title="稳定 id">{terrain.id}</code>
                    <textarea
                      rows={1}
                      aria-label={`${terrain.displayName}默认属性`}
                      value={propertiesText(terrain.defaultProperties)}
                      placeholder="默认属性 key=value"
                      onChange={(event) =>
                        updateTerrain(terrain.id, {
                          defaultProperties: parseTerrainProperties(
                            event.target.value,
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      className="link-btn game-map-delete-btn"
                      onClick={() => deleteTerrain(terrain.id)}
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="game-map-no-selection">还没有地形类型。</p>
            )}
            <form
              className="game-map-terrain-add game-map-terrain-add-rich"
              onSubmit={(event) => {
                event.preventDefault();
                addTerrainType();
              }}
            >
              <input
                value={newTerrain}
                placeholder="新增地形显示名，例如：林地"
                aria-label="新增地形显示名称"
                onChange={(event) => setNewTerrain(event.target.value)}
              />
              <input
                type="color"
                value={newTerrainColor}
                aria-label="新增地形颜色"
                onChange={(event) => setNewTerrainColor(event.target.value)}
              />
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={newTerrainPassable}
                  onChange={(event) => setNewTerrainPassable(event.target.checked)}
                />
                可通行
              </label>
              <input
                value={newTerrainProperties}
                placeholder="默认属性 movementCost=1"
                aria-label="新增地形默认属性"
                onChange={(event) => setNewTerrainProperties(event.target.value)}
              />
              <button type="submit" className="secondary-btn">
                添加地形
              </button>
            </form>
          </div>
          {mapNotice ? (
            <p className="game-map-notice" role="status">
              {mapNotice}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

