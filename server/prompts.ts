import crypto from "node:crypto";
import type { KnowledgeReference, MarketingTaskType, TenantFactRecord } from "../src/domain/types";

export interface MarketingPromptContext {
  skill_route: string[];
  knowledge_refs: KnowledgeReference[];
  tenant_facts: TenantFactRecord[];
  business_evidence_refs: string[];
  knowledge_conflicts: string[];
  growth_posture: "aggressive";
}

const SHARED_POLICY = `你是 Trust-to-Action 企业微信营销大脑。你的工作是输出可审阅的营销决策候选，不执行任何外部动作。

严格优先级：
1. 系统、隐私、授权、审批、事实、服务容量与禁止自动外发规则；
2. 已发布企业事实和输入中的有效业务证据；
3. 企业微信领域规则；
4. 匹配市场的专用规则；
5. 进攻型增长战术；
6. 通用理论。

理论、经验和知识只能解释策略，不能替代产品事实、客户证明或成交事实。只引用输入中的 evidence/ref ID，不得创造引用。
默认增长姿态为 aggressive：聚焦窄市场，提高内容密度，快速设计可测实验，放大已经有效的组合。但任何授权、频控、事实、证明审批或服务容量冲突都必须先服从门禁。
不得声称已发布、已发送、已报价或已取得结果。不得输出隐藏推理过程，只输出可核对的依据、假设和不确定项。`;

const TASK_INSTRUCTIONS: Record<MarketingTaskType, string> = {
  weekly_strategy: `生成一周策略：选择一个窄目标市场和一个主要经营矛盾；将 T/I/D/A 配比合计为 100；每个内容槽只有一个 CTA；为每项建议绑定业务证据，并给出量化复查计划。`,
  content_brief: `生成内容 Brief：固定目标客户、T/I/D/A 阶段、朋友圈主角度、关键事实、证明需求、唯一 CTA 和截止时间。少于三个独立会话的个体信号不能描述成趋势。`,
  content_draft: `生成朋友圈主稿：只使用已发布企业事实和有效证明；表达直接、克制、事实优先；保持一个 CTA；涉及客户原话、案例、数字、价格或承诺时保留审批标记。`,
  customer_nba: `评估客户状态与下一最佳动作：弱信号不能独立推动 D1/A1；状态最多前进一步；D1/A1 需要有效强证据；C1 需要成交事实。证据不足时保持状态并返回 insufficient_evidence。`,
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function buildMarketingPrompt(task: MarketingTaskType, context: MarketingPromptContext) {
  const knowledge = context.knowledge_refs.map((item) => `[${item.chunk_id}] ${item.source_title} > ${item.heading_path.join(" > ")} (${item.knowledge_kind}, ${item.skill})\n${item.excerpt}`).join("\n\n");
  const facts = context.tenant_facts.map((item) => `[${item.id}] ${item.type}/${item.title}: ${item.statement}`).join("\n");
  return `${SHARED_POLICY}\n\n当前任务：${TASK_INSTRUCTIONS[task]}\n\n已路由 SKILL：${context.skill_route.join(" -> ")}\n业务证据 ID：${context.business_evidence_refs.join(", ") || "无"}\n知识冲突：${context.knowledge_conflicts.join("；") || "无"}\n\n已发布企业事实：\n${facts || "无。不得补造企业事实。"}\n\n检索知识：\n${knowledge}`;
}

export const MARKETING_PROMPT_HASHES = Object.fromEntries((Object.keys(TASK_INSTRUCTIONS) as MarketingTaskType[]).map((task) => [task, crypto.createHash("sha256").update(`${SHARED_POLICY}\n${TASK_INSTRUCTIONS[task]}`).digest("hex").slice(0, 16)])) as Record<MarketingTaskType, string>;

export function marketingInputFingerprint(input: unknown, context: MarketingPromptContext) {
  return crypto.createHash("sha256").update(stableJson({ input, context: { ...context, knowledge_refs: context.knowledge_refs.map((item) => ({ chunk_id: item.chunk_id, version: item.version })), tenant_facts: context.tenant_facts.map((item) => item.id) } })).digest("hex");
}
