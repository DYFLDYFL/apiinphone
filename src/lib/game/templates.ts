import {
  characterSystemPrompt,
  refereeSystemPrompt,
  worldSystemPrompt,
} from "./prompts";
import type { GameAgent, GameSheet, GameState } from "./types";

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

export const DEFAULT_WORLDVIEW =
  "青石镇：边陲小镇，晨雾常在。有药房、铁匠铺、杂货铺与广场。民风朴实却暗流涌动，江湖传闻与邻里琐事交织。物理与人情须自洽；银钱、伤势、距离不可空口捏造。";

export type CharTemplateDraft = {
  name: string;
  persona: string;
  attrs: Record<string, string | number | boolean>;
  inventory: string;
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
  characters: CharTemplateDraft[];
};

export function defaultTemplateDraft(characterCount = 3): GameTemplateDraft {
  const n = Math.min(6, Math.max(2, Math.round(characterCount)));
  return {
    title: "青石镇",
    worldview: DEFAULT_WORLDVIEW,
    characters: CHAR_TEMPLATES.slice(0, n).map((c) => ({
      ...c,
      attrs: { ...c.attrs },
    })),
  };
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
    sheets.push({
      id: sheetId,
      name: t.name.trim() || "未命名",
      attrs: { ...t.attrs },
      inventory,
      flags: [],
      notes: "",
    });
    characters.push({
      id: agentId,
      kind: "character",
      name: t.name.trim() || "未命名",
      sheetId,
      persona: t.persona,
      systemPrompt: characterSystemPrompt(t.name, t.persona),
      history: [],
    });
  }

  const worldview = tpl.worldview.trim() || DEFAULT_WORLDVIEW;
  const world: GameAgent = {
    id: id("world"),
    kind: "world",
    name: "世界",
    persona: worldview,
    systemPrompt: worldSystemPrompt(worldview),
    history: [],
  };

  const referee: GameAgent = {
    id: id("ref"),
    kind: "referee",
    name: "裁判",
    persona: "公正、简练、只认面板与事件。",
    systemPrompt: refereeSystemPrompt(),
    history: [],
  };

  return {
    id: id("game"),
    title: tpl.title.trim() || "新游戏",
    createdAt: now,
    updatedAt: now,
    worldview,
    worldClock: {
      tick: 0,
      label: "第 0 时",
      sceneSummary: "晨雾未散，青石镇刚醒。",
    },
    agents: [world, ...characters, referee],
    sheets,
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
      },
    ],
    tickBuffer: null,
    settings: {
      maxInteractionRounds: 6,
      characterCount: characters.length,
    },
  };
}
