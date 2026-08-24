import { z } from "zod";

export const StateCodeSchema = z.enum(["T0", "T1", "I1", "D1", "A1", "C1"]);
export type StateCode = z.infer<typeof StateCodeSchema>;

export const EvidenceStrengthSchema = z.enum(["weak", "medium", "strong"]);
export type EvidenceStrength = z.infer<typeof EvidenceStrengthSchema>;

export const RecommendationActionSchema = z.enum([
  "继续观察",
  "发送知识内容",
  "询问资格问题",
  "分享 Demo",
  "分享案例",
  "创建跟进任务",
  "准备 Offer",
  "转人工",
]);

export const EvidenceSchema = z.object({
  id: z.string(),
  strength: EvidenceStrengthSchema,
  type: z.string(),
  text: z.string(),
  occurred_at: z.string(),
  source: z.string(),
  valid: z.boolean(),
  transaction_fact: z.boolean().default(false),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const CustomerEvaluationSchema = z.object({
  objective: z.string().min(1),
  target_segment: z.string().min(1),
  state_before: StateCodeSchema,
  state_after: StateCodeSchema,
  confidence: z.number().int().min(0).max(100),
  evidence_refs: z.array(z.string()).min(1),
  recommendation: RecommendationActionSchema,
  not_recommended: z.array(z.string()).max(3),
  draft: z.string(),
  cta: z.string(),
  expected_transition: z.string(),
  risk_flags: z.array(z.string()),
  approval_required: z.boolean(),
  next_review_at: z.string(),
});
export type CustomerEvaluation = z.infer<typeof CustomerEvaluationSchema>;

export const WeeklyStrategySchema = z.object({
  theme: z.string().min(1),
  objective: z.string().min(1),
  target_segments: z.array(z.string()).min(1).max(5),
  ratio: z.object({ trust: z.number(), interest: z.number(), desire: z.number(), action: z.number() }),
  evidence_gaps: z.array(z.string()).max(6),
  content_slots: z.array(z.object({ day: z.string(), stage: z.enum(["T", "I", "D", "A"]), topic: z.string(), cta: z.string() })).min(4).max(10),
  evidence_refs: z.array(z.string()),
  risk_flags: z.array(z.string()),
  next_review_at: z.string(),
});
export type WeeklyStrategy = z.infer<typeof WeeklyStrategySchema>;

export const ContentDraftProposalSchema = z.object({
  title: z.string().min(1),
  stage: z.enum(["T", "I", "D", "A"]),
  target_segment: z.string().min(1),
  objective: z.string().min(1),
  body: z.string().min(1),
  cta: z.string().min(1),
  expected_transition: z.string(),
  evidence_refs: z.array(z.string()),
  risk_flags: z.array(z.string()),
  approval_required: z.boolean(),
});
export type ContentDraftProposal = z.infer<typeof ContentDraftProposalSchema>;

export const RiskReviewSchema = z.object({
  summary: z.string(),
  risk_flags: z.array(z.string()),
  claims: z.array(z.object({ text: z.string(), evidence_ref: z.string().nullable(), valid: z.boolean(), reason: z.string() })),
  approval_recommended: z.boolean(),
  suggested_revision: z.string(),
});
export type RiskReview = z.infer<typeof RiskReviewSchema>;

export const ConversationInsightProposalSchema = z.object({
  title: z.string().min(1),
  category: z.enum(["问题", "异议", "期望结果", "购买信号"]),
  signal_type: z.string().min(1),
  customer_segment: z.string().min(1),
  summary: z.string().min(1),
  redacted_quotes: z.array(z.string()).min(1).max(5),
  message_refs: z.array(z.string()).min(1),
  conversation_refs: z.array(z.string()).min(1),
  confidence: z.number().int().min(0).max(100),
  evidence_strength: EvidenceStrengthSchema,
  recommended_angle: z.string().min(1),
});
export type ConversationInsightProposal = z.infer<typeof ConversationInsightProposalSchema>;

export const ConversationInsightsSchema = z.object({
  insights: z.array(ConversationInsightProposalSchema).min(1).max(20),
  excluded_message_count: z.number().int().min(0),
  analysis_note: z.string(),
});
export type ConversationInsights = z.infer<typeof ConversationInsightsSchema>;

export const ContentBriefProposalSchema = z.object({
  title: z.string().min(1),
  target_segment: z.string().min(1),
  stage: z.enum(["T", "I", "D", "A"]),
  primary_angle: z.string().min(1),
  key_facts: z.array(z.string()).min(1).max(6),
  proof_requirements: z.array(z.string()).max(6),
  cta: z.string().min(1),
  due_at: z.string(),
  insight_refs: z.array(z.string()).min(1),
});
export type ContentBriefProposal = z.infer<typeof ContentBriefProposalSchema>;

export const WeeklyRetrospectiveSchema = z.object({
  week_label: z.string().min(1),
  summary: z.string().min(1),
  top_themes: z.array(z.object({ theme: z.string(), reason: z.string(), business_results: z.number().int().min(0) })).max(5),
  bottlenecks: z.array(z.string()).max(6),
  next_week_candidates: z.array(z.object({ theme: z.string(), objective: z.string(), evidence_refs: z.array(z.string()) })).min(1).max(6),
  caveat: z.literal("时间关联，不代表因果"),
});
export type WeeklyRetrospective = z.infer<typeof WeeklyRetrospectiveSchema>;

export const AiMetaSchema = z.object({
  model: z.string(),
  response_id: z.string(),
  prompt_version: z.string(),
  generated_at: z.string(),
});
export type AiMeta = z.infer<typeof AiMetaSchema>;

export const AiResultSchema = <T extends z.ZodTypeAny>(schema: T) => z.object({ data: schema, meta: AiMetaSchema });

export const AiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    request_id: z.string(),
  }),
});

export type AiResult<T> = { data: T; meta: AiMeta };

export const STATE_ORDER: StateCode[] = ["T0", "T1", "I1", "D1", "A1", "C1"];
export const STATE_LABELS: Record<StateCode, string> = {
  T0: "未建立认知",
  T1: "专家认可",
  I1: "产品兴趣",
  D1: "结果欲望",
  A1: "行动准备",
  C1: "已成交",
};
