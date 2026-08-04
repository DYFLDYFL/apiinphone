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
import {
  applySheetPatches,
  applyAuthorizedContextFileEdits,
  readableContextFiles,
  readableSheets,
  syncContextFiles,
} from "./mutations";
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
  syncContextFiles(game);
  const gameSettings: AppSettings = {
    ...applyModelOverride(settingsForGame(settings), agent.modelOverride),
    toolsEnabled: false,
    toolsWebSearch: false,
    toolsPythonSandbox: false,
    systemPrompt: "",
  };
  const readableFiles = readableContextFiles(game, agent);

  const messages: ChatMessage[] = [
    { role: "system", content: agent.systemPrompt },
    ...agent.history,
    {
      role: "user",
      content: [
        userPrompt,
        `\n\n你有权限查看的角色属性：\n${readableSheets(game, agent)}`,
        readableFiles
          ? `\n\n你有权限查看的游戏文档：\n${readableFiles}`
          : "",
        '如需修改有权限的游戏文档，请在 JSON 中增加 fileEdits:[{"fileId":"文档 id","content":"完整新内容"}] 或 [{"fileId":"文档 id","append":"追加内容"}]；如需修改角色属性，请使用 attributeEdits:[{"sheetId":"角色面板 id","attrs":{},"attrsAdd":{},"attrsRemove":{}}]。所有修改都会按权限和属性选项校验。',
      ].join(""),
    },
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
  const json = extractJsonObject(text);
  applyAuthorizedContextFileEdits(game, agent, json?.fileEdits);
  if (Array.isArray(json?.attributeEdits)) {
    applySheetPatches(
      game,
      json.attributeEdits as NonNullable<import("./types").JudgeResult["sheetPatches"]>,
      agent,
    );
  }
  return { text, json };
}
