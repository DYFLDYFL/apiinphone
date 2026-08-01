import type { DeepSeekBalance, TokenUsage } from "../types";

/** CNY per 1M tokens — off-peak baseline (fallback when balance delta unavailable). */
export interface ModelTokenRatesCny {
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

const RATES: Record<string, ModelTokenRatesCny> = {
  "deepseek-v4-flash": { cacheHit: 0.02, cacheMiss: 1, output: 2 },
  "deepseek-v4-pro": { cacheHit: 0.025, cacheMiss: 3, output: 6 },
  "deepseek-chat": { cacheHit: 0.02, cacheMiss: 1, output: 2 },
  "deepseek-reasoner": { cacheHit: 0.02, cacheMiss: 1, output: 2 },
};

const DEFAULT_RATES: ModelTokenRatesCny = {
  cacheHit: 0.02,
  cacheMiss: 1,
  output: 2,
};

export function ratesForModel(model: string): ModelTokenRatesCny {
  const key = model.trim().toLowerCase();
  if (RATES[key]) return RATES[key];
  if (key.includes("pro")) return RATES["deepseek-v4-pro"];
  if (key.includes("flash") || key.includes("deepseek")) {
    return RATES["deepseek-v4-flash"];
  }
  return DEFAULT_RATES;
}

export function estimateCostCny(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheHitTokens = 0,
  cacheMissTokens?: number,
): number {
  const rates = ratesForModel(model);
  const hit = Math.max(0, cacheHitTokens);
  const miss =
    cacheMissTokens != null && cacheMissTokens > 0
      ? cacheMissTokens
      : Math.max(0, promptTokens - hit);
  return (
    (hit / 1_000_000) * rates.cacheHit +
    (miss / 1_000_000) * rates.cacheMiss +
    (Math.max(0, completionTokens) / 1_000_000) * rates.output
  );
}

export function estimateUsageCostCny(
  model: string,
  usage: Pick<
    TokenUsage,
    | "promptTokens"
    | "completionTokens"
    | "promptCacheHitTokens"
    | "promptCacheMissTokens"
  >,
): number {
  return estimateCostCny(
    model,
    usage.promptTokens,
    usage.completionTokens,
    usage.promptCacheHitTokens,
    usage.promptCacheMissTokens,
  );
}

/** Prefer CNY balance total from /user/balance. */
export function cnyTotalFromBalance(info: DeepSeekBalance): number | null {
  if (!info.balanceInfos.length) return null;
  const cny =
    info.balanceInfos.find((e) => e.currency.toUpperCase() === "CNY") ??
    info.balanceInfos[0];
  const n = Number(String(cny.totalBalance).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Positive spend when balance decreased; null if topped up / missing data. */
export function spentCnyFromBalanceDelta(
  before: number | null,
  after: number | null,
): number | null {
  if (before == null || after == null) return null;
  const spent = before - after;
  if (!Number.isFinite(spent) || spent < 0) return null;
  return spent;
}

export function formatCny(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "¥0";
  if (amount < 0.0001) return "< ¥0.0001";
  if (amount < 0.01) return `¥${amount.toFixed(4)}`;
  if (amount < 1) return `¥${amount.toFixed(3)}`;
  return `¥${amount.toFixed(2)}`;
}

export type SpendKind = "balance" | "estimate";

export function formatSpendLine(
  amount: number | null | undefined,
  kind: SpendKind | null | undefined,
): string | null {
  if (amount == null || !Number.isFinite(amount) || amount < 0) return null;
  if (amount === 0 && kind === "balance") {
    return `实扣 ${formatCny(0)}（余额差值）`;
  }
  if (amount <= 0) return null;
  if (kind === "balance") return `实扣 ${formatCny(amount)}（余额差值）`;
  return `约合 ${formatCny(amount)}（价表估算）`;
}
