import type {
  GamePipeline,
  PipelineEdge,
  PipelineEdgeWhen,
  PipelineNode,
  PipelineNodeKind,
} from "./types";

export const PIPELINE_NODE_KINDS: PipelineNodeKind[] = [
  "agent",
  "world_open",
  "propose",
  "respond",
  "judge",
  "chronicle",
  "advance_clock",
];

export const PIPELINE_EDGE_WHENS: PipelineEdgeWhen[] = [
  "always",
  "has_intents",
  "no_intents",
  "judge_accept",
  "judge_redo",
  "judge_reject",
];

export const PIPELINE_KIND_LABELS: Record<PipelineNodeKind, string> = {
  agent: "自由 AI 节点",
  world_open: "世界开场",
  propose: "角色提案",
  respond: "对端回应",
  judge: "裁判裁定",
  chronicle: "整理剧情",
  advance_clock: "世界拨钟",
};

export const PIPELINE_WHEN_LABELS: Record<PipelineEdgeWhen, string> = {
  always: "总是",
  has_intents: "有提案",
  no_intents: "无提案",
  judge_accept: "裁判通过",
  judge_redo: "裁判打回重做",
  judge_reject: "裁判驳回(不重做)",
};

export const MAX_PIPELINE_STEPS = 32;

/** 默认流水线：等价于旧版写死的推进一轮。 */
export function defaultPipeline(): GamePipeline {
  const nodes: PipelineNode[] = [
    { id: "n_open", kind: "world_open", label: "世界开场" },
    { id: "n_propose", kind: "propose", label: "角色提案" },
    { id: "n_respond", kind: "respond", label: "对端回应" },
    { id: "n_judge", kind: "judge", label: "裁判裁定" },
    { id: "n_chronicle", kind: "chronicle", label: "整理剧情" },
    { id: "n_clock", kind: "advance_clock", label: "世界拨钟" },
  ];
  const edges: PipelineEdge[] = [
    { from: "n_open", to: "n_propose", when: "always" },
    { from: "n_propose", to: "n_respond", when: "has_intents" },
    { from: "n_propose", to: "n_chronicle", when: "no_intents" },
    { from: "n_respond", to: "n_judge", when: "always" },
    { from: "n_judge", to: "n_propose", when: "judge_redo" },
    { from: "n_judge", to: "n_chronicle", when: "judge_accept" },
    { from: "n_judge", to: "n_chronicle", when: "judge_reject" },
    { from: "n_chronicle", to: "n_clock", when: "always" },
  ];
  return { entry: "n_open", nodes, edges };
}

function isNodeKind(v: unknown): v is PipelineNodeKind {
  return (
    typeof v === "string" &&
    (PIPELINE_NODE_KINDS as string[]).includes(v)
  );
}

function isEdgeWhen(v: unknown): v is PipelineEdgeWhen {
  return (
    typeof v === "string" &&
    (PIPELINE_EDGE_WHENS as string[]).includes(v)
  );
}

export type PipelineRouteFlags = {
  hasIntents?: boolean;
  judgeOutcome?: "accept" | "redo" | "reject";
};

/** 按边列表顺序取第一条匹配的出边目标；无匹配返回 null（结束）。 */
export function selectNextNodeId(
  pipeline: GamePipeline,
  fromId: string,
  flags: PipelineRouteFlags,
): string | null {
  const outs = pipeline.edges.filter((e) => e.from === fromId);
  for (const e of outs) {
    if (edgeMatches(e.when, flags)) return e.to;
  }
  return null;
}

function edgeMatches(when: PipelineEdgeWhen, flags: PipelineRouteFlags): boolean {
  switch (when) {
    case "always":
      return true;
    case "has_intents":
      return Boolean(flags.hasIntents);
    case "no_intents":
      return !flags.hasIntents;
    case "judge_accept":
      return flags.judgeOutcome === "accept";
    case "judge_redo":
      return flags.judgeOutcome === "redo";
    case "judge_reject":
      return flags.judgeOutcome === "reject";
    default:
      return false;
  }
}

export type PipelineValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

export function validatePipeline(raw: unknown): PipelineValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["流水线缺失"], warnings };
  }
  const p = raw as Partial<GamePipeline>;
  if (!Array.isArray(p.nodes) || !p.nodes.length) {
    errors.push("至少需要一个节点");
  }
  if (!Array.isArray(p.edges)) {
    errors.push("边列表无效");
  }
  const nodes = Array.isArray(p.nodes) ? p.nodes : [];
  const edges = Array.isArray(p.edges) ? p.edges : [];
  const ids = new Set<string>();
  for (const n of nodes) {
    if (!n || typeof n !== "object") {
      errors.push("存在无效节点");
      continue;
    }
    if (typeof n.id !== "string" || !n.id.trim()) {
      errors.push("节点缺少 id");
      continue;
    }
    if (ids.has(n.id)) errors.push(`重复节点 id：${n.id}`);
    ids.add(n.id);
    if (!isNodeKind(n.kind)) errors.push(`未知节点类型：${String(n.kind)}`);
  }
  if (typeof p.entry !== "string" || !p.entry.trim()) {
    errors.push("缺少入口节点");
  } else if (ids.size && !ids.has(p.entry)) {
    errors.push(`入口节点不存在：${p.entry}`);
  }
  for (const e of edges) {
    if (!e || typeof e !== "object") {
      errors.push("存在无效边");
      continue;
    }
    if (!ids.has(e.from) || !ids.has(e.to)) {
      errors.push(`边端点无效：${e.from} → ${e.to}`);
    }
    if (!isEdgeWhen(e.when)) {
      errors.push(`未知边条件：${String(e.when)}`);
    }
  }
  const kinds = new Set(
    nodes.filter((n) => n && isNodeKind(n.kind)).map((n) => n.kind),
  );
  if (!kinds.has("advance_clock")) {
    warnings.push("未包含「世界拨钟」节点，推进后可能不拨钟");
  }
  if (!kinds.has("propose")) {
    warnings.push("未包含「角色提案」节点");
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** 规范化或回退默认图。 */
export function normalizePipeline(raw: unknown): GamePipeline {
  const check = validatePipeline(raw);
  if (!check.ok) return defaultPipeline();
  const p = raw as GamePipeline;
  const nodes: PipelineNode[] = p.nodes.map((n) => ({
    id: String(n.id).trim(),
    kind: n.kind,
    label: typeof n.label === "string" ? n.label : undefined,
    agentIds: Array.isArray(n.agentIds) ? n.agentIds.map(String) : undefined,
    targetIds: Array.isArray(n.targetIds) ? n.targetIds.map(String) : undefined,
    dispatchMode: n.dispatchMode === "parallel" ? "parallel" : "serial",
  }));
  const edges: PipelineEdge[] = p.edges.map((e) => ({
    from: String(e.from).trim(),
    to: String(e.to).trim(),
    when: e.when,
  }));
  return {
    entry: String(p.entry).trim(),
    nodes,
    edges,
  };
}

export function newPipelineNodeId(existing: PipelineNode[]): string {
  let i = 1;
  const ids = new Set(existing.map((n) => n.id));
  while (ids.has(`n_${i}`)) i += 1;
  return `n_${i}`;
}
