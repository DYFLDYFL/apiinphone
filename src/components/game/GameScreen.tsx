import { useCallback, useEffect, useState } from "react";
import type { AppSettings } from "../../types";
import {
  createGame,
  deleteGame,
  listGames,
  saveGame,
  sanitizeStoryText,
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
import { seedInitialChronicles } from "../../lib/game/orchestrator";
import {
  characterSystemPrompt,
  chroniclerSystemPrompt,
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
import type {
  AgentModelOverride,
  GameAgent,
  GameEvent,
  GamePipeline,
  GameState,
  PipelineEdge,
  PipelineEdgeWhen,
  PipelineNode,
  PipelineNodeKind,
  ProposeMode,
  ProposeOrderMode,
} from "../../lib/game/types";
import {
  defaultPipeline,
  newPipelineNodeId,
  PIPELINE_EDGE_WHENS,
  PIPELINE_KIND_LABELS,
  PIPELINE_NODE_KINDS,
  PIPELINE_WHEN_LABELS,
  validatePipeline,
} from "../../lib/game/pipeline";
import {
  rememberGameModel,
  effectiveGameModel,
} from "../../lib/settings";
import {
  getProvider,
  modelSupportsThinking,
  reasoningEffortsForModel,
  type ReasoningEffort,
} from "../../lib/apiProviders";
import { ModelSwitcher } from "../ModelSwitcher";

interface GameScreenProps {
  settings: AppSettings;
  onSettingsChange: (next: AppSettings) => void;
  onBack: () => void;
  onOpenSettings: () => void;
  onOpenInfo: () => void;
}

type LogTab = "timeline" | "story" | "playerStory";
type SidePanel = "collapsed" | "world" | "chars";

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
  const [charCountInput, setCharCountInput] = useState("3");
  const [logTab, setLogTab] = useState<LogTab>("timeline");
  const [sidePanel, setSidePanel] = useState<SidePanel>("collapsed");
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
    const god = sanitizeStoryText(game.godStory);
    const player = sanitizeStoryText(game.playerStory);
    if (god === game.godStory && player === game.playerStory) return;
    const next = { ...game, godStory: god, playerStory: player };
    setGame(next);
    bindGameRunnerGame(next);
    void saveGame(next);
  }, [game]);

  useEffect(() => {
    if (!game) return;
    const play = game.playMode === "play";
    const unlocked = Boolean(game.godViewUnlocked) || !play;
    if (play && !unlocked && logTab !== "playerStory") {
      setLogTab("playerStory");
    }
  }, [game, logTab]);

  useEffect(() => {
    if (!pendingIntent) return;
    if (!settings.gameAutoDelegateAi) return;
    const t = window.setTimeout(() => {
      delegatePlayerIntentToAi();
    }, 80);
    return () => window.clearTimeout(t);
  }, [pendingIntent, settings.gameAutoDelegateAi]);

  const openGame = async (id: string) => {
    const snap = getGameRunnerSnapshot();
    if (snap.game && snap.gameId === id) {
      setGame(snap.game);
      setView("play");
      return;
    }
    const g = await setActiveGame(id);
    if (!g) return;
    setGame(g);
    bindGameRunnerGame(g);
    setView("play");
    if (g.playMode === "play" && !g.godViewUnlocked) {
      setLogTab("playerStory");
    } else {
      setLogTab(g.playMode === "play" ? "playerStory" : "story");
    }
    const needSeed =
      !g.godStory.trim() ||
      (g.playMode === "play" && !g.playerStory.trim());
    if (needSeed && !isGameRunning(g.id)) {
      setBusy(true);
      setStatus("生成开场剧情…");
      try {
        const seeded = await seedInitialChronicles(settings, g, {
          onPersist: (next) => {
            setGame({ ...next });
            bindGameRunnerGame(next);
          },
        });
        setGame(seeded);
        bindGameRunnerGame(seeded);
      } catch (err) {
        alert(String(err));
      } finally {
        setBusy(false);
        setStatus("");
      }
    }
  };

  const resizeDraftCharacters = (
    prev: GameTemplateDraft,
    n: number,
  ): GameTemplateDraft => {
    const clamped = Math.min(6, Math.max(2, Math.round(n)));
    const base = defaultTemplateDraft(clamped);
    return {
      ...prev,
      characters: base.characters.map((c, i) =>
        prev.characters[i]
          ? {
              ...prev.characters[i],
              attrs: { ...prev.characters[i].attrs },
            }
          : c,
      ),
      playerCharacterIndex: Math.min(
        clamped - 1,
        prev.playerCharacterIndex ?? 0,
      ),
      customProposeOrder: Array.from({ length: clamped }, (_, i) => i),
    };
  };

  const applyCharacterCount = (n: number) => {
    const clamped = Math.min(6, Math.max(2, Math.round(n)));
    setDraft((prev) => resizeDraftCharacters(prev, clamped));
    setCharCountInput(String(clamped));
    return clamped;
  };

  const handleCreate = async () => {
    if (!settings.apiKey.trim()) {
      alert("请先在设置中填写 API Key");
      return;
    }
    const n = Math.min(
      6,
      Math.max(2, Math.round(Number(charCountInput) || draft.characters.length || 3)),
    );
    const nextDraft = resizeDraftCharacters(draft, n);
    setDraft(nextDraft);
    setCharCountInput(String(n));
    const playMode = nextDraft.playMode === "play" ? "play" : "spectate";
    setBusy(true);
    setStatus("生成开场剧情…");
    try {
      const g = await createGame({
        ...nextDraft,
        title: nextDraft.title.trim() || "新游戏",
        characters: nextDraft.characters.slice(0, n),
        playMode,
        playerCharacterIndex: nextDraft.playerCharacterIndex ?? 0,
      });
      setGame(g);
      bindGameRunnerGame(g);
      setView("play");
      setLogTab(playMode === "play" ? "playerStory" : "story");
      const seeded = await seedInitialChronicles(settings, g, {
        onPersist: (next) => {
          setGame({ ...next });
          bindGameRunnerGame(next);
        },
      });
      setGame(seeded);
      bindGameRunnerGame(seeded);
      setStatus("");
      await refreshList();
    } catch (err) {
      alert(String(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("删除该局将清空本地文件夹中的剧情与存档，确定？")) return;
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
    const ready =
      game.playMode === "play"
        ? Boolean(game.playerStory.trim())
        : Boolean(game.godStory.trim());
    if (!ready) return;
    if (!settings.apiKey.trim()) {
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
      const override = a.systemPromptOverride?.trim();
      return {
        ...a,
        persona: worldview,
        systemPrompt: override
          ? override
          : worldSystemPrompt(worldview),
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
      const override = a.systemPromptOverride?.trim();
      return {
        ...a,
        persona,
        systemPrompt: override
          ? override
          : characterSystemPrompt(a.name, persona),
      };
    });
    const next = { ...game, sheets, agents };
    await saveGame(next);
    setGame(next);
    bindGameRunnerGame(next);
  };

  const unlockGodView = async (): Promise<boolean> => {
    if (!game || game.godViewUnlocked) return true;
    const ok = window.confirm(
      "查看时间线/上帝剧情需解锁上帝视角，视为作弊且不可再上锁。确定解锁？",
    );
    if (!ok) return false;
    const next = { ...game, godViewUnlocked: true };
    await saveGame(next);
    setGame(next);
    bindGameRunnerGame(next);
    return true;
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
          </div>
          {topActions}
        </header>
        <div className="game-body game-lobby">
          <section className="game-card game-create-card">
            <div className="game-card-heading">
              <div>
                <h3>新建游戏</h3>
                <p>先定下世界与角色，再开始第一轮故事。</p>
              </div>
              <span className="game-card-badge">建局</span>
            </div>
            <div className="game-form-grid">
              <label className="game-field">
                标题
                <input
                  value={draft.title}
                  placeholder="例如：青石镇的晨雾"
                  onChange={(e) =>
                    setDraft({ ...draft, title: e.target.value })
                  }
                />
              </label>
              <label className="game-field">
                初始时刻
                <input
                  value={draft.initialTime}
                  placeholder="例如：三月初二 05:30"
                  onChange={(e) =>
                    setDraft({ ...draft, initialTime: e.target.value })
                  }
                />
              </label>
            </div>
            <fieldset className="settings-fieldset game-view-fieldset">
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
                扮演开局默认只看「玩家剧情」；点「时间线/剧情」会提示是否解锁（作弊）。
              </p>
            </fieldset>
            <div className="game-create-controls">
              <label className="game-field game-count-field">
                角色数量
                <span className="game-field-hint">2–6 名角色</span>
                <input
                  type="number"
                  min={2}
                  max={6}
                  value={charCountInput}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setCharCountInput(raw);
                    if (raw.trim() === "") return;
                    const num = Number(raw);
                    if (!Number.isFinite(num)) return;
                    if (num < 2 || num > 6) return;
                    applyCharacterCount(num);
                  }}
                  onBlur={() => {
                    applyCharacterCount(
                      Number(charCountInput) || draft.characters.length || 3,
                    );
                  }}
                />
              </label>
              <button
                type="button"
                className="secondary-btn game-template-toggle"
                onClick={() => setShowTemplate((v) => !v)}
              >
                <span>{showTemplate ? "收起模板" : "编辑模板"}</span>
                <span aria-hidden="true">{showTemplate ? "⌃" : "⌄"}</span>
              </button>
            </div>
            {showTemplate ? (
              <div className="game-template-editor">
                <fieldset className="game-ai-block">
                  <legend>运行逻辑</legend>
                  <label>
                    提案顺序
                    <select
                      value={draft.proposeOrder ?? "template"}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          proposeOrder: e.target.value as ProposeOrderMode,
                        })
                      }
                    >
                      <option value="template">固定模板顺序</option>
                      <option value="random">每轮随机</option>
                      <option value="custom">自定义排序</option>
                    </select>
                  </label>
                  <label>
                    提案方式
                    <select
                      value={draft.proposeMode ?? "serial"}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          proposeMode: e.target.value as ProposeMode,
                        })
                      }
                    >
                      <option value="serial">串行</option>
                      <option value="parallel">并行</option>
                    </select>
                  </label>
                  {(draft.proposeOrder ?? "template") === "custom" ? (
                    <div className="game-order-list">
                      <p className="settings-hint">自定义提案顺序（↑↓）</p>
                      {(draft.customProposeOrder ??
                        draft.characters.map((_, i) => i)
                      ).map((idx, pos) => {
                        const ch = draft.characters[idx];
                        if (!ch) return null;
                        const order =
                          draft.customProposeOrder ??
                          draft.characters.map((_, i) => i);
                        return (
                          <div key={`${idx}-${pos}`} className="game-order-row">
                            <span>
                              {pos + 1}. {ch.name || `角色 ${idx + 1}`}
                            </span>
                            <span>
                              <button
                                type="button"
                                className="link-btn"
                                disabled={pos === 0}
                                onClick={() => {
                                  if (pos === 0) return;
                                  const next = [...order];
                                  [next[pos - 1], next[pos]] = [
                                    next[pos],
                                    next[pos - 1],
                                  ];
                                  setDraft({
                                    ...draft,
                                    customProposeOrder: next,
                                  });
                                }}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                className="link-btn"
                                disabled={pos >= order.length - 1}
                                onClick={() => {
                                  if (pos >= order.length - 1) return;
                                  const next = [...order];
                                  [next[pos], next[pos + 1]] = [
                                    next[pos + 1],
                                    next[pos],
                                  ];
                                  setDraft({
                                    ...draft,
                                    customProposeOrder: next,
                                  });
                                }}
                              >
                                ↓
                              </button>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                  <PipelineEditor
                    value={draft.pipeline ?? defaultPipeline()}
                    onChange={(pipeline) => setDraft({ ...draft, pipeline })}
                  />
                </fieldset>

                <fieldset className="game-ai-block">
                  <legend>世界 AI</legend>
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
                  <label>
                    System 提示词（空=默认）
                    <textarea
                      rows={3}
                      value={draft.worldSystemPrompt ?? ""}
                      placeholder={worldSystemPrompt(draft.worldview).slice(0, 80) + "…"}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          worldSystemPrompt: e.target.value,
                        })
                      }
                    />
                  </label>
                  <ModelOverrideEditor
                    value={draft.worldModel}
                    onChange={(worldModel) =>
                      setDraft({ ...draft, worldModel })
                    }
                  />
                </fieldset>

                <fieldset className="game-ai-block">
                  <legend>裁判 AI</legend>
                  <label>
                    人设
                    <input
                      value={draft.refereePersona ?? ""}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          refereePersona: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    System 提示词（空=默认）
                    <textarea
                      rows={3}
                      value={draft.refereeSystemPrompt ?? ""}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          refereeSystemPrompt: e.target.value,
                        })
                      }
                    />
                  </label>
                  <ModelOverrideEditor
                    value={draft.refereeModel}
                    onChange={(refereeModel) =>
                      setDraft({ ...draft, refereeModel })
                    }
                  />
                </fieldset>

                <fieldset className="game-ai-block">
                  <legend>书记 AI</legend>
                  <label>
                    上帝视角提示词（空=默认）
                    <textarea
                      rows={2}
                      value={draft.chroniclerGodPrompt ?? ""}
                      placeholder={chroniclerSystemPrompt("god").slice(0, 60) + "…"}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          chroniclerGodPrompt: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    玩家视角提示词（空=默认）
                    <textarea
                      rows={2}
                      value={draft.chroniclerPlayerPrompt ?? ""}
                      placeholder={chroniclerSystemPrompt("player").slice(0, 60) + "…"}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          chroniclerPlayerPrompt: e.target.value,
                        })
                      }
                    />
                  </label>
                  <ModelOverrideEditor
                    value={draft.chroniclerModel}
                    onChange={(chroniclerModel) =>
                      setDraft({ ...draft, chroniclerModel })
                    }
                  />
                </fieldset>

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
                  onClick={() => {
                    const n = draft.characters.length;
                    const base = defaultTemplateDraft(n);
                    setDraft({
                      ...base,
                      playMode: draft.playMode,
                      playerCharacterIndex: draft.playerCharacterIndex,
                    });
                    setCharCountInput(String(n));
                  }}
                >
                  恢复默认
                </button>
              </div>
            ) : null}
            <div className="game-create-actions">
              <p>创建后可以随时暂停推进，但开局视角不可更改。</p>
              <button
                type="button"
                className="primary-btn game-create-button"
                onClick={() => void handleCreate()}
              >
                创建游戏
              </button>
            </div>
          </section>
          <section className="game-card game-saves-card">
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
                        时段 {g.tick} · {new Date(g.updatedAt).toLocaleString()}
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

  const openingReady =
    playMode === "play"
      ? Boolean(game.playerStory.trim())
      : Boolean(game.godStory.trim());

  const selectTab = (tab: LogTab) => {
    if (playMode === "spectate" && tab === "playerStory") return;
    if (!unlocked && (tab === "timeline" || tab === "story")) {
      void (async () => {
        const ok = await unlockGodView();
        if (ok) setLogTab(tab);
      })();
      return;
    }
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
            {game.worldClock.timeText || game.worldClock.label}
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
              title={
                !unlocked
                  ? "点击将提示解锁上帝视角（作弊）"
                  : undefined
              }
              onClick={() => selectTab("timeline")}
            >
              时间线
            </button>
            <button
              type="button"
              className={
                logTab === "story" ? "picker-option active" : "picker-option"
              }
              title={
                !unlocked
                  ? "点击将提示解锁上帝视角（作弊）"
                  : undefined
              }
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
          {playMode === "play" && unlocked ? (
            <p className="settings-hint warn-hint">已解锁·作弊（不可再锁）</p>
          ) : playMode === "play" && !unlocked ? (
            <p className="settings-hint">
              默认仅「玩家剧情」；点「时间线」或「剧情」可提示解锁。
            </p>
          ) : null}

          {logTab === "timeline" ? (
            <>
              <p className="settings-hint">{game.worldClock.sceneSummary}</p>
              <ul className="game-events">
                {filteredEvents.map((e) => {
                  const hist = game.worldClock.history;
                  const timeLabel =
                    hist?.[String(e.tick)] ||
                    (e.tick === game.worldClock.tick
                      ? game.worldClock.timeText || game.worldClock.label
                      : `时段 ${e.tick}`);
                  return (
                    <li key={e.id}>
                      <span className="game-evt-meta">
                        {timeLabel} · 第{e.interactionRound}轮 · {e.actorName}
                        {e.audience === "private" ? " · 私" : ""}
                      </span>
                      <div>{formatEventSummary(e.summary)}</div>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}

          {logTab === "story" ? (
            <div className="game-story-body">
              {game.godStory.trim() ? (
                <div className="game-story-text">
                  {sanitizeStoryText(game.godStory)}
                </div>
              ) : (
                <p className="settings-hint">尚无剧情，推进一轮后自动生成。</p>
              )}
            </div>
          ) : null}

          {logTab === "playerStory" ? (
            <div className="game-story-body">
              {playMode === "spectate" ? (
                <p className="settings-hint">旁观模式无玩家剧情。</p>
              ) : game.playerStory.trim() ? (
                <div className="game-story-text">
                  {sanitizeStoryText(game.playerStory)}
                </div>
              ) : (
                <p className="settings-hint">
                  尚无个人经历，推进后按你的可见事件生成。
                </p>
              )}
            </div>
          ) : null}
        </section>

        <section className="game-card game-side-compact">
          <div className="game-side-tabs">
            <button
              type="button"
              className={
                sidePanel === "world" ? "picker-option active" : "picker-option"
              }
              onClick={() =>
                setSidePanel((v) => (v === "world" ? "collapsed" : "world"))
              }
            >
              世界观
            </button>
            <button
              type="button"
              className={
                sidePanel === "chars" ? "picker-option active" : "picker-option"
              }
              onClick={() =>
                setSidePanel((v) => (v === "chars" ? "collapsed" : "chars"))
              }
            >
              角色
            </button>
          </div>

          {sidePanel === "world" ? (
            <div className="game-side-panel">
              <textarea
                rows={3}
                defaultValue={game.worldview || ""}
                disabled={busy}
                onBlur={(e) => void saveWorldview(e.target.value)}
              />
            </div>
          ) : null}

          {sidePanel === "chars" ? (
            <div className="game-side-panel game-sheet-list">
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
                              rows={2}
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
          ) : null}
        </section>
      </div>

      <footer className="game-footer">
        {status ? <div className="game-status">{status}</div> : null}
        {playMode === "play" ? (
          <label className="checkbox game-auto-ai">
            <input
              type="checkbox"
              checked={Boolean(settings.gameAutoDelegateAi)}
              onChange={(e) => {
                onSettingsChange({
                  ...settings,
                  gameAutoDelegateAi: e.target.checked,
                });
              }}
            />
            交给 AI
          </label>
        ) : null}
        {pendingIntent && !settings.gameAutoDelegateAi ? (
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
        ) : pendingIntent && settings.gameAutoDelegateAi ? (
          <p className="settings-hint">本轮已勾选交给 AI，正在代提…</p>
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
              disabled={!openingReady}
              onClick={() => {
                if (!openingReady) return;
                void handleAdvance();
              }}
            >
              推进一轮
            </button>
          )}
        </div>
        <p className="settings-hint">
          每次推进一轮交互后由世界拨钟；回对话或回列表时推进仍继续。
        </p>
      </footer>
    </div>
  );
}

function PipelineEditor({
  value,
  onChange,
}: {
  value: GamePipeline;
  onChange: (next: GamePipeline) => void;
}) {
  const validation = validatePipeline(value);
  const setNodes = (nodes: PipelineNode[]) => onChange({ ...value, nodes });
  const setEdges = (edges: PipelineEdge[]) => onChange({ ...value, edges });

  return (
    <div className="game-pipeline-editor">
      <p className="settings-hint">流水线节点与出边（条件按列表顺序取第一条匹配）</p>
      <label>
        入口节点
        <select
          value={value.entry}
          onChange={(e) => onChange({ ...value, entry: e.target.value })}
        >
          {value.nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label || PIPELINE_KIND_LABELS[n.kind]}（{n.id}）
            </option>
          ))}
        </select>
      </label>
      {value.nodes.map((node, idx) => {
        const outs = value.edges
          .map((e, ei) => ({ e, ei }))
          .filter(({ e }) => e.from === node.id);
        return (
          <details key={node.id} className="game-pipeline-node" open={idx < 2}>
            <summary>
              {PIPELINE_KIND_LABELS[node.kind]}
              {node.label ? ` · ${node.label}` : ""}（{node.id}）
            </summary>
            <label>
              类型
              <select
                value={node.kind}
                onChange={(e) => {
                  const kind = e.target.value as PipelineNodeKind;
                  const nodes = value.nodes.map((n) =>
                    n.id === node.id
                      ? {
                          ...n,
                          kind,
                          label: PIPELINE_KIND_LABELS[kind],
                        }
                      : n,
                  );
                  setNodes(nodes);
                }}
              >
                {PIPELINE_NODE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {PIPELINE_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              备注名
              <input
                value={node.label ?? ""}
                onChange={(e) => {
                  const nodes = value.nodes.map((n) =>
                    n.id === node.id ? { ...n, label: e.target.value } : n,
                  );
                  setNodes(nodes);
                }}
              />
            </label>
            <div className="game-pipeline-edges">
              <p className="settings-hint">出边</p>
              {outs.map(({ e, ei }) => (
                <div key={ei} className="game-pipeline-edge-row">
                  <select
                    value={e.when}
                    onChange={(ev) => {
                      const edges = value.edges.map((x, i) =>
                        i === ei
                          ? { ...x, when: ev.target.value as PipelineEdgeWhen }
                          : x,
                      );
                      setEdges(edges);
                    }}
                  >
                    {PIPELINE_EDGE_WHENS.map((w) => (
                      <option key={w} value={w}>
                        {PIPELINE_WHEN_LABELS[w]}
                      </option>
                    ))}
                  </select>
                  <span>→</span>
                  <select
                    value={e.to}
                    onChange={(ev) => {
                      const edges = value.edges.map((x, i) =>
                        i === ei ? { ...x, to: ev.target.value } : x,
                      );
                      setEdges(edges);
                    }}
                  >
                    {value.nodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.label || PIPELINE_KIND_LABELS[n.kind]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() =>
                      setEdges(value.edges.filter((_, i) => i !== ei))
                    }
                  >
                    删边
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  const to =
                    value.nodes.find((n) => n.id !== node.id)?.id ?? node.id;
                  setEdges([
                    ...value.edges,
                    { from: node.id, to, when: "always" },
                  ]);
                }}
              >
                + 出边
              </button>
            </div>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                const nodes = value.nodes.filter((n) => n.id !== node.id);
                const edges = value.edges.filter(
                  (e) => e.from !== node.id && e.to !== node.id,
                );
                const entry =
                  value.entry === node.id
                    ? nodes[0]?.id ?? ""
                    : value.entry;
                onChange({ entry, nodes, edges });
              }}
            >
              删除节点
            </button>
          </details>
        );
      })}
      <div className="game-pipeline-actions">
        <button
          type="button"
          className="secondary-btn"
          onClick={() => {
            const id = newPipelineNodeId(value.nodes);
            onChange({
              ...value,
              nodes: [
                ...value.nodes,
                {
                  id,
                  kind: "propose",
                  label: PIPELINE_KIND_LABELS.propose,
                },
              ],
              entry: value.entry || id,
            });
          }}
        >
          添加节点
        </button>
        <button
          type="button"
          className="link-btn"
          onClick={() => onChange(defaultPipeline())}
        >
          恢复默认流水线
        </button>
      </div>
      {!validation.ok ? (
        <p className="info-error">{validation.errors.join("；")}</p>
      ) : null}
      {validation.warnings.length ? (
        <p className="settings-hint">{validation.warnings.join("；")}</p>
      ) : null}
    </div>
  );
}

function ModelOverrideEditor({
  value,
  onChange,
}: {
  value?: AgentModelOverride;
  onChange: (next: AgentModelOverride | undefined) => void;
}) {
  const provider = getProvider();
  const model = value?.model?.trim() || "";
  const effectiveModel = model || provider.defaultModel;
  const showTier = modelSupportsThinking(effectiveModel);
  const efforts = reasoningEffortsForModel(effectiveModel);

  const patch = (partial: Partial<AgentModelOverride>) => {
    const next: AgentModelOverride = { ...value, ...partial };
    if (!next.model?.trim()) delete next.model;
    if (!next.thinkingMode) delete next.thinkingMode;
    if (!next.reasoningEffort) delete next.reasoningEffort;
    const empty =
      !next.model && !next.thinkingMode && !next.reasoningEffort;
    onChange(empty ? undefined : next);
  };

  return (
    <div className="game-model-override">
      <label>
        模型（空=全局游戏模型）
        <select
          value={model}
          onChange={(e) => patch({ model: e.target.value || undefined })}
        >
          <option value="">（沿用全局）</option>
          {[provider.defaultModel, ...provider.models].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      {showTier ? (
        <>
          <label>
            思考
            <select
              value={value?.thinkingMode ?? ""}
              onChange={(e) =>
                patch({
                  thinkingMode: (e.target.value || undefined) as
                    | "enabled"
                    | "disabled"
                    | undefined,
                })
              }
            >
              <option value="">（沿用全局）</option>
              <option value="enabled">开启</option>
              <option value="disabled">关闭</option>
            </select>
          </label>
          <label>
            推理档
            <select
              value={value?.reasoningEffort ?? ""}
              onChange={(e) =>
                patch({
                  reasoningEffort: (e.target.value || undefined) as
                    | ReasoningEffort
                    | undefined,
                })
              }
            >
              <option value="">（沿用全局）</option>
              {efforts.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null}
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
      <label>
        System 提示词（空=默认）
        <textarea
          rows={2}
          value={value.systemPrompt ?? ""}
          onChange={(e) =>
            onChange({ ...value, systemPrompt: e.target.value })
          }
        />
      </label>
      <ModelOverrideEditor
        value={value.model}
        onChange={(model) => onChange({ ...value, model })}
      />
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

