import type { AppSettings } from "../../types";
import {
  createStreamControl,
  type StreamControl,
} from "../apiClient";
import {
  startChatKeepAlive,
  stopChatKeepAlive,
} from "../chatKeepAlive";
import {
  advanceGameTick,
  injectPlayerEvent,
  type PlayerIntentDraft,
  type PlayerIntentRequest,
  type TickProgress,
} from "./orchestrator";
import type { GameState } from "./types";

export type GameRunnerSnapshot = {
  gameId: string | null;
  game: GameState | null;
  running: boolean;
  statusText: string;
  pendingPlayerIntent: PlayerIntentRequest | null;
};

type Listener = (snap: GameRunnerSnapshot) => void;

const listeners = new Set<Listener>();

let activeGameId: string | null = null;
let game: GameState | null = null;
let running = false;
let statusText = "";
let control: StreamControl | null = null;
let runToken = 0;
let pendingPlayerIntent: PlayerIntentRequest | null = null;
let resolvePlayerIntent:
  | ((draft: PlayerIntentDraft | null) => void)
  | null = null;

function emit(): void {
  const snap: GameRunnerSnapshot = {
    gameId: activeGameId,
    game: game
      ? {
          ...game,
          events: [...game.events],
          agents: game.agents,
          sheets: game.sheets,
        }
      : null,
    running,
    statusText,
    pendingPlayerIntent,
  };
  for (const fn of listeners) {
    try {
      fn(snap);
    } catch {
      /* ignore */
    }
  }
}

function setStatus(text: string): void {
  statusText = text;
  emit();
}

function clearPendingPlayerIntent(result: PlayerIntentDraft | null): void {
  const resolve = resolvePlayerIntent;
  resolvePlayerIntent = null;
  pendingPlayerIntent = null;
  resolve?.(result);
  emit();
}

export function subscribeGameRunner(listener: Listener): () => void {
  listeners.add(listener);
  listener({
    gameId: activeGameId,
    game,
    running,
    statusText,
    pendingPlayerIntent,
  });
  return () => {
    listeners.delete(listener);
  };
}

export function getGameRunnerSnapshot(): GameRunnerSnapshot {
  return {
    gameId: activeGameId,
    game,
    running,
    statusText,
    pendingPlayerIntent,
  };
}

export function isGameRunning(id?: string): boolean {
  if (!running) return false;
  if (id) return activeGameId === id;
  return true;
}

export function stopGameAdvance(): void {
  control?.cancel();
  clearPendingPlayerIntent(null);
  setStatus("正在停止…");
}

/** 扮演模式：提交本轮意图。 */
export function submitPlayerIntent(draft: PlayerIntentDraft): boolean {
  if (!resolvePlayerIntent || !pendingPlayerIntent) return false;
  if (draft.delegateToAi) {
    clearPendingPlayerIntent({
      toId: "世界",
      action: "",
      delegateToAi: true,
    });
    return true;
  }
  const action = draft.action.trim();
  if (!action) return false;
  clearPendingPlayerIntent({
    toId: draft.toId.trim() || "世界",
    action,
    rationale: draft.rationale?.trim() || undefined,
  });
  return true;
}

/** 本轮提案交给 AI（仅一次）。 */
export function delegatePlayerIntentToAi(): boolean {
  return submitPlayerIntent({ toId: "世界", action: "", delegateToAi: true });
}

export async function startGameAdvance(
  settings: AppSettings,
  source: GameState,
  inject?: string,
): Promise<void> {
  if (running && activeGameId === source.id) {
    return;
  }
  if (running) {
    stopGameAdvance();
    await new Promise((r) => setTimeout(r, 50));
  }

  const token = ++runToken;
  activeGameId = source.id;
  game = source;
  running = true;
  control = createStreamControl();
  pendingPlayerIntent = null;
  resolvePlayerIntent = null;
  setStatus("推进中…");
  void startChatKeepAlive("游戏推进中", "多智能体回合进行中…");

  try {
    let working = source;
    if (inject?.trim()) {
      working = await injectPlayerEvent(working, inject.trim());
      game = working;
      emit();
    }
    const next = await advanceGameTick(settings, working, {
      control: control ?? undefined,
      onProgress: (p: TickProgress) => {
        if (token !== runToken) return;
        setStatus(
          `${p.phase} · 交互 ${p.interactionRound}/${p.maxRounds}`,
        );
      },
      onPersist: (g) => {
        if (token !== runToken) return;
        game = g;
        activeGameId = g.id;
        emit();
      },
      awaitPlayerIntent: (req) =>
        new Promise<PlayerIntentDraft | null>((resolve) => {
          if (token !== runToken) {
            resolve(null);
            return;
          }
          pendingPlayerIntent = req;
          resolvePlayerIntent = resolve;
          setStatus(
            `等待你扮演「${req.characterName}」· 交互 ${req.round}/${req.maxRounds}`,
          );
          emit();
        }),
    });
    if (token !== runToken) return;
    game = next;
    activeGameId = next.id;
    running = false;
    control = null;
    pendingPlayerIntent = null;
    resolvePlayerIntent = null;
    setStatus(
      next.tickBuffer?.status === "interrupted"
        ? "已中断"
        : `完成 ${next.worldClock.label}`,
    );
  } catch (err) {
    if (token !== runToken) return;
    running = false;
    control = null;
    pendingPlayerIntent = null;
    resolvePlayerIntent = null;
    setStatus(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    if (token === runToken) {
      running = false;
      control = null;
      pendingPlayerIntent = null;
      resolvePlayerIntent = null;
      void stopChatKeepAlive();
      emit();
    }
  }
}

/** Keep a non-running game in runner cache so UI can reopen it. */
export function bindGameRunnerGame(next: GameState | null): void {
  if (running) return;
  game = next;
  activeGameId = next?.id ?? null;
  emit();
}
