/** Offline .excalidraw JSON builder (table as rectangle + bound text cells). */

export const MAX_EXCAL_ROWS = 40;
export const MAX_EXCAL_COLS = 12;
export const MAX_EXCAL_CELL_CHARS = 120;

type CellGrid = string[][];

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    w += /[\u0000-\u00ff]/.test(ch) ? fontSize * 0.55 : fontSize;
  }
  return Math.ceil(w);
}

function baseProps(seed: number) {
  return {
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid" as const,
    strokeWidth: 2,
    strokeStyle: "solid" as const,
    roughness: 1,
    opacity: 100,
    seed,
    version: 1,
    versionNonce: seed ^ 0x9e3779b9,
    isDeleted: false,
    groupIds: [] as string[],
    frameId: null as string | null,
    boundElements: null as { id: string; type: string }[] | null,
    updated: Date.now(),
    link: null as string | null,
    locked: false,
  };
}

/**
 * Parse tool input into a 2D string grid.
 * Accepts: rows array, JSON string of 2D array, or TSV/CSV text.
 */
export function parseTableRows(input: unknown): CellGrid {
  if (Array.isArray(input)) {
    return normalizeGrid(input);
  }
  if (typeof input === "string") {
    const raw = input.trim();
    if (!raw) return [];
    if (raw.startsWith("[")) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) return normalizeGrid(parsed);
      } catch {
        /* fall through to TSV */
      }
    }
    return parseDelimited(raw);
  }
  return [];
}

function normalizeGrid(rows: unknown[]): CellGrid {
  const grid: CellGrid = [];
  for (const row of rows) {
    if (Array.isArray(row)) {
      grid.push(row.map((c) => String(c ?? "").slice(0, MAX_EXCAL_CELL_CHARS)));
    } else if (typeof row === "string") {
      grid.push(
        row.split(/\t|,/).map((c) => c.trim().slice(0, MAX_EXCAL_CELL_CHARS)),
      );
    } else if (row != null) {
      grid.push([String(row).slice(0, MAX_EXCAL_CELL_CHARS)]);
    }
  }
  return grid;
}

function parseDelimited(text: string): CellGrid {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length);
  const useTab =
    lines.some((l) => l.includes("\t")) ||
    !lines.some((l) => l.includes(","));
  return lines.map((line) =>
    (useTab ? line.split("\t") : splitCsvLine(line)).map((c) =>
      c.trim().slice(0, MAX_EXCAL_CELL_CHARS),
    ),
  );
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export function validateTableGrid(grid: CellGrid): CellGrid {
  if (!grid.length) {
    throw new Error("表格至少需要一行数据。");
  }
  if (grid.length > MAX_EXCAL_ROWS) {
    throw new Error(`行数过多（${grid.length}），上限 ${MAX_EXCAL_ROWS}。`);
  }
  const cols = Math.max(...grid.map((r) => r.length), 0);
  if (cols === 0) throw new Error("表格不能为空。");
  if (cols > MAX_EXCAL_COLS) {
    throw new Error(`列数过多（${cols}），上限 ${MAX_EXCAL_COLS}。`);
  }
  return grid.map((row) => {
    const padded = [...row];
    while (padded.length < cols) padded.push("");
    return padded.slice(0, cols);
  });
}

export function buildExcalidrawTableJson(
  gridInput: CellGrid,
  options?: { title?: string },
): string {
  const grid = validateTableGrid(gridInput);
  const rows = grid.length;
  const cols = grid[0].length;
  const fontSize = 16;
  const padX = 14;
  const padY = 10;
  const originX = 80;
  const originY = options?.title?.trim() ? 140 : 80;
  const groupId = uid("g");

  const colWidths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let maxW = 72;
    for (let r = 0; r < rows; r++) {
      const cell = grid[r][c] || " ";
      maxW = Math.max(maxW, estimateTextWidth(cell, fontSize) + padX * 2);
    }
    colWidths.push(Math.min(maxW, 280));
  }
  const rowHeight = Math.max(36, Math.ceil(fontSize * 1.25) + padY * 2);

  const elements: Record<string, unknown>[] = [];
  let seed = (Date.now() % 1_000_000) + 1;

  if (options?.title?.trim()) {
    const title = options.title.trim().slice(0, 80);
    const tw = estimateTextWidth(title, 28) + 8;
    elements.push({
      ...baseProps(seed++),
      id: uid("title"),
      type: "text",
      x: originX,
      y: 60,
      width: tw,
      height: 36,
      text: title,
      originalText: title,
      fontSize: 28,
      fontFamily: 1,
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      autoResize: true,
      lineHeight: 1.25,
      groupIds: [groupId],
      backgroundColor: "transparent",
    });
  }

  let xCursor = originX;
  for (let c = 0; c < cols; c++) {
    let yCursor = originY;
    for (let r = 0; r < rows; r++) {
      const cellText = grid[r][c] || " ";
      const w = colWidths[c];
      const h = rowHeight;
      const rectId = uid(`r${r}c${c}`);
      const textId = uid(`t${r}c${c}`);
      const isHeader = r === 0;
      const th = Math.ceil(fontSize * 1.25);
      elements.push({
        ...baseProps(seed++),
        id: rectId,
        type: "rectangle",
        x: xCursor,
        y: yCursor,
        width: w,
        height: h,
        backgroundColor: isHeader ? "#a5d8ff" : "#ffffff",
        fillStyle: "solid",
        roundness: null,
        groupIds: [groupId],
        boundElements: [{ id: textId, type: "text" }],
      });
      elements.push({
        ...baseProps(seed++),
        id: textId,
        type: "text",
        x: xCursor + padX,
        y: yCursor + (h - th) / 2,
        width: Math.max(8, w - padX * 2),
        height: th,
        text: cellText,
        originalText: cellText,
        fontSize,
        fontFamily: 1,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: rectId,
        autoResize: false,
        lineHeight: 1.25,
        groupIds: [groupId],
        boundElements: null,
        backgroundColor: "transparent",
        strokeWidth: 1,
      });
      yCursor += h;
    }
    xCursor += colWidths[c];
  }

  const doc = {
    type: "excalidraw",
    version: 2,
    source: "https://apiinphone.local",
    elements,
    appState: {
      gridSize: null,
      viewBackgroundColor: "#ffffff",
    },
    files: {},
  };
  return JSON.stringify(doc, null, 2);
}
