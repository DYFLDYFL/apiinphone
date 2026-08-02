import type { AppSettings, ChatMessage } from "../../types";
import {
  chatStream,
  createStreamControl,
  type StreamControl,
} from "../apiClient";
import {
  normalizeReasoningEffort,
  type ReasoningEffort,
} from "../apiProviders";
import { settingsForGame } from "../settings";
import type { AgentModelOverride, GameAgent, GameState } from "./types";

const MAX_HISTORY = 8;

export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const direct = JSON.parse(trimmed) as unknown;
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return direct as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function trimHistory(agent: GameAgent): void {
  if (agent.history.length > MAX_HISTORY * 2) {
    agent.history = agent.history.slice(-MAX_HISTORY * 2);
  }
}

function applyModelOverride(
  base: AppSettings,
  override?: AgentModelOverride,
): AppSettings {
  if (!override) return base;
  const model = override.model?.trim() || base.model;
  const thinkingMode = override.thinkingMode ?? base.thinkingMode;
  const effortRaw = override.reasoningEffort ?? base.reasoningEffort;
  const reasoningEffort = normalizeReasoningEffort(
    effortRaw as ReasoningEffort | string | undefined,
    model,
  );
  return {
    ...base,
    model,
    thinkingMode,
    reasoningEffort,
  };
}

/** Run one agent turn: system + short history + user prompt → assistant text (+ JSON). */
export async function runGameAgent(
  settings: AppSettings,
  game: GameState,
  agent: GameAgent,
  userPrompt: string,
  control?: StreamControl,
  onStatus?: (text: string) => void,
): Promise<{ text: string; json: Record<string, unknown> | null }> {
  const gameSettings: AppSettings = {
    ...applyModelOverride(settingsForGame(settings), agent.modelOverride),
    toolsEnabled: false,
    toolsWebSearch: false,
    toolsPythonSandbox: false,
    systemPrompt: "",
  };

  const messages: ChatMessage[] = [
    { role: "system", content: agent.systemPrompt },
    ...agent.history,
    { role: "user", content: userPrompt },
  ];

  const ctrl = control ?? createStreamControl();
  const result = await chatStream(gameSettings, messages, {
    control: ctrl,
    onRetryWait: (info) => {
      onStatus?.(
        `${info.reason}（${info.attempt}/${info.maxAttempts}，${Math.ceil(info.delayMs / 1000)}s）`,
      );
    },
  });
  const text = (result.content || result.note || "").trim();
  agent.history.push({ role: "user", content: userPrompt });
  agent.history.push({ role: "assistant", content: text || "(无内容)" });
  trimHistory(agent);
  void game;
  return { text, json: extractJsonObject(text) };
}
