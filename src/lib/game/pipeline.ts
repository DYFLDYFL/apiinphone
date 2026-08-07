import type {
  AgentFeatureKey,
  GamePipeline,
  PipelineEdge,
  PipelineEdgeWhen,
  PipelineNode,
} from "./types";

export const PIPELINE_EDGE_WHENS: PipelineEdgeWhen[] = [
  "always",
  "has_intents",
  "no_intents",
  "judge_accept",
  "judge_redo",
  "judge_reject",
];

export const PIPELINE_WHEN_LABELS: Record<PipelineEdgeWhen, string> = {
  always: "总是",
  has_intents: "有提案",
  no_intents: "无提案",
  judge_accept: "裁判通过",
  judge_redo: "裁判打回重做",
  judge_reject: "裁判驳回(不重做)",
};

export const MAX_PIPELINE_STEPS = 32;

/** 默认能力链：提供可直接运行的结构，但不预置流程标题。 */
export function defaultPipeline(bindings: {
  entryAgentIds?: string[];
  openAgentIds?: string[];
  proposeAgentIds?: string[];
  respondAgentIds?: string[];
  judgeAgentIds?: string[];
  chronicleAgentIds?: string[];
  clockAgentIds?: string[];
} = {}): GamePipeline {
  const nodes: PipelineNode[] = [
    { id: "n_open", name: "世界开场", executionCapabilities: ["world_open"], agentIds: bindings.openAgentIds },
    { id: "n_propose", name: "角色提案", executionCapabilities: ["propose"], agentIds: bindings.proposeAgentIds },
    { id: "n_respond", name: "回应互动", executionCapabilities: ["respond"], agentIds: bindings.respondAgentIds },
    { id: "n_judge", name: "裁判裁定", executionCapabilities: ["judge"], agentIds: bindings.judgeAgentIds },
    { id: "n_chronicle", name: "整理剧情", executionCapabilities: ["chronicle"], agentIds: bindings.chronicleAgentIds },
    { id: "n_clock", name: "推进时刻", executionCapabilities: ["advance_clock"], agentIds: bindings.clockAgentIds },
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
  return {
    entryAgentIds: [...(bindings.entryAgentIds ?? bindings.openAgentIds ?? [])],
    nodes,
    edges,
  };
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
    if (typeof n.name !== "string") {
      errors.push(`节点标题无效：${n.id}`);
    }
  }
  if (!Array.isArray(p.entryAgentIds) && !nodes.some((node) => Array.isArray(node.agentIds) && node.agentIds.length)) {
    errors.push("缺少入口 AI");
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
  if (!nodes.some((n) => n && Array.isArray(n.agentIds) && n.agentIds.length)) {
    warnings.push("没有节点绑定执行 AI");
  }
  if (!nodes.some((n) => n && n.executionCapabilities?.includes("advance_clock"))) {
    warnings.push("未包含拨钟能力节点，推进后可能不拨钟");
  }
  if (!nodes.some((n) => n && n.executionCapabilities?.includes("propose"))) {
    warnings.push("未包含提案能力节点");
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
    name: typeof n.name === "string" ? n.name.trim() : "",
    executionCapabilities: Array.isArray(n.executionCapabilities)
      ? n.executionCapabilities.filter(
          (feature): feature is AgentFeatureKey =>
            typeof feature === "string" &&
            [
              "world_open",
              "propose",
              "respond",
              "judge",
              "chronicle",
              "advance_clock",
            ].includes(feature),
        )
      : undefined,
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
    entryAgentIds: Array.isArray(p.entryAgentIds)
      ? p.entryAgentIds.map(String)
      : (nodes[0]?.agentIds ?? []),
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
