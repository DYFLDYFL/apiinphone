import type { AppSettings, ChatMessage, ChatSession } from "../types";
import { summarizeText } from "./apiClient";
import { contextLimitForModel } from "./apiProviders";
import { effectiveModel } from "./settings";

/** 保留在摘要之后的最近消息条数。 */
const KEEP_RECENT = 4;
/** 少于该条数不做压缩（太短没有意义）。 */
const MIN_HISTORY = 8;

/**
 * 判断当前会话是否达到上下文压缩阈值。
 * threshold 为 0 表示关闭；contextTokens 为空时不做判断。
 */
export function shouldCompress(
  settings: AppSettings,
  session: ChatSession,
): boolean {
  const threshold = settings.contextCompressThreshold ?? 0;
  if (threshold <= 0) return false;
  if (session.contextTokens <= 0) return false;
  if (session.history.length <= MIN_HISTORY) return false;
  const limit = contextLimitForModel(effectiveModel(settings));
  if (limit <= 0) return false;
  return (session.contextTokens / limit) * 100 >= threshold;
}

/**
 * 把 history 的早期部分压缩为摘要，返回重建后的 history。
 * 摘要失败（summarizeText 返回 null）时返回原 history，不阻塞发送。
 */
export async function compressHistory(
  settings: AppSettings,
  history: ChatMessage[],
): Promise<{ history: ChatMessage[]; compressed: boolean }> {
  const keep = Math.max(KEEP_RECENT, Math.min(KEEP_RECENT * 2, history.length));
  const dropCount = history.length - keep;
  if (dropCount < MIN_HISTORY) {
    return { history, compressed: false };
  }
  const dropped = history.slice(0, dropCount);
  const rest = history.slice(dropCount);
  const summary = await summarizeText(settings, dropped, 500);
  if (!summary) {
    return { history, compressed: false };
  }
  return {
    history: [
      {
        role: "user",
        content: `以下为早前对话的摘要（上下文压缩生成，请将其视为已有对话内容）：\n${summary}`,
      },
      ...rest,
    ],
    compressed: true,
  };
}
