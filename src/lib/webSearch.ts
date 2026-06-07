import type { AppSettings } from "../types";
import { httpJson, httpText } from "./nativeHttp";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export class WebSearchError extends Error {}

/** Desktop UA — search engines often return richer HTML than mobile UA. */
const SEARCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const BING_CN = "https://cn.bing.com/search";
const BING_INTL = "https://www.bing.com/search";
const BING_RSS = "https://www.bing.com/search";
const DDG_HTML = "https://html.duckduckgo.com/html/";
const DDG_API = "https://api.duckduckgo.com/";

/** Community-maintained public SearXNG instances (last-resort fallback). */
const PUBLIC_SEARXNG = [
  "https://searx.be",
  "https://search.rhscz.eu",
  "https://paulgo.io",
];

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

function decodeHtmlEntities(text: string): string {
  const el = document.createElement("textarea");
  el.innerHTML = text;
  return el.value;
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(TAG_RE, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapBingUrl(href: string, base = BING_INTL): string {
  if (!href.includes("/ck/a")) return href;
  try {
    const url = new URL(href, base);
    const u = url.searchParams.get("u") ?? "";
    if (!u) return href;
    const b64 = u.startsWith("a1") ? u.slice(2) : u;
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const decoded = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + pad);
    if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
      return decoded;
    }
  } catch {
    /* keep original */
  }
  return href;
}

function networkHint(err: unknown): string {
  const raw = String(err).toLowerCase();
  if (
    raw.includes("failed to fetch") ||
    raw.includes("network") ||
    raw.includes("abort")
  ) {
    return "（网络不可用或请求超时，请检查网络/VPN 后重试）";
  }
  return "";
}

async function fetchText(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<string> {
  try {
    const headers: Record<string, string> = {
      "User-Agent": SEARCH_UA,
      Accept:
        "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      ...(init.headers as Record<string, string> | undefined),
    };
    const { status, text } = await httpText(
      url,
      { ...init, headers },
      timeoutMs,
    );
    if (status < 200 || status >= 300) {
      throw new WebSearchError(`HTTP ${status}`);
    }
    return text;
  } catch (err) {
    if (err instanceof WebSearchError) throw err;
    throw new WebSearchError(`网络请求失败${networkHint(err)}：${String(err)}`);
  }
}

function blockedPageHint(html: string): string | null {
  if (/captcha|verify you are human|access denied|forbidden/i.test(html)) {
    return "搜索引擎返回验证页，请更换引擎或关闭 VPN 后重试。";
  }
  return null;
}

function parseBingResults(
  html: string,
  topK: number,
  base = BING_CN,
): SearchResult[] {
  const blocked = blockedPageHint(html);
  if (blocked) throw new WebSearchError(blocked);

  const results: SearchResult[] = [];
  const blocks = html.match(/<li[^>]*\bb_algo\b[^>]*>[\s\S]*?<\/li>/gi) ?? [];
  for (const block of blocks) {
    if (results.length >= topK) break;
    const linkM = block.match(
      /<h2[^>]*>\s*<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!linkM) continue;
    const title = stripTags(linkM[2]);
    const url = unwrapBingUrl(decodeHtmlEntities(linkM[1]), base);
    if (!title || !url) continue;
    const capM = block.match(
      /<div[^>]*\bb_caption\b[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/i,
    );
    results.push({
      title,
      url,
      snippet: capM ? stripTags(capM[1]) : "",
    });
  }

  if (results.length) return results;

  const headingRe =
    /<h[23][^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(html)) && results.length < topK) {
    const href = unwrapBingUrl(decodeHtmlEntities(match[1]), base);
    const title = stripTags(match[2]);
    if (!title || !href.startsWith("http")) continue;
    if (href.includes("bing.com/search") || href.includes("microsoft.com/bing")) {
      continue;
    }
    results.push({ title, url: href, snippet: "" });
  }

  if (!results.length) {
    if (/no results found|did not match any documents|无结果|找不到/i.test(html)) {
      return [];
    }
    if (html.length > 4000) {
      throw new WebSearchError("未能解析 Bing 页面，可能被拦截或页面结构已变化。");
    }
  }
  return results;
}

function parseDuckDuckGoResults(html: string, topK: number): SearchResult[] {
  const blocked = blockedPageHint(html);
  if (blocked) throw new WebSearchError(blocked);

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
      url: decodeHtmlEntities(linkM[1]),
      snippet: snipM ? stripTags(snipM[1]) : "",
    });
  }
  if (!results.length && html.length > 2000) {
    throw new WebSearchError("未能解析 DuckDuckGo 页面。");
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
  const trimmed = xml.trim();
  if (
    !trimmed.startsWith("<?xml") &&
    !trimmed.startsWith("<rss") &&
    !/<rss[\s>]/i.test(trimmed)
  ) {
    const blocked = blockedPageHint(xml);
    if (blocked) throw new WebSearchError(blocked);
    throw new WebSearchError("Bing RSS 返回非 RSS 内容（可能被重定向）。");
  }
  const results: SearchResult[] = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  for (const item of items) {
    if (results.length >= topK) break;
    const title = item.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
    const link = item.match(/<link>([\s\S]*?)<\/link>/i)?.[1]?.trim() ?? "";
    const desc = item.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? "";
    if (title && link) {
      results.push({
        title: stripTags(title),
        url: link,
        snippet: stripTags(desc),
      });
    }
  }
  if (!results.length) {
    throw new WebSearchError("Bing RSS 未返回条目。");
  }
  return results;
}

async function searchJina(query: string, topK: number): Promise<SearchResult[]> {
  const text = await fetchText(
    `https://s.jina.ai/${encodeURIComponent(query)}`,
    {
      headers: {
        Accept: "text/plain, text/markdown, */*",
        "X-Respond-With": "no-content",
      },
    },
    25000,
  );
  const trimmed = text.trim();
  if (trimmed.length < 30) {
    throw new WebSearchError("Jina 搜索未返回有效内容。");
  }

  const results: SearchResult[] = [];
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(trimmed)) && results.length < topK) {
    results.push({ title: match[1], url: match[2], snippet: "" });
  }
  if (results.length) return results;

  return [
    {
      title: query,
      url: `https://s.jina.ai/${encodeURIComponent(query)}`,
      snippet: trimmed.slice(0, 5000),
    },
  ];
}

async function searchPublicSearxng(
  query: string,
  topK: number,
): Promise<SearchResult[]> {
  const errors: string[] = [];
  for (const base of PUBLIC_SEARXNG) {
    try {
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
      const { status, data } = await httpJson<{
        results?: Array<{ title?: string; url?: string; content?: string }>;
      }>(
        url,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": SEARCH_UA,
          },
        },
        18000,
      );
      if (status < 200 || status >= 300) {
        errors.push(`${base}: HTTP ${status}`);
        continue;
      }
      const results = (data.results ?? [])
        .filter((r) => r.title && r.url)
        .slice(0, topK)
        .map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          snippet: r.content ?? "",
        }));
      if (results.length) return results;
      errors.push(`${base}: 无结果`);
    } catch (err) {
      errors.push(`${base}: ${String(err)}`);
    }
  }
  throw new WebSearchError(
    `公共 SearXNG 均不可用（${errors.slice(0, 2).join("；")}）`,
  );
}

function normalizeSearxngEndpoint(raw: string): string {
  let text = raw.trim() || "http://localhost:8080";
  if (!text.includes("://")) text = `http://${text}`;
  return text.replace(/\/$/, "");
}

function fallbackEngines(primary: string): string[] {
  const chain = ["bing_rss", "duckduckgo", "bing_intl", "ddg_api", "jina"];
  if (primary === "metaso" || primary === "baidu") return chain;
  return chain.filter((e) => e !== primary);
}

async function searchWithEngine(
  engine: string,
  query: string,
  settings: AppSettings,
  topK: number,
): Promise<SearchResult[]> {
  if (engine === "bing_cn") {
    const html = await fetchText(`${BING_CN}?q=${encodeURIComponent(query)}`);
    return parseBingResults(html, topK, BING_CN);
  }
  if (engine === "bing_intl") {
    const html = await fetchText(`${BING_INTL}?q=${encodeURIComponent(query)}`);
    return parseBingResults(html, topK, BING_INTL);
  }
  if (engine === "bing_rss") {
    const xml = await fetchText(
      `${BING_RSS}?q=${encodeURIComponent(query)}&format=rss`,
      { headers: { Accept: "application/rss+xml, application/xml, text/xml" } },
    );
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
    const results = parseDdgApi(data).slice(0, topK);
    if (!results.length) {
      throw new WebSearchError("DuckDuckGo API 无可用摘要（仅适合实体词，不适合新闻）。");
    }
    return results;
  }
  if (engine === "jina") {
    return searchJina(query, topK);
  }
  if (engine === "searxng") {
    const base = normalizeSearxngEndpoint(settings.webSearchEndpoint);
    try {
      const { status, data } = await httpJson<{
        results?: Array<{ title?: string; url?: string; content?: string }>;
      }>(
        `${base}/search?q=${encodeURIComponent(query)}&format=json`,
        { headers: { Accept: "application/json", "User-Agent": SEARCH_UA } },
        18000,
      );
      if (status >= 200 && status < 300) {
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
    let m: RegExpExecArray | null;
    while ((m = articleRe.exec(html)) && results.length < topK) {
      const block = m[0];
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
    const { status, data } = await httpJson<{
      webpages?: Array<{ title?: string; link?: string; snippet?: string }>;
    }>(
      "https://metaso.cn/api/v1/search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "User-Agent": SEARCH_UA,
        },
        body: JSON.stringify({ q: query, scope: "webpage", size: topK }),
      },
      18000,
    );
    if (status === 401 || status === 403) {
      throw new WebSearchError("Metaso API Key 无效或未授权。");
    }
    if (status !== 200) throw new WebSearchError(`Metaso HTTP ${status}`);
    return (data.webpages ?? []).slice(0, topK).map((r) => ({
      title: r.title ?? "",
      url: r.link ?? "",
      snippet: r.snippet ?? "",
    }));
  }
  if (engine === "baidu") {
    const key = settings.webSearchBaiduKey.trim();
    if (!key) throw new WebSearchError("百度 AI 搜索需要 API Key。");
    const { status, data } = await httpJson<{
      references?: Array<{
        title?: string;
        url?: string;
        snippet?: string;
        content?: string;
      }>;
    }>(
      "https://qianfan.baidubce.com/v2/ai_search/web_search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "User-Agent": SEARCH_UA,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: query }],
        }),
      },
      18000,
    );
    if (status !== 200) throw new WebSearchError(`Baidu HTTP ${status}`);
    return (data.references ?? []).slice(0, topK).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.snippet ?? r.content ?? "",
    }));
  }
  const html = await fetchText(`${BING_CN}?q=${encodeURIComponent(query)}`);
  return parseBingResults(html, topK, BING_CN);
}

export async function webSearch(
  query: string,
  settings: AppSettings,
  topK = 5,
): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) throw new WebSearchError("搜索词不能为空");
  const k = Math.min(10, Math.max(1, topK));
  const primary = settings.webSearchEngine || "bing_rss";
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

  try {
    return await searchPublicSearxng(q, k);
  } catch (err) {
    const msg = err instanceof WebSearchError ? err.message : String(err);
    errors.push(`public_searxng: ${msg}`);
  }

  throw new WebSearchError(
    `搜索失败（已尝试 ${engines.length + 1} 路：${engines.join(" → ")} → 公共SearXNG）。` +
      `详情：${errors.join("；")}`,
  );
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
      "建议：Android 需重新安装最新 APK（已启用原生 HTTP）；在设置中填写 Metaso/百度 Key（国内最稳）；或关闭 VPN 后重试。"
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
