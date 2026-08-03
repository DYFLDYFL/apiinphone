import {
  characterSystemPrompt,
  DEFAULT_REFEREE_PERSONA,
  pickPromptOverride,
  refereeSystemPrompt,
  worldSystemPrompt,
} from "./prompts";
import type {
  AgentModelOverride,
  GameAgent,
  GameAttributeDefinition,
  GameContextFile,
  GameDateTime,
  GamePipeline,
  GameSheet,
  GameState,
} from "./types";
import { defaultPipeline, normalizePipeline } from "./pipeline";

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export const ATTR_LABELS: Record<string, string> = {
  hp: "体力",
  stamina: "耐力",
  strength: "力量",
  agility: "敏捷",
  insight: "悟性",
  charm: "魅力",
  wealth: "银钱",
  location: "位置",
  mood: "心情",
  reputation: "声望",
};

export const DEFAULT_ATTRIBUTE_DEFINITIONS: GameAttributeDefinition[] = [
  { key: "hp", label: "体力", valueType: "number", numberOptions: [0, 5, 10, 15, 20] },
  { key: "stamina", label: "耐力", valueType: "number", numberOptions: [0, 5, 10, 15, 20] },
  { key: "strength", label: "力量", valueType: "number", numberOptions: [0, 2, 4, 6, 8, 10] },
  { key: "agility", label: "敏捷", valueType: "number", numberOptions: [0, 2, 4, 6, 8, 10] },
  { key: "insight", label: "悟性", valueType: "number", numberOptions: [0, 2, 4, 6, 8, 10] },
  { key: "charm", label: "魅力", valueType: "number", numberOptions: [0, 2, 4, 6, 8, 10] },
  { key: "wealth", label: "银钱", valueType: "number", numberOptions: [0, 5, 10, 20, 50, 100] },
  { key: "location", label: "位置", valueType: "text", textOptions: ["广场", "药房", "铁匠铺", "东门外"] },
  { key: "mood", label: "心情", valueType: "text", textOptions: ["平静", "警惕", "沉稳", "轻快", "好奇"] },
  { key: "reputation", label: "声望", valueType: "number", numberOptions: [0, 1, 2, 3, 5, 10] },
];

export function inferAttributeDefinitions(
  attrsList: Array<Record<string, string | number | boolean>>,
): GameAttributeDefinition[] {
  const keys = new Set(DEFAULT_ATTRIBUTE_DEFINITIONS.map((item) => item.key));
  const definitions = DEFAULT_ATTRIBUTE_DEFINITIONS.map((item) => ({
    ...item,
    numberOptions: item.numberOptions ? [...item.numberOptions] : undefined,
    textOptions: item.textOptions ? [...item.textOptions] : undefined,
  }));
  for (const attrs of attrsList) {
    for (const [key, value] of Object.entries(attrs)) {
      const existing = definitions.find((item) => item.key === key);
      if (existing) {
        if (existing.valueType === "number" && typeof value === "number") {
          existing.numberOptions = Array.from(
            new Set([...(existing.numberOptions ?? []), value]),
          ).sort((a, b) => a - b);
        } else if (existing.valueType === "text" && typeof value === "string") {
          existing.textOptions = Array.from(
            new Set([...(existing.textOptions ?? []), value]),
          );
        }
        continue;
      }
      if (keys.has(key)) continue;
      keys.add(key);
      definitions.push({
        key,
        label: ATTR_LABELS[key] ?? key,
        valueType: typeof value === "number" ? "number" : "text",
        numberOptions: typeof value === "number" ? [value] : undefined,
        textOptions: typeof value === "number" ? undefined : [String(value)],
      });
    }
  }
  return definitions;
}

function normalizeAttributeDefinitions(
  definitions: GameAttributeDefinition[] | undefined,
  attrsList: Array<Record<string, string | number | boolean>>,
): GameAttributeDefinition[] {
  const source = Array.isArray(definitions) ? definitions : [];
  const valid = source
    .filter((item) => item && typeof item.key === "string" && item.key.trim())
    .map((item): GameAttributeDefinition => ({
      key: item.key.trim(),
      label: item.label?.trim() || item.key.trim(),
      valueType: item.valueType === "text" ? "text" : "number",
      numberOptions:
        item.valueType === "text"
          ? undefined
          : Array.isArray(item.numberOptions)
            ? item.numberOptions.filter((value) => Number.isFinite(value))
            : undefined,
      textOptions:
        item.valueType === "text"
          ? Array.isArray(item.textOptions)
            ? item.textOptions.filter((value) => typeof value === "string")
            : undefined
          : undefined,
    }));
  const configured = valid.length ? valid : inferAttributeDefinitions(attrsList);
  const inferred = inferAttributeDefinitions(attrsList);
  const attrKeys = new Set(attrsList.flatMap((attrs) => Object.keys(attrs)));
  const extras = inferred.filter(
    (item) =>
      attrKeys.has(item.key) && !configured.some((x) => x.key === item.key),
  );
  const merged = configured.map((item) => {
    const fromData = inferred.find((candidate) => candidate.key === item.key);
    return {
      ...item,
      numberOptions:
        item.valueType === "number"
          ? Array.from(
              new Set([
                ...(item.numberOptions ?? []),
                ...(fromData?.numberOptions ?? []),
              ]),
            ).sort((a, b) => a - b)
          : undefined,
      textOptions:
        item.valueType === "text"
          ? Array.from(
              new Set([...(item.textOptions ?? []), ...(fromData?.textOptions ?? [])]),
            )
          : undefined,
    };
  });
  return [...merged, ...extras];
}

export const DEFAULT_WORLDVIEW =
  "青石镇：边陲小镇，晨雾常在。有药房、铁匠铺、杂货铺与广场。民风朴实却暗流涌动，江湖传闻与邻里琐事交织。物理与人情须自洽；银钱、伤势、距离不可空口捏造。";

export type CharTemplateDraft = {
  name: string;
  persona: string;
  attrs: Record<string, string | number | boolean>;
  inventory: string;
  /** 非空则覆盖默认角色 system prompt。 */
  systemPrompt?: string;
  model?: AgentModelOverride;
  readableFileIds?: string[];
  editableFileIds?: string[];
  disabledFeatures?: import("./types").AgentFeatureKey[];
};

export const CHAR_TEMPLATES: CharTemplateDraft[] = [
  {
    name: "林晚",
    persona:
      "小镇药房学徒，心思细、胆子小，关心病人与草药。说话简短，遇冲突倾向回避或求助。",
    attrs: {
      hp: 10,
      stamina: 8,
      strength: 4,
      agility: 6,
      insight: 8,
      charm: 6,
      wealth: 12,
      location: "药房",
      mood: "平静",
      reputation: 3,
    },
    inventory: "药箱",
  },
  {
    name: "赵铁",
    persona:
      "打铁匠，直爽好强，护短。对不公会出手，但对孩子与老人客气。口头禅是「说事」。",
    attrs: {
      hp: 14,
      stamina: 12,
      strength: 9,
      agility: 5,
      insight: 5,
      charm: 4,
      wealth: 20,
      location: "铁匠铺",
      mood: "沉稳",
      reputation: 5,
    },
    inventory: "铁锤",
  },
  {
    name: "阿福",
    persona:
      "流浪说书人，爱打听消息、夸大其词。怕打架，擅长周旋与散布传闻。",
    attrs: {
      hp: 9,
      stamina: 10,
      strength: 3,
      agility: 7,
      insight: 6,
      charm: 9,
      wealth: 8,
      location: "广场",
      mood: "轻快",
      reputation: 4,
    },
    inventory: "旧琴",
  },
  {
    name: "苏青",
    persona: "猎户之女，冷静务实，熟悉山林。少言，重承诺。",
    attrs: {
      hp: 12,
      stamina: 13,
      strength: 7,
      agility: 9,
      insight: 7,
      charm: 5,
      wealth: 10,
      location: "东门外",
      mood: "警惕",
      reputation: 4,
    },
    inventory: "短弓",
  },
  {
    name: "钱掌柜",
    persona: "杂货铺老板，精于算计，表面和气。在意银钱与面子。",
    attrs: {
      hp: 10,
      stamina: 7,
      strength: 4,
      agility: 4,
      insight: 8,
      charm: 7,
      wealth: 80,
      location: "杂货铺",
      mood: "精明",
      reputation: 6,
    },
    inventory: "算盘",
  },
  {
    name: "小满",
    persona: "顽皮孩童，乱跑乱问。容易卷入事件，也会带来意外线索。",
    attrs: {
      hp: 8,
      stamina: 11,
      strength: 2,
      agility: 8,
      insight: 4,
      charm: 7,
      wealth: 2,
      location: "广场",
      mood: "好奇",
      reputation: 2,
    },
    inventory: "糖人",
  },
];

export type GameTemplateDraft = {
  title: string;
  worldview: string;
  /** 初始世界时刻，完全使用结构化字段。 */
  initialTime: string;
  initialTimeParts: GameDateTime;
  characters: CharTemplateDraft[];
  attributeDefinitions?: GameAttributeDefinition[];
  contextFiles?: GameContextFile[];
  playMode?: import("./types").GamePlayMode;
  /** 扮演时选中的角色在 characters 数组中的下标。 */
  playerCharacterIndex?: number;
  /** 非空则覆盖世界 system prompt。 */
  worldSystemPrompt?: string;
  worldModel?: AgentModelOverride;
  worldReadableFileIds?: string[];
  worldEditableFileIds?: string[];
  worldDisabledFeatures?: import("./types").AgentFeatureKey[];
  refereePersona?: string;
  refereeSystemPrompt?: string;
  refereeModel?: AgentModelOverride;
  refereeReadableFileIds?: string[];
  refereeEditableFileIds?: string[];
  refereeDisabledFeatures?: import("./types").AgentFeatureKey[];
  chroniclerGodPrompt?: string;
  chroniclerPlayerPrompt?: string;
  chroniclerModel?: AgentModelOverride;
  chroniclerReadableFileIds?: string[];
  chroniclerEditableFileIds?: string[];
  chroniclerDisabledFeatures?: import("./types").AgentFeatureKey[];
  /** 废弃隐藏编辑器字段；当前建局不会使用。 */
  proposeOrder?: import("./types").ProposeOrderMode;
  customProposeOrder?: number[];
  proposeMode?: import("./types").ProposeMode;
  pipeline?: GamePipeline;
};

export type GameAiPresetDraft = Pick<
  GameTemplateDraft,
  | "worldSystemPrompt"
  | "worldModel"
  | "refereePersona"
  | "refereeSystemPrompt"
  | "refereeModel"
  | "chroniclerGodPrompt"
  | "chroniclerPlayerPrompt"
  | "chroniclerModel"
  | "pipeline"
>;

export type GameAiPreset = {
  id: string;
  title: string;
  genre: string;
  description: string;
  draft: GameAiPresetDraft;
};

export const DEFAULT_INITIAL_TIME_PARTS: GameDateTime = {
  description: "开场",
  year: 1,
  month: 3,
  day: 2,
  hour: 5,
  minute: 30,
};

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function normalizeGameDateTime(
  value: Partial<GameDateTime> | undefined,
  fallback: GameDateTime = DEFAULT_INITIAL_TIME_PARTS,
): GameDateTime {
  const year = Number(value?.year);
  const month = Number(value?.month);
  const safeYear = Number.isInteger(year) && year >= 1 && year <= 9999
    ? year
    : fallback.year;
  const safeMonth = Number.isInteger(month) && month >= 1 && month <= 12
    ? month
    : fallback.month;
  const rawDay = Number(value?.day);
  const maxDay = daysInMonth(safeYear, safeMonth);
  const day = Number.isInteger(rawDay) && rawDay >= 1 && rawDay <= maxDay
    ? rawDay
    : Math.min(fallback.day, maxDay);
  const hour = Number(value?.hour);
  const minute = Number(value?.minute);
  return {
    description: String(value?.description ?? fallback.description).trim() || fallback.description,
    year: safeYear,
    month: safeMonth,
    day,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : fallback.hour,
    minute:
      Number.isInteger(minute) && minute >= 0 && minute <= 59
        ? minute
        : fallback.minute,
  };
}

export function isValidGameDateTime(value: unknown): value is GameDateTime {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<GameDateTime>;
  const normalized = normalizeGameDateTime(item, {
    ...DEFAULT_INITIAL_TIME_PARTS,
    description: String(item.description ?? ""),
  });
  return (
    typeof item.description === "string" &&
    Number.isInteger(item.year) &&
    Number.isInteger(item.month) &&
    Number.isInteger(item.day) &&
    Number.isInteger(item.hour) &&
    Number.isInteger(item.minute) &&
    normalized.year === item.year &&
    normalized.month === item.month &&
    normalized.day === item.day &&
    normalized.hour === item.hour &&
    normalized.minute === item.minute
  );
}

export function formatGameDateTime(value: GameDateTime): string {
  const time = `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;
  const date = `${value.year}年${value.month}月${value.day}日`;
  return value.description.trim()
    ? `${value.description.trim()} · ${date} ${time}`
    : `${date} ${time}`;
}

export function defaultContextFiles(
  worldview = "",
  timeText = formatGameDateTime(DEFAULT_INITIAL_TIME_PARTS),
): GameContextFile[] {
  return [
    { id: "worldview", title: "世界设定", content: worldview },
    { id: "clock", title: "当前时间", content: timeText },
    { id: "scene", title: "当前场景", content: "" },
    { id: "timeline", title: "公开时间线", content: "" },
    { id: "characters", title: "角色档案", content: "" },
    { id: "clues", title: "线索与秘密", content: "" },
  ];
}

export function defaultGameRunSettings(characterCount = 3): {
  characterCount: number;
  pipeline: GamePipeline;
} {
  return {
    characterCount,
    pipeline: defaultPipeline(),
  };
}

export function defaultTemplateDraft(characterCount = 3): GameTemplateDraft {
  const n = Math.min(6, Math.max(2, Math.round(characterCount)));
  return {
    title: "青石镇",
    worldview: DEFAULT_WORLDVIEW,
    initialTime: formatGameDateTime(DEFAULT_INITIAL_TIME_PARTS),
    initialTimeParts: { ...DEFAULT_INITIAL_TIME_PARTS },
    attributeDefinitions: DEFAULT_ATTRIBUTE_DEFINITIONS.map((item) => ({ ...item })),
    contextFiles: defaultContextFiles(
      DEFAULT_WORLDVIEW,
      formatGameDateTime(DEFAULT_INITIAL_TIME_PARTS),
    ),
    characters: CHAR_TEMPLATES.slice(0, n).map((c) => ({
      ...c,
      attrs: { ...c.attrs },
    })),
    playMode: "spectate",
    playerCharacterIndex: 0,
    worldSystemPrompt: "",
    refereePersona: DEFAULT_REFEREE_PERSONA,
    refereeSystemPrompt: "",
    chroniclerGodPrompt: "",
    chroniclerPlayerPrompt: "",
    pipeline: defaultPipeline(),
  };
}

function makeAiPreset(
  id: string,
  title: string,
  genre: string,
  description: string,
  patch: Partial<GameAiPresetDraft> = {},
): GameAiPreset {
  const base = defaultTemplateDraft(3);
  return {
    id,
    title,
    genre,
    description,
    draft: {
      worldSystemPrompt: base.worldSystemPrompt,
      worldModel: base.worldModel,
      refereePersona: base.refereePersona,
      refereeSystemPrompt: base.refereeSystemPrompt,
      refereeModel: base.refereeModel,
      chroniclerGodPrompt: base.chroniclerGodPrompt,
      chroniclerPlayerPrompt: base.chroniclerPlayerPrompt,
      chroniclerModel: base.chroniclerModel,
      pipeline: base.pipeline,
      ...patch,
    },
  };
}

export const AI_RUNTIME_PRESETS: GameAiPreset[] = [
  makeAiPreset(
    "standard-narrative",
    "标准叙事",
    "稳妥",
    "世界开场、角色互动、裁判和书记按完整流程运行，适合大多数题材。",
  ),
  makeAiPreset(
    "fast-interaction",
    "快速互动",
    "节奏",
    "角色提案并行处理，书记使用更短的整理提示，适合快速推进剧情。",
    {
      chroniclerGodPrompt: "用紧凑的段落整理本轮关键因果、角色变化和下一步悬念。",
      chroniclerPlayerPrompt: "只整理玩家角色亲历的关键行动与结果，保持简洁。",
    },
  ),
  makeAiPreset(
    "strict-judge",
    "严谨裁判",
    "规则",
    "强调证据、资源、距离和既有属性变化，适合悬疑、生存与策略玩法。",
    {
      refereePersona:
        `${baseRefereePersonaForPreset()} 裁定时优先检查因果、资源、距离与已知信息，禁止无依据跳跃。`,
      worldSystemPrompt:
        "严格维护世界连续性。所有资源、伤势、距离、线索和时间变化都必须有来源并可追溯。",
    },
  ),
];

function baseRefereePersonaForPreset(): string {
  return DEFAULT_REFEREE_PERSONA;
}

export function applyAiPreset(
  draft: GameTemplateDraft,
  preset: GameAiPreset,
): GameTemplateDraft {
  return {
    ...draft,
    ...JSON.parse(JSON.stringify(preset.draft)),
  };
}

export type GameTemplatePreset = {
  id: string;
  title: string;
  genre: string;
  description: string;
  draft: GameTemplateDraft;
};

function genrePreset(
  id: string,
  title: string,
  genre: string,
  description: string,
  worldview: string,
  initialTimeParts: GameDateTime,
  extraAttributes: GameAttributeDefinition[] = [],
): GameTemplatePreset {
  const draft = defaultTemplateDraft(3);
  const definitions = [
    ...(draft.attributeDefinitions ?? DEFAULT_ATTRIBUTE_DEFINITIONS),
    ...extraAttributes,
  ];
  return {
    id,
    title,
    genre,
    description,
    draft: {
      ...draft,
      title,
      worldview,
      initialTime: formatGameDateTime(initialTimeParts),
      initialTimeParts,
      contextFiles: defaultContextFiles(
        worldview,
        formatGameDateTime(initialTimeParts),
      ),
      attributeDefinitions: definitions.map((item) => ({ ...item })),
    },
  };
}

export const GAME_TEMPLATE_PRESETS: GameTemplatePreset[] = [
  genrePreset(
    "qing-shi",
    "青石镇",
    "古代悬疑",
    "边陲小镇的晨雾里，邻里琐事牵出一桩旧案。",
    DEFAULT_WORLDVIEW,
    DEFAULT_INITIAL_TIME_PARTS,
  ),
  genrePreset(
    "fog-city",
    "雾都档案",
    "现代都市",
    "一座被暴雨笼罩的城市，线索藏在监控、街巷与人心之间。",
    "临江市：高楼、旧城与地下交通交错。案件必须遵循现代社会常识，证据、舆论与时间都不可凭空跳过。",
    { ...DEFAULT_INITIAL_TIME_PARTS, description: "周一早晨", hour: 8, minute: 30 },
    [{ key: "clues", label: "线索", valueType: "number" }],
  ),
  genrePreset(
    "ash-era",
    "灰烬纪元",
    "末日生存",
    "文明崩塌后的第七年，水源、燃料和信任都很稀缺。",
    "灰烬纪元：废墟聚落依靠净水器与旧时代物资生存。感染、辐射、天气和资源必须保持连续。",
    { ...DEFAULT_INITIAL_TIME_PARTS, description: "灰烬纪元第七年·清晨" },
    [{ key: "supplies", label: "物资", valueType: "number" }],
  ),
  genrePreset(
    "star-ring",
    "星环边境",
    "科幻星际",
    "边境空间站接收到一段不该存在的求救信号。",
    "星环边境：空间站、跃迁航道与殖民地组成脆弱网络。氧气、能源、通讯延迟和船体损伤必须自洽。",
    { description: "星环边境", year: 2187, month: 4, day: 12, hour: 6, minute: 0 },
    [
      { key: "oxygen", label: "氧气", valueType: "number" },
      { key: "energy", label: "能源", valueType: "number" },
    ],
  ),
  genrePreset(
    "moon-kingdom",
    "月影王国",
    "奇幻冒险",
    "王国边境的月光会改变魔法，古老契约正在苏醒。",
    "月影王国：精灵、工匠、骑士与术士共同生活。魔法有代价，誓约、血统与传说会影响现实。",
    { description: "月影历·月升前", year: 302, month: 1, day: 1, hour: 18, minute: 0 },
    [{ key: "mana", label: "魔力", valueType: "number" }],
  ),
];

export function cloneTemplateDraft(draft: GameTemplateDraft): GameTemplateDraft {
  return JSON.parse(JSON.stringify(draft)) as GameTemplateDraft;
}

export function createTemplateGame(
  draft: GameTemplateDraft | string = "青石镇",
  characterCount = 3,
): GameState {
  const now = new Date().toISOString();
  const tpl =
    typeof draft === "string"
      ? { ...defaultTemplateDraft(characterCount), title: draft.trim() || "新游戏" }
      : draft;
  const chars = tpl.characters.slice(0, 6);
  const sheets: GameSheet[] = [];
  const characters: GameAgent[] = [];

  for (const t of chars) {
    const sheetId = id("sheet");
    const agentId = id("char");
    const inventory = t.inventory
      .split(/[,，、]/)
      .map((x) => x.trim())
      .filter(Boolean);
    const name = t.name.trim() || "未命名";
    const override = t.systemPrompt?.trim() || "";
    sheets.push({
      id: sheetId,
      name,
      attrs: { ...t.attrs },
      inventory,
      flags: [],
      notes: "",
    });
    characters.push({
      id: agentId,
      kind: "character",
      name,
      sheetId,
      persona: t.persona,
      systemPrompt: pickPromptOverride(
        override,
        characterSystemPrompt(name, t.persona),
      ),
      systemPromptOverride: override || undefined,
      modelOverride: t.model,
      readableFileIds: t.readableFileIds,
      editableFileIds: t.editableFileIds,
      disabledFeatures: t.disabledFeatures,
      history: [],
    });
  }

  const worldview = tpl.worldview.trim() || DEFAULT_WORLDVIEW;
  const initialDateTime = normalizeGameDateTime(tpl.initialTimeParts);
  const timeText = formatGameDateTime(initialDateTime);
  const contextFiles = (tpl.contextFiles?.length
    ? tpl.contextFiles
    : defaultContextFiles(worldview, timeText)
  ).map((file) => ({ ...file }));
  const defaultReadable = contextFiles
    .filter((file) => file.id !== "clues")
    .map((file) => file.id);
  const defaultEditable: string[] = [];
  const worldOverride = tpl.worldSystemPrompt?.trim() || "";
  const world: GameAgent = {
    id: id("world"),
    kind: "world",
    name: "世界",
    persona: worldview,
    systemPrompt: pickPromptOverride(
      worldOverride,
      worldSystemPrompt(worldview),
    ),
    systemPromptOverride: worldOverride || undefined,
    modelOverride: tpl.worldModel,
    readableFileIds: tpl.worldReadableFileIds,
    editableFileIds: tpl.worldEditableFileIds,
    disabledFeatures: tpl.worldDisabledFeatures,
    history: [],
  };

  const refPersona = tpl.refereePersona?.trim() || DEFAULT_REFEREE_PERSONA;
  const refOverride = tpl.refereeSystemPrompt?.trim() || "";
  const referee: GameAgent = {
    id: id("ref"),
    kind: "referee",
    name: "裁判",
    persona: refPersona,
    systemPrompt: pickPromptOverride(
      refOverride,
      refereeSystemPrompt(refPersona),
    ),
    systemPromptOverride: refOverride || undefined,
    modelOverride: tpl.refereeModel,
    readableFileIds: tpl.refereeReadableFileIds,
    editableFileIds: tpl.refereeEditableFileIds,
    disabledFeatures: tpl.refereeDisabledFeatures,
    history: [],
  };
  const agents = [world, ...characters, referee].map((agent) => ({
    ...agent,
    readableFileIds: Array.isArray(agent.readableFileIds)
      ? [...agent.readableFileIds]
      : [...defaultReadable],
    editableFileIds: Array.isArray(agent.editableFileIds)
      ? [...agent.editableFileIds]
      : [...defaultEditable],
  }));
  const agentIdForDraftValue = (value: string): string => {
    if (value === "world") return world.id;
    if (value === "referee") return referee.id;
    const match = value.match(/^character_(\d+)$/);
    if (match) return characters[Number(match[1])]?.id ?? value;
    return agents.find((agent) => agent.id === value || agent.name === value)?.id ?? value;
  };
  const pipeline = normalizePipeline(tpl.pipeline ?? defaultPipeline());
  pipeline.nodes = pipeline.nodes.map((node) => ({
    ...node,
    agentIds: node.agentIds?.map(agentIdForDraftValue),
    targetIds: node.targetIds?.map(agentIdForDraftValue),
  }));

  const result: GameState = {
    id: id("game"),
    title: tpl.title.trim() || "新游戏",
    createdAt: now,
    updatedAt: now,
    worldview,
    worldClock: {
      tick: 0,
      label: timeText,
      timeText,
      description: initialDateTime.description,
      dateTime: initialDateTime,
      sceneSummary: "晨雾未散，青石镇刚醒。",
      history: { "0": timeText },
    },
    agents,
    sheets,
    contextFiles,
    events: [
      {
        id: id("evt"),
        tick: 0,
        interactionRound: 0,
        at: now,
        kind: "system",
        actorId: "system",
        actorName: "系统",
        summary: "游戏开始。",
        audience: "public",
        visibleTo: [],
      },
    ],
    tickBuffer: {
      tick: 0,
      interactionRound: 0,
      status: "need_open",
    },
    settings: {
      ...defaultGameRunSettings(characters.length),
      pipeline,
      chroniclerGodPrompt: tpl.chroniclerGodPrompt?.trim() || undefined,
      chroniclerPlayerPrompt: tpl.chroniclerPlayerPrompt?.trim() || undefined,
      chroniclerModel: tpl.chroniclerModel,
      chroniclerReadableFileIds: Array.isArray(tpl.chroniclerReadableFileIds)
        ? tpl.chroniclerReadableFileIds
        : defaultReadable,
      chroniclerEditableFileIds: Array.isArray(tpl.chroniclerEditableFileIds)
        ? tpl.chroniclerEditableFileIds
        : defaultEditable,
      chroniclerDisabledFeatures: tpl.chroniclerDisabledFeatures,
    },
    attributeDefinitions: normalizeAttributeDefinitions(
      tpl.attributeDefinitions,
      characters.map((ch) => sheets.find((sheet) => sheet.id === ch.sheetId)?.attrs ?? {}),
    ),
    playMode: tpl.playMode === "play" ? "play" : "spectate",
    playerCharacterId: null,
    godStory: "",
    playerStory: "",
    storyTick: -1,
    godViewUnlocked: tpl.playMode !== "play",
  };

  if (result.playMode === "play" && characters.length) {
    const idx = Math.min(
      characters.length - 1,
      Math.max(0, Math.round(tpl.playerCharacterIndex ?? 0)),
    );
    result.playerCharacterId = characters[idx].id;
    result.godViewUnlocked = false;
  }

  return result;
}
