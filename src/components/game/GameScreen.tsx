import { useCallback, useEffect, useState } from "react";
import type { AppSettings } from "../../types";
import {
  createGame,
  deleteGame,
  listGames,
  saveGame,
  setActiveGame,
} from "../../lib/game/gameStore";
import {
  bindGameRunnerGame,
  delegatePlayerIntentToAi,
  getGameRunnerSnapshot,
  isGameRunning,
  startGameAdvance,
  stopGameAdvance,
  submitPlayerIntent,
  subscribeGameRunner,
} from "../../lib/game/gameRunner";
import type { PlayerIntentRequest } from "../../lib/game/orchestrator";
import {
  characterSystemPrompt,
  worldSystemPrompt,
} from "../../lib/game/prompts";
import {
  ATTR_LABELS,
  defaultTemplateDraft,
  type CharTemplateDraft,
  type GameTemplateDraft,
} from "../../lib/game/templates";
import {
  eventsVisibleTo,
  formatAttrLines,
  formatEventSummary,
} from "../../lib/game/mutations";
import type { GameAgent, GameEvent, GameState } from "../../lib/game/types";
import {
  isWebTransport,
  rememberGameModel,
  effectiveGameModel,
} from "../../lib/settings";
import { ModelSwitcher } from "../ModelSwitcher";

interface GameScreenProps {
  settings: AppSettings;
  onSettingsChange: (next: AppSettings) => void;
  onBack: () => void;
  onOpenSettings: () => void;
  onOpenInfo: () => void;
}

type LogTab = "timeline" | "story" | "playerStory";

const EDIT_ATTR_KEYS = [
  "hp",
  "stamina",
  "strength",
  "agility",
  "insight",
  "charm",
  "wealth",
  "location",
  "mood",
  "reputation",
] as const;

function sanitizeTimelineEvents(
  events: GameEvent[],
  playMode: "spectate" | "play",
  unlocked: boolean,
): GameEvent[] {
  if (playMode !== "play" || unlocked) return events;
  return events.map((e) => {
    if (e.kind !== "judge" || e.audience === "private") return e;
    return {
      ...e,
      summary: e.summary.startsWith("本轮交互已裁定")
        ? e.summary
        : "本轮交互已裁定",
      detail: undefined,
      sheetDiffs: undefined,
    };
  });
}

export function GameScreen({
  settings,
  onSettingsChange,
  onBack,
  onOpenSettings,
  onOpenInfo,
}: GameScreenProps) {
  const [games, setGames] = useState<
    Array<{ id: string; title: string; updatedAt: string; tick: number }>
  >([]);
  const [game, setGame] = useState<GameState | null>(null);
  const [view, setView] = useState<"lobby" | "play">("lobby");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [inject, setInject] = useState("");
  const [showTemplate, setShowTemplate] = useState(false);
  const [draft, setDraft] = useState<GameTemplateDraft>(() =>
    defaultTemplateDraft(3),
  );
  const [logTab, setLogTab] = useState<LogTab>("timeline");
  const [pendingIntent, setPendingIntent] =
    useState<PlayerIntentRequest | null>(null);
  const [intentTo, setIntentTo] = useState("世界");
  const [intentAction, setIntentAction] = useState("");
  const [intentWhy, setIntentWhy] = useState("");

  const refreshList = useCallback(async () => {
    setGames(await listGames());
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    return subscribeGameRunner((snap) => {
      setBusy(snap.running);
      setStatus(snap.statusText);
      setPendingIntent(snap.pendingPlayerIntent);
      if (snap.pendingPlayerIntent?.redoHint) {
        setIntentAction("");
      }
      if (snap.game && (!game || game.id === snap.game.id)) {
        setGame(snap.game);
        if (snap.running) setView("play");
      }
      void refreshList();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshList]);

  useEffect(() => {
    if (!game) return;
    const play = game.playMode === "play";
    const unlocked = Boolean(game.godViewUnlocked) || !play;
    if (play && !unlocked && logTab !== "playerStory") {
      setLogTab("playerStory");
    }
  }, [game, logTab]);

  const openGame = async (id: string) => {
    const snap = getGameRunnerSnapshot();
    if (snap.game && snap.gameId === id) {
      setGame(snap.game);
      setView("play");
      return;
    }
    const g = await setActiveGame(id);
    setGame(g);
    bindGameRunnerGame(g);
    setView("play");
    if (g?.playMode === "play" && !g.godViewUnlocked) {
      setLogTab("playerStory");
    } else {
      setLogTab("timeline");
    }
  };

  const handleCreate = async () => {
    if (isWebTransport(settings)) {
      if (!settings.webSessionToken.trim()) {
        alert("请先在设置中粘贴网页会话 Token");
        return;
      }
    } else if (!settings.apiKey.trim()) {
      alert("请先在设置中填写 API Key");
      return;
    }
    const playMode = draft.playMode === "play" ? "play" : "spectate";
    const g = await createGame({
      ...draft,
      title: draft.title.trim() || "新游戏",
      characters: draft.characters.slice(0, 6),
      playMode,
      playerCharacterIndex: draft.playerCharacterIndex ?? 0,
    });
    setGame(g);
    bindGameRunnerGame(g);
    setView("play");
    setLogTab(playMode === "play" ? "playerStory" : "timeline");
    await refreshList();
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("删除该局？")) return;
    if (isGameRunning(id)) stopGameAdvance();
    await deleteGame(id);
    if (game?.id === id) {
      setGame(null);
      bindGameRunnerGame(null);
      setView("lobby");
    }
    await refreshList();
  };

  const handleAdvance = async () => {
    if (!game || busy) return;
    if (isWebTransport(settings)) {
      if (!settings.webSessionToken.trim()) {
        alert("请先在设置中粘贴网页会话 Token");
        return;
      }
    } else if (!settings.apiKey.trim()) {
      alert("请先在设置中填写 API Key");
      return;
    }
    const injectText = inject;
    setInject("");
    try {
      await startGameAdvance(settings, game, injectText);
      await refreshList();
    } catch (err) {
      alert(String(err));
    }
  };

  const renameTitle = async (title: string) => {
    if (!game) return;
    const next = { ...game, title: title.trim() || game.title };
    await saveGame(next);
    setGame(next);
    bindGameRunnerGame(next);
    await refreshList();
  };

  const saveWorldview = async (text: string) => {
    if (!game || busy) return;
    const worldview = text.trim();
    const agents = game.agents.map((a) => {
      if (a.kind !== "world") return a;
      return {
        ...a,
        persona: worldview,
        systemPrompt: worldSystemPrompt(worldview),
      };
    });
    const next = { ...game, worldview, agents };
    await saveGame(next);
    setGame(next);
    bindGameRunnerGame(next);
  };

  const saveCharacter = async (
    agent: GameAgent,
    patch: {
      persona?: string;
      attrs?: Record<string, string | number | boolean>;
      inventory?: string[];
    },
  ) => {
    if (!game || busy) return;
    const sheets = game.sheets.map((s) => {
      if (s.id !== agent.sheetId) return s;
      return {
        ...s,
        attrs: patch.attrs ? { ...s.attrs, ...patch.attrs } : s.attrs,
        inventory: patch.inventory ?? s.inventory,
        name: agent.name,
      };
    });
    const agents = game.agents.map((a) => {
      if (a.id !== agent.id) return a;
      const persona = patch.persona ?? a.persona;
      return {
        ...a,
        persona,
        systemPrompt: characterSystemPrompt(a.name, persona),
      };
    });
    const next = { ...game, sheets, agents };
    await saveGame(next);
    setGame(next);
    bindGameRunnerGame(next);
  };

  const unlockGodView = async () => {
    if (!game || game.godViewUnlocked) return;
    const ok = window.confirm(
      "解锁时间线与上帝剧情视为作弊，且不可再上锁。确定？",
    );
    if (!ok) return;
    const next = { ...game, godViewUnlocked: true };
    await saveGame(next);
    setGame(next);
    bindGameRunnerGame(next);
  };

  const handleSubmitIntent = () => {
    if (!intentAction.trim()) {
      alert("请填写行动");
      return;
    }
    const ok = submitPlayerIntent({
      toId: intentTo.trim() || "世界",
      action: intentAction.trim(),
      rationale: intentWhy.trim() || undefined,
    });
    if (ok) {
      setIntentAction("");
      setIntentWhy("");
    }
  };

  const transportLabel = isWebTransport(settings) ? "网页" : "官方";

  const topActions = (
    <div className="game-topbar-actions">
      <button
        type="button"
        className="icon-btn"
        onClick={onOpenInfo}
        title="用量"
      >
        ℹ
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={onOpenSettings}
        title="设置"
      >
        ⚙
      </button>
    </div>
  );

  if (view === "lobby" || !game) {
    const draftPlay = draft.playMode === "play" ? "play" : "spectate";
    return (
      <div className="game-screen">
        <header className="game-topbar">
          <button type="button" className="icon-btn" onClick={onBack}>
            ←
          </button>
          <div className="game-topbar-title">
            <div>游戏</div>
            <div className="game-subtitle">{transportLabel}</div>
          </div>
          {topActions}
        </header>
        <div className="game-body game-lobby">
          <section className="game-card">
            <h3>新建</h3>
            <label>
              标题
              <input
                value={draft.title}
                onChange={(e) =>
                  setDraft({ ...draft, title: e.target.value })
                }
              />
            </label>
            <fieldset className="settings-fieldset">
              <legend>开局视角（创建后不可改）</legend>
              <label className="radio-row">
                <input
                  type="radio"
                  name="draftPlayMode"
                  checked={draftPlay === "spectate"}
                  onChange={() =>
                    setDraft({ ...draft, playMode: "spectate" })
                  }
                />
                旁观（斗蛐蛐）
              </label>
              <label className="radio-row">
                <input
                  type="radio"
                  name="draftPlayMode"
                  checked={draftPlay === "play"}
                  onChange={() =>
                    setDraft({
                      ...draft,
                      playMode: "play",
                      playerCharacterIndex: draft.playerCharacterIndex ?? 0,
                    })
                  }
                />
                扮演角色
              </label>
              {draftPlay === "play" ? (
                <label>
                  扮演谁
                  <select
                    value={String(draft.playerCharacterIndex ?? 0)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        playerCharacterIndex: Number(e.target.value) || 0,
                      })
                    }
                  >
                    {draft.characters.map((c, i) => (
                      <option key={i} value={i}>
                        {c.name || `角色 ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <p className="settings-hint">
                扮演开局默认只看「玩家剧情」；解锁时间线/上帝剧情视为作弊。
              </p>
            </fieldset>
            <label>
              角色数（2–6）
              <input
                type="number"
                min={2}
                max={6}
                value={draft.characters.length}
                onChange={(e) => {
                  const n = Math.min(
                    6,
                    Math.max(2, Number(e.target.value) || 3),
                  );
                  const base = defaultTemplateDraft(n);
                  setDraft({
                    ...draft,
                    characters: base.characters.map((c, i) =>
                      draft.characters[i]
                        ? {
                            ...draft.characters[i],
                            attrs: { ...draft.characters[i].attrs },
                          }
                        : c,
                    ),
                    playerCharacterIndex: Math.min(
                      n - 1,
                      draft.playerCharacterIndex ?? 0,
                    ),
                  });
                }}
              />
            </label>
            <button
              type="button"
              className="secondary-btn"
              onClick={() => setShowTemplate((v) => !v)}
            >
              {showTemplate ? "收起模板" : "编辑模板"}
            </button>
            {showTemplate ? (
              <div className="game-template-editor">
                <label>
                  世界观
                  <textarea
                    rows={4}
                    value={draft.worldview}
                    onChange={(e) =>
                      setDraft({ ...draft, worldview: e.target.value })
                    }
                  />
                </label>
                {draft.characters.map((ch, idx) => (
                  <CharDraftEditor
                    key={idx}
                    index={idx}
                    value={ch}
                    onChange={(next) => {
                      const characters = [...draft.characters];
                      characters[idx] = next;
                      setDraft({ ...draft, characters });
                    }}
                  />
                ))}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() =>
                    setDraft({
                      ...defaultTemplateDraft(draft.characters.length),
                      playMode: draft.playMode,
                      playerCharacterIndex: draft.playerCharacterIndex,
                    })
                  }
                >
                  恢复默认
                </button>
              </div>
            ) : null}
            <button
              type="button"
              className="primary-btn"
              onClick={() => void handleCreate()}
            >
              创建
            </button>
          </section>
          <section className="game-card">
            <h3>存档</h3>
            {!games.length ? (
              <p className="settings-hint">尚无存档</p>
            ) : (
              <ul className="game-list">
                {games.map((g) => (
                  <li key={g.id}>
                    <button
                      type="button"
                      className="game-list-main"
                      onClick={() => void openGame(g.id)}
                    >
                      <strong>{g.title}</strong>
                      <span>
                        {g.tick} 时 · {new Date(g.updatedAt).toLocaleString()}
                        {isGameRunning(g.id) ? " · 推进中…" : ""}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => void handleDelete(g.id)}
                    >
                      删
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    );
  }

  const chars = game.agents.filter((a) => a.kind === "character");
  const playMode = game.playMode === "play" ? "play" : "spectate";
  const playerId = game.playerCharacterId;
  const unlocked = playMode !== "play" || Boolean(game.godViewUnlocked);
  const playerName =
    chars.find((c) => c.id === playerId)?.name ?? "角色";

  const rawTimeline =
    playMode === "play" && playerId && !unlocked
      ? eventsVisibleTo(game, playerId, 80)
      : game.events.slice(-80);
  const filteredEvents = sanitizeTimelineEvents(
    rawTimeline,
    playMode,
    unlocked,
  );

  const intentTargets = [
    "世界",
    ...chars.filter((c) => c.id !== playerId).map((c) => c.name),
  ];
  const maxR = isWebTransport(settings)
    ? Math.min(game.settings.maxInteractionRounds, 3)
    : game.settings.maxInteractionRounds;

  const selectTab = (tab: LogTab) => {
    if (!unlocked && (tab === "timeline" || tab === "story")) return;
    if (playMode === "spectate" && tab === "playerStory") return;
    setLogTab(tab);
  };

  return (
    <div className="game-screen">
      <header className="game-topbar">
        <button
          type="button"
          className="icon-btn"
          onClick={() => setView("lobby")}
          title="局列表"
        >
          ←
        </button>
        <div className="game-topbar-title">
          <input
            className="game-title-input"
            value={game.title}
            onChange={(e) => setGame({ ...game, title: e.target.value })}
            onBlur={(e) => void renameTitle(e.target.value)}
          />
          <div className="game-subtitle">
            {game.worldClock.label}
            {" · "}
            {transportLabel}
            {" · "}
            {playMode === "play" ? `扮演·${playerName}` : "旁观"}
            {playMode === "play" && unlocked ? " · 已解锁·作弊" : ""}
            {busy && status ? ` · ${status}` : ""}
          </div>
          <ModelSwitcher
            settings={settings}
            scope="game"
            disabled={false}
            onChange={(next) => {
              const remembered = rememberGameModel(
                next,
                effectiveGameModel(next),
              );
              onSettingsChange(remembered);
            }}
          />
        </div>
        {topActions}
        <button type="button" className="secondary-btn" onClick={onBack}>
          回对话
        </button>
      </header>

      <div className="game-body game-play">
        <section className="game-card">
          <div className="game-log-tabs">
            <button
              type="button"
              className={
                logTab === "timeline"
                  ? "picker-option active"
                  : "picker-option"
              }
              disabled={!unlocked}
              onClick={() => selectTab("timeline")}
            >
              时间线
            </button>
            <button
              type="button"
              className={
                logTab === "story" ? "picker-option active" : "picker-option"
              }
              disabled={!unlocked}
              onClick={() => selectTab("story")}
            >
              剧情
            </button>
            <button
              type="button"
              className={
                logTab === "playerStory"
                  ? "picker-option active"
                  : "picker-option"
              }
              disabled={playMode === "spectate"}
              onClick={() => selectTab("playerStory")}
            >
              玩家剧情
            </button>
          </div>
          {!unlocked ? (
            <div className="game-unlock-row">
              <p className="settings-hint">
                扮演模式已锁定时间线与上帝剧情，仅可看玩家剧情。
              </p>
              <button
                type="button"
                className="secondary-btn"
                disabled={busy}
                onClick={() => void unlockGodView()}
              >
                解锁上帝视角（作弊）
              </button>
            </div>
          ) : playMode === "play" ? (
            <p className="settings-hint warn-hint">已解锁·作弊（不可再锁）</p>
          ) : null}

          {logTab === "timeline" ? (
            <>
              <p className="settings-hint">{game.worldClock.sceneSummary}</p>
              <ul className="game-events">
                {filteredEvents.map((e) => (
                  <li key={e.id}>
                    <span className="game-evt-meta">
                      第{e.tick}时 · 第{e.interactionRound}轮 · {e.actorName}
                      {e.audience === "private" ? " · 私" : ""}
                    </span>
                    <div>{formatEventSummary(e.summary)}</div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {logTab === "story" ? (
            <div className="game-story-body">
              {game.godStory.trim() ? (
                <pre className="game-story-text">{game.godStory}</pre>
              ) : (
                <p className="settings-hint">尚无剧情，推进时间后自动生成。</p>
              )}
            </div>
          ) : null}

          {logTab === "playerStory" ? (
            <div className="game-story-body">
              {playMode === "spectate" ? (
                <p className="settings-hint">旁观模式无玩家剧情。</p>
              ) : game.playerStory.trim() ? (
                <pre className="game-story-text">{game.playerStory}</pre>
              ) : (
                <p className="settings-hint">
                  尚无个人经历，推进后按你的可见事件生成。
                </p>
              )}
            </div>
          ) : null}
        </section>

        <details className="game-card" open={false}>
          <summary>世界观</summary>
          <textarea
            rows={4}
            defaultValue={game.worldview || ""}
            disabled={busy}
            onBlur={(e) => void saveWorldview(e.target.value)}
          />
        </details>

        <section className="game-card game-sheets">
          <h3>角色面板</h3>
          <div className="game-sheet-list">
            {chars.map((ch) => {
              const sheet = game.sheets.find((s) => s.id === ch.sheetId);
              if (!sheet) return null;
              const isSelf = playMode === "play" && ch.id === playerId;
              return (
                <details
                  key={ch.id}
                  className={
                    isSelf ? "game-sheet game-sheet-self" : "game-sheet"
                  }
                  open={isSelf || undefined}
                >
                  <summary>
                    <strong>
                      {sheet.name}
                      {isSelf ? "（你）" : ""}
                    </strong>
                    <span className="info-muted">
                      {" "}
                      {String(sheet.attrs.location ?? "")} ·{" "}
                      {String(sheet.attrs.mood ?? "")}
                    </span>
                  </summary>
                  <div className="game-sheet-body">
                    <p className="settings-hint">{formatAttrLines(sheet)}</p>
                    {isSelf || playMode === "spectate" || unlocked ? (
                      <>
                        {EDIT_ATTR_KEYS.map((key) => (
                          <label key={key} className="game-attr-row">
                            {ATTR_LABELS[key] ?? key}
                            <input
                              disabled={busy}
                              defaultValue={String(sheet.attrs[key] ?? "")}
                              onBlur={(e) => {
                                const raw = e.target.value.trim();
                                const num = Number(raw);
                                const value =
                                  raw !== "" &&
                                  !Number.isNaN(num) &&
                                  key !== "location" &&
                                  key !== "mood"
                                    ? num
                                    : raw;
                                void saveCharacter(ch, {
                                  attrs: { [key]: value },
                                });
                              }}
                            />
                          </label>
                        ))}
                        <label>
                          人设
                          <textarea
                            rows={3}
                            disabled={busy}
                            defaultValue={ch.persona}
                            onBlur={(e) =>
                              void saveCharacter(ch, {
                                persona: e.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          物品（顿号分隔）
                          <input
                            disabled={busy}
                            defaultValue={sheet.inventory.join("、")}
                            onBlur={(e) =>
                              void saveCharacter(ch, {
                                inventory: e.target.value
                                  .split(/[,，、]/)
                                  .map((x) => x.trim())
                                  .filter(Boolean),
                              })
                            }
                          />
                        </label>
                      </>
                    ) : (
                      <p className="settings-hint">
                        他角摘要 · 物品：
                        {sheet.inventory.join("、") || "未知"}
                      </p>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        </section>
      </div>

      <footer className="game-footer">
        {status ? <div className="game-status">{status}</div> : null}
        {pendingIntent ? (
          <div className="game-player-intent">
            <strong>你的行动 · {pendingIntent.characterName}</strong>
            {pendingIntent.redoHint ? (
              <p className="settings-hint warn-hint">
                裁判驳回：{pendingIntent.redoHint}
              </p>
            ) : null}
            <label>
              目标
              <select
                value={intentTo}
                onChange={(e) => setIntentTo(e.target.value)}
              >
                {intentTargets.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label>
              行动
              <input
                value={intentAction}
                placeholder="你想做什么"
                onChange={(e) => setIntentAction(e.target.value)}
              />
            </label>
            <label>
              理由（可选）
              <input
                value={intentWhy}
                placeholder="简短理由"
                onChange={(e) => setIntentWhy(e.target.value)}
              />
            </label>
            <div className="game-footer-actions">
              <button
                type="button"
                className="primary-btn"
                onClick={handleSubmitIntent}
              >
                提交意图
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => delegatePlayerIntentToAi()}
              >
                本次交给 AI
              </button>
            </div>
          </div>
        ) : (
          <label className="game-inject">
            注入事件（可选）
            <input
              value={inject}
              disabled={busy}
              placeholder="例如：广场突然下起雨来"
              onChange={(e) => setInject(e.target.value)}
            />
          </label>
        )}
        <div className="game-footer-actions">
          {busy ? (
            <button
              type="button"
              className="secondary-btn"
              onClick={() => stopGameAdvance()}
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              className="primary-btn"
              onClick={() => void handleAdvance()}
            >
              推进时间
            </button>
          )}
        </div>
        <p className="settings-hint">
          {isWebTransport(settings)
            ? `网页会话 · 串行间隔 ${(settings.webMinIntervalMs / 1000).toFixed(1)}s · 交互上限 ≤${maxR}`
            : `每周期最多 ${maxR} 轮交互。回对话或回列表时推进仍继续。`}
        </p>
      </footer>
    </div>
  );
}

function CharDraftEditor({
  index,
  value,
  onChange,
}: {
  index: number;
  value: CharTemplateDraft;
  onChange: (next: CharTemplateDraft) => void;
}) {
  return (
    <details className="game-char-draft" open={index < 3}>
      <summary>
        角色 {index + 1}：{value.name || "未命名"}
      </summary>
      <label>
        姓名
        <input
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </label>
      <label>
        人设
        <textarea
          rows={2}
          value={value.persona}
          onChange={(e) => onChange({ ...value, persona: e.target.value })}
        />
      </label>
      {EDIT_ATTR_KEYS.map((key) => (
        <label key={key} className="game-attr-row">
          {ATTR_LABELS[key] ?? key}
          <input
            value={String(value.attrs[key] ?? "")}
            onChange={(e) => {
              const raw = e.target.value;
              const num = Number(raw);
              const nextVal =
                raw !== "" &&
                !Number.isNaN(num) &&
                key !== "location" &&
                key !== "mood"
                  ? num
                  : raw;
              onChange({
                ...value,
                attrs: { ...value.attrs, [key]: nextVal },
              });
            }}
          />
        </label>
      ))}
      <label>
        物品
        <input
          value={value.inventory}
          onChange={(e) => onChange({ ...value, inventory: e.target.value })}
        />
      </label>
    </details>
  );
}
