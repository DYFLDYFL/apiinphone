import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
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
  worldSystemPrompt,
} from "../../lib/game/prompts";
import {
  AI_RUNTIME_PRESETS,
  CHAR_TEMPLATES,
  applyAiPreset,
  cloneTemplateDraft,
  DEFAULT_ATTRIBUTE_DEFINITIONS,
  GAME_TEMPLATE_PRESETS,
  AGENT_INFORMATION_PRESET_LABELS,
  defaultTemplateDraft,
  defaultContextFiles,
  daysInMonth,
  formatGameClock,
  formatGameDateTime,
  WEEKDAY_LABELS,
  inferAttributeDefinitions,
  informationAccessForAgent,
  informationPresetForAgent,
  normalizeGameDateTime,
  type CharTemplateDraft,
  type AgentInformationPreset,
  type GameAiPreset,
  type GameTemplateDraft,
  type GameTemplatePreset,
} from "../../lib/game/templates";
import {
  eventsVisibleTo,
  formatAttrLines,
  formatEventSummary,
} from "../../lib/game/mutations";
import { normalizeWorldMap, terrainNameAt } from "../../lib/game/map";
import {
  deleteSavedAiPreset,
  deleteSavedWorldPreset,
  loadSavedAiPresets,
  loadSavedWorldPresets,
  saveAiPreset,
  saveWorldPreset,
  type SavedAiPreset,
  type SavedWorldPreset,
} from "../../lib/game/presetStore";
import type {
  AgentModelOverride,
  AgentFeatureKey,
  GameAgent,
  GameAttributeDefinition,
  GameAttributePermission,
  GameDateTime,
  GameMapCell,
  GameEvent,
  GamePipeline,
  GameState,
  GameWorldMap,
  PipelineEdge,
  PipelineEdgeWhen,
  PipelineNode,
} from "../../lib/game/types";
import {
  defaultPipeline,
  newPipelineNodeId,
  PIPELINE_EDGE_WHENS,
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
import { WorldMapStepEditor } from "./WorldMapStep";

interface GameScreenProps {
  settings: AppSettings;
  onSettingsChange: (next: AppSettings) => void;
  onBack: () => void;
  onOpenSettings: () => void;
  onOpenInfo: () => void;
}

type LogTab = "timeline" | "story" | "playerStory";
type SidePanel = "collapsed" | "world" | "chars";
type WorldSetupStep = "basic" | "attributes" | "map";
type AiSetupStep = "agents" | "pipeline";


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

function syncDraftCharacterAgents(
  draft: GameTemplateDraft,
  characters = draft.characters,
): GameTemplateDraft {
  const existingByCharacterId = new Map(
    draft.agents
      .filter((agent) => Boolean(agent.characterId))
      .map((agent) => [agent.characterId as string, agent]),
  );
  const characterAgents = characters.map((character, index) => {
    const characterId = character.id ?? `character_${index}`;
    const existing = existingByCharacterId.get(characterId);
    const defaultAccess = informationAccessForAgent(
      "character",
      (draft.contextFiles ?? defaultContextFiles(draft.worldview, draft.initialTime)).map(
        (file) => file.id,
      ),
      (draft.attributeDefinitions ?? DEFAULT_ATTRIBUTE_DEFINITIONS).map(
        (definition) => definition.key,
      ),
      characterId,
    );
    return {
      id: existing?.id ?? `agent_${characterId}`,
      characterId,
      name: character.name,
      persona: character.persona,
      systemPrompt: existing?.systemPrompt,
      model: existing?.model,
      capabilities: [
        ...(existing?.capabilities ??
          character.capabilities ??
          ["propose", "respond"]),
      ],
      readableFileIds: existing?.readableFileIds ?? defaultAccess.readableFileIds,
      editableFileIds: existing?.editableFileIds ?? defaultAccess.editableFileIds,
      attributePermissions:
        existing?.attributePermissions ?? defaultAccess.attributePermissions,
    };
  });
  const baseContextFiles =
    draft.contextFiles ??
    defaultContextFiles(draft.worldview, draft.initialTime);
  const characterStoryFiles = characters.map((character, index) => {
    const characterId = character.id ?? `character_${index}`;
    return {
      id: `personal_story_${characterId}`,
      title: `${character.name || `角色 ${index + 1}`}的个人剧情`,
      content: "",
    };
  });
  return {
    ...draft,
    characters,
    contextFiles: [
      ...baseContextFiles.filter(
        (file) => !file.id.startsWith("personal_story_"),
      ),
      ...characterStoryFiles,
    ],
    agents: [
      ...draft.agents.filter((agent) => !agent.characterId),
      ...characterAgents,
    ],
  };
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
  const [draft, setDraft] = useState<GameTemplateDraft>(() =>
    defaultTemplateDraft(3),
  );
  const [savedWorldPresets, setSavedWorldPresets] = useState<SavedWorldPreset[]>(
    [],
  );
  const [savedAiPresets, setSavedAiPresets] = useState<SavedAiPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState("qing-shi");
  const [editingWorldPresetId, setEditingWorldPresetId] = useState<string>();
  const [editingWorldPresetSourceId, setEditingWorldPresetSourceId] =
    useState<string>();
  const [editingWorldPresetName, setEditingWorldPresetName] =
    useState("新世界预设");
  const [editingAiPresetId, setEditingAiPresetId] = useState<string>();
  const [editingAiPresetSourceId, setEditingAiPresetSourceId] =
    useState<string>();
  const [editingAiPresetName, setEditingAiPresetName] =
    useState("新 AI 逻辑预设");
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

  useEffect(() => {
    void Promise.all([loadSavedWorldPresets(), loadSavedAiPresets()]).then(
      ([worldPresets, aiPresets]) => {
        setSavedWorldPresets(worldPresets);
        setSavedAiPresets(aiPresets);
      },
    );
  }, []);

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
    return syncDraftCharacterAgents({
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
    });
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
      if (!a.capabilities.includes("world_open")) return a;
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
    setDraft(syncDraftCharacterAgents(draft, characters));
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

  const applyWorldPresetFields = (
    base: GameTemplateDraft,
    preset?: GameTemplatePreset,
  ): GameTemplateDraft => {
    const source = preset?.draft ?? defaultTemplateDraft(base.characters.length);
    return syncDraftCharacterAgents(
      {
        ...base,
        title: source.title,
        worldview: source.worldview,
        initialTime: source.initialTime,
        initialTimeParts: { ...source.initialTimeParts },
        weekCycleEnabled: Boolean(source.weekCycleEnabled),
        worldMap: source.worldMap
          ? normalizeWorldMap(source.worldMap)
          : undefined,
        contextFiles: source.contextFiles?.map((file) => ({ ...file })),
        attributeDefinitions: source.attributeDefinitions?.map((item) => ({
          ...item,
          textOptions: item.textOptions ? [...item.textOptions] : undefined,
        })),
      },
      base.characters,
    );
  };

  const applyAiDraft = (
    base: GameTemplateDraft,
    aiDraft: GameAiPreset["draft"],
  ): GameTemplateDraft =>
    syncDraftCharacterAgents({
      ...base,
      agents: aiDraft.agents.map((agent) => ({
        ...agent,
        capabilities: [...agent.capabilities],
        readableFileIds: agent.readableFileIds
          ? [...agent.readableFileIds]
          : undefined,
        editableFileIds: agent.editableFileIds
          ? [...agent.editableFileIds]
          : undefined,
        attributePermissions: agent.attributePermissions
          ? { ...agent.attributePermissions }
          : undefined,
      })),
      pipeline: cloneTemplateDraft({
        ...base,
        pipeline: aiDraft.pipeline,
      }).pipeline,
    });

  const startNewWorldPreset = () => {
    setDraft(defaultTemplateDraft(draft.characters.length));
    setEditingWorldPresetId(undefined);
    setEditingWorldPresetSourceId(undefined);
    setEditingWorldPresetName("新世界预设");
    setSelectedPresetId("custom-new-world");
    setWorldSetupStep("basic");
    setView("world-editor");
  };

  const editWorldPreset = (preset: GameTemplatePreset | SavedWorldPreset) => {
    setDraft((prev) => applyWorldPresetFields(prev, preset));
    setEditingWorldPresetId(
      "origin" in preset && preset.origin === "custom" ? preset.id : undefined,
    );
    setEditingWorldPresetSourceId(
      "origin" in preset && preset.origin === "custom"
        ? preset.sourcePresetId
        : preset.id,
    );
    setEditingWorldPresetName(preset.title);
    setSelectedPresetId(preset.id);
    setWorldSetupStep("basic");
    setView("world-editor");
  };

  const saveCurrentWorldPreset = async () => {
    const saved = await saveWorldPreset({
      id: editingWorldPresetId,
      title: editingWorldPresetName,
      draft,
      sourcePresetId: editingWorldPresetSourceId,
    });
    setSavedWorldPresets((prev) => [
      ...prev.filter((item) => item.id !== saved.id),
      saved,
    ]);
    setEditingWorldPresetId(saved.id);
    setEditingWorldPresetSourceId(saved.sourcePresetId);
    setSelectedPresetId(saved.id);
    setStatus("世界预设已保存");
  };

  const startNewAiPreset = () => {
    const base = defaultTemplateDraft(draft.characters.length);
    setDraft((prev) => applyAiDraft(prev, base.pipeline ? {
      agents: base.agents,
      pipeline: base.pipeline,
    } : { agents: base.agents, pipeline: defaultTemplateDraft(3).pipeline }));
    setEditingAiPresetId(undefined);
    setEditingAiPresetSourceId(undefined);
    setEditingAiPresetName("新 AI 逻辑预设");
    setSelectedAiPresetId("custom-new-ai");
    setAiSetupStep("agents");
    setView("ai-editor");
  };

  const editAiPreset = (preset: GameAiPreset | SavedAiPreset) => {
    setDraft((prev) => applyAiDraft(prev, preset.draft));
    setEditingAiPresetId(
      "origin" in preset && preset.origin === "custom" ? preset.id : undefined,
    );
    setEditingAiPresetSourceId(
      "origin" in preset && preset.origin === "custom"
        ? preset.sourcePresetId
        : preset.id,
    );
    setEditingAiPresetName(preset.title);
    setSelectedAiPresetId(preset.id);
    setAiSetupStep("agents");
    setView("ai-editor");
  };

  const saveCurrentAiPreset = async () => {
    const saved = await saveAiPreset({
      id: editingAiPresetId,
      title: editingAiPresetName,
      draft: {
        agents: draft.agents,
        pipeline: draft.pipeline ?? defaultTemplateDraft(draft.characters.length).pipeline!,
      },
      sourcePresetId: editingAiPresetSourceId,
    });
    setSavedAiPresets((prev) => [
      ...prev.filter((item) => item.id !== saved.id),
      saved,
    ]);
    setEditingAiPresetId(saved.id);
    setEditingAiPresetSourceId(saved.sourcePresetId);
    setSelectedAiPresetId(saved.id);
    setStatus("AI 逻辑预设已保存");
  };

  const removeSavedWorldPreset = async (id: string) => {
    await deleteSavedWorldPreset(id);
    setSavedWorldPresets((prev) => prev.filter((item) => item.id !== id));
  };

  const removeSavedAiPreset = async (id: string) => {
    await deleteSavedAiPreset(id);
    setSavedAiPresets((prev) => prev.filter((item) => item.id !== id));
  };

  const selectWorldPreset = (preset: GameTemplatePreset | SavedWorldPreset) => {
    const world = cloneTemplateDraft(preset.draft);
    const next: GameTemplateDraft = {
      ...draft,
      title: world.title,
      worldview: world.worldview,
      initialTime: world.initialTime,
      initialTimeParts: { ...world.initialTimeParts },
      weekCycleEnabled: Boolean(world.weekCycleEnabled),
      worldMap: world.worldMap
        ? normalizeWorldMap(world.worldMap)
        : undefined,
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
    setDraft(syncDraftCharacterAgents(next));
    setSelectedPresetId(preset.id);
    setSelectedAiPresetId("");
    setCharCountInput(String(next.characters.length));
    setAiChoiceBackView("template-choice");
    setView("ai-choice");
  };

  const confirmWorld = () => {
    setAiChoiceBackView("world-editor");
    setView("ai-choice");
  };

  const selectAiPreset = (preset: GameAiPreset | SavedAiPreset) => {
    setDraft((prev) => syncDraftCharacterAgents(applyAiPreset(prev, preset)));
    setSelectedAiPresetId(preset.id);
    setCharacterEntryView("ai-choice");
    setView("characters");
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
    setDraft(syncDraftCharacterAgents(draft, characters));
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
    setDraft(syncDraftCharacterAgents({
      ...draft,
      characters,
      playerCharacterIndex,
    }));
    setCharCountInput(String(characters.length));
  };

  if (view === "template-choice") {
    return (
      <TemplateChoiceScreen
        selectedPresetId={selectedPresetId}
        topActions={topActions}
        onBack={() => setView("lobby")}
        onSelectPreset={selectWorldPreset}
        onEditPreset={editWorldPreset}
        onNewPreset={startNewWorldPreset}
        savedPresets={savedWorldPresets}
        onDeleteSavedPreset={removeSavedWorldPreset}
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
        presetName={editingWorldPresetName}
        onPresetNameChange={setEditingWorldPresetName}
        onSavePreset={() => void saveCurrentWorldPreset()}
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
        onEditPreset={editAiPreset}
        onNewPreset={startNewAiPreset}
        savedPresets={savedAiPresets}
        onDeleteSavedPreset={removeSavedAiPreset}
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
        presetName={editingAiPresetName}
        onPresetNameChange={setEditingAiPresetName}
        onSavePreset={() => void saveCurrentAiPreset()}
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
                const mapCell = sheet.position
                  ? game.worldMap?.cells[
                      `${sheet.position.x},${sheet.position.y}`
                    ]
                  : undefined;
                const mapTerrain = sheet.position
                  ? terrainNameAt(game.worldMap, sheet.position)
                  : "";
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
                        {mapCell?.zoneName ||
                          (mapTerrain !== "未标注地形" ? mapTerrain : "") ||
                          (sheet.position
                            ? `坐标 ${sheet.position.x},${sheet.position.y}`
                            : "未定位")}{" "}
                        ·{" "}
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
                              {definition.valueType === "number" ? (
                                <input
                                  type="number"
                                  min={Number.MIN_SAFE_INTEGER}
                                  max={Number.MAX_SAFE_INTEGER}
                                  step="any"
                                  disabled={busy}
                                  defaultValue={String(sheet.attrs[definition.key] ?? "")}
                                  onBlur={(e) => {
                                    const raw = e.target.value.trim();
                                    const value = raw === "" ? "" : Number(raw);
                                    void saveCharacter(ch, {
                                      attrs: { [definition.key]: value },
                                    });
                                  }}
                                />
                              ) : (
                                <select
                                  disabled={busy}
                                  defaultValue={String(sheet.attrs[definition.key] ?? "")}
                                  onChange={(e) => {
                                    void saveCharacter(ch, {
                                      attrs: { [definition.key]: e.target.value },
                                    });
                                  }}
                                >
                                  <option value="">未设置</option>
                                  {(definition.textOptions ?? []).map((option) => (
                                    <option key={String(option)} value={String(option)}>
                                      {String(option)}
                                    </option>
                                  ))}
                                </select>
                              )}
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
  onEditPreset,
  onNewPreset,
  savedPresets,
  onDeleteSavedPreset,
}: {
  selectedPresetId: string;
  topActions: ReactNode;
  onBack: () => void;
  onSelectPreset: (preset: GameTemplatePreset | SavedWorldPreset) => void;
  onEditPreset: (preset: GameTemplatePreset | SavedWorldPreset) => void;
  onNewPreset: () => void;
  savedPresets: SavedWorldPreset[];
  onDeleteSavedPreset: (id: string) => void;
}) {
  const presets: Array<{
    preset: GameTemplatePreset | SavedWorldPreset;
    custom: boolean;
  }> = [
    ...GAME_TEMPLATE_PRESETS.map((preset) => ({ preset, custom: false })),
    ...savedPresets.map((preset) => ({ preset, custom: true })),
  ];
  return (
    <div className="game-screen game-editor-screen">
      <EditorHeader
        title="选择世界模板"
        subtitle="选择、编辑或新建世界预设后进入人物选择"
        topActions={topActions}
        onBack={onBack}
      />
      <div className="game-body game-editor-body">
        <section className="game-editor-section game-card">
          <div className="game-section-title">
            <h3>世界预设</h3>
            <span>内置预设和本地预设都可以使用或编辑</span>
          </div>
          <div className="game-preset-grid">
            {presets.map(({ preset, custom }) => (
              <article
                key={preset.id}
                className={
                  selectedPresetId === preset.id
                    ? "game-preset-card active"
                    : "game-preset-card"
                }
              >
                <span className="game-preset-genre">
                  {custom ? "我的预设" : preset.genre}
                </span>
                <strong>{preset.title}</strong>
                <span>{preset.description}</span>
                <div className="game-preset-card-actions">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => onSelectPreset(preset)}
                  >
                    使用
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => onEditPreset(preset)}
                  >
                    编辑
                  </button>
                  {custom ? (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => onDeleteSavedPreset(preset.id)}
                    >
                      删除
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
            <button
              type="button"
              className="game-preset-card game-preset-new-card"
              onClick={onNewPreset}
            >
              <strong>+ 新建世界预设</strong>
              <span>从默认世界开始编辑并保存为本地预设</span>
            </button>
          </div>
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
  onEditPreset,
  onNewPreset,
  savedPresets,
  onDeleteSavedPreset,
}: {
  selectedAiPresetId: string;
  topActions: ReactNode;
  onBack: () => void;
  onSelectPreset: (preset: GameAiPreset | SavedAiPreset) => void;
  onEditPreset: (preset: GameAiPreset | SavedAiPreset) => void;
  onNewPreset: () => void;
  savedPresets: SavedAiPreset[];
  onDeleteSavedPreset: (id: string) => void;
}) {
  const presets: Array<{
    preset: GameAiPreset | SavedAiPreset;
    custom: boolean;
  }> = [
    ...AI_RUNTIME_PRESETS.map((preset) => ({ preset, custom: false })),
    ...savedPresets.map((preset) => ({ preset, custom: true })),
  ];
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
            <h3>AI 逻辑预设</h3>
            <span>内置预设和本地预设都可以使用或编辑</span>
          </div>
          <div className="game-ai-preset-grid">
            {presets.map(({ preset, custom }) => (
              <article
                key={preset.id}
                className={
                  selectedAiPresetId === preset.id
                    ? "game-ai-preset-card active"
                    : "game-ai-preset-card"
                }
              >
                <span className="game-preset-genre">
                  {custom ? "我的预设" : preset.genre}
                </span>
                <strong>{preset.title}</strong>
                <span>{preset.description}</span>
                <div className="game-preset-card-actions">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => onSelectPreset(preset)}
                  >
                    使用
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => onEditPreset(preset)}
                  >
                    编辑
                  </button>
                  {custom ? (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => onDeleteSavedPreset(preset.id)}
                    >
                      删除
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
            <button
              type="button"
              className="game-ai-preset-card game-preset-new-card"
              onClick={onNewPreset}
            >
              <strong>+ 新建 AI 逻辑预设</strong>
              <span>从默认 AI 配置开始编辑并保存</span>
            </button>
          </div>
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
  presetName,
  onPresetNameChange,
  onSavePreset,
}: {
  draft: GameTemplateDraft;
  step: AiSetupStep;
  topActions: ReactNode;
  onBack: () => void;
  onChange: (draft: GameTemplateDraft) => void;
  onStepChange: (step: AiSetupStep) => void;
  onConfirm: () => void;
  presetName: string;
  onPresetNameChange: (value: string) => void;
  onSavePreset: () => void;
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
        <div className="game-preset-save-bar">
          <label className="game-field">
            AI 逻辑预设名称
            <input
              value={presetName}
              onChange={(event) => onPresetNameChange(event.target.value)}
            />
          </label>
          <button type="button" className="primary-btn" onClick={onSavePreset}>
            保存为本地预设
          </button>
        </div>
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
          <UnifiedAgentsStep draft={draft} onChange={onChange} />
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
  { id: "map", label: "世界地图" },
];

function WorldSetupScreen({
  draft,
  step,
  topActions,
  onBack,
  onChange,
  onStepChange,
  onConfirm,
  presetName,
  onPresetNameChange,
  onSavePreset,
}: {
  draft: GameTemplateDraft;
  step: WorldSetupStep;
  topActions: ReactNode;
  onBack: () => void;
  onChange: (draft: GameTemplateDraft) => void;
  onStepChange: (step: WorldSetupStep) => void;
  onConfirm: () => void;
  presetName: string;
  onPresetNameChange: (value: string) => void;
  onSavePreset: () => void;
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
        <div className="game-preset-save-bar">
          <label className="game-field">
            世界预设名称
            <input
              value={presetName}
              onChange={(event) => onPresetNameChange(event.target.value)}
            />
          </label>
          <button type="button" className="primary-btn" onClick={onSavePreset}>
            保存为本地预设
          </button>
        </div>
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
        {step === "map" ? (
          <WorldMapStepEditor draft={draft} onChange={onChange} />
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

/**
 * Kept as a source-compatible fallback for older integrations.
 * The active editor is WorldMapStepEditor.
 */
export function LegacyWorldMapStep({
  draft,
  onChange,
}: {
  draft: GameTemplateDraft;
  onChange: (draft: GameTemplateDraft) => void;
}) {
  const map = draft.worldMap ?? {
    terrainTypes: [],
    terrainRegions: [],
    cells: {},
  };
  const cells = Object.entries(map.cells)
    .map(([key, cell]) => ({ key, cell }))
    .sort((a, b) => a.cell.y - b.cell.y || a.cell.x - b.cell.x);
  const terrainTypes = Array.from(
    new Set(
      (map.terrainTypes ?? [])
        .map((terrain) =>
          typeof (terrain as unknown) === "string"
            ? String(terrain).trim()
            : terrain.displayName.trim(),
        )
        .filter(Boolean),
    ),
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [newX, setNewX] = useState("0");
  const [newY, setNewY] = useState("0");
  const [newTerrain, setNewTerrain] = useState("");
  const [terrainRenameDrafts, setTerrainRenameDrafts] = useState<
    Record<string, string>
  >({});
  const [mapNotice, setMapNotice] = useState("");
  const dragRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const hoverCloseTimer = useRef<number | undefined>(undefined);

  const GRID_SIZE = 76;
  const VIEWBOX_WIDTH = 800;
  const VIEWBOX_HEIGHT = 420;
  const TERRAIN_COLORS = [
    "#38bdf8",
    "#a78bfa",
    "#34d399",
    "#fbbf24",
    "#fb7185",
    "#f97316",
    "#2dd4bf",
  ];
  const clampZoom = (value: number) => Math.min(2.5, Math.max(0.45, value));
  const updateMap = (nextMap: unknown) =>
    onChange({ ...draft, worldMap: nextMap as GameWorldMap });
  const updateCells = (cellsByKey: Record<string, GameMapCell>) =>
    updateMap({
      terrainTypes: [...terrainTypes],
      terrainRegions: [...map.terrainRegions],
      cells: cellsByKey,
    });
  const parseProperties = (value: string): Record<string, string> =>
    Object.fromEntries(
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf("=");
          return index < 0
            ? [line, ""]
            : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
        }),
    );
  const propertiesText = (cell: GameMapCell) =>
    Object.entries(cell.properties ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
  const updateCell = (oldKey: string, patch: Partial<GameMapCell>) => {
    const current = map.cells[oldKey];
    if (!current) return;
    const cellsByKey = { ...map.cells };
    cellsByKey[oldKey] = {
      ...current,
      ...patch,
      properties: patch.properties
        ? { ...patch.properties }
        : { ...(current.properties ?? {}) },
      objects: patch.objects ? [...patch.objects] : [...current.objects],
    };
    updateCells(cellsByKey);
  };
  const selectedCell = selectedKey ? map.cells[selectedKey] : undefined;
  const popoverKey =
    hoveredKey && map.cells[hoveredKey] ? hoveredKey : null;
  const popoverCell = popoverKey ? map.cells[popoverKey] : undefined;
  const showPopover = (key: string) => {
    if (hoverCloseTimer.current !== undefined) {
      window.clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = undefined;
    }
    setHoveredKey(key);
  };
  const hidePopoverLater = (key: string) => {
    if (hoverCloseTimer.current !== undefined) {
      window.clearTimeout(hoverCloseTimer.current);
    }
    hoverCloseTimer.current = window.setTimeout(() => {
      setHoveredKey((current) => (current === key ? null : current));
    }, 220);
  };
  const selectCell = (key: string) => {
    setSelectedKey(key);
    setEditingKey(null);
    setMapNotice("");
  };
  const editCell = (key: string) => {
    setSelectedKey(key);
    setEditingKey(key);
    setMapNotice("");
  };
  const updateSelectedCell = (patch: Partial<GameMapCell>) => {
    if (selectedKey) updateCell(selectedKey, patch);
  };
  const removeSelectedCell = () => {
    if (!selectedKey) return;
    const cellsByKey = { ...map.cells };
    delete cellsByKey[selectedKey];
    updateCells(cellsByKey);
    setSelectedKey(null);
    setEditingKey(null);
    setHoveredKey(null);
  };
  const addEmptyCell = () => {
    const parsedX = Number(newX);
    const parsedY = Number(newY);
    if (!Number.isFinite(parsedX) || !Number.isFinite(parsedY)) {
      setMapNotice("请输入有效的整数坐标。");
      return;
    }
    const x = Math.round(parsedX);
    const y = Math.round(parsedY);
    const key = `${x},${y}`;
    if (map.cells[key]) {
      editCell(key);
      setMapNotice(`坐标（${x}, ${y}）已经存在，已选中它。`);
      return;
    }
    const cell: GameMapCell = {
      x,
      y,
      zoneName: "",
      terrain: "",
      properties: {},
      objects: [],
      passable: true,
    };
    updateCells({ ...map.cells, [key]: cell });
    setSelectedKey(key);
    setEditingKey(key);
    setMapNotice("");
  };
  const addTerrainType = () => {
    const terrain = newTerrain.trim();
    if (!terrain) {
      setMapNotice("请输入地形名称。");
      return;
    }
    if (terrainTypes.includes(terrain)) {
      setMapNotice(`地形「${terrain}」已经存在。`);
      return;
    }
    updateMap({
      terrainTypes: [...terrainTypes, terrain],
      cells: { ...map.cells },
    });
    setNewTerrain("");
    setMapNotice("");
  };
  const renameTerrain = (terrain: string) => {
    const nextTerrain = (terrainRenameDrafts[terrain] ?? terrain).trim();
    if (!nextTerrain) {
      setMapNotice("地形名称不能为空。");
      return;
    }
    if (nextTerrain === terrain) return;
    if (terrainTypes.some((item) => item !== terrain && item === nextTerrain)) {
      setMapNotice(`地形「${nextTerrain}」已经存在，不能重名。`);
      return;
    }
    const usageCount = cells.filter(
      ({ cell }) => cell.terrain === terrain,
    ).length;
    if (
      usageCount > 0 &&
      !window.confirm(
        `有 ${usageCount} 个坐标使用「${terrain}」。重命名后将同步替换这些坐标，继续吗？`,
      )
    ) {
      return;
    }
    const cellsByKey = { ...map.cells };
    Object.entries(cellsByKey).forEach(([key, cell]) => {
      if (cell.terrain === terrain) {
        cellsByKey[key] = { ...cell, terrain: nextTerrain };
      }
    });
    updateMap({
      terrainTypes: terrainTypes.map((item) =>
        item === terrain ? nextTerrain : item,
      ),
      cells: cellsByKey,
    });
    setTerrainRenameDrafts((current) => {
      const next = { ...current };
      delete next[terrain];
      next[nextTerrain] = nextTerrain;
      return next;
    });
    setMapNotice("");
  };
  const deleteTerrain = (terrain: string) => {
    const usageCount = cells.filter(
      ({ cell }) => cell.terrain === terrain,
    ).length;
    const replacement = terrainTypes.find((item) => item !== terrain);
    const warning =
      usageCount > 0
        ? replacement
          ? `有 ${usageCount} 个坐标使用「${terrain}」。删除后将替换为「${replacement}」，继续吗？`
          : `有 ${usageCount} 个坐标使用「${terrain}」。删除后这些坐标的地形会清空，继续吗？`
        : `确定删除地形「${terrain}」吗？`;
    if (!window.confirm(warning)) return;
    const cellsByKey = { ...map.cells };
    if (usageCount > 0) {
      Object.entries(cellsByKey).forEach(([key, cell]) => {
        if (cell.terrain === terrain) {
          cellsByKey[key] = { ...cell, terrain: replacement ?? "" };
        }
      });
    }
    updateMap({
      terrainTypes: terrainTypes.filter((item) => item !== terrain),
      cells: cellsByKey,
    });
    setTerrainRenameDrafts((current) => {
      const next = { ...current };
      delete next[terrain];
      return next;
    });
    setMapNotice("");
  };
  const mapBounds = cells.length
    ? cells.reduce(
        (bounds, { cell }) => ({
          minX: Math.min(bounds.minX, cell.x),
          maxX: Math.max(bounds.maxX, cell.x),
          minY: Math.min(bounds.minY, cell.y),
          maxY: Math.max(bounds.maxY, cell.y),
        }),
        {
          minX: cells[0].cell.x,
          maxX: cells[0].cell.x,
          minY: cells[0].cell.y,
          maxY: cells[0].cell.y,
        },
      )
    : { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  const mapCenterX = (mapBounds.minX + mapBounds.maxX) / 2;
  const mapCenterY = (mapBounds.minY + mapBounds.maxY) / 2;
  const viewTransform = `translate(${VIEWBOX_WIDTH / 2 + pan.x} ${
    VIEWBOX_HEIGHT / 2 + pan.y
  }) scale(${zoom}) translate(${-mapCenterX * GRID_SIZE} ${
    -mapCenterY * GRID_SIZE
  })`;
  const terrainColor = (terrain: string | undefined) => {
    const index = terrain ? terrainTypes.indexOf(terrain) : -1;
    return index >= 0
      ? TERRAIN_COLORS[index % TERRAIN_COLORS.length]
      : "#94a3b8";
  };
  const handleMapPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handleMapPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const xScale = VIEWBOX_WIDTH / Math.max(bounds.width, 1);
    const yScale = VIEWBOX_HEIGHT / Math.max(bounds.height, 1);
    setPan({
      x: drag.panX + (event.clientX - drag.clientX) * xScale,
      y: drag.panY + (event.clientY - drag.clientY) * yScale,
    });
  };
  const handleMapPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };
  const handleMapWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    setZoom((current) =>
      clampZoom(current * (event.deltaY < 0 ? 1.12 : 0.88)),
    );
  };
  const selectedTerrainOptions =
    selectedCell?.terrain && !terrainTypes.includes(selectedCell.terrain)
      ? [selectedCell.terrain, ...terrainTypes]
      : terrainTypes;
  return (
    <section className="game-editor-section game-card game-map-editor-card">
      <div className="game-map-editor-header">
        <div className="game-section-title">
          <h3>世界地图</h3>
          <span>只保存有内容的坐标格，拖动空白处浏览稀疏地图</span>
        </div>
        <button
          type="button"
          className="game-map-collapse-btn"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((current) => !current)}
        >
          {collapsed ? "展开" : "收起"}
        </button>
      </div>
      {!collapsed ? (
        <div className="game-map-editor-body">
          <div className="game-map-toolbar">
            <div className="game-map-zoom-controls" aria-label="地图缩放">
              <button
                type="button"
                className="game-map-control-btn"
                aria-label="缩小地图"
                onClick={() => setZoom((current) => clampZoom(current * 0.82))}
              >
                −
              </button>
              <span className="game-map-zoom-label">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                className="game-map-control-btn"
                aria-label="放大地图"
                onClick={() => setZoom((current) => clampZoom(current * 1.22))}
              >
                +
              </button>
              <button
                type="button"
                className="game-map-reset-btn"
                onClick={() => {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
              >
                重置视图
              </button>
            </div>
            <span className="game-map-toolbar-meta">
              {cells.length} 个坐标 · {terrainTypes.length} 种地形
            </span>
          </div>

          <div className="game-map-viewport">
            <svg
              className="game-map-svg"
              viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
              role="img"
              aria-label="可缩放、可平移的世界地图"
              onPointerDown={handleMapPointerDown}
              onPointerMove={handleMapPointerMove}
              onPointerUp={handleMapPointerUp}
              onPointerCancel={handleMapPointerUp}
              onWheel={handleMapWheel}
            >
              <defs>
                <pattern
                  id="game-map-grid-pattern"
                  width={GRID_SIZE}
                  height={GRID_SIZE}
                  patternUnits="userSpaceOnUse"
                >
                  <path
                    d={`M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}`}
                    fill="none"
                    className="game-map-grid-line"
                  />
                </pattern>
              </defs>
              <g transform={viewTransform}>
                <rect
                  x={-10000}
                  y={-10000}
                  width={20000}
                  height={20000}
                  className="game-map-canvas-backdrop"
                  fill="url(#game-map-grid-pattern)"
                />
                <line
                  x1={-10000}
                  y1={0}
                  x2={10000}
                  y2={0}
                  className="game-map-axis"
                />
                <line
                  x1={0}
                  y1={-10000}
                  x2={0}
                  y2={10000}
                  className="game-map-axis"
                />
                {cells.map(({ key, cell }) => {
                  const nodeTitle =
                    cell.zoneName?.trim() || `坐标（${cell.x}, ${cell.y}）`;
                  const isSelected = selectedKey === key;
                  return (
                    <g
                      key={key}
                      className={
                        isSelected
                          ? "game-map-node selected"
                          : "game-map-node"
                      }
                      data-map-node="true"
                      role="button"
                      tabIndex={0}
                      aria-label={`${nodeTitle}，坐标 ${cell.x}, ${cell.y}`}
                      transform={`translate(${cell.x * GRID_SIZE} ${
                        cell.y * GRID_SIZE
                      })`}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        selectCell(key);
                      }}
                      onClick={() => selectCell(key)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectCell(key);
                        }
                      }}
                      onMouseEnter={() => showPopover(key)}
                      onMouseLeave={() => hidePopoverLater(key)}
                      onFocus={() => showPopover(key)}
                      onBlur={() => hidePopoverLater(key)}
                    >
                      <title>
                        {nodeTitle} · （{cell.x}, {cell.y}） ·{" "}
                        {cell.terrain || "未设置地形"}
                      </title>
                      <rect
                        x={-31}
                        y={-25}
                        width={62}
                        height={50}
                        rx={14}
                        className="game-map-node-card"
                        fill={terrainColor(cell.terrain)}
                      />
                      <circle
                        cx={-20}
                        cy={-14}
                        r={4}
                        className={
                          cell.passable === false
                            ? "game-map-node-status blocked"
                            : "game-map-node-status"
                        }
                      />
                      <text
                        x={0}
                        y={1}
                        textAnchor="middle"
                        className="game-map-node-label"
                        pointerEvents="none"
                      >
                        {nodeTitle.slice(0, 10)}
                      </text>
                      <text
                        x={0}
                        y={15}
                        textAnchor="middle"
                        className="game-map-node-terrain"
                        pointerEvents="none"
                      >
                        {(cell.terrain || "未设地形").slice(0, 9)}
                      </text>
                      <text
                        x={0}
                        y={42}
                        textAnchor="middle"
                        className="game-map-node-coordinate"
                        pointerEvents="none"
                      >
                        {cell.x}, {cell.y}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
            {cells.length === 0 ? (
              <div className="game-map-empty">
                <strong>还没有地图坐标</strong>
                <span>在下方添加一个空坐标，再为它填写区域资料。</span>
              </div>
            ) : null}
            {popoverCell && popoverKey ? (
              <div
                className="game-map-popover"
                role="dialog"
                aria-label="地图坐标信息"
                onMouseEnter={() => showPopover(popoverKey)}
                onMouseLeave={() => hidePopoverLater(popoverKey)}
                onFocus={() => showPopover(popoverKey)}
                onBlur={() => hidePopoverLater(popoverKey)}
              >
                <div className="game-map-popover-heading">
                  <strong>
                    {popoverCell.zoneName?.trim() ||
                      `坐标（${popoverCell.x}, ${popoverCell.y}）`}
                  </strong>
                  <span>
                    {popoverCell.x}, {popoverCell.y}
                  </span>
                </div>
                <p>
                  {popoverCell.terrain || "未设置地形"} ·{" "}
                  {popoverCell.passable === false ? "不可通行" : "可通行"}
                </p>
                <p>
                  {popoverCell.objects.length} 个物件 ·{" "}
                  {Object.keys(popoverCell.properties).length} 项属性
                </p>
                <div className="game-map-popover-actions">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => selectCell(popoverKey)}
                  >
                    查看
                  </button>
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={() => {
                      editCell(popoverKey);
                      setHoveredKey(null);
                    }}
                  >
                    编辑
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <p className="game-map-help">
            拖动空白处平移 · 滚轮或「− / +」缩放 · 点击或触摸节点选中 ·
            Tab 后可用 Enter 查看
          </p>

          <form
            className="game-map-add-coordinate"
            onSubmit={(event) => {
              event.preventDefault();
              addEmptyCell();
            }}
          >
            <label className="game-field">
              X
              <input
                type="number"
                step={1}
                value={newX}
                onChange={(event) => setNewX(event.target.value)}
              />
            </label>
            <label className="game-field">
              Y
              <input
                type="number"
                step={1}
                value={newY}
                onChange={(event) => setNewY(event.target.value)}
              />
            </label>
            <button type="submit" className="secondary-btn">
              添加空坐标
            </button>
          </form>

          {selectedCell && selectedKey ? (
            <div className="game-map-selection-card">
              <div className="game-map-selection-header">
                <div>
                  <h4>
                    {selectedCell.zoneName?.trim() || "未命名区域"}
                  </h4>
                  <span>
                    坐标（{selectedCell.x}, {selectedCell.y}）
                  </span>
                </div>
                <span
                  className={
                    selectedCell.passable === false
                      ? "game-map-passability blocked"
                      : "game-map-passability"
                  }
                >
                  {selectedCell.passable === false ? "不可通行" : "可通行"}
                </span>
              </div>
              {editingKey === selectedKey ? (
                <div className="game-map-selected-editor">
                  <div className="game-map-editor-fields">
                    <label className="game-field">
                      区域名称
                      <input
                        value={selectedCell.zoneName ?? ""}
                        placeholder="例如：北门集市"
                        onChange={(event) =>
                          updateSelectedCell({ zoneName: event.target.value })
                        }
                      />
                    </label>
                    <label className="game-field">
                      地形
                      <select
                        value={selectedCell.terrain ?? ""}
                        onChange={(event) =>
                          updateSelectedCell({ terrain: event.target.value })
                        }
                      >
                        <option value="">未设置地形</option>
                        {selectedTerrainOptions.map((terrain) => (
                          <option value={terrain} key={terrain}>
                            {terrainTypes.includes(terrain)
                              ? terrain
                              : `遗留地形：${terrain}`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="game-field game-map-editor-wide">
                      区域属性（每行一个 key=value）
                      <textarea
                        rows={3}
                        value={propertiesText(selectedCell)}
                        placeholder={"危险等级=2\n所属势力=北境"}
                        onChange={(event) =>
                          updateSelectedCell({
                            properties: parseProperties(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label className="game-field game-map-editor-wide">
                      存在物件（逗号分隔）
                      <input
                        value={selectedCell.objects.join("、")}
                        placeholder="例如：水井、告示牌"
                        onChange={(event) =>
                          updateSelectedCell({
                            objects: event.target.value
                              .split(/[,，、]/)
                              .map((item) => item.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                  </div>
                  <label className="checkbox game-map-passable-toggle">
                    <input
                      type="checkbox"
                      checked={selectedCell.passable !== false}
                      onChange={(event) =>
                        updateSelectedCell({
                          passable: event.target.checked,
                        })
                      }
                    />
                    可通行
                  </label>
                  <div className="game-map-selection-actions">
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => setEditingKey(null)}
                    >
                      完成编辑
                    </button>
                    <button
                      type="button"
                      className="link-btn game-map-delete-btn"
                      onClick={removeSelectedCell}
                    >
                      删除此坐标
                    </button>
                  </div>
                </div>
              ) : (
                <div className="game-map-selection-summary">
                  <p>
                    {selectedCell.terrain || "未设置地形"} ·{" "}
                    {selectedCell.objects.length} 个物件 ·{" "}
                    {Object.keys(selectedCell.properties).length} 项属性
                  </p>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => setEditingKey(selectedKey)}
                  >
                    编辑所选坐标
                  </button>
                </div>
              )}
            </div>
          ) : (
            <p className="game-map-no-selection">
              选择一个地图节点后，可查看详情或编辑区域资料。
            </p>
          )}

          <div className="game-map-terrain-manager">
            <div className="game-map-subsection-heading">
              <div>
                <h4>地形类型</h4>
                <span>节点颜色来自这里；删除使用中的地形前会要求替换或清空。</span>
              </div>
              <span>{terrainTypes.length} 种</span>
            </div>
            {terrainTypes.length > 0 ? (
              <div className="game-map-terrain-list">
                {terrainTypes.map((terrain) => {
                  const usageCount = cells.filter(
                    ({ cell }) => cell.terrain === terrain,
                  ).length;
                  return (
                    <div className="game-map-terrain-row" key={terrain}>
                      <input
                        aria-label={`地形${terrain}的新名称`}
                        value={terrainRenameDrafts[terrain] ?? terrain}
                        onChange={(event) =>
                          setTerrainRenameDrafts((current) => ({
                            ...current,
                            [terrain]: event.target.value,
                          }))
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            renameTerrain(terrain);
                          }
                        }}
                      />
                      <span className="game-map-terrain-usage">
                        {usageCount} 格
                      </span>
                      <div className="game-map-terrain-actions">
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => renameTerrain(terrain)}
                        >
                          重命名
                        </button>
                        <button
                          type="button"
                          className="link-btn game-map-delete-btn"
                          onClick={() => deleteTerrain(terrain)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="game-map-no-selection">还没有地形类型。</p>
            )}
            <form
              className="game-map-terrain-add"
              onSubmit={(event) => {
                event.preventDefault();
                addTerrainType();
              }}
            >
              <input
                value={newTerrain}
                placeholder="新增地形，例如：林地"
                aria-label="新增地形名称"
                onChange={(event) => setNewTerrain(event.target.value)}
              />
              <button type="submit" className="secondary-btn">
                添加地形
              </button>
            </form>
          </div>
          {mapNotice ? (
            <p className="game-map-notice" role="status">
              {mapNotice}
            </p>
          ) : null}
        </div>
      ) : null}
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
  const weekCycleEnabled = Boolean(draft.weekCycleEnabled);
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
  const dayCount = daysInMonth(current.era, current.year, current.month);
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
      <label className="checkbox">
        <input
          type="checkbox"
          checked={weekCycleEnabled}
          onChange={(event) =>
            onChange({
              ...draft,
              weekCycleEnabled: event.target.checked,
              initialTimeParts: {
                ...current,
                weekday: current.weekday ?? 1,
              },
              initialTime: formatGameDateTime(current),
            })
          }
        />
        启用 7 日循环计时表
      </label>
      {weekCycleEnabled ? (
        <label className="game-field">
          星期
          <select
            value={current.weekday ?? 1}
            onChange={(event) =>
              update({ weekday: Number(event.target.value) as GameDateTime["weekday"] })
            }
          >
            {options(1, 7).map((value) => (
              <option key={value} value={value}>
                {WEEKDAY_LABELS[value as keyof typeof WEEKDAY_LABELS]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="game-time-select-grid">
        <label className="game-field">
          纪元
          <select
            value={current.era}
            onChange={(e) =>
              update({ era: e.target.value === "BCE" ? "BCE" : "CE" })
            }
          >
            <option value="CE">公元</option>
            <option value="BCE">公元前</option>
          </select>
        </label>
        <label className="game-field">
          年
          <input
            type="number"
            min={1}
            max={99999}
            step={1}
            value={current.year}
            onChange={(e) => update({ year: Number(e.target.value) })}
          />
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
            {options(1, dayCount).map((value) => (
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
      <p className="settings-hint">
        最终保存为：{formatGameClock(current, weekCycleEnabled)}
      </p>
    </div>
  );
}

function AttributeOptionsEditor({
  valueType,
  options,
  onChange,
}: {
  valueType: GameAttributeDefinition["valueType"];
  options: Array<string | number>;
  onChange: (options: string[] | number[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const updateAt = (index: number, raw: string) => {
    if (valueType === "number") {
      if (!raw.trim()) return;
      const number = Math.max(-10000, Math.min(10000, Math.round(Number(raw))));
      if (!Number.isFinite(number)) return;
      onChange(options.map((item, itemIndex) => itemIndex === index ? number : item) as number[]);
      return;
    }
    if (raw.trim()) {
      onChange(options.map((item, itemIndex) => itemIndex === index ? raw.trim() : item) as string[]);
    }
  };
  const addOption = () => {
    if (!draft.trim()) return;
    if (valueType === "number") {
      const number = Math.max(-10000, Math.min(10000, Math.round(Number(draft))));
      if (!Number.isFinite(number)) return;
      if (!options.some((item) => Number(item) === number)) {
        onChange([...options, number] as number[]);
      }
    } else if (!options.includes(draft.trim())) {
      onChange([...options, draft.trim()] as string[]);
    }
    setDraft("");
  };
  return (
    <div className="game-attribute-options">
      <div className="game-attribute-option-chips">
        {options.map((option, index) => (
          <div className="game-attribute-option-chip" key={`${String(option)}-${index}`}>
            <input
              type={valueType === "number" ? "number" : "text"}
              min={valueType === "number" ? -10000 : undefined}
              max={valueType === "number" ? 10000 : undefined}
              value={String(option)}
              onChange={(e) => updateAt(index, e.target.value)}
              aria-label={`选项 ${index + 1}`}
            />
            <button
              type="button"
              className="game-attribute-option-remove"
              onClick={() => onChange(options.filter((_, itemIndex) => itemIndex !== index) as string[] | number[])}
              aria-label="删除选项"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="game-attribute-option-add">
        <input
          type={valueType === "number" ? "number" : "text"}
          min={valueType === "number" ? -10000 : undefined}
          max={valueType === "number" ? 10000 : undefined}
          value={draft}
          placeholder={valueType === "number" ? "-10000 至 10000" : "输入一个文字选项"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addOption();
            }
          }}
        />
        <button type="button" className="secondary-btn" onClick={addOption}>
          添加选项
        </button>
      </div>
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
                          numberOptions: undefined,
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
            {definition.valueType === "text" ? (
              <AttributeOptionsEditor
                valueType="text"
                options={definition.textOptions ?? []}
                onChange={(options) =>
                  setDefinitions(
                    definitions.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, textOptions: options as string[] }
                        : item,
                    ),
                  )
                }
              />
            ) : (
              <p className="game-attribute-number-hint">
                数值在人物编辑和游戏中填写，可输入任意安全范围内的数字
              </p>
            )}
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
              numberOptions: undefined,
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
  attributeDefinitions = [],
  attributePermissions = {},
  onAttributePermissionsChange,
}: {
  model?: AgentModelOverride;
  onModelChange: (model?: AgentModelOverride) => void;
  readableFileIds?: string[];
  editableFileIds?: string[];
  onAccessChange: (readableFileIds: string[], editableFileIds: string[]) => void;
  disabledFeatures?: AgentFeatureKey[];
  onDisabledFeaturesChange: (features: AgentFeatureKey[]) => void;
  files: Array<{ id: string; title: string }>;
  attributeDefinitions?: GameAttributeDefinition[];
  attributePermissions?: Record<string, GameAttributePermission>;
  onAttributePermissionsChange?: (
    permissions: Record<string, GameAttributePermission>,
  ) => void;
}) {
  const readable = new Set(readableFileIds ?? files.map((file) => file.id));
  const editable = new Set(editableFileIds ?? []);
  const features: Array<{ id: AgentFeatureKey; label: string }> = [
    { id: "world_open", label: "世界开场" },
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
      {attributeDefinitions.length ? (
        <div className="game-agent-attributes">
          <div className="game-agent-files-title">属性权限（按属性控制增删改）</div>
          <div className="game-agent-attribute-grid">
            {attributeDefinitions.map((definition) => {
              const permission = attributePermissions[definition.key] ?? {};
              const update = (operation: keyof GameAttributePermission) => {
                const next = { ...permission, [operation]: !permission[operation] };
                onAttributePermissionsChange?.({
                  ...attributePermissions,
                  [definition.key]: next,
                });
              };
              return (
                <div className="game-agent-attribute-row" key={definition.key}>
                  <span>{definition.label}</span>
                  {(["read", "set", "add", "remove"] as const).map((operation) => (
                    <label key={operation}>
                      <input
                        type="checkbox"
                        checked={Boolean(permission[operation])}
                        onChange={() => update(operation)}
                      />
                      {operation === "read"
                        ? "看"
                        : operation === "set"
                          ? "改"
                          : operation === "add"
                            ? "增"
                            : "删"}
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function UnifiedAgentsStep({
  draft,
  onChange,
}: {
  draft: GameTemplateDraft;
  onChange: (draft: GameTemplateDraft) => void;
}) {
  const [openAgentIds, setOpenAgentIds] = useState<Set<string>>(
    () => new Set(draft.agents.slice(0, 1).map((agent) => agent.id)),
  );
  const files = (draft.contextFiles ?? defaultContextFiles(draft.worldview, draft.initialTime))
    .map(({ id, title }) => ({ id, title }));
  const definitions = attributeDefinitionsForDraft(draft);
  const allFeatures: AgentFeatureKey[] = [
    "world_open",
    "propose",
    "respond",
    "judge",
    "chronicle",
    "advance_clock",
  ];
  const updateAgent = (
    index: number,
    patch: Partial<GameTemplateDraft["agents"][number]>,
  ) => {
    const current = draft.agents[index];
    const nextAgents = draft.agents.map((agent, itemIndex) =>
      itemIndex === index ? { ...agent, ...patch } : agent,
    );
    const nextCharacters = current?.characterId
      ? draft.characters.map((character) =>
          character.id === current.characterId
            ? {
                ...character,
                name:
                  typeof patch.name === "string"
                    ? patch.name
                    : character.name,
                persona:
                  typeof patch.persona === "string"
                    ? patch.persona
                    : character.persona,
              }
            : character,
        )
      : draft.characters;
    onChange({
      ...draft,
      agents: nextAgents,
      characters: nextCharacters,
    });
  };
  const addAgent = () =>
    onChange({
      ...draft,
      agents: [
        ...draft.agents,
        {
          id: `agent_${Math.random().toString(36).slice(2, 8)}`,
          name: `新 AI ${draft.agents.length + 1}`,
          persona: "",
          capabilities: ["respond"],
        },
      ],
    });
  return (
    <section className="game-editor-section game-card">
      <div className="game-section-title">
        <h3>统一 AI 列表</h3>
        <span>每个 AI 都可承担一个或多个职责，也可以全部删除后重新添加</span>
      </div>
      <div className="game-agent-card-list">
        {draft.agents.map((agent, index) => {
          const disabled = allFeatures.filter((feature) => !agent.capabilities.includes(feature));
          const applyInformationPreset = (preset: AgentInformationPreset) => {
            updateAgent(
              index,
              informationAccessForAgent(
                preset,
                files.map((file) => file.id),
                definitions.map((definition) => definition.key),
                agent.characterId,
              ),
            );
          };
          return (
            <details
              className="game-agent-card"
              key={agent.id}
              open={openAgentIds.has(agent.id)}
              onToggle={(event) => {
                const open = event.currentTarget.open;
                setOpenAgentIds((previous) => {
                  const next = new Set(previous);
                  if (open) next.add(agent.id);
                  else next.delete(agent.id);
                  return next;
                });
              }}
            >
              <summary className="game-agent-card-summary">
                <div className="game-agent-card-heading">
                <button
                  type="button"
                  className="game-collapse-toggle"
                  aria-label={openAgentIds.has(agent.id) ? "收起 AI" : "展开 AI"}
                  aria-expanded={openAgentIds.has(agent.id)}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpenAgentIds((previous) => {
                      const next = new Set(previous);
                      if (next.has(agent.id)) next.delete(agent.id);
                      else next.add(agent.id);
                      return next;
                    });
                  }}
                >
                  {openAgentIds.has(agent.id) ? "⌄" : "›"}
                </button>
                <input
                  className="game-agent-card-title"
                  value={agent.name}
                  placeholder={`AI ${index + 1}`}
                  aria-label={`AI ${index + 1} 名称`}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) =>
                    updateAgent(index, { name: event.target.value })
                  }
                />
                <button
                  type="button"
                  className="link-btn"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onChange({
                      ...draft,
                      agents: draft.agents.filter(
                        (_, itemIndex) => itemIndex !== index,
                      ),
                    });
                  }}
                >
                  删除
                </button>
                </div>
              </summary>
              <div className="game-agent-card-body">
              <label className="game-field">
                人设
                <textarea
                  rows={3}
                  value={agent.persona}
                  onChange={(e) => updateAgent(index, { persona: e.target.value })}
                />
              </label>
              <label className="game-field">
                专属提示词（空=按能力生成）
                <textarea
                  rows={3}
                  value={agent.systemPrompt ?? ""}
                  onChange={(e) => updateAgent(index, { systemPrompt: e.target.value })}
                />
              </label>
              <div className="game-information-preset-row">
                <label className="game-field">
                  信息差预设
                  <select
                    defaultValue=""
                    onChange={(event) => {
                      if (!event.target.value) return;
                      applyInformationPreset(
                        event.target.value as AgentInformationPreset,
                      );
                      event.currentTarget.value = "";
                    }}
                  >
                    <option value="">选择预设并应用</option>
                    {Object.entries(AGENT_INFORMATION_PRESET_LABELS).map(
                      ([preset, label]) => (
                        <option key={preset} value={preset}>
                          {label}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() =>
                    applyInformationPreset(informationPresetForAgent(agent))
                  }
                >
                  恢复角色默认权限
                </button>
              </div>
              <AgentConfigEditor
                model={agent.model}
                onModelChange={(model) => updateAgent(index, { model })}
                readableFileIds={agent.readableFileIds}
                editableFileIds={agent.editableFileIds}
                onAccessChange={(readableFileIds, editableFileIds) =>
                  updateAgent(index, { readableFileIds, editableFileIds })
                }
                disabledFeatures={disabled}
                onDisabledFeaturesChange={(nextDisabled) =>
                  updateAgent(index, {
                    capabilities: allFeatures.filter((feature) => !nextDisabled.includes(feature)),
                  })
                }
                attributeDefinitions={definitions}
                attributePermissions={agent.attributePermissions}
                onAttributePermissionsChange={(attributePermissions) =>
                  updateAgent(index, { attributePermissions })
                }
                files={files}
              />
              </div>
            </details>
          );
        })}
      </div>
      <button type="button" className="secondary-btn" onClick={addAgent}>
        添加 AI
      </button>
    </section>
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
        节点标题可直接编辑，实际执行由绑定 AI 的能力和执行能力配置决定。
      </p>
      <PipelineEditor
        value={draft.pipeline ?? defaultPipeline()}
        onChange={(pipeline) => onChange({ ...draft, pipeline })}
        agents={[
          ...draft.agents.map((agent) => ({
            id: agent.id,
            name: agent.name || agent.id,
            kind: "agent",
            capabilities: agent.capabilities,
          })),
        ]}
      />
    </section>
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
  const mapCells = Object.values(draft.worldMap?.cells ?? {}).sort(
    (a, b) => a.y - b.y || a.x - b.x,
  );
  const characterFeatures: AgentFeatureKey[] = ["propose", "respond"];
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
            初始地图位置
            <select
              value={
                character.position
                  ? `${character.position.x},${character.position.y}`
                  : ""
              }
              onChange={(event) => {
                const [x, y] = event.target.value.split(",").map(Number);
                onChange({
                  ...character,
                  position: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined,
                });
              }}
            >
              <option value="">未定位</option>
              {mapCells.map((cell) => (
                <option key={`${cell.x},${cell.y}`} value={`${cell.x},${cell.y}`}>
                  [{cell.x},{cell.y}] {cell.zoneName || "未命名区域"}
                </option>
              ))}
            </select>
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
            disabledFeatures={characterFeatures.filter(
              (feature) => !(character.capabilities ?? characterFeatures).includes(feature),
            )}
            onDisabledFeaturesChange={(disabledFeatures) =>
              onChange({
                ...character,
                capabilities: characterFeatures.filter(
                  (feature) => !disabledFeatures.includes(feature),
                ),
              })
            }
            attributeDefinitions={definitions}
            attributePermissions={character.attributePermissions}
            onAttributePermissionsChange={(attributePermissions) =>
              onChange({ ...character, attributePermissions })
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
                {definition.valueType === "number" ? (
                  <input
                    type="number"
                    min={Number.MIN_SAFE_INTEGER}
                    max={Number.MAX_SAFE_INTEGER}
                    step="any"
                    value={String(character.attrs[definition.key] ?? "")}
                    onChange={(e) => setAttr(definition, e.target.value)}
                  />
                ) : (
                  <select
                    value={String(character.attrs[definition.key] ?? "")}
                    onChange={(e) => setAttr(definition, e.target.value)}
                  >
                    <option value="">未设置</option>
                    {(definition.textOptions ?? []).map((value) => (
                      <option key={String(value)} value={String(value)}>
                        {String(value)}
                      </option>
                    ))}
                  </select>
                )}
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
  agents?: Array<{
    id: string;
    name: string;
    kind: string;
    capabilities?: AgentFeatureKey[];
  }>;
}) {
  const validation = validatePipeline(value);
  const [openNodeIds, setOpenNodeIds] = useState<Set<string>>(
    () => new Set(),
  );
  const setNodes = (nodes: PipelineNode[]) => onChange({ ...value, nodes });
  const setEdges = (edges: PipelineEdge[]) => onChange({ ...value, edges });
  const capabilityLabels: Array<{ id: AgentFeatureKey; label: string }> = [
    { id: "world_open", label: "世界开场" },
    { id: "propose", label: "提案" },
    { id: "respond", label: "回应" },
    { id: "judge", label: "裁判" },
    { id: "chronicle", label: "整理剧情" },
    { id: "advance_clock", label: "拨钟" },
  ];

  return (
    <div className="game-pipeline-editor">
      <p className="settings-hint">流水线节点与出边（条件按列表顺序取第一条匹配）</p>
      <p className="settings-hint">
        没有单独的入口节点；第一个节点绑定的 AI（可多选）就是入口组：
        {value.entryAgentIds
          .map((id) => agents.find((agent) => agent.id === id)?.name ?? id)
          .join("、") || "未绑定"}
      </p>
      {value.nodes.map((node) => {
        const eligibleAgents = agents;
        const outs = value.edges
          .map((e, ei) => ({ e, ei }))
          .filter(({ e }) => e.from === node.id);
        return (
          <details
            key={node.id}
            className="game-pipeline-node"
            open={openNodeIds.has(node.id)}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setOpenNodeIds((previous) => {
                const next = new Set(previous);
                if (open) next.add(node.id);
                else next.delete(node.id);
                return next;
              });
            }}
          >
            <summary>
              <button
                type="button"
                className="game-collapse-toggle"
                aria-label={openNodeIds.has(node.id) ? "收起节点" : "展开节点"}
                aria-expanded={openNodeIds.has(node.id)}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpenNodeIds((previous) => {
                    const next = new Set(previous);
                    if (next.has(node.id)) next.delete(node.id);
                    else next.add(node.id);
                    return next;
                  });
                }}
              >
                {openNodeIds.has(node.id) ? "⌄" : "›"}
              </button>
              <input
                className="game-pipeline-node-title"
                value={node.name}
                placeholder="未命名节点"
                aria-label="节点名称"
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                  const nodes = value.nodes.map((n) =>
                    n.id === node.id ? { ...n, name: event.target.value } : n,
                  );
                  setNodes(nodes);
                }}
              />
              <span className="game-pipeline-node-id">（{node.id}）</span>
            </summary>
            <label className="game-pipeline-agent-select">
              执行能力（可多选，标题文字不参与判断）
              <select
                multiple
                value={node.executionCapabilities ?? []}
                onChange={(e) => {
                  const executionCapabilities = Array.from(
                    e.target.selectedOptions,
                  ).map((option) => option.value as AgentFeatureKey);
                  setNodes(
                    value.nodes.map((n) =>
                      n.id === node.id ? { ...n, executionCapabilities } : n,
                    ),
                  );
                }}
              >
                {capabilityLabels.map((capability) => (
                  <option key={capability.id} value={capability.id}>
                    {capability.label}
                  </option>
                ))}
              </select>
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
                  const nodes = value.nodes.map((n) =>
                    n.id === node.id ? { ...n, agentIds } : n,
                  );
                  onChange({
                    ...value,
                    nodes,
                    entryAgentIds:
                      value.nodes[0]?.id === node.id
                        ? agentIds
                        : value.entryAgentIds,
                  });
                }}
              >
                {eligibleAgents.map((agent) => (
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
                        {n.name || "未命名节点"}
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
                onChange({
                  ...value,
                  entryAgentIds: nodes[0]?.agentIds ?? [],
                  nodes,
                  edges,
                });
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
                  name: "",
                  executionCapabilities: [],
                  agentIds: [],
                  targetIds: [],
                  dispatchMode: "parallel",
                },
              ],
            });
          }}
        >
          添加节点
        </button>
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            const byCapability = (feature: AgentFeatureKey) =>
              agents
                .filter((agent) => agent.capabilities?.includes(feature))
                .map((agent) => agent.id);
            const open = byCapability("world_open");
            onChange(
              defaultPipeline({
                entryAgentIds: open.slice(0, 1),
                openAgentIds: open.slice(0, 1),
                proposeAgentIds: byCapability("propose"),
                respondAgentIds: byCapability("respond"),
                judgeAgentIds: byCapability("judge"),
                chronicleAgentIds: byCapability("chronicle"),
                clockAgentIds: byCapability("advance_clock"),
              }),
            );
          }}
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

