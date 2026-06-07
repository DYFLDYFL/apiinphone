import type { AppSettings } from "../types";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export class WebSearchError extends Error {}

const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36";
const BING_CN = "https://cn.bing.com/search";
const BING_INTL = "https://www.bing.com/search";
const BING_RSS = "https://www.bing.com/search";
const DDG_HTML = "https://html.duckduckgo.com/html/";
const DDG_API = "https://api.duckduckgo.com/";

const TAG_RE = /<[^>]+>/g;

export function formatSearchResults(
  query: string,
  results: SearchResult[],
): string {
  const lines = [`query: ${query}`, `\nresults (${results.length}):`];
  if (!results.length) {
    lines.push("\n(无结果)");
  }
  results.forEach((r, i) => {
    lines.push(`\n${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
  });
  return lines.join("\n");
}

function stripTags(html: string): string {
  const el = document.createElement("textarea");
  el.innerHTML = html.replace(TAG_RE, " ");
  return el.value.replace(/\s+/g, " ").trim();
}

function networkHint(err: unknown): string {
  const raw = String(err).toLowerCase();
  if (raw.includes("failed to fetch") || raw.includes("network") || raw.includes("abort")) {
    return "（网络不可用或请求超时，请检查网络后重试）";
  }
  return "";
}

async function fetchText(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!resp.ok) throw new WebSearchError(`HTTP ${resp.status}`);
    return await resp.text();
  } catch (err) {
    if (err instanceof WebSearchError) throw err;
    throw new WebSearchError(`网络请求失败${networkHint(err)}：${String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

function parseBingResults(html: string, topK: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.match(/<li[^>]*\bb_algo\b[^>]*>[\s\S]*?<\/li>/gi) ?? [];
  for (const block of blocks) {
    if (results.length >= topK) break;
    const linkM = block.match(
      /<h2[^>]*>\s*<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!linkM) continue;
    const capM = block.match(
      /<div[^>]*\bb_caption\b[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/i,
    );
    results.push({
      title: stripTags(linkM[2]),
      url: linkM[1],
      snippet: capM ? stripTags(capM[1]) : "",
    });
  }
  if (!results.length && /captcha|verify you are human|access denied/i.test(html)) {
    throw new WebSearchError("搜索引擎返回验证页，请更换引擎或稍后重试。");
  }
  return results;
}

function parseDuckDuckGoResults(html: string, topK: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks =
    html.match(
      /<div[^>]*\bresult\b[^>]*>[\s\S]*?<\/div>\s*(?=<div[^>]*\bresult\b|$)/gi,
    ) ?? [];
  for (const block of blocks) {
    if (results.length >= topK) break;
    const linkM = block.match(
      /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!linkM) continue;
    const snipM = block.match(
      /<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
    );
    results.push({
      title: stripTags(linkM[2]),
      url: linkM[1],
      snippet: snipM ? stripTags(snipM[1]) : "",
    });
  }
  return results;
}

function parseDdgApi(data: Record<string, unknown>): SearchResult[] {
  const results: SearchResult[] = [];
  const abstract = String(data.AbstractText ?? data.Abstract ?? "").trim();
  const abstractUrl = String(data.AbstractURL ?? "").trim();
  const heading = String(data.Heading ?? "Summary").trim();
  if (abstractUrl && abstract) {
    results.push({ title: heading, url: abstractUrl, snippet: abstract });
  }
  const walk = (topics: unknown) => {
    if (!Array.isArray(topics)) return;
    for (const topic of topics) {
      if (!topic || typeof topic !== "object") continue;
      const row = topic as Record<string, unknown>;
      if (Array.isArray(row.Topics)) {
        walk(row.Topics);
        continue;
      }
      const url = String(row.FirstURL ?? "").trim();
      const text = String(row.Text ?? "").trim();
      if (url && text) results.push({ title: text, url, snippet: "" });
    }
  };
  walk(data.Results);
  walk(data.RelatedTopics);
  return results;
}

function parseBingRss(xml: string, topK: number): SearchResult[] {
  const results: SearchResult[] = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  for (const item of items) {
    if (results.length >= topK) break;
    const title = item.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
    const link = item.match(/<link>([\s\S]*?)<\/link>/i)?.[1]?.trim() ?? "";
    const desc = item.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? "";
    if (title && link) {
      results.push({ title: stripTags(title), url: link, snippet: stripTags(desc) });
    }
  }
  return results;
}

function normalizeSearxngEndpoint(raw: string): string {
  let text = raw.trim() || "http://localhost:8080";
  if (!text.includes("://")) text = `http://${text}`;
  return text.replace(/\/$/, "");
}

function fallbackEngines(primary: string): string[] {
  if (primary === "bing_rss" || primary === "ddg_api") return [];
  if (primary === "metaso" || primary === "baidu") return ["bing_rss", "ddg_api"];
  return ["bing_rss", "ddg_api"].filter((e) => e !== primary);
}

async function searchWithEngine(
  engine: string,
  query: string,
  settings: AppSettings,
  topK: number,
): Promise<SearchResult[]> {
  if (engine === "bing_cn") {
    const html = await fetchText(`${BING_CN}?q=${encodeURIComponent(query)}`);
    return parseBingResults(html, topK);
  }
  if (engine === "bing_intl") {
    const html = await fetchText(`${BING_INTL}?q=${encodeURIComponent(query)}`);
    return parseBingResults(html, topK);
  }
  if (engine === "bing_rss") {
    const xml = await fetchText(`${BING_RSS}?q=${encodeURIComponent(query)}&format=rss`, {
      headers: { Accept: "application/rss+xml, application/xml, text/xml" },
    });
    return parseBingRss(xml, topK);
  }
  if (engine === "duckduckgo") {
    const html = await fetchText(DDG_HTML, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://html.duckduckgo.com/",
      },
      body: new URLSearchParams({ q: query, b: "", kl: "wt-wt" }).toString(),
    });
    return parseDuckDuckGoResults(html, topK);
  }
  if (engine === "ddg_api") {
    const json = await fetchText(
      `${DDG_API}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { Accept: "application/json" } },
    );
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(json) as Record<string, unknown>;
    } catch {
      throw new WebSearchError("DuckDuckGo API 返回无效 JSON。");
    }
    return parseDdgApi(data).slice(0, topK);
  }
  if (engine === "searxng") {
    const base = normalizeSearxngEndpoint(settings.webSearchEndpoint);
    try {
      const resp = await fetch(
        `${base}/search?q=${encodeURIComponent(query)}&format=json`,
        { headers: { Accept: "application/json" } },
      );
      if (resp.ok) {
        const data = (await resp.json()) as {
          results?: Array<{ title?: string; url?: string; content?: string }>;
        };
        const results = (data.results ?? []).slice(0, topK).map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          snippet: r.content ?? "",
        }));
        if (results.length) return results;
      }
    } catch {
      /* HTML fallback */
    }
    const html = await fetchText(
      `${base}/search?q=${encodeURIComponent(query)}&format=html`,
    );
    const articleRe = /<article[^>]*\bresult\b[^>]*>[\s\S]*?<\/article>/gi;
    const results: SearchResult[] = [];
    let match: RegExpExecArray | null;
    while ((match = articleRe.exec(html)) && results.length < topK) {
      const block = match[0];
      const linkM = block.match(
        /<h[34][^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
      );
      if (!linkM) continue;
      results.push({
        title: stripTags(linkM[2]),
        url: linkM[1],
        snippet: "",
      });
    }
    return results;
  }
  if (engine === "metaso") {
    const key = settings.webSearchMetasoKey.trim();
    if (!key) throw new WebSearchError("Metaso 需要 API Key。");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch("https://metaso.cn/api/v1/search", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: query, scope: "webpage", size: topK }),
      });
      if (!resp.ok) throw new WebSearchError(`Metaso HTTP ${resp.status}`);
      const data = (await resp.json()) as {
        webpages?: Array<{ title?: string; link?: string; snippet?: string }>;
      };
      return (data.webpages ?? []).slice(0, topK).map((r) => ({
        title: r.title ?? "",
        url: r.link ?? "",
        snippet: r.snippet ?? "",
      }));
    } finally {
      clearTimeout(timer);
    }
  }
  if (engine === "baidu") {
    const key = settings.webSearchBaiduKey.trim();
    if (!key) throw new WebSearchError("百度 AI 搜索需要 API Key。");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(
        "https://qianfan.baidubce.com/v2/ai_search/web_search",
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, top_k: topK }),
        },
      );
      if (!resp.ok) throw new WebSearchError(`Baidu HTTP ${resp.status}`);
      const data = (await resp.json()) as {
        results?: Array<{ title?: string; url?: string; snippet?: string }>;
      };
      return (data.results ?? []).slice(0, topK).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.snippet ?? "",
      }));
    } finally {
      clearTimeout(timer);
    }
  }
  const html = await fetchText(`${BING_CN}?q=${encodeURIComponent(query)}`);
  return parseBingResults(html, topK);
}

export async function webSearch(
  query: string,
  settings: AppSettings,
  topK = 5,
): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) throw new WebSearchError("搜索词不能为空");
  const k = Math.min(10, Math.max(1, topK));
  const primary = settings.webSearchEngine || "bing_cn";
  const engines = [primary, ...fallbackEngines(primary)];
  const errors: string[] = [];

  for (const engine of engines) {
    try {
      const results = await searchWithEngine(engine, q, settings, k);
      if (results.length) return results;
      errors.push(`${engine}: 无结果`);
    } catch (err) {
      const msg = err instanceof WebSearchError ? err.message : String(err);
      errors.push(`${engine}: ${msg}`);
    }
  }

  const detail = errors[errors.length - 1] ?? "未知错误";
  throw new WebSearchError(`搜索失败（已尝试 ${engines.length} 个引擎）。${detail}`);
}

export async function webFetch(url: string): Promise<string> {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new WebSearchError("url 必须是 http:// 或 https:// 开头的绝对地址。");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebSearchError("无效的 URL。");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new WebSearchError("不允许访问内网或本地地址。");
  }
  try {
    const html = await fetchText(url, {}, 20000);
    const bodyMatch = html.match(/<body[\s\S]*?>([\s\S]*?)<\/body>/i);
    const text = stripTags(bodyMatch?.[1] ?? html);
    return text.slice(0, 12000);
  } catch (err) {
    if (err instanceof WebSearchError) throw err;
    throw new WebSearchError(`抓取失败${networkHint(err)}：${String(err)}`);
  }
}

/** Safe wrapper: never throws — returns text for tool role message. */
export async function webSearchForTool(
  query: string,
  settings: AppSettings,
  topK = 5,
): Promise<string> {
  try {
    const results = await webSearch(query, settings, topK);
    return formatSearchResults(query, results);
  } catch (err) {
    const msg = err instanceof WebSearchError ? err.message : String(err);
    return (
      `搜索失败：${msg}\n\n` +
      "请向用户说明无法联网搜索，并建议：检查网络、在设置中更换搜索引擎（推荐 DuckDuckGo API 或 Bing RSS 备用），或关闭 Tool Calls 后重试。"
    );
  }
}

export async function webFetchForTool(url: string): Promise<string> {
  try {
    return await webFetch(url);
  } catch (err) {
    const msg = err instanceof WebSearchError ? err.message : String(err);
    return `抓取失败：${msg}`;
  }
}
