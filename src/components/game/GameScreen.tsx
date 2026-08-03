import { useCallback, useEffect, useState, type ReactNode } from "react";
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
  AI_RUNTIME_PRESETS,
  ATTR_LABELS,
  CHAR_TEMPLATES,
  applyAiPreset,
  cloneTemplateDraft,
  DEFAULT_ATTRIBUTE_DEFINITIONS,
  GAME_TEMPLATE_PRESETS,
  defaultTemplateDraft,
  defaultContextFiles,
  formatGameDateTime,
  inferAttributeDefinitions,
  normalizeGameDateTime,
  type CharTemplateDraft,
  type GameAiPreset,
  type GameTemplateDraft,
  type GameTemplatePreset,
} from "../../lib/game/templates";
import {
  eventsVisibleTo,
  formatAttrLines,
  formatEventSummary,
} from "../../lib/game/mutations";
import type {
  AgentModelOverride,
  AgentFeatureKey,
  GameAgent,
  GameAttributeDefinition,
  GameDateTime,
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
type WorldSetupStep = "basic" | "attributes";
type AiSetupStep = "agents" | "pipeline";

const EDIT_ATTR_KEYS = DEFAULT_ATTRIBUTE_DEFINITIONS.map((item) => item.key);

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
  const [view, setView] = useState<
    | "lobby"
    | "template-choice"
    | "world-editor"
    | "ai-choice"
    | "ai-editor"
    | "characters"
    | "character"
    | "play"
  >("lobby");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [inject, setInject] = useState("");
  const [showTemplate, setShowTemplate] = useState(false);
  const [draft, setDraft] = useState<GameTemplateDraft>(() =>
    defaultTemplateDraft(3),
  );
  const [selectedPresetId, setSelectedPresetId] = useState("qing-shi");
  const [editingCharacterIndex, setEditingCharacterIndex] = useState(0);
  const [characterEntryView, setCharacterEntryView] = useState<
    "ai-choice" | "ai-editor"
  >("ai-choice");
  const [aiChoiceBackView, setAiChoiceBackView] = useState<
    "template-choice" | "world-editor"
  >("template-choice");
  const [aiSetupStep, setAiSetupStep] = useState<AiSetupStep>("agents");
  const [selectedAiPresetId, setSelectedAiPresetId] = useState("");
  const [worldSetupStep, setWorldSetupStep] =
    useState<WorldSetupStep>("basic");
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
    minimum = 0,
  ): GameTemplateDraft => {
    const clamped = Math.min(6, Math.max(minimum, Math.round(n)));
    const base = defaultTemplateDraft(Math.max(2, clamped));
    const defaults = base.characters.slice(0, clamped);
    return {
      ...prev,
      characters: defaults.map((c, i) =>
        prev.characters[i]
          ? {
              ...prev.characters[i],
              attrs: { ...prev.characters[i].attrs },
            }
          : c,
      ),
      playerCharacterIndex: clamped
        ? Math.min(clamped - 1, prev.playerCharacterIndex ?? 0)
        : 0,
    };
  };

  const applyCharacterCount = (n: number) => {
    const clamped = Math.min(6, Math.max(0, Math.round(n)));
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
    const nextDraft = resizeDraftCharacters(draft, n, 2);
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

  const updateCharacter = (index: number, next: CharTemplateDraft) => {
    const characters = [...draft.characters];
    characters[index] = next;
    setDraft({ ...draft, characters });
  };

  const startNewGame = () => {
    const next = defaultTemplateDraft(3);
    setDraft(next);
    setSelectedPresetId("");
    setSelectedAiPresetId("");
    setCharCountInput("3");
    setCharacterEntryView("ai-choice");
    setAiChoiceBackView("template-choice");
    setView("template-choice");
  };

  const selectWorldPreset = (preset: GameTemplatePreset) => {
    const world = cloneTemplateDraft(preset.draft);
    const next: GameTemplateDraft = {
      ...draft,
      title: world.title,
      worldview: world.worldview,
      initialTime: world.initialTime,
      initialTimeParts: { ...world.initialTimeParts },
      contextFiles: world.contextFiles?.map((file) => ({ ...file })),
      attributeDefinitions: world.attributeDefinitions?.map((item) => ({
        ...item,
      })),
      characters: world.characters.map((character) => ({
        ...character,
        attrs: { ...character.attrs },
        model: character.model ? { ...character.model } : undefined,
      })),
      playerCharacterIndex: Math.min(
        Math.max(0, world.characters.length - 1),
        draft.playerCharacterIndex ?? 0,
      ),
    };
    setDraft(next);
    setSelectedPresetId(preset.id);
    setSelectedAiPresetId("");
    setCharCountInput(String(next.characters.length));
    setAiChoiceBackView("template-choice");
    setView("ai-choice");
  };

  const openCustomWorld = () => {
    setSelectedPresetId("custom");
    setSelectedAiPresetId("");
    setCharacterEntryView("ai-choice");
    setAiChoiceBackView("world-editor");
    setWorldSetupStep("basic");
    setView("world-editor");
  };

  const confirmWorld = () => {
    setAiChoiceBackView("world-editor");
    setView("ai-choice");
  };

  const selectAiPreset = (preset: GameAiPreset) => {
    setDraft((prev) => applyAiPreset(prev, preset));
    setSelectedAiPresetId(preset.id);
    setCharacterEntryView("ai-choice");
    setView("characters");
  };

  const openCustomAi = () => {
    setSelectedAiPresetId("custom");
    setAiSetupStep("agents");
    setView("ai-editor");
  };

  const confirmAi = () => {
    setCharacterEntryView("ai-editor");
    setView("characters");
  };

  const addCharacterPreset = (template: CharTemplateDraft) => {
    if (draft.characters.length >= 6) return;
    const characters = [
      ...draft.characters,
      {
        ...template,
        attrs: { ...template.attrs },
        model: template.model ? { ...template.model } : undefined,
      },
    ];
    setDraft({
      ...draft,
      characters,
    });
    setCharCountInput(String(characters.length));
  };

  const addBlankCharacter = () => {
    addCharacterPreset({
      name: "",
      persona: "",
      attrs: {},
      inventory: "",
      systemPrompt: "",
    });
  };

  const removeCharacter = (index: number) => {
    const characters = draft.characters.filter((_, itemIndex) => itemIndex !== index);
    const playerCharacterIndex = characters.length
      ? Math.min(characters.length - 1, draft.playerCharacterIndex ?? 0)
      : 0;
    setDraft({
      ...draft,
      characters,
      playerCharacterIndex,
    });
    setCharCountInput(String(characters.length));
  };

  if (view === "template-choice") {
    return (
      <TemplateChoiceScreen
        selectedPresetId={selectedPresetId}
        topActions={topActions}
        onBack={() => setView("lobby")}
        onSelectPreset={selectWorldPreset}
        onOpenCustom={openCustomWorld}
      />
    );
  }

  if (view === "world-editor") {
    return (
      <WorldSetupScreen
        draft={draft}
        step={worldSetupStep}
        topActions={topActions}
        onBack={() => setView("template-choice")}
        onChange={setDraft}
        onStepChange={setWorldSetupStep}
        onConfirm={confirmWorld}
      />
    );
  }

  if (view === "ai-choice") {
    return (
      <AiChoiceScreen
        selectedAiPresetId={selectedAiPresetId}
        topActions={topActions}
        onBack={() => setView(aiChoiceBackView)}
        onSelectPreset={selectAiPreset}
        onOpenCustom={openCustomAi}
      />
    );
  }

  if (view === "ai-editor") {
    return (
      <AiSetupScreen
        draft={draft}
        step={aiSetupStep}
        topActions={topActions}
        onBack={() => setView("ai-choice")}
        onChange={setDraft}
        onStepChange={setAiSetupStep}
        onConfirm={confirmAi}
      />
    );
  }

  if (view === "characters") {
    return (
      <CharacterChoiceScreen
        draft={draft}
        charCountInput={charCountInput}
        topActions={topActions}
        onBack={() => setView(characterEntryView)}
        onOpenCharacter={(index) => {
          setEditingCharacterIndex(index);
          setView("character");
        }}
        onAddPreset={addCharacterPreset}
        onAddBlank={addBlankCharacter}
        onRemoveCharacter={removeCharacter}
        onCharCountChange={(value) => {
          setCharCountInput(value);
          if (value.trim() === "") return;
          const count = Number(value);
          if (Number.isFinite(count) && count >= 0 && count <= 6) {
            applyCharacterCount(count);
          }
        }}
        onCharCountBlur={() =>
          applyCharacterCount(
            charCountInput.trim() === ""
              ? draft.characters.length || 3
              : Number.isFinite(Number(charCountInput))
                ? Number(charCountInput)
                : draft.characters.length || 3,
          )
        }
        onChangeDraft={setDraft}
        onCreate={() => void handleCreate()}
      />
    );
  }

  if (view === "character") {
    const index = Math.min(
      Math.max(0, editingCharacterIndex),
      Math.max(0, draft.characters.length - 1),
    );
    return (
      <CharacterEditorScreen
        draft={draft}
        index={index}
        topActions={topActions}
        onBack={() => setView("characters")}
        onChange={(next) => updateCharacter(index, next)}
      />
    );
  }

  if (view === "lobby" || !game) {
    return (
      <NewGameLobbyScreen
        games={games}
        topActions={topActions}
        onBack={onBack}
        onStartNewGame={startNewGame}
        onOpenGame={(id) => void openGame(id)}
        onDelete={(id) => void handleDelete(id)}
        isGameRunning={isGameRunning}
      />
    );
  }

  if (false) {
    return (
      <LobbyScreen
        draft={draft}
        games={games}
        charCountInput={charCountInput}
        selectedPresetId={selectedPresetId}
        topActions={topActions}
        onBack={onBack}
        onChangeDraft={setDraft}
        onSelectPreset={selectWorldPreset}
        onCharCountChange={(value) => {
          setCharCountInput(value);
          if (value.trim() !== "") {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 2 && n <= 6) applyCharacterCount(n);
          }
        }}
        onCharCountBlur={() =>
          applyCharacterCount(
            Number(charCountInput) || draft.characters.length || 3,
          )
        }
        onOpenTemplate={() => setView("template-choice")}
        onOpenCharacters={() => setView("characters")}
        onCreate={() => void handleCreate()}
        onOpenGame={(id) => void openGame(id)}
        onDelete={(id) => void handleDelete(id)}
        isGameRunning={isGameRunning}
      />
    );
  }

  if (false) {
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
                上帝视角
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
  const gameAttributeDefinitions =
    game.attributeDefinitions?.length
      ? game.attributeDefinitions
      : inferAttributeDefinitions(game.sheets.map((sheet) => sheet.attrs));

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
            {playMode === "play" ? `扮演·${playerName}` : "上帝视角"}
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
                <p className="settings-hint">上帝视角模式无玩家剧情。</p>
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
                          {gameAttributeDefinitions.map((definition) => (
                            <label key={definition.key} className="game-attr-row">
                              {definition.label}
                              <input
                                disabled={busy}
                                defaultValue={String(
                                  sheet.attrs[definition.key] ?? "",
                                )}
                                onBlur={(e) => {
                                  const raw = e.target.value.trim();
                                  const num = Number(raw);
                                  const value =
                                    raw !== "" &&
                                    !Number.isNaN(num) &&
                                    definition.valueType === "number"
                                      ? num
                                      : raw;
                                  void saveCharacter(ch, {
                                    attrs: { [definition.key]: value },
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

function attributeDefinitionsForDraft(
  draft: GameTemplateDraft,
): GameAttributeDefinition[] {
  const inferred = inferAttributeDefinitions(
    draft.characters.map((character) => character.attrs),
  );
  const saved = draft.attributeDefinitions ?? [];
  const configured = saved
    .filter((item) => item.key.trim())
    .map((item): GameAttributeDefinition => ({
      ...item,
      label: item.label?.trim() || item.key.trim(),
      valueType: item.valueType === "text" ? "text" : "number",
    }));
  if (!configured.length) return inferred;
  const attrKeys = new Set(
    draft.characters.flatMap((character) => Object.keys(character.attrs)),
  );
  const extras = inferred.filter(
    (item) =>
      attrKeys.has(item.key) && !configured.some((x) => x.key === item.key),
  );
  return [...configured, ...extras];
}

function NewGameLobbyScreen({
  games,
  topActions,
  onBack,
  onStartNewGame,
  onOpenGame,
  onDelete,
  isGameRunning,
}: {
  games: Array<{ id: string; title: string; updatedAt: string; tick: number }>;
  topActions: ReactNode;
  onBack: () => void;
  onStartNewGame: () => void;
  onOpenGame: (id: string) => void;
  onDelete: (id: string) => void;
  isGameRunning: (id: string) => boolean;
}) {
  return (
    <div className="game-screen">
      <header className="game-topbar">
        <button type="button" className="icon-btn" onClick={onBack}>
          ←
        </button>
        <div className="game-topbar-title">
          <div>游戏</div>
          <div className="game-subtitle">分层建局，不把所有设置堆在一页。</div>
        </div>
        {topActions}
      </header>
      <div className="game-body game-lobby game-lobby-layered">
        <section className="game-card game-start-card">
          <div className="game-card-heading">
            <div>
              <h3>新建游戏</h3>
              <p>先选择世界模板，再进入人物选择与编辑。</p>
            </div>
            <span className="game-card-badge">开始</span>
          </div>
          <button type="button" className="primary-btn game-create-button" onClick={onStartNewGame}>
            开始建局
          </button>
        </section>
        <section className="game-card game-saves-card">
          <h3>存档</h3>
          {!games.length ? (
            <p className="settings-hint">尚无存档</p>
          ) : (
            <ul className="game-list">
              {games.map((saved) => (
                <li key={saved.id}>
                  <button
                    type="button"
                    className="game-list-main"
                    onClick={() => onOpenGame(saved.id)}
                  >
                    <strong>{saved.title}</strong>
                    <span>
                      时段 {saved.tick} · {new Date(saved.updatedAt).toLocaleString()}
                      {isGameRunning(saved.id) ? " · 推进中…" : ""}
                    </span>
                  </button>
                  <button type="button" className="link-btn" onClick={() => onDelete(saved.id)}>
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

function TemplateChoiceScreen({
  selectedPresetId,
  topActions,
  onBack,
  onSelectPreset,
  onOpenCustom,
}: {
  selectedPresetId: string;
  topActions: ReactNode;
  onBack: () => void;
  onSelectPreset: (preset: GameTemplatePreset) => void;
  onOpenCustom: () => void;
}) {
  return (
    <div className="game-screen game-editor-screen">
      <EditorHeader
        title="选择世界模板"
        subtitle="选择内置世界后直接进入人物选择，也可以从零自定义"
        topActions={topActions}
        onBack={onBack}
      />
      <div className="game-body game-editor-body">
        <section className="game-editor-section game-card">
          <div className="game-section-title">
            <h3>内置世界</h3>
            <span>选中后下一页选择人物</span>
          </div>
          <div className="game-preset-grid">
            {GAME_TEMPLATE_PRESETS.map((preset) => (
              <button
                type="button"
                key={preset.id}
                className={
                  selectedPresetId === preset.id
                    ? "game-preset-card active"
                    : "game-preset-card"
                }
                onClick={() => onSelectPreset(preset)}
              >
                <span className="game-preset-genre">{preset.genre}</span>
                <strong>{preset.title}</strong>
                <span>{preset.description}</span>
                <small>选择并进入人物</small>
              </button>
            ))}
          </div>
        </section>
        <section
          className={
            selectedPresetId === "custom"
              ? "game-card game-custom-world-card active"
              : "game-card game-custom-world-card"
          }
        >
          <div className="game-section-title">
            <h3>自定义世界</h3>
            <span>世界设置完成后再选人物</span>
          </div>
          <p className="settings-hint">
            自己设定世界观、时刻、属性集合、AI 人设和运行流水线。
          </p>
          <button type="button" className="secondary-btn" onClick={onOpenCustom}>
            进入自定义设置
          </button>
        </section>
      </div>
    </div>
  );
}

type LobbyScreenProps = {
  draft: GameTemplateDraft;
  games: Array<{ id: string; title: string; updatedAt: string; tick: number }>;
  charCountInput: string;
  selectedPresetId: string;
  topActions: ReactNode;
  onBack: () => void;
  onChangeDraft: (draft: GameTemplateDraft) => void;
  onSelectPreset: (preset: GameTemplatePreset) => void;
  onCharCountChange: (value: string) => void;
  onCharCountBlur: () => void;
  onOpenTemplate: () => void;
  onOpenCharacters: () => void;
  onCreate: () => void;
  onOpenGame: (id: string) => void;
  onDelete: (id: string) => void;
  isGameRunning: (id: string) => boolean;
};

function LobbyScreen({
  draft,
  games,
  charCountInput,
  selectedPresetId,
  topActions,
  onBack,
  onChangeDraft,
  onSelectPreset,
  onCharCountChange,
  onCharCountBlur,
  onOpenTemplate,
  onOpenCharacters,
  onCreate,
  onOpenGame,
  onDelete,
  isGameRunning,
}: LobbyScreenProps) {
  const playMode = draft.playMode === "play" ? "play" : "spectate";
  return (
    <div className="game-screen">
      <header className="game-topbar">
        <button type="button" className="icon-btn" onClick={onBack}>
          ←
        </button>
        <div className="game-topbar-title">
          <div>游戏</div>
          <div className="game-subtitle">选择题材，分层编辑后开始故事。</div>
        </div>
        {topActions}
      </header>
      <div className="game-body game-lobby game-lobby-layered">
        <section className="game-card">
          <div className="game-card-heading">
            <div>
              <h3>选择世界观</h3>
              <p>内置五种题材，也可以在模板编辑页继续改写。</p>
            </div>
            <span className="game-card-badge">预设</span>
          </div>
          <div className="game-preset-grid">
            {GAME_TEMPLATE_PRESETS.map((preset) => (
              <button
                type="button"
                key={preset.id}
                className={
                  selectedPresetId === preset.id
                    ? "game-preset-card active"
                    : "game-preset-card"
                }
                onClick={() => onSelectPreset(preset)}
              >
                <span className="game-preset-genre">{preset.genre}</span>
                <strong>{preset.title}</strong>
                <span>{preset.description}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="game-card game-create-card">
          <div className="game-card-heading">
            <div>
              <h3>新建游戏</h3>
              <p>建局页只保留开始游戏所需的选项。</p>
            </div>
            <span className="game-card-badge">建局</span>
          </div>
          <div className="game-form-grid">
            <label className="game-field">
              标题
              <input
                value={draft.title}
                placeholder="例如：青石镇的晨雾"
                onChange={(e) => onChangeDraft({ ...draft, title: e.target.value })}
              />
            </label>
          </div>
          <TimePickerEditor draft={draft} onChange={onChangeDraft} />
          <fieldset className="settings-fieldset game-view-fieldset">
            <legend>开局视角（创建后不可改）</legend>
            <label className="radio-row">
              <input
                type="radio"
                name="draftPlayMode"
                checked={playMode === "spectate"}
                onChange={() => onChangeDraft({ ...draft, playMode: "spectate" })}
              />
              上帝视角
            </label>
            <label className="radio-row">
              <input
                type="radio"
                name="draftPlayMode"
                checked={playMode === "play"}
                onChange={() =>
                  onChangeDraft({
                    ...draft,
                    playMode: "play",
                    playerCharacterIndex: draft.playerCharacterIndex ?? 0,
                  })
                }
              />
              扮演角色
            </label>
            {playMode === "play" ? (
              <label>
                扮演谁
                <select
                  value={String(draft.playerCharacterIndex ?? 0)}
                  onChange={(e) =>
                    onChangeDraft({
                      ...draft,
                      playerCharacterIndex: Number(e.target.value) || 0,
                    })
                  }
                >
                  {draft.characters.map((character, index) => (
                    <option key={index} value={index}>
                      {character.name || `角色 ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <p className="settings-hint">
              上帝视角可查看完整时间线与剧情；扮演角色默认只看自己的经历。
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
                onChange={(e) => onCharCountChange(e.target.value)}
                onBlur={onCharCountBlur}
              />
            </label>
            <div className="game-lobby-edit-actions">
              <button type="button" className="secondary-btn" onClick={onOpenTemplate}>
                编辑模板
              </button>
              <button type="button" className="secondary-btn" onClick={onOpenCharacters}>
                编辑角色
              </button>
            </div>
          </div>
          <div className="game-create-actions">
            <p>模板与角色会在创建时写入本局存档，之后仍可在游戏内调整状态。</p>
            <button type="button" className="primary-btn game-create-button" onClick={onCreate}>
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
              {games.map((saved) => (
                <li key={saved.id}>
                  <button
                    type="button"
                    className="game-list-main"
                    onClick={() => onOpenGame(saved.id)}
                  >
                    <strong>{saved.title}</strong>
                    <span>
                      时段 {saved.tick} · {new Date(saved.updatedAt).toLocaleString()}
                      {isGameRunning(saved.id) ? " · 推进中…" : ""}
                    </span>
                  </button>
                  <button type="button" className="link-btn" onClick={() => onDelete(saved.id)}>
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

type EditorHeaderProps = {
  title: string;
  subtitle: string;
  topActions: ReactNode;
  onBack: () => void;
};

function EditorHeader({ title, subtitle, topActions, onBack }: EditorHeaderProps) {
  return (
    <header className="game-topbar game-editor-header">
      <button type="button" className="icon-btn" onClick={onBack} title="返回">
        ←
      </button>
      <div className="game-topbar-title">
        <div>{title}</div>
        <div className="game-subtitle">{subtitle}</div>
      </div>
      {topActions}
    </header>
  );
}

function AiChoiceScreen({
  selectedAiPresetId,
  topActions,
  onBack,
  onSelectPreset,
  onOpenCustom,
}: {
  selectedAiPresetId: string;
  topActions: ReactNode;
  onBack: () => void;
  onSelectPreset: (preset: GameAiPreset) => void;
  onOpenCustom: () => void;
}) {
  return (
    <div className="game-screen game-editor-screen">
      <EditorHeader
        title="选择 AI 运行逻辑"
        subtitle="与世界模板分开选择，决定 AI 如何协作和推进"
        topActions={topActions}
        onBack={onBack}
      />
      <div className="game-body game-editor-body">
        <section className="game-editor-section game-card">
          <div className="game-section-title">
            <h3>预设 AI 逻辑</h3>
            <span>选择后直接进入人物页</span>
          </div>
          <div className="game-ai-preset-grid">
            {AI_RUNTIME_PRESETS.map((preset) => (
              <button
                type="button"
                key={preset.id}
                className={
                  selectedAiPresetId === preset.id
                    ? "game-ai-preset-card active"
                    : "game-ai-preset-card"
                }
                onClick={() => onSelectPreset(preset)}
              >
                <span className="game-preset-genre">{preset.genre}</span>
                <strong>{preset.title}</strong>
                <span>{preset.description}</span>
                <small>选择并进入人物</small>
              </button>
            ))}
          </div>
        </section>
        <section
          className={
            selectedAiPresetId === "custom"
              ? "game-card game-custom-world-card active"
              : "game-card game-custom-world-card"
          }
        >
          <div className="game-section-title">
            <h3>自定义 AI 运行逻辑</h3>
            <span>自己定义 AI 与思考链</span>
          </div>
          <p className="settings-hint">
            分两步设置 AI 提示词、统一配置与自由流水线节点。
          </p>
          <button type="button" className="secondary-btn" onClick={onOpenCustom}>
            进入自定义 AI 设置
          </button>
        </section>
      </div>
    </div>
  );
}

const AI_SETUP_STEPS: Array<{ id: AiSetupStep; label: string }> = [
  { id: "agents", label: "AI 设置" },
  { id: "pipeline", label: "思考链与流水线" },
];

function AiSetupScreen({
  draft,
  step,
  topActions,
  onBack,
  onChange,
  onStepChange,
  onConfirm,
}: {
  draft: GameTemplateDraft;
  step: AiSetupStep;
  topActions: ReactNode;
  onBack: () => void;
  onChange: (draft: GameTemplateDraft) => void;
  onStepChange: (step: AiSetupStep) => void;
  onConfirm: () => void;
}) {
  const stepIndex = AI_SETUP_STEPS.findIndex((item) => item.id === step);
  const currentIndex = stepIndex < 0 ? 0 : stepIndex;
  const goPrevious = () => {
    if (currentIndex === 0) {
      onBack();
      return;
    }
    onStepChange(AI_SETUP_STEPS[currentIndex - 1].id);
  };
  const goNext = () => {
    if (currentIndex >= AI_SETUP_STEPS.length - 1) {
      onConfirm();
      return;
    }
    onStepChange(AI_SETUP_STEPS[currentIndex + 1].id);
  };
  return (
    <div className="game-screen game-editor-screen">
      <EditorHeader
        title="自定义 AI 运行逻辑"
        subtitle={`${currentIndex + 1} / ${AI_SETUP_STEPS.length} · ${AI_SETUP_STEPS[currentIndex].label}`}
        topActions={topActions}
        onBack={onBack}
      />
      <div className="game-body game-editor-body game-world-setup-body">
        <nav className="game-world-step-nav" aria-label="AI 设置步骤">
          {AI_SETUP_STEPS.map((item, index) => (
            <button
              type="button"
              key={item.id}
              className={
                index === currentIndex
                  ? "game-world-step active"
                  : index < currentIndex
                    ? "game-world-step done"
                    : "game-world-step"
              }
              onClick={() => onStepChange(item.id)}
            >
              <span>{index + 1}</span>
              {item.label}
            </button>
          ))}
        </nav>
        {step === "agents" ? (
          <WorldAgentsStep draft={draft} onChange={onChange} />
        ) : (
          <WorldPipelineStep draft={draft} onChange={onChange} />
        )}
        <div className="game-world-step-actions">
          <button type="button" className="secondary-btn" onClick={goPrevious}>
            {currentIndex === 0 ? "返回 AI 选择" : "上一步"}
          </button>
          <button type="button" className="primary-btn" onClick={goNext}>
            {currentIndex === AI_SETUP_STEPS.length - 1
              ? "确认 AI 逻辑，选择人物"
              : "下一步"}
          </button>
        </div>
      </div>
    </div>
  );
}

const WORLD_SETUP_STEPS: Array<{ id: WorldSetupStep; label: string }> = [
  { id: "basic", label: "基本信息" },
  { id: "attributes", label: "属性集合" },
];

function WorldSetupScreen({
  draft,
  step,
  topActions,
  onBack,
  onChange,
  onStepChange,
  onConfirm,
}: {
  draft: GameTemplateDraft;
  step: WorldSetupStep;
  topActions: ReactNode;
  onBack: () => void;
  onChange: (draft: GameTemplateDraft) => void;
  onStepChange: (step: WorldSetupStep) => void;
  onConfirm: () => void;
}) {
  const stepIndex = WORLD_SETUP_STEPS.findIndex((item) => item.id === step);
  const currentIndex = stepIndex < 0 ? 0 : stepIndex;
  const goPrevious = () => {
    if (currentIndex === 0) {
      onBack();
      return;
    }
    onStepChange(WORLD_SETUP_STEPS[currentIndex - 1].id);
  };
  const goNext = () => {
    if (currentIndex >= WORLD_SETUP_STEPS.length - 1) {
      onConfirm();
      return;
    }
    onStepChange(WORLD_SETUP_STEPS[currentIndex + 1].id);
  };

  return (
    <div className="game-screen game-editor-screen">
      <EditorHeader
        title="自定义世界"
        subtitle={`${currentIndex + 1} / ${WORLD_SETUP_STEPS.length} · ${WORLD_SETUP_STEPS[currentIndex].label}`}
        topActions={topActions}
        onBack={onBack}
      />
      <div className="game-body game-editor-body game-world-setup-body">
        <nav className="game-world-step-nav" aria-label="世界设置步骤">
          {WORLD_SETUP_STEPS.map((item, index) => (
            <button
              type="button"
              key={item.id}
              className={
                index === currentIndex
                  ? "game-world-step active"
                  : index < currentIndex
                    ? "game-world-step done"
                    : "game-world-step"
              }
              onClick={() => onStepChange(item.id)}
            >
              <span>{index + 1}</span>
              {item.label}
            </button>
          ))}
        </nav>

        {step === "basic" ? (
          <WorldBasicStep draft={draft} onChange={onChange} />
        ) : null}
        {step === "attributes" ? (
          <WorldAttributesStep draft={draft} onChange={onChange} />
        ) : null}
        <div className="game-world-step-actions">
          <button type="button" className="secondary-btn" onClick={goPrevious}>
            {currentIndex === 0 ? "返回选择世界" : "上一步"}
          </button>
          <button type="button" className="primary-btn" onClick={goNext}>
            {currentIndex === WORLD_SETUP_STEPS.length - 1
              ? "确认世界设置，选择人物"
              : "下一步"}
          </button>
        </div>
      </div>
    </div>
  );
}

function WorldBasicStep({
  draft,
  onChange,
}: {
  draft: GameTemplateDraft;
  onChange: (draft: GameTemplateDraft) => void;
}) {
  return (
    <section className="game-editor-section game-card">
      <div className="game-section-title">
        <h3>基本信息</h3>
        <span>先确定故事的外壳</span>
      </div>
      <label className="game-field">
        游戏标题
        <input
          value={draft.title}
          placeholder="例如：雾都档案"
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
        />
      </label>
      <TimePickerEditor draft={draft} onChange={onChange} />
      <label className="game-field">
        世界观描述
        <textarea
          rows={10}
          value={draft.worldview}
          placeholder="描述时代、地点、规则和故事基调"
          onChange={(e) => onChange({ ...draft, worldview: e.target.value })}
        />
      </label>
    </section>
  );
}

function TimePickerEditor({
  draft,
  onChange,
}: {
  draft: GameTemplateDraft;
  onChange: (draft: GameTemplateDraft) => void;
}) {
  const current = normalizeGameDateTime(
    draft.initialTimeParts,
  );
  const update = (patch: Partial<GameDateTime>) => {
    const next = normalizeGameDateTime({ ...current, ...patch });
    onChange({
      ...draft,
      initialTime: formatGameDateTime(next),
      initialTimeParts: next,
    });
  };
  const options = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => from + index);
  const yearOptions = Array.from(new Set([...options(1, 100), current.year])).sort(
    (a, b) => a - b,
  );
  return (
    <div className="game-time-picker">
      <div className="game-section-title">
        <h3>初始时间</h3>
        <span>只能从固定年月日时分中选择</span>
      </div>
      <label className="game-field">
        时间描述
        <input
          value={current.description}
          placeholder="例如：春日清晨"
          onChange={(e) => update({ description: e.target.value })}
        />
      </label>
      <div className="game-time-select-grid">
        <label className="game-field">
          年
          <select value={current.year} onChange={(e) => update({ year: Number(e.target.value) })}>
            {yearOptions.map((value) => (
              <option key={value} value={value}>{value} 年</option>
            ))}
          </select>
        </label>
        <label className="game-field">
          月
          <select value={current.month} onChange={(e) => update({ month: Number(e.target.value) })}>
            {options(1, 12).map((value) => (
              <option key={value} value={value}>{value} 月</option>
            ))}
          </select>
        </label>
        <label className="game-field">
          日
          <select value={current.day} onChange={(e) => update({ day: Number(e.target.value) })}>
            {options(1, 31).map((value) => (
              <option key={value} value={value}>{value} 日</option>
            ))}
          </select>
        </label>
        <label className="game-field">
          时
          <select value={current.hour} onChange={(e) => update({ hour: Number(e.target.value) })}>
            {options(0, 23).map((value) => (
              <option key={value} value={value}>{String(value).padStart(2, "0")} 时</option>
            ))}
          </select>
        </label>
        <label className="game-field">
          分
          <select value={current.minute} onChange={(e) => update({ minute: Number(e.target.value) })}>
            {options(0, 59).map((value) => (
              <option key={value} value={value}>{String(value).padStart(2, "0")} 分</option>
            ))}
          </select>
        </label>
      </div>
      <p className="settings-hint">最终保存为：{formatGameDateTime(current)}</p>
    </div>
  );
}

function WorldAttributesStep({
  draft,
  onChange,
}: {
  draft: GameTemplateDraft;
  onChange: (draft: GameTemplateDraft) => void;
}) {
  const definitions = attributeDefinitionsForDraft(draft);
  const setDefinitions = (next: GameAttributeDefinition[]) =>
    onChange({ ...draft, attributeDefinitions: next });
  return (
    <section className="game-editor-section game-card">
      <div className="game-section-title">
        <h3>属性集合</h3>
        <span>统一定义，人物分别填写</span>
      </div>
      <div className="game-attribute-definitions">
        {definitions.map((definition, index) => (
          <div className="game-attribute-definition" key={`${definition.key}-${index}`}>
            <input
              value={definition.label}
              aria-label="属性名称"
              placeholder="显示名"
              onChange={(e) =>
                setDefinitions(
                  definitions.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, label: e.target.value }
                      : item,
                  ),
                )
              }
            />
            <select
              value={definition.valueType}
              aria-label="属性类型"
              onChange={(e) =>
                setDefinitions(
                  definitions.map((item, itemIndex) =>
                    itemIndex === index
                      ? {
                          ...item,
                          valueType:
                            e.target.value === "text" ? "text" : "number",
                          numberOptions:
                            e.target.value === "text"
                              ? undefined
                              : item.numberOptions ?? [0, 1, 2, 3, 5, 10],
                          textOptions:
                            e.target.value === "text"
                              ? item.textOptions ?? ["平静", "警惕", "沉稳"]
                              : undefined,
                        }
                      : item,
                  ),
                )
              }
            >
              <option value="number">数字</option>
              <option value="text">文字</option>
            </select>
            <input
              className="game-attribute-options-input"
              aria-label="属性选项"
              placeholder="选项，用逗号分隔"
              value={
                definition.valueType === "number"
                  ? (definition.numberOptions ?? []).join(", ")
                  : (definition.textOptions ?? []).join("，")
              }
              onChange={(e) => {
                const values = e.target.value
                  .split(/[,，]/)
                  .map((value) => value.trim())
                  .filter(Boolean);
                setDefinitions(
                  definitions.map((item, itemIndex) =>
                    itemIndex === index
                      ? item.valueType === "number"
                        ? {
                            ...item,
                            numberOptions: values
                              .map(Number)
                              .filter((value) => Number.isFinite(value)),
                          }
                        : { ...item, textOptions: values }
                      : item,
                  ),
                );
              }}
            />
            <button
              type="button"
              className="link-btn"
              disabled={definitions.length <= 1}
              onClick={() =>
                setDefinitions(definitions.filter((_, itemIndex) => itemIndex !== index))
              }
            >
              删除
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="secondary-btn"
        onClick={() =>
          setDefinitions([
            ...definitions,
            {
              key: `attribute_${definitions.length + 1}`,
              label: `新属性 ${definitions.length + 1}`,
              valueType: "number",
              numberOptions: [0, 1, 2, 3, 5, 10],
            },
          ])
        }
      >
        添加属性
      </button>
      <p className="settings-hint">
        删除只影响之后创建的模板，不会破坏已有存档里的自由属性。
      </p>
    </section>
  );
}

function AgentConfigEditor({
  model,
  onModelChange,
  readableFileIds,
  editableFileIds,
  onAccessChange,
  disabledFeatures,
  onDisabledFeaturesChange,
  files,
}: {
  model?: AgentModelOverride;
  onModelChange: (model?: AgentModelOverride) => void;
  readableFileIds?: string[];
  editableFileIds?: string[];
  onAccessChange: (readableFileIds: string[], editableFileIds: string[]) => void;
  disabledFeatures?: AgentFeatureKey[];
  onDisabledFeaturesChange: (features: AgentFeatureKey[]) => void;
  files: Array<{ id: string; title: string }>;
}) {
  const readable = new Set(readableFileIds ?? files.map((file) => file.id));
  const editable = new Set(editableFileIds ?? []);
  const features: Array<{ id: AgentFeatureKey; label: string }> = [
    { id: "propose", label: "提案" },
    { id: "respond", label: "回应" },
    { id: "judge", label: "裁判" },
    { id: "chronicle", label: "整理剧情" },
    { id: "advance_clock", label: "拨钟" },
  ];
  const changeReadable = (fileId: string, checked: boolean) => {
    const nextReadable = new Set(readable);
    const nextEditable = new Set(editable);
    if (checked) nextReadable.add(fileId);
    else {
      nextReadable.delete(fileId);
      nextEditable.delete(fileId);
    }
    onAccessChange([...nextReadable], [...nextEditable]);
  };
  const changeEditable = (fileId: string, checked: boolean) => {
    const nextEditable = new Set(editable);
    if (checked) nextEditable.add(fileId);
    else nextEditable.delete(fileId);
    onAccessChange([...readable], [...nextEditable].filter((id) => readable.has(id)));
  };
  return (
    <div className="game-agent-config">
      <ModelOverrideEditor value={model} onChange={onModelChange} />
      <div className="game-agent-feature-grid">
        {features.map((feature) => (
          <label className="game-agent-toggle" key={feature.id}>
            <input
              type="checkbox"
              checked={!(disabledFeatures ?? []).includes(feature.id)}
              onChange={(e) =>
                onDisabledFeaturesChange(
                  e.target.checked
                    ? (disabledFeatures ?? []).filter((id) => id !== feature.id)
                    : [...new Set([...(disabledFeatures ?? []), feature.id])],
                )
              }
            />
            {feature.label}
          </label>
        ))}
      </div>
      <div className="game-agent-files">
        <div className="game-agent-files-title">文档权限（可编辑 ⊆ 可查看）</div>
        <div className="game-agent-files-grid">
          {files.map((file) => (
            <div className="game-agent-file-row" key={file.id}>
              <span>{file.title}</span>
              <label>
                <input
                  type="checkbox"
                  checked={readable.has(file.id)}
                  onChange={(e) => changeReadable(file.id, e.target.checked)}
                />
                查看
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={editable.has(file.id) && readable.has(file.id)}
                  disabled={!readable.has(file.id)}
                  onChange={(e) => changeEditable(file.id, e.target.checked)}
                />
                编辑
              </label>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function WorldAgentsStep({
  draft,
  onChange,
}: {
  draft: GameTemplateDraft;
  onChange: (draft: GameTemplateDraft) => void;
}) {
  const files = (draft.contextFiles ?? defaultContextFiles(draft.worldview, draft.initialTime))
    .map(({ id, title }) => ({ id, title }));
  return (
    <div className="game-world-step-stack">
      <section className="game-editor-section game-card">
        <div className="game-section-title">
          <h3>世界 AI</h3>
          <span>描述世界如何回应</span>
        </div>
        <label className="game-field">
          System 提示词（空=默认）
          <textarea
            rows={5}
            value={draft.worldSystemPrompt ?? ""}
            placeholder={`${worldSystemPrompt(draft.worldview).slice(0, 100)}…`}
            onChange={(e) =>
              onChange({ ...draft, worldSystemPrompt: e.target.value })
            }
          />
        </label>
        <AgentConfigEditor
          model={draft.worldModel}
          onModelChange={(worldModel) => onChange({ ...draft, worldModel })}
          readableFileIds={draft.worldReadableFileIds}
          editableFileIds={draft.worldEditableFileIds}
          onAccessChange={(worldReadableFileIds, worldEditableFileIds) =>
            onChange({ ...draft, worldReadableFileIds, worldEditableFileIds })
          }
          disabledFeatures={draft.worldDisabledFeatures}
          onDisabledFeaturesChange={(worldDisabledFeatures) =>
            onChange({ ...draft, worldDisabledFeatures })
          }
          files={files}
        />
      </section>
      <section className="game-editor-section game-card">
        <div className="game-section-title">
          <h3>裁判 AI</h3>
          <span>判定行动是否成立</span>
        </div>
        <label className="game-field">
          人设
          <input
            value={draft.refereePersona ?? ""}
            onChange={(e) =>
              onChange({ ...draft, refereePersona: e.target.value })
            }
          />
        </label>
        <label className="game-field">
          System 提示词（空=默认）
          <textarea
            rows={4}
            value={draft.refereeSystemPrompt ?? ""}
            onChange={(e) =>
              onChange({ ...draft, refereeSystemPrompt: e.target.value })
            }
          />
        </label>
        <AgentConfigEditor
          model={draft.refereeModel}
          onModelChange={(refereeModel) => onChange({ ...draft, refereeModel })}
          readableFileIds={draft.refereeReadableFileIds}
          editableFileIds={draft.refereeEditableFileIds}
          onAccessChange={(refereeReadableFileIds, refereeEditableFileIds) =>
            onChange({ ...draft, refereeReadableFileIds, refereeEditableFileIds })
          }
          disabledFeatures={draft.refereeDisabledFeatures}
          onDisabledFeaturesChange={(refereeDisabledFeatures) =>
            onChange({ ...draft, refereeDisabledFeatures })
          }
          files={files}
        />
      </section>
      <section className="game-editor-section game-card">
        <div className="game-section-title">
          <h3>书记 AI</h3>
          <span>整理两种视角的剧情</span>
        </div>
        <label className="game-field">
          上帝视角提示词（空=默认）
          <textarea
            rows={3}
            value={draft.chroniclerGodPrompt ?? ""}
            placeholder={`${chroniclerSystemPrompt("god").slice(0, 80)}…`}
            onChange={(e) =>
              onChange({ ...draft, chroniclerGodPrompt: e.target.value })
            }
          />
        </label>
        <label className="game-field">
          玩家视角提示词（空=默认）
          <textarea
            rows={3}
            value={draft.chroniclerPlayerPrompt ?? ""}
            placeholder={`${chroniclerSystemPrompt("player").slice(0, 80)}…`}
            onChange={(e) =>
              onChange({ ...draft, chroniclerPlayerPrompt: e.target.value })
            }
          />
        </label>
        <AgentConfigEditor
          model={draft.chroniclerModel}
          onModelChange={(chroniclerModel) =>
            onChange({ ...draft, chroniclerModel })
          }
          readableFileIds={draft.chroniclerReadableFileIds}
          editableFileIds={draft.chroniclerEditableFileIds}
          onAccessChange={(chroniclerReadableFileIds, chroniclerEditableFileIds) =>
            onChange({ ...draft, chroniclerReadableFileIds, chroniclerEditableFileIds })
          }
          disabledFeatures={draft.chroniclerDisabledFeatures}
          onDisabledFeaturesChange={(chroniclerDisabledFeatures) =>
            onChange({ ...draft, chroniclerDisabledFeatures })
          }
          files={files}
        />
      </section>
    </div>
  );
}

function WorldPipelineStep({
  draft,
  onChange,
}: {
  draft: GameTemplateDraft;
  onChange: (draft: GameTemplateDraft) => void;
}) {
  return (
    <section className="game-editor-section game-card">
      <div className="game-section-title">
        <h3>运行逻辑</h3>
        <span>最后确认每轮如何推进</span>
      </div>
      <p className="settings-hint">
        新建游戏不再单独固定顺序或串并行；下面的节点可以指定多个 AI、目标和调度方式。
        旧存档中的顺序字段仍会兼容读取。
      </p>
      <PipelineEditor
        value={draft.pipeline ?? defaultPipeline()}
        onChange={(pipeline) => onChange({ ...draft, pipeline })}
        agents={[
          { id: "world", name: "世界", kind: "world" },
          ...draft.characters.map((character, index) => ({
            id: `character_${index}`,
            name: character.name || `角色 ${index + 1}`,
            kind: "character" as const,
          })),
          { id: "referee", name: "裁判", kind: "referee" },
        ]}
      />
    </section>
  );
}

export function TemplateEditorScreen({
  draft,
  topActions,
  title,
  subtitle,
  onBack,
  onChange,
  onConfirm,
}: {
  draft: GameTemplateDraft;
  topActions: ReactNode;
  title: string;
  subtitle: string;
  onBack: () => void;
  onChange: (draft: GameTemplateDraft) => void;
  onConfirm: () => void;
}) {
  const definitions = attributeDefinitionsForDraft(draft);
  const setDefinitions = (next: GameAttributeDefinition[]) =>
    onChange({ ...draft, attributeDefinitions: next });
  const files = (draft.contextFiles ?? defaultContextFiles(draft.worldview, draft.initialTime))
    .map(({ id, title }) => ({ id, title }));
  return (
    <div className="game-screen game-editor-screen">
      <EditorHeader
        title={title}
        subtitle={subtitle}
        topActions={topActions}
        onBack={onBack}
      />
      <div className="game-body game-editor-body">
        <section className="game-editor-section game-card">
          <div className="game-section-title">
            <h3>世界观</h3>
            <span>决定世界如何回应角色</span>
          </div>
          <div className="game-form-grid">
            <label className="game-field">
              游戏标题
              <input
                value={draft.title}
                placeholder="例如：雾都档案"
                onChange={(e) => onChange({ ...draft, title: e.target.value })}
              />
            </label>
          </div>
          <TimePickerEditor draft={draft} onChange={onChange} />
          <label className="game-field">
            世界观描述
            <textarea
              rows={7}
              value={draft.worldview}
              onChange={(e) => onChange({ ...draft, worldview: e.target.value })}
            />
          </label>
          <label className="game-field">
            世界 AI System 提示词（空=默认）
            <textarea
              rows={4}
              value={draft.worldSystemPrompt ?? ""}
              placeholder={`${worldSystemPrompt(draft.worldview).slice(0, 100)}…`}
              onChange={(e) => onChange({ ...draft, worldSystemPrompt: e.target.value })}
            />
          </label>
          <AgentConfigEditor
            model={draft.worldModel}
            onModelChange={(worldModel) => onChange({ ...draft, worldModel })}
            readableFileIds={draft.worldReadableFileIds}
            editableFileIds={draft.worldEditableFileIds}
            onAccessChange={(worldReadableFileIds, worldEditableFileIds) =>
              onChange({ ...draft, worldReadableFileIds, worldEditableFileIds })
            }
            disabledFeatures={draft.worldDisabledFeatures}
            onDisabledFeaturesChange={(worldDisabledFeatures) =>
              onChange({ ...draft, worldDisabledFeatures })
            }
            files={files}
          />
        </section>

        <section className="game-editor-section game-card">
          <div className="game-section-title">
            <h3>属性集合</h3>
            <span>统一定义，角色分别填写数值</span>
          </div>
          <div className="game-attribute-definitions">
            {definitions.map((definition, index) => (
              <div className="game-attribute-definition" key={`${definition.key}-${index}`}>
                <input
                  value={definition.label}
                  aria-label="属性名称"
                  placeholder="显示名"
                  onChange={(e) => {
                    const next = definitions.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, label: e.target.value } : item,
                    );
                    setDefinitions(next);
                  }}
                />
                <select
                  value={definition.valueType}
                  aria-label="属性类型"
                  onChange={(e) => {
                    const next: GameAttributeDefinition[] = definitions.map(
                      (item, itemIndex) =>
                      itemIndex === index
                        ? {
                            ...item,
                            valueType:
                              e.target.value === "text" ? "text" : "number",
                          }
                        : item,
                    );
                    setDefinitions(next);
                  }}
                >
                  <option value="number">数字</option>
                  <option value="text">文字</option>
                </select>
                <input
                  className="game-attribute-options-input"
                  aria-label="属性选项"
                  placeholder="选项，用逗号分隔"
                  value={
                    definition.valueType === "number"
                      ? (definition.numberOptions ?? []).join(", ")
                      : (definition.textOptions ?? []).join("，")
                  }
                  onChange={(e) => {
                    const values = e.target.value
                      .split(/[,，]/)
                      .map((value) => value.trim())
                      .filter(Boolean);
                    setDefinitions(
                      definitions.map((item, itemIndex) =>
                        itemIndex === index
                          ? item.valueType === "number"
                            ? {
                                ...item,
                                numberOptions: values
                                  .map(Number)
                                  .filter((value) => Number.isFinite(value)),
                              }
                            : { ...item, textOptions: values }
                          : item,
                      ),
                    );
                  }}
                />
                <button
                  type="button"
                  className="link-btn"
                  disabled={definitions.length <= 1}
                  onClick={() => setDefinitions(definitions.filter((_, i) => i !== index))}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="secondary-btn"
            onClick={() =>
              setDefinitions([
                ...definitions,
                {
                  key: `attribute_${definitions.length + 1}`,
                  label: `新属性 ${definitions.length + 1}`,
                  valueType: "number",
                  numberOptions: [0, 1, 2, 3, 5, 10],
                },
              ])
            }
          >
            添加属性
          </button>
          <p className="settings-hint">
            删除只影响之后创建的模板，不会破坏已有存档里的自由属性。
          </p>
        </section>

        <section className="game-editor-section game-card">
          <div className="game-section-title">
            <h3>裁判 AI</h3>
            <span>负责判定行动是否成立</span>
          </div>
          <label className="game-field">
            人设
            <input
              value={draft.refereePersona ?? ""}
              onChange={(e) => onChange({ ...draft, refereePersona: e.target.value })}
            />
          </label>
          <label className="game-field">
            System 提示词（空=默认）
            <textarea
              rows={4}
              value={draft.refereeSystemPrompt ?? ""}
              onChange={(e) => onChange({ ...draft, refereeSystemPrompt: e.target.value })}
            />
          </label>
          <AgentConfigEditor
            model={draft.refereeModel}
            onModelChange={(refereeModel) => onChange({ ...draft, refereeModel })}
            readableFileIds={draft.refereeReadableFileIds}
            editableFileIds={draft.refereeEditableFileIds}
            onAccessChange={(refereeReadableFileIds, refereeEditableFileIds) =>
              onChange({ ...draft, refereeReadableFileIds, refereeEditableFileIds })
            }
            disabledFeatures={draft.refereeDisabledFeatures}
            onDisabledFeaturesChange={(refereeDisabledFeatures) =>
              onChange({ ...draft, refereeDisabledFeatures })
            }
            files={files}
          />
        </section>

        <section className="game-editor-section game-card">
          <div className="game-section-title">
            <h3>书记 AI</h3>
            <span>整理上帝视角与玩家视角剧情</span>
          </div>
          <label className="game-field">
            上帝视角提示词（空=默认）
            <textarea
              rows={3}
              value={draft.chroniclerGodPrompt ?? ""}
              placeholder={`${chroniclerSystemPrompt("god").slice(0, 80)}…`}
              onChange={(e) => onChange({ ...draft, chroniclerGodPrompt: e.target.value })}
            />
          </label>
          <label className="game-field">
            玩家视角提示词（空=默认）
            <textarea
              rows={3}
              value={draft.chroniclerPlayerPrompt ?? ""}
              placeholder={`${chroniclerSystemPrompt("player").slice(0, 80)}…`}
              onChange={(e) =>
                onChange({ ...draft, chroniclerPlayerPrompt: e.target.value })
              }
            />
          </label>
          <AgentConfigEditor
            model={draft.chroniclerModel}
            onModelChange={(chroniclerModel) => onChange({ ...draft, chroniclerModel })}
            readableFileIds={draft.chroniclerReadableFileIds}
            editableFileIds={draft.chroniclerEditableFileIds}
            onAccessChange={(chroniclerReadableFileIds, chroniclerEditableFileIds) =>
              onChange({ ...draft, chroniclerReadableFileIds, chroniclerEditableFileIds })
            }
            disabledFeatures={draft.chroniclerDisabledFeatures}
            onDisabledFeaturesChange={(chroniclerDisabledFeatures) =>
              onChange({ ...draft, chroniclerDisabledFeatures })
            }
            files={files}
          />
        </section>

        <section className="game-editor-section game-card">
          <div className="game-section-title">
            <h3>运行逻辑</h3>
            <span>配置自由 AI 节点和条件跳转</span>
          </div>
          <PipelineEditor
            value={draft.pipeline ?? defaultPipeline()}
            onChange={(pipeline) => onChange({ ...draft, pipeline })}
          />
        </section>
        <div className="game-editor-bottom-note">
          <span>当前使用：{getProvider().defaultModel}（可为各 AI 单独覆盖）</span>
          <button
            type="button"
            className="link-btn"
            onClick={() =>
              onChange({
                ...defaultTemplateDraft(draft.characters.length),
                title: draft.title,
                playMode: draft.playMode,
                playerCharacterIndex: draft.playerCharacterIndex,
                characters: draft.characters,
              })
            }
          >
            恢复模板默认
          </button>
        </div>
        <button type="button" className="primary-btn game-editor-confirm-btn" onClick={onConfirm}>
          确认世界设置，选择人物
        </button>
      </div>
    </div>
  );
}

function CharacterChoiceScreen({
  draft,
  charCountInput,
  topActions,
  onBack,
  onOpenCharacter,
  onAddPreset,
  onAddBlank,
  onRemoveCharacter,
  onCharCountChange,
  onCharCountBlur,
  onChangeDraft,
  onCreate,
}: {
  draft: GameTemplateDraft;
  charCountInput: string;
  topActions: ReactNode;
  onBack: () => void;
  onOpenCharacter: (index: number) => void;
  onAddPreset: (template: CharTemplateDraft) => void;
  onAddBlank: () => void;
  onRemoveCharacter: (index: number) => void;
  onCharCountChange: (value: string) => void;
  onCharCountBlur: () => void;
  onChangeDraft: (draft: GameTemplateDraft) => void;
  onCreate: () => void;
}) {
  const playMode = draft.playMode === "play" ? "play" : "spectate";
  return (
    <div className="game-screen game-editor-screen">
      <EditorHeader
        title="选择人物"
        subtitle="选择预设或自己编辑，确认后创建游戏"
        topActions={topActions}
        onBack={onBack}
      />
      <div className="game-body game-editor-body">
        <section className="game-editor-section game-card">
          <div className="game-section-title">
            <h3>人物预设</h3>
            <span>{draft.characters.length >= 6 ? "最多 6 名" : "点击添加"}</span>
          </div>
          <div className="game-character-presets">
            {CHAR_TEMPLATES.map((template) => (
              <button
                type="button"
                className="game-character-preset"
                key={template.name}
                disabled={draft.characters.length >= 6}
                onClick={() => onAddPreset(template)}
              >
                <strong>{template.name}</strong>
                <span>{template.persona}</span>
                <small>＋ 添加</small>
              </button>
            ))}
            <button
              type="button"
              className="game-character-preset game-character-preset-blank"
              disabled={draft.characters.length >= 6}
              onClick={onAddBlank}
            >
              <strong>空白角色</strong>
              <span>从姓名、人设和属性开始自己填写。</span>
              <small>＋ 添加后编辑</small>
            </button>
          </div>
        </section>

        <section className="game-editor-section game-card">
          <div className="game-section-title">
            <h3>当前人物</h3>
            <span>点击人物进入独立编辑</span>
          </div>
          <label className="game-field game-character-count-field">
            角色数量
            <span className="game-field-hint">编辑中可为 0–6 名，创建至少 2 名</span>
            <input
              type="number"
              min={0}
              max={6}
              value={charCountInput}
              onChange={(e) => onCharCountChange(e.target.value)}
              onBlur={onCharCountBlur}
            />
          </label>
          {draft.characters.length ? (
            <div className="game-character-list">
              {draft.characters.map((character, index) => (
                <div className="game-character-card-row" key={index}>
                  <button
                    type="button"
                    className="game-character-card"
                    onClick={() => onOpenCharacter(index)}
                  >
                    <span className="game-character-index">{index + 1}</span>
                    <span className="game-character-card-copy">
                      <strong>{character.name || `角色 ${index + 1}`}</strong>
                      <span>{character.persona || "尚未填写人设"}</span>
                    </span>
                    <span className="game-character-arrow">›</span>
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => onRemoveCharacter(index)}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="game-character-empty">
              <strong>还没有角色</strong>
              <span>可以从上面的预设添加，也可以创建空白角色。</span>
              <button type="button" className="secondary-btn" onClick={onAddBlank}>
                添加角色
              </button>
            </div>
          )}
        </section>

        <section className="game-editor-section game-card">
          <fieldset className="settings-fieldset game-view-fieldset">
            <legend>开局视角（创建后不可改）</legend>
            <label className="radio-row">
              <input
                type="radio"
                name="characterChoicePlayMode"
                checked={playMode === "spectate"}
                onChange={() => onChangeDraft({ ...draft, playMode: "spectate" })}
              />
              上帝视角
            </label>
            <label className="radio-row">
              <input
                type="radio"
                name="characterChoicePlayMode"
                checked={playMode === "play"}
                onChange={() =>
                  onChangeDraft({
                    ...draft,
                    playMode: "play",
                    playerCharacterIndex: draft.playerCharacterIndex ?? 0,
                  })
                }
              />
              扮演角色
            </label>
            {playMode === "play" ? (
              <label>
                扮演谁
                <select
                  value={String(draft.playerCharacterIndex ?? 0)}
                  onChange={(e) =>
                    onChangeDraft({
                      ...draft,
                      playerCharacterIndex: Number(e.target.value) || 0,
                    })
                  }
                >
                  {draft.characters.map((character, index) => (
                    <option key={index} value={index}>
                      {character.name || `角色 ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </fieldset>
          <p className="settings-hint">
            上帝视角可查看完整时间线；扮演角色默认只看自己的经历。
          </p>
          <button
            type="button"
            className="primary-btn game-editor-confirm-btn"
            disabled={draft.characters.length < 2}
            onClick={onCreate}
          >
            确认人物并创建游戏
          </button>
          {draft.characters.length < 2 ? (
            <p className="settings-hint warn-hint">至少添加 2 名角色后才能创建游戏。</p>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function CharacterEditorScreen({
  draft,
  index,
  topActions,
  onBack,
  onChange,
}: {
  draft: GameTemplateDraft;
  index: number;
  topActions: ReactNode;
  onBack: () => void;
  onChange: (character: CharTemplateDraft) => void;
}) {
  const character = draft.characters[index] ?? defaultTemplateDraft(2).characters[0];
  const definitions = attributeDefinitionsForDraft(draft);
  const files = (draft.contextFiles ?? defaultContextFiles(draft.worldview, draft.initialTime))
    .map(({ id, title }) => ({ id, title }));
  const setAttr = (definition: GameAttributeDefinition, raw: string) => {
    const value =
      definition.valueType === "number" && raw.trim() !== ""
        ? Number(raw)
        : raw;
    onChange({ ...character, attrs: { ...character.attrs, [definition.key]: value } });
  };
  return (
    <div className="game-screen game-editor-screen">
      <EditorHeader
        title={`角色 ${index + 1}`}
        subtitle="独立编辑姓名、人设、属性与物品"
        topActions={topActions}
        onBack={onBack}
      />
      <div className="game-body game-editor-body">
        <section className="game-editor-section game-card">
          <label className="game-field">
            姓名
            <input
              value={character.name}
              onChange={(e) => onChange({ ...character, name: e.target.value })}
            />
          </label>
          <label className="game-field">
            人设
            <textarea
              rows={5}
              value={character.persona}
              onChange={(e) => onChange({ ...character, persona: e.target.value })}
            />
          </label>
          <label className="game-field">
            System 提示词（空=默认）
            <textarea
              rows={4}
              value={character.systemPrompt ?? ""}
              onChange={(e) => onChange({ ...character, systemPrompt: e.target.value })}
            />
          </label>
          <AgentConfigEditor
            model={character.model}
            onModelChange={(model) => onChange({ ...character, model })}
            readableFileIds={character.readableFileIds}
            editableFileIds={character.editableFileIds}
            onAccessChange={(readableFileIds, editableFileIds) =>
              onChange({ ...character, readableFileIds, editableFileIds })
            }
            disabledFeatures={character.disabledFeatures}
            onDisabledFeaturesChange={(disabledFeatures) =>
              onChange({ ...character, disabledFeatures })
            }
            files={files}
          />
        </section>
        <section className="game-editor-section game-card">
          <div className="game-section-title">
            <h3>属性值</h3>
            <span>紧凑网格编辑</span>
          </div>
          <div className="game-attribute-grid">
            {definitions.map((definition) => (
              <label className="game-attribute-field" key={definition.key}>
                <span>{definition.label}</span>
                <select
                  value={String(character.attrs[definition.key] ?? "")}
                  onChange={(e) => setAttr(definition, e.target.value)}
                >
                  <option value="">未设置</option>
                  {(definition.valueType === "number"
                    ? definition.numberOptions ?? []
                    : definition.textOptions ?? []
                  ).map((value) => (
                    <option key={String(value)} value={String(value)}>
                      {String(value)}
                    </option>
                  ))}
                  {!(
                    definition.valueType === "number"
                      ? definition.numberOptions ?? []
                      : definition.textOptions ?? []
                  ).some(
                    (value) =>
                      String(value) === String(character.attrs[definition.key] ?? ""),
                  ) &&
                    character.attrs[definition.key] !== undefined && (
                      <option value={String(character.attrs[definition.key])}>
                        {String(character.attrs[definition.key])}（旧值）
                      </option>
                    )}
                </select>
              </label>
            ))}
          </div>
        </section>
        <section className="game-editor-section game-card">
          <label className="game-field">
            物品（顿号分隔）
            <input
              value={character.inventory}
              onChange={(e) => onChange({ ...character, inventory: e.target.value })}
            />
          </label>
        </section>
        <button type="button" className="primary-btn game-editor-save-btn" onClick={onBack}>
          完成角色编辑
        </button>
      </div>
    </div>
  );
}

function PipelineEditor({
  value,
  onChange,
  agents = [],
}: {
  value: GamePipeline;
  onChange: (next: GamePipeline) => void;
  agents?: Array<{ id: string; name: string; kind: string }>;
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
            <label className="game-pipeline-agent-select">
              执行 AI（可多选）
              <select
                multiple
                value={node.agentIds ?? []}
                onChange={(e) => {
                  const agentIds = Array.from(e.target.selectedOptions).map(
                    (option) => option.value,
                  );
                  setNodes(
                    value.nodes.map((n) =>
                      n.id === node.id ? { ...n, agentIds } : n,
                    ),
                  );
                }}
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>
            </label>
            <label className="game-pipeline-agent-select">
              目标 AI / 角色（可多选）
              <select
                multiple
                value={node.targetIds ?? []}
                onChange={(e) => {
                  const targetIds = Array.from(e.target.selectedOptions).map(
                    (option) => option.value,
                  );
                  setNodes(
                    value.nodes.map((n) =>
                      n.id === node.id ? { ...n, targetIds } : n,
                    ),
                  );
                }}
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>
            </label>
            <label>
              调度方式
              <select
                value={node.dispatchMode ?? "serial"}
                onChange={(e) =>
                  setNodes(
                    value.nodes.map((n) =>
                      n.id === node.id
                        ? {
                            ...n,
                            dispatchMode:
                              e.target.value === "parallel"
                                ? "parallel"
                                : "serial",
                          }
                        : n,
                    ),
                  )
                }
              >
                <option value="serial">依次处理</option>
                <option value="parallel">同时处理</option>
              </select>
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
                  kind: "agent",
                  label: PIPELINE_KIND_LABELS.agent,
                  agentIds: [],
                  targetIds: [],
                  dispatchMode: "parallel",
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

