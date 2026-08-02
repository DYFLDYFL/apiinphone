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
import type { GameAgent, GamePlayMode, GameState } from "../../lib/game/types";
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
  const [showGodTimeline, setShowGodTimeline] = useState(false);
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
    const g = await createGame({
      ...draft,
      title: draft.title.trim() || "新游戏",
      characters: draft.characters.slice(0, 6),
    });
    setGame(g);
    bindGameRunnerGame(g);
    setView("play");
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

  const savePlayMode = async (
    playMode: GamePlayMode,
    playerCharacterId: string | null,
  ) => {
    if (!game || busy) return;
    let nextId = playerCharacterId;
    if (playMode === "play") {
      const chars = game.agents.filter((a) => a.kind === "character");
      if (!nextId || !chars.some((c) => c.id === nextId)) {
        nextId = chars[0]?.id ?? null;
      }
      if (!nextId) {
        alert("没有可扮演的角色");
        return;
      }
    } else {
      nextId = null;
    }
    const next = {
      ...game,
      playMode,
      playerCharacterId: nextId,
    };
    await saveGame(next);
    setGame(next);
    bindGameRunnerGame(next);
    if (playMode === "spectate") setShowGodTimeline(false);
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
                        ? { ...draft.characters[i], attrs: { ...draft.characters[i].attrs } }
                        : c,
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
                    setDraft(defaultTemplateDraft(draft.characters.length))
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
  const filteredEvents =
    playMode === "play" && playerId && !showGodTimeline
      ? eventsVisibleTo(game, playerId, 80)
      : game.events.slice(-80);
  const intentTargets = [
    "世界",
    ...chars.filter((c) => c.id !== playerId).map((c) => c.name),
  ];
  const maxR = isWebTransport(settings)
    ? Math.min(game.settings.maxInteractionRounds, 3)
    : game.settings.maxInteractionRounds;

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
            {playMode === "play" ? "扮演" : "旁观"}
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
          <h3>视角</h3>
          <div className="game-play-mode">
            <label className="radio-row">
              <input
                type="radio"
                name="playMode"
                checked={playMode === "spectate"}
                disabled={busy}
                onChange={() => void savePlayMode("spectate", null)}
              />
              旁观（斗蛐蛐）
            </label>
            <label className="radio-row">
              <input
                type="radio"
                name="playMode"
                checked={playMode === "play"}
                disabled={busy}
                onChange={() =>
                  void savePlayMode("play", playerId ?? chars[0]?.id ?? null)
                }
              />
              扮演角色
            </label>
            {playMode === "play" ? (
              <label>
                扮演
                <select
                  disabled={busy}
                  value={playerId ?? ""}
                  onChange={(e) =>
                    void savePlayMode("play", e.target.value || null)
                  }
                >
                  {chars.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {playMode === "play" ? (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={showGodTimeline}
                  onChange={(e) => setShowGodTimeline(e.target.checked)}
                />
                显示全部（上帝视角）
              </label>
            ) : null}
          </div>
          <p className="settings-hint">
            扮演时只填意图；对白与后果仍由 AI + 裁判落地。推进中不可改视角。
          </p>
        </section>

        <section className="game-card game-timeline">
          <h3>时间线</h3>
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
              const openSelf = isSelf;
              return (
                <details
                  key={ch.id}
                  className={
                    isSelf ? "game-sheet game-sheet-self" : "game-sheet"
                  }
                  open={openSelf || undefined}
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
                    {isSelf || playMode === "spectate" ? (
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
            <button
              type="button"
              className="primary-btn"
              onClick={handleSubmitIntent}
            >
              提交意图
            </button>
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
      <summary>角色 {index + 1}：{value.name || "未命名"}</summary>
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
