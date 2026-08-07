import {
  characterSystemPrompt,
  DEFAULT_REFEREE_PERSONA,
  pickPromptOverride,
  refereeSystemPrompt,
  worldSystemPrompt,
  chroniclerSystemPrompt,
} from "./prompts";
import type {
  AgentFeatureKey,
  AgentModelOverride,
  GameAgent,
  GameAttributeDefinition,
  GameAttributePermission,
  GameContextFile,
  GameDateTime,
  GamePipeline,
  GameSheet,
  GameState,
  GameWeekday,
  GameMapCell,
  GameWorldMap,
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
  mood: "心情",
  reputation: "声望",
};

export const MIN_ATTRIBUTE_NUMBER = Number.MIN_SAFE_INTEGER;
export const MAX_ATTRIBUTE_NUMBER = Number.MAX_SAFE_INTEGER;

export function isValidAttributeNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_ATTRIBUTE_NUMBER &&
    value <= MAX_ATTRIBUTE_NUMBER
  );
}

export const DEFAULT_ATTRIBUTE_DEFINITIONS: GameAttributeDefinition[] = [
  { key: "hp", label: "体力", valueType: "number" },
  { key: "stamina", label: "耐力", valueType: "number" },
  { key: "strength", label: "力量", valueType: "number" },
  { key: "agility", label: "敏捷", valueType: "number" },
  { key: "insight", label: "悟性", valueType: "number" },
  { key: "charm", label: "魅力", valueType: "number" },
  { key: "wealth", label: "银钱", valueType: "number" },
  { key: "mood", label: "心情", valueType: "text", textOptions: ["平静", "焦虑", "专注", "疲惫", "警觉"] },
  { key: "reputation", label: "声望", valueType: "number" },
];

export function inferAttributeDefinitions(
  attrsList: Array<Record<string, string | number | boolean>>,
): GameAttributeDefinition[] {
  const keys = new Set(DEFAULT_ATTRIBUTE_DEFINITIONS.map((item) => item.key));
  const definitions = DEFAULT_ATTRIBUTE_DEFINITIONS.map((item) => ({
    ...item,
    numberOptions: undefined,
    textOptions: item.textOptions ? [...item.textOptions] : undefined,
  }));
  for (const attrs of attrsList) {
    for (const [key, value] of Object.entries(attrs)) {
      const existing = definitions.find((item) => item.key === key);
      if (existing) {
        if (existing.valueType === "text" && typeof value === "string") {
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
        numberOptions: undefined,
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
      numberOptions: undefined,
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
      numberOptions: undefined,
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
  id?: string;
  name: string;
  persona: string;
  position?: { x: number; y: number };
  attrs: Record<string, string | number | boolean>;
  inventory: string;
  /** 非空则覆盖默认角色 system prompt。 */
  systemPrompt?: string;
  model?: AgentModelOverride;
  readableFileIds?: string[];
  editableFileIds?: string[];
  disabledFeatures?: import("./types").AgentFeatureKey[];
  attributePermissions?: Record<string, GameAttributePermission>;
  capabilities?: AgentFeatureKey[];
};

export type AgentTemplateDraft = {
  id: string;
  /** 非空表示这是某个角色的 AI 控制器。 */
  characterId?: string;
  name: string;
  persona: string;
  systemPrompt?: string;
  model?: AgentModelOverride;
  capabilities: AgentFeatureKey[];
  readableFileIds?: string[];
  editableFileIds?: string[];
  attributePermissions?: Record<string, GameAttributePermission>;
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
  weekCycleEnabled?: boolean;
  agents: AgentTemplateDraft[];
  characters: CharTemplateDraft[];
  attributeDefinitions?: GameAttributeDefinition[];
  contextFiles?: GameContextFile[];
  worldMap?: GameWorldMap;
  playMode?: import("./types").GamePlayMode;
  /** 扮演时选中的角色在 characters 数组中的下标。 */
  playerCharacterIndex?: number;
  pipeline?: GamePipeline;
};

export type GameAiPresetDraft = Pick<GameTemplateDraft, "agents" | "pipeline">;

export type GameAiPreset = {
  id: string;
  title: string;
  genre: string;
  description: string;
  draft: GameAiPresetDraft;
};

export const DEFAULT_INITIAL_TIME_PARTS: GameDateTime = {
  description: "开场",
  era: "CE",
  year: 1,
  month: 3,
  day: 2,
  weekday: 1,
  hour: 5,
  minute: 30,
};

export const WEEKDAY_LABELS: Record<GameWeekday, string> = {
  1: "周一",
  2: "周二",
  3: "周三",
  4: "周四",
  5: "周五",
  6: "周六",
  7: "周日",
};

export function isLeapYear(era: GameDateTime["era"], year: number): boolean {
  const astronomicalYear = era === "BCE" ? 1 - year : year;
  return (
    astronomicalYear % 4 === 0 &&
    (astronomicalYear % 100 !== 0 || astronomicalYear % 400 === 0)
  );
}

export function daysInMonth(
  era: GameDateTime["era"],
  year: number,
  month: number,
): number {
  if (month === 2) return isLeapYear(era, year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function normalizeGameDateTime(
  value: Partial<GameDateTime> | undefined,
  fallback: GameDateTime = DEFAULT_INITIAL_TIME_PARTS,
): GameDateTime {
  const era = value?.era === "BCE" ? "BCE" : value?.era === "CE" ? "CE" : fallback.era;
  const year = Number(value?.year);
  const safeYear = Number.isInteger(year) && year >= 1 && year <= 99999
    ? year
    : fallback.year;
  const month = Number(value?.month);
  const safeMonth = Number.isInteger(month) && month >= 1 && month <= 12
    ? month
    : fallback.month;
  const rawDay = Number(value?.day);
  const maxDay = daysInMonth(era, safeYear, safeMonth);
  const day = Number.isInteger(rawDay) && rawDay >= 1
    ? Math.min(rawDay, maxDay)
    : Math.min(fallback.day, maxDay);
  const weekday = Number(value?.weekday);
  const hour = Number(value?.hour);
  const minute = Number(value?.minute);
  return {
    description: String(value?.description ?? fallback.description).trim() || fallback.description,
    era,
    year: safeYear,
    month: safeMonth,
    day,
    weekday:
      Number.isInteger(weekday) && weekday >= 1 && weekday <= 7
        ? (weekday as GameWeekday)
        : fallback.weekday,
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
    (item.era === "BCE" || item.era === "CE") &&
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
  const date = `${value.era === "BCE" ? "公元前" : "公元"} ${value.year}年${value.month}月${value.day}日`;
  return value.description.trim()
    ? `${value.description.trim()} · ${date} ${time}`
    : `${date} ${time}`;
}

export function formatGameClock(
  value: GameDateTime,
  weekCycleEnabled = false,
): string {
  const dateText = formatGameDateTime(value);
  if (!weekCycleEnabled || !value.weekday) return dateText;
  return `${WEEKDAY_LABELS[value.weekday]} · ${dateText}`;
}

export function defaultContextFiles(
  worldview = "",
  timeText = formatGameDateTime(DEFAULT_INITIAL_TIME_PARTS),
): GameContextFile[] {
  return [
    { id: "worldview", title: "世界设定", content: worldview },
    { id: "world_map", title: "世界地图与地形", content: "" },
    { id: "clock", title: "当前时间", content: timeText },
    { id: "scene", title: "当前场景", content: "" },
    { id: "timeline", title: "公开时间线", content: "" },
    { id: "characters", title: "全角色档案", content: "" },
    { id: "clues", title: "线索与秘密", content: "" },
    { id: "god_story", title: "上帝视角剧情", content: "" },
    { id: "personal_stories", title: "全个人剧情", content: "" },
  ];
}

export function mapCellKey(x: number, y: number): string {
  return `${Math.round(x)},${Math.round(y)}`;
}

export function createWorldMap(
  cells: Array<GameMapCell> = [],
  terrainTypes: string[] = [],
): GameWorldMap {
  const inferredTerrainTypes = Array.from(
    new Set(cells.map((cell) => cell.terrain?.trim()).filter(Boolean)),
  ) as string[];
  return {
    terrainTypes: terrainTypes.length ? [...terrainTypes] : inferredTerrainTypes,
    cells: Object.fromEntries(
      cells.map((cell) => [
        mapCellKey(cell.x, cell.y),
        {
          ...cell,
          x: Math.round(cell.x),
          y: Math.round(cell.y),
          properties: { ...cell.properties },
          objects: [...cell.objects],
        },
      ]),
    ),
  };
}

export function defaultWorldMapForGenre(genre: string): GameWorldMap {
  if (genre.includes("科幻")) {
    return createWorldMap([
      { x: 0, y: 0, zoneName: "空间站中枢", terrain: "舱室", properties: {}, objects: ["控制台"] },
      { x: 1, y: 0, zoneName: "生活区", terrain: "舱室", properties: {}, objects: ["居住舱"] },
      { x: -1, y: 0, zoneName: "停泊区", terrain: "舱室", properties: {}, objects: ["飞船接口"] },
      { x: 0, y: 1, zoneName: "维修环廊", terrain: "维护区", properties: {}, objects: ["工具柜"] },
      { x: 0, y: -1, zoneName: "能源区", terrain: "机房", properties: {}, objects: ["反应堆"] },
    ], ["舱室", "维护区", "机房", "真空区"]);
  }
  if (genre.includes("现代")) {
    return createWorldMap([
      { x: 0, y: 0, zoneName: "市中心", terrain: "城市道路", properties: {}, objects: ["地铁站", "商场"] },
      { x: 1, y: 0, zoneName: "旧城区", terrain: "街巷", properties: {}, objects: ["老楼"] },
      { x: 0, y: 1, zoneName: "江岸", terrain: "滨水", properties: {}, objects: ["步道"] },
      { x: -1, y: 0, zoneName: "工业区", terrain: "工业用地", properties: {}, objects: ["仓库"] },
      { x: 0, y: -1, zoneName: "大学城", terrain: "公共设施", properties: {}, objects: ["图书馆"] },
    ], ["城市道路", "街巷", "滨水", "工业用地", "公共设施"]);
  }
  if (genre.includes("末日")) {
    return createWorldMap([
      { x: 0, y: 0, zoneName: "聚落", terrain: "废墟", properties: {}, objects: ["净水器"] },
      { x: 1, y: 0, zoneName: "旧公路", terrain: "荒地", properties: {}, objects: ["废弃车辆"] },
      { x: 0, y: 1, zoneName: "水源地", terrain: "湿地", properties: {}, objects: ["蓄水池"] },
      { x: -1, y: 0, zoneName: "感染区", terrain: "危险区", properties: {}, objects: ["警示牌"] },
      { x: 0, y: -1, zoneName: "农场遗址", terrain: "荒地", properties: {}, objects: ["破旧温室"] },
    ], ["废墟", "荒地", "湿地", "危险区"]);
  }
  if (genre.includes("奇幻")) {
    return createWorldMap([
      { x: 0, y: 0, zoneName: "王都", terrain: "城镇", properties: {}, objects: ["城门", "集市"] },
      { x: 1, y: 0, zoneName: "月林", terrain: "森林", properties: {}, objects: ["古树"] },
      { x: 0, y: 1, zoneName: "边境路", terrain: "道路", properties: {}, objects: ["路碑"] },
      { x: -1, y: 0, zoneName: "矿谷", terrain: "山地", properties: {}, objects: ["矿井"] },
      { x: 0, y: -1, zoneName: "湖畔村", terrain: "水域", properties: {}, objects: ["码头"] },
    ], ["城镇", "森林", "道路", "山地", "水域"]);
  }
  return createWorldMap([
    { x: 0, y: 0, zoneName: "青石镇广场", terrain: "城镇", properties: {}, objects: ["告示牌"] },
    { x: 1, y: 0, zoneName: "药房街", terrain: "街巷", properties: {}, objects: ["药房"] },
    { x: -1, y: 0, zoneName: "铁匠街", terrain: "街巷", properties: {}, objects: ["铁匠铺"] },
    { x: 0, y: 1, zoneName: "东门外", terrain: "道路", properties: {}, objects: ["城门"] },
    { x: 0, y: -1, zoneName: "杂货街", terrain: "街巷", properties: {}, objects: ["杂货铺"] },
    { x: 1, y: 1, zoneName: "河堤", terrain: "河岸", properties: {}, objects: ["渡口"] },
  ], ["城镇", "街巷", "道路", "河岸", "荒地"]);
}

export type AgentInformationPreset =
  | "world"
  | "judge"
  | "chronicler"
  | "character";

export const AGENT_INFORMATION_PRESET_LABELS: Record<
  AgentInformationPreset,
  string
> = {
  world: "世界 AI（全局资料）",
  judge: "裁判 AI（完整裁定资料）",
  chronicler: "书记 AI（整理资料）",
  character: "角色 AI（公开资料与自身属性）",
};

export function informationPresetForAgent(agent: {
  capabilities: AgentFeatureKey[];
  characterId?: string;
}): AgentInformationPreset {
  if (agent.characterId) return "character";
  if (agent.capabilities.includes("judge")) return "judge";
  if (agent.capabilities.includes("chronicle")) return "chronicler";
  return "world";
}

export function informationAccessForAgent(
  preset: AgentInformationPreset,
  fileIds: string[],
  attributeKeys: string[],
  characterId?: string,
): {
  readableFileIds: string[];
  editableFileIds: string[];
  attributePermissions: Record<string, GameAttributePermission>;
} {
  const readableFileIds =
    preset === "character"
      ? fileIds.filter(
          (id) =>
            ["worldview", "clock", "scene", "timeline", "world_map"].includes(id) ||
            Boolean(characterId && id === `personal_story_${characterId}`),
        )
      : [...fileIds];
  const editableCandidates =
    preset === "world"
      ? ["clock", "scene", "timeline"]
      : preset === "chronicler"
        ? ["timeline"]
        : [];
  const editableFileIds = editableCandidates.filter((id) =>
    readableFileIds.includes(id),
  );
  const attributePermissions = Object.fromEntries(
    attributeKeys.map((key) => [
      key,
      preset === "judge"
        ? { read: true, set: true, add: true, remove: true }
        : { read: true },
    ]),
  );
  return { readableFileIds, editableFileIds, attributePermissions };
}

export function defaultGameRunSettings(characterCount = 3): {
  characterCount: number;
  weekCycleEnabled: boolean;
  pipeline: GamePipeline;
} {
  return {
    characterCount,
    weekCycleEnabled: false,
    pipeline: defaultPipeline(),
  };
}

export function defaultTemplateDraft(characterCount = 3): GameTemplateDraft {
  const n = Math.min(6, Math.max(2, Math.round(characterCount)));
  const characters = CHAR_TEMPLATES.slice(0, n).map((c) => ({
    ...c,
    id: `character_${CHAR_TEMPLATES.indexOf(c)}`,
    capabilities: ["propose", "respond"] as AgentFeatureKey[],
    attrs: { ...c.attrs },
  }));
  const characterAgents: AgentTemplateDraft[] = characters.map((character) => ({
    id: `agent_${character.id}`,
    characterId: character.id,
    name: character.name,
    persona: character.persona,
    capabilities: [...(character.capabilities ?? ["propose", "respond"])],
    readableFileIds: [
      "worldview",
      "clock",
      "scene",
      "timeline",
      "world_map",
      `personal_story_${character.id}`,
    ],
    editableFileIds: [],
    attributePermissions: Object.fromEntries(
      DEFAULT_ATTRIBUTE_DEFINITIONS.map((definition) => [
        definition.key,
        { read: true },
      ]),
    ),
  }));
  return {
    title: "青石镇",
    worldview: DEFAULT_WORLDVIEW,
    initialTime: formatGameDateTime(DEFAULT_INITIAL_TIME_PARTS),
    initialTimeParts: { ...DEFAULT_INITIAL_TIME_PARTS },
    weekCycleEnabled: false,
    attributeDefinitions: DEFAULT_ATTRIBUTE_DEFINITIONS.map((item) => ({ ...item })),
    contextFiles: [
      ...defaultContextFiles(
        DEFAULT_WORLDVIEW,
        formatGameDateTime(DEFAULT_INITIAL_TIME_PARTS),
      ),
      ...characterAgents.map((agent) => ({
        id: `personal_story_${agent.characterId}`,
        title: `${agent.name}的个人剧情`,
        content: "",
      })),
    ],
    agents: [
      {
        id: "world_agent",
        name: "世界",
        persona: DEFAULT_WORLDVIEW,
        capabilities: ["world_open", "respond", "advance_clock"],
        readableFileIds: [
          "worldview",
          "clock",
          "scene",
          "timeline",
          "world_map",
          "characters",
          "clues",
          "god_story",
          "personal_stories",
          ...characterAgents.map((agent) => `personal_story_${agent.characterId}`),
        ],
        editableFileIds: ["clock", "scene", "timeline"],
        attributePermissions: Object.fromEntries(
          DEFAULT_ATTRIBUTE_DEFINITIONS.map((definition) => [
            definition.key,
            { read: true },
          ]),
        ),
      },
      {
        id: "judge_agent",
        name: "裁判",
        persona: DEFAULT_REFEREE_PERSONA,
        capabilities: ["judge"],
        readableFileIds: [
          "worldview",
          "clock",
          "scene",
          "timeline",
          "world_map",
          "characters",
          "clues",
          "god_story",
          "personal_stories",
          ...characterAgents.map((agent) => `personal_story_${agent.characterId}`),
        ],
        editableFileIds: [],
        attributePermissions: Object.fromEntries(
          DEFAULT_ATTRIBUTE_DEFINITIONS.map((definition) => [
            definition.key,
            { read: true, set: true, add: true, remove: true },
          ]),
        ),
      },
      {
        id: "chronicler_agent",
        name: "书记",
        persona: "整理本局剧情，区分全知视角与玩家视角。",
        capabilities: ["chronicle"],
        readableFileIds: [
          "worldview",
          "clock",
          "scene",
          "timeline",
          "world_map",
          "characters",
          "clues",
          "god_story",
          "personal_stories",
          ...characterAgents.map((agent) => `personal_story_${agent.characterId}`),
        ],
        editableFileIds: [
          "timeline",
          "god_story",
          "personal_stories",
          ...characterAgents.map((agent) => `personal_story_${agent.characterId}`),
        ],
        attributePermissions: Object.fromEntries(
          DEFAULT_ATTRIBUTE_DEFINITIONS.map((definition) => [
            definition.key,
            { read: true },
          ]),
        ),
      },
      ...characterAgents,
    ],
    characters,
    playMode: "spectate",
    playerCharacterIndex: 0,
    pipeline: defaultPipeline({
      entryAgentIds: ["world_agent"],
      openAgentIds: ["world_agent"],
      proposeAgentIds: Array.from({ length: n }, (_, index) => `agent_character_${index}`),
      respondAgentIds: ["world_agent"],
      judgeAgentIds: ["judge_agent"],
      chronicleAgentIds: ["chronicler_agent"],
      clockAgentIds: ["world_agent"],
    }),
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
      agents: base.agents.map((agent) => ({
        ...agent,
        capabilities: [...agent.capabilities],
      })),
      pipeline: base.pipeline,
      ...patch,
    },
  };
}

function pipelineWithDispatchMode(
  mode: "serial" | "parallel",
): GamePipeline {
  const pipeline = defaultTemplateDraft(3).pipeline ?? defaultPipeline();
  return {
    ...pipeline,
    nodes: pipeline.nodes.map((node) =>
      node.id === "n_propose" ? { ...node, dispatchMode: mode } : node,
    ),
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
      agents: defaultTemplateDraft(3).agents.map((agent) =>
        agent.capabilities.includes("chronicle")
          ? {
              ...agent,
              systemPrompt: "用紧凑的段落整理本轮关键因果、角色变化和下一步悬念。",
            }
          : { ...agent, capabilities: [...agent.capabilities] },
      ),
      pipeline: pipelineWithDispatchMode("parallel"),
    },
  ),
  makeAiPreset(
    "strict-judge",
    "严谨裁判",
    "规则",
    "强调证据、资源、距离和既有属性变化，适合悬疑、生存与策略玩法。",
    {
      agents: defaultTemplateDraft(3).agents.map((agent) => {
        if (agent.capabilities.includes("judge")) {
          return {
            ...agent,
            persona: `${baseRefereePersonaForPreset()} 裁定时优先检查因果、资源、距离与已知信息，禁止无依据跳跃。`,
          };
        }
        if (agent.capabilities.includes("world_open")) {
          return {
            ...agent,
            systemPrompt:
              "严格维护世界连续性。所有资源、伤势、距离、线索和时间变化都必须有来源并可追溯。",
          };
        }
        return { ...agent, capabilities: [...agent.capabilities] };
      }),
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
  const commonKeys = new Set(
    genre.includes("现代")
      ? ["hp", "stamina", "insight", "charm", "reputation", "mood"]
      : genre.includes("末日")
        ? ["hp", "stamina", "strength", "agility", "insight", "mood"]
        : genre.includes("科幻")
          ? ["hp", "stamina", "strength", "agility", "insight", "reputation", "mood"]
          : genre.includes("奇幻")
            ? ["hp", "stamina", "strength", "agility", "insight", "charm", "reputation", "mood"]
            : DEFAULT_ATTRIBUTE_DEFINITIONS.map((item) => item.key),
  );
  const definitions = [
    ...(draft.attributeDefinitions ?? DEFAULT_ATTRIBUTE_DEFINITIONS).filter(
      (item) => commonKeys.has(item.key),
    ),
    ...extraAttributes,
  ].map((item) =>
    item.key === "mood"
      ? {
          ...item,
          textOptions: genre.includes("现代")
            ? ["平静", "焦虑", "专注", "疲惫", "警觉"]
            : genre.includes("末日")
              ? ["警觉", "紧张", "疲惫", "麻木", "希望"]
              : genre.includes("科幻")
                ? ["冷静", "警戒", "专注", "疲惫", "兴奋"]
                : genre.includes("奇幻")
                  ? ["平静", "警觉", "敬畏", "兴奋", "疲惫"]
                  : ["平静", "焦虑", "专注", "疲惫", "警觉"],
        }
      : item,
  );
  const moodOptions =
    definitions.find((item) => item.key === "mood")?.textOptions ?? [];
  const characters = draft.characters.map((character) => ({
    ...character,
    attrs: {
      ...Object.fromEntries(
        Object.entries(character.attrs).filter(([key]) => commonKeys.has(key)),
      ),
      ...(moodOptions.length
        ? { mood: moodOptions[draft.characters.indexOf(character) % moodOptions.length] }
        : {}),
    },
  }));
  return {
    id,
    title,
    genre,
    description,
    draft: {
      ...draft,
      characters,
      title,
      worldview,
      initialTime: formatGameDateTime(initialTimeParts),
      initialTimeParts,
      worldMap: defaultWorldMapForGenre(genre),
      contextFiles: [
        ...defaultContextFiles(
          worldview,
          formatGameDateTime(initialTimeParts),
        ),
        ...draft.agents
          .filter((agent) => Boolean(agent.characterId))
          .map((agent) => ({
            id: `personal_story_${agent.characterId}`,
            title: `${agent.name}的个人剧情`,
            content: "",
          })),
      ],
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
    { ...DEFAULT_INITIAL_TIME_PARTS, description: "早晨", weekday: 1, hour: 8, minute: 30 },
    [{ key: "evidence", label: "证据掌握", valueType: "number" }],
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
    { description: "星环边境", era: "CE", year: 2187, month: 4, day: 12, hour: 6, minute: 0 },
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
    { description: "月影历·月升前", era: "CE", year: 302, month: 1, day: 1, hour: 18, minute: 0 },
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
  const characterAgentDrafts = new Map(
    tpl.agents
      .filter((agent) => Boolean(agent.characterId))
      .map((agent) => [agent.characterId as string, agent]),
  );
  const worldview = tpl.worldview.trim() || DEFAULT_WORLDVIEW;
  const initialDateTime = normalizeGameDateTime(tpl.initialTimeParts);
  const weekCycleEnabled = Boolean(tpl.weekCycleEnabled);
  const timeText = formatGameClock(initialDateTime, weekCycleEnabled);
  const contextFiles = (tpl.contextFiles?.length
    ? tpl.contextFiles
    : defaultContextFiles(worldview, timeText)
  ).map((file) => ({ ...file }));
  for (const required of [
    ["god_story", "上帝视角剧情"],
    ["personal_stories", "全个人剧情"],
  ] as const) {
    if (!contextFiles.some((file) => file.id === required[0])) {
      contextFiles.push({ id: required[0], title: required[1], content: "" });
    }
  }
  for (const character of chars) {
    const characterId = character.id ?? "";
    const fileId = `personal_story_${characterId}`;
    if (
      characterId &&
      !contextFiles.some((file) => file.id === fileId)
    ) {
      contextFiles.push({
        id: fileId,
        title: `${character.name || characterId}的个人剧情`,
        content: "",
      });
    }
  }
  const attributeDefinitions = normalizeAttributeDefinitions(
    tpl.attributeDefinitions,
    chars.map((character) => character.attrs),
  );
  const worldMap = tpl.worldMap ?? defaultWorldMapForGenre("古代悬疑");

  const agentIdMap = new Map<string, string>();
  for (let index = 0; index < chars.length; index += 1) {
    const t = chars[index];
    const sheetId = id("sheet");
    const agentId = id("char");
    const characterId = t.id ?? `character_${index}`;
    const agentDraft = characterAgentDrafts.get(characterId);
    agentIdMap.set(characterId, agentId);
    if (agentDraft) agentIdMap.set(agentDraft.id, agentId);
    const inventory = t.inventory
      .split(/[,，、]/)
      .map((x) => x.trim())
      .filter(Boolean);
    const name = agentDraft?.name?.trim() || t.name.trim() || "未命名";
    const persona = agentDraft?.persona ?? t.persona;
    const override =
      agentDraft?.systemPrompt?.trim() || t.systemPrompt?.trim() || "";
    sheets.push({
      id: sheetId,
      name,
      attrs: { ...t.attrs },
      inventory,
      flags: [],
      notes: "",
      position: t.position ?? { x: index % 3, y: Math.floor(index / 3) },
    });
    characters.push({
      id: agentId,
      kind: "character",
      characterId,
      name,
      sheetId,
      persona,
      systemPrompt: pickPromptOverride(
        override,
        characterSystemPrompt(name, persona),
      ),
      systemPromptOverride: override || undefined,
      modelOverride: agentDraft?.model ?? t.model,
      readableFileIds: agentDraft?.readableFileIds ?? t.readableFileIds,
      editableFileIds: agentDraft?.editableFileIds ?? t.editableFileIds,
      capabilities:
        agentDraft?.capabilities ??
        t.capabilities ??
        ["propose", "respond"],
      attributePermissions:
        agentDraft?.attributePermissions ?? t.attributePermissions,
      history: [],
    });
  }

  const systemAgents: GameAgent[] = tpl.agents
    .filter((draftAgent) => !draftAgent.characterId)
    .map((draftAgent) => {
    const agentId = id("agent");
    agentIdMap.set(draftAgent.id, agentId);
    const capabilities = [...draftAgent.capabilities];
    const fallbackPrompt = capabilities.includes("judge")
      ? refereeSystemPrompt(draftAgent.persona)
      : capabilities.includes("chronicle")
        ? chroniclerSystemPrompt("god")
        : capabilities.includes("world_open") ||
            capabilities.includes("respond") ||
            capabilities.includes("advance_clock")
          ? worldSystemPrompt(draftAgent.persona || worldview)
          : draftAgent.persona;
    return {
      id: agentId,
      kind: "agent",
      name: draftAgent.name.trim() || "未命名 AI",
      persona: draftAgent.persona,
      systemPrompt: pickPromptOverride(draftAgent.systemPrompt, fallbackPrompt),
      systemPromptOverride: draftAgent.systemPrompt?.trim() || undefined,
      modelOverride: draftAgent.model,
      capabilities,
      readableFileIds: draftAgent.readableFileIds,
      editableFileIds: draftAgent.editableFileIds,
      attributePermissions: draftAgent.attributePermissions,
      history: [],
    };
    });
  const agents = [...systemAgents, ...characters].map((agent) => ({
    ...agent,
    ...(() => {
      const access = informationAccessForAgent(
        informationPresetForAgent({
          capabilities: agent.capabilities,
          characterId:
            agent.kind === "character" ? agent.characterId : undefined,
        }),
        contextFiles.map((file) => file.id),
        attributeDefinitions.map((definition) => definition.key),
        agent.kind === "character" ? agent.characterId : undefined,
      );
      return {
        readableFileIds: Array.isArray(agent.readableFileIds)
          ? [...agent.readableFileIds]
          : access.readableFileIds,
        editableFileIds: Array.isArray(agent.editableFileIds)
          ? [...agent.editableFileIds]
          : access.editableFileIds,
        attributePermissions:
          agent.attributePermissions ?? access.attributePermissions,
      };
    })(),
  }));
  const agentIdForDraftValue = (value: string): string =>
    agentIdMap.get(value) ??
    agents.find((agent) => agent.id === value || agent.name === value)?.id ??
    value;
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
    worldMap,
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
      weekCycleEnabled,
      pipeline,
    },
    attributeDefinitions,
    playMode: tpl.playMode === "play" ? "play" : "spectate",
    playerCharacterId: null,
    godStory: "",
    playerStory: "",
    personalStories: Object.fromEntries(
      chars.map((character) => [character.id ?? "", ""]),
    ),
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
