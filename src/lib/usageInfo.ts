import type { AppSettings, DeepSeekBalance, TokenUsage } from "../types";
import { contextLimitForModel } from "./apiProviders";

export function formatBalanceDisplay(info: DeepSeekBalance): string[] {
  const lines: string[] = [];
  for (const entry of info.balanceInfos) {
    const currency = entry.currency || "?";
    let line = `${currency} ${entry.totalBalance}`;
    const extras: string[] = [];
    if (!["0", "0.00", "0.0", ""].includes(entry.grantedBalance)) {
      extras.push(`赠送 ${entry.grantedBalance}`);
    }
    if (!["0", "0.00", "0.0", ""].includes(entry.toppedUpBalance)) {
      extras.push(`充值 ${entry.toppedUpBalance}`);
    }
    if (extras.length) line += `（${extras.join(" · ")}）`;
    lines.push(line);
  }
  if (!lines.length) lines.push("暂无余额数据");
  lines.push(info.isAvailable ? "余额充足" : "余额不足");
  return lines;
}

export function formatSessionUsage(
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
  cacheHitTokens = 0,
): string {
  if (totalTokens <= 0 && promptTokens <= 0 && completionTokens <= 0) {
    return "本对话：尚无 API 用量记录";
  }
  const lines = [
    "本对话累计",
    `输入 ${promptTokens.toLocaleString()} · 输出 ${completionTokens.toLocaleString()}`,
    `合计 ${totalTokens.toLocaleString()} tokens`,
  ];
  if (cacheHitTokens > 0 && promptTokens > 0) {
    const hitPct = Math.min(100, (cacheHitTokens / promptTokens) * 100);
    lines.push(
      `缓存命中 ${cacheHitTokens.toLocaleString()}（占累计输入 ${hitPct.toFixed(1)}%）`,
    );
  }
  return lines.join("\n");
}

export function formatLastRequestUsage(usage: TokenUsage | null): string {
  if (!usage || usage.totalTokens <= 0) return "上次请求：—";
  const lines = [
    "上次请求",
    `输入 ${usage.promptTokens.toLocaleString()} · 输出 ${usage.completionTokens.toLocaleString()}`,
    `合计 ${usage.totalTokens.toLocaleString()} tokens`,
  ];
  if (usage.promptCacheHitTokens > 0 && usage.promptTokens > 0) {
    const hitPct = Math.min(
      100,
      (usage.promptCacheHitTokens / usage.promptTokens) * 100,
    );
    lines.push(
      `缓存命中 ${usage.promptCacheHitTokens.toLocaleString()}（占本次输入 ${hitPct.toFixed(1)}%）`,
    );
  }
  return lines.join("\n");
}

export function formatContextUsage(contextTokens: number, model: string): string {
  const limit = contextLimitForModel(model);
  if (contextTokens <= 0) {
    return `当前上下文：尚无记录\n上限 ${limit.toLocaleString()} tokens`;
  }
  const pct = Math.min(100, (contextTokens / limit) * 100);
  return [
    `${contextTokens.toLocaleString()} / ${limit.toLocaleString()}`,
    `占用 ${pct.toFixed(1)}%`,
  ].join("\n");
}

export function balanceUnavailableText(settings: AppSettings): string {
  if (settings.apiProvider === "deepseek") return "余额：未查询";
  return "当前提供商不支持余额查询";
}
