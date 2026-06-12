import type { NumberedSource, ToolTraceItem } from "../types";
import type { SearchResult } from "./webSearch";

export type { NumberedSource };

function isHitStartLine(line: string): boolean {
  return /^\s*\[\d+\]\s/.test(line) || /^\s*\d+\.\s/.test(line);
}

/** Parse web_search tool output (legacy `1.` or `[1]` formats). */
export function parseSearchHits(
  text: string,
): Array<{ n?: number; title: string; url: string; snippet?: string }> {
  const hits: Array<{ n?: number; title: string; url: string; snippet?: string }> =
    [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const bracket = lines[i].match(/^\s*\[(\d+)\]\s+(.+)$/);
    const legacy = lines[i].match(/^\s*(\d+)\.\s+(.+)$/);
    const title = (bracket?.[2] ?? legacy?.[2])?.trim();
    if (!title) continue;
    const n = bracket
      ? Number(bracket[1])
      : legacy
        ? Number(legacy[1])
        : undefined;
    const urlLine = (lines[i + 1] || "").trim();
    const url = urlLine.replace(/^URL:\s*/i, "").trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;

    let snippet: string | undefined;
    let consumed = 2;
    const maybeSnippet = (lines[i + 2] || "").trim();
    if (
      maybeSnippet &&
      !isHitStartLine(maybeSnippet) &&
      !maybeSnippet.startsWith("http://") &&
      !maybeSnippet.startsWith("https://")
    ) {
      snippet = maybeSnippet.startsWith("摘要:")
        ? maybeSnippet.slice(3).trim()
        : maybeSnippet;
      if (!snippet) snippet = undefined;
      consumed = 3;
    }

    hits.push({ n, title, url, snippet });
    i += consumed - 1;
  }
  return hits;
}

export function formatNumberedSearchResults(
  query: string,
  results: SearchResult[],
  startIndex = 1,
): string {
  const lines = [
    `query: ${query}`,
    `\nresults (${results.length}):`,
    "（以下编号请在回答正文中用 [1][2]… 标注引用，编号与「参考来源」一致。）",
  ];
  if (!results.length) {
    lines.push("\n(无结果)");
    return lines.join("\n");
  }
  results.forEach((r, i) => {
    const n = startIndex + i;
    lines.push(`\n[${n}] ${r.title}`);
    lines.push(`URL: ${r.url}`);
    if (r.snippet) lines.push(`摘要: ${r.snippet}`);
  });
  return lines.join("\n");
}

/** Renumber hits in an existing tool output for multi-round search. */
export function renumberSearchOutput(
  text: string,
  startIndex: number,
): { text: string; nextIndex: number } {
  const queryMatch = text.match(/^query:\s*(.+)$/m);
  const query = queryMatch?.[1]?.trim() ?? "";
  const hits = parseSearchHits(text);
  if (!hits.length) return { text, nextIndex: startIndex };
  const results: SearchResult[] = hits.map((h) => ({
    title: h.title,
    url: h.url,
    snippet: h.snippet ?? "",
  }));
  return {
    text: formatNumberedSearchResults(query, results, startIndex),
    nextIndex: startIndex + hits.length,
  };
}

/** All numbered hits from tool trace (keep every [n], no URL dedup). */
export function collectNumberedSources(
  toolTrace: ToolTraceItem[],
): NumberedSource[] {
  const sources: NumberedSource[] = [];
  let fallbackN = 1;
  for (const tool of toolTrace) {
    if (tool.name !== "web_search" || !tool.result?.trim()) continue;
    for (const hit of parseSearchHits(tool.result)) {
      const n = hit.n ?? fallbackN++;
      sources.push({ n, title: hit.title, url: hit.url });
      if (hit.n != null) fallbackN = Math.max(fallbackN, hit.n + 1);
    }
  }
  sources.sort((a, b) => a.n - b.n);
  return sources;
}

/** Map citation index → URL for in-text [n] links. */
export function citationUrlMap(
  sources: NumberedSource[],
): Map<number, string> {
  const map = new Map<number, string>();
  for (const s of sources) {
    if (!map.has(s.n)) map.set(s.n, s.url);
  }
  return map;
}
