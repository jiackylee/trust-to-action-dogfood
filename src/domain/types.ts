import type { AiMeta, CustomerEvaluation, Evidence, EvidenceStrength, StateCode, WeeklyRetrospective, WeeklyStrategy } from "./schemas";

export type Role = "operations" | "sales" | "lead";
export type Status = "pending" | "ready" | "review" | "approved" | "returned" | "done" | "blocked";
export type PublicationChannel = "朋友圈" | "销售" | "官网" | "仅内部";
export type ApprovalStatus = "not_required" | "required" | "pending" | "approved" | "returned";

export type Versioned<T> = T & { id: string; revision: number; updated_at: string };

export interface CustomerNote {
  id: string;
  text: string;
  actor: string;
  at: string;
}

export interface NbaDecision {
  decision: "accepted" | "modified" | "rejected";
  action: string;
  reason: string;
  actor: string;
  decided_at: string;
  task_id: string | null;
}

export type EvaluationDecisionKind = "accepted" | "modified" | "rejected";
export type EvaluationReasonCode = "wrong_state" | "wrong_evidence" | "wrong_nba" | "missing_context" | "risk_compliance" | "too_generic" | "other";
export type EvaluationReviewOutcome = "retained" | "quality_reversal" | "new_evidence";

export interface ModelAttempt {
  model: string;
  status: "success" | "failed" | "escalated";
  latency_ms: number;
  response_id: string | null;
  error_code: string | null;
}

export interface GenerationRunCore {
  task: "customer_evaluation";
  subject_id: string;
  status: "success" | "blocked" | "failed";
  model: string;
  prompt_version: string;
  router_version: string;
  route_reason: string;
  attempts: ModelAttempt[];
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  input_fingerprint: string;
  response_id: string | null;
  error_code: string | null;
  created_at: string;
}
export type GenerationRun = Versioned<GenerationRunCore>;

export interface EvaluationCandidateCore {
  customer_id: string;
  customer_revision: number;
  evidence_fingerprint: string;
  evaluation: CustomerEvaluation;
  ai_meta: AiMeta;
  run_id: string;
  status: "pending" | "accepted" | "modified" | "rejected" | "stale";
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decision_id: string | null;
}
export type EvaluationCandidate = Versioned<EvaluationCandidateCore>;

export interface EvaluationDecisionCore {
  candidate_id: string;
  customer_id: string;
  decision: EvaluationDecisionKind;
  original_evaluation: CustomerEvaluation;
  final_evaluation: CustomerEvaluation | null;
  reason_code: EvaluationReasonCode | null;
  reason_note: string;
  actor: string;
  decided_at: string;
  reviewed_within_48h: boolean;
  review_outcome: EvaluationReviewOutcome | null;
  review_reason: string;
  reviewed_at: string | null;
}
export type EvaluationDecision = Versioned<EvaluationDecisionCore>;

export interface PromptVersionCore {
  name: string;
  task: "customer_evaluation";
  status: "draft" | "published" | "archived";
  description: string;
  created_by: string;
  published_by: string | null;
  published_at: string | null;
}
export type PromptVersion = Versioned<PromptVersionCore>;

export interface RouterVersionCore {
  name: string;
  status: "draft" | "published" | "archived";
  primary_model: string;
  fast_model: string;
  confidence_threshold: number;
  description: string;
  created_by: string;
  published_by: string | null;
  published_at: string | null;
}
export type RouterVersion = Versioned<RouterVersionCore>;

export interface GoldenCaseCore {
  split: "development" | "holdout";
  scenario: string;
  industry: string;
  state_before: StateCode;
  evidence_strength: EvidenceStrength;
  anomaly: string | null;
  expected_state: StateCode;
  acceptable_nba: CustomerEvaluation["recommendation"][];
  expected_evidence_refs: string[];
  future_event: "retained" | "quality_reversal" | "new_evidence";
  double_reviewed: boolean;
}
export type GoldenCase = Versioned<GoldenCaseCore>;

export interface EvalScore {
  state_accuracy: number;
  nba_acceptability: number;
  evidence_precision: number;
  policy_violations: number;
  privacy_leaks: number;
  first_draft_adoption: number;
  adoption_improvement_points: number;
  critical_slice_regression: number;
  p95_latency_ms: number;
  passed: boolean;
}

export interface EvalRunCore {
  prompt_version_id: string;
  router_version_id: string;
  split: "development" | "holdout";
  status: "running" | "completed" | "failed";
  case_count: number;
  score: EvalScore | null;
  started_at: string;
  completed_at: string | null;
  generated_by: string;
}
export type EvalRun = Versioned<EvalRunCore>;

export interface AiQualityMetrics {
  first_draft_adoption_rate: number;
  baseline_adoption_rate: number;
  review_coverage_rate: number;
  reviewed_candidates: number;
  mature_candidates: number;
  pending_candidates: number;
  stale_candidates: number;
  state_accuracy: number;
  nba_acceptability: number;
  evidence_precision: number;
  p95_latency_ms: number;
  fast_model_share: number;
  escalation_rate: number;
  policy_violations: number;
  privacy_leaks: number;
}

export interface CustomerCore {
  name: string;
  company: string;
  title: string;
  owner: string;
  shared: boolean;
  industry: string;
  size: string;
  source: string;
  tags: string[];
  state: StateCode;
  confidence: number;
  evidence_strength: EvidenceStrength;
  last_interaction: string;
  last_interaction_at: string;
  review_at: string;
  anomaly: string | null;
  kf_summary: string;
  evidence: Evidence[];
  evaluation: CustomerEvaluation | null;
  evaluation_meta: { model: string; response_id: string; prompt_version: string } | null;
  notes: CustomerNote[];
  nba_decision: NbaDecision | null;
}
export type Customer = Versioned<CustomerCore>;

export interface DraftCore {
  title: string;
  stage: "T" | "I" | "D" | "A";
  segment: string;
  objective: string;
  body: string;
  cta: string;
  expected_transition: string;
  channel: PublicationChannel;
  evidence_refs: string[];
  risk_flags: string[];
  approval_required: boolean;
  approval_status: ApprovalStatus;
  status: Status;
  published_at: string | null;
  result: string | null;
  brief_id: string | null;
  content_family_id: string | null;
  variant_of: string | null;
}
export type Draft = Versioned<DraftCore>;

export interface ProofCore {
  title: string;
  industry: string;
  redacted_quote: string;
  process: string;
  baseline: string;
  result: string;
  period: string;
  authorization: PublicationChannel[];
  expires_at: string;
  completeness: number;
  status: "usable" | "internal_only" | "incomplete" | "revoked";
  missing_fields: string[];
  referenced_by: string[];
}
export type Proof = Versioned<ProofCore>;

export interface ApprovalCore {
  object_id: string;
  object_type: "draft" | "proof";
  object_revision: number;
  title: string;
  type: string;
  requester: string;
  approver: string;
  status: "pending" | "approved" | "returned";
  summary: string;
  risk_flags: string[];
  evidence_refs: string[];
  reason: string;
  due_at: string;
}
export type Approval = Versioned<ApprovalCore>;

export interface TaskCore {
  customer_id: string;
  title: string;
  type: string;
  owner: string;
  priority: "high" | "medium" | "low";
  due_at: string;
  status: "pending" | "executed" | "done";
  outcome: string;
}
export type Task = Versioned<TaskCore>;

export interface IntegrationCore {
  name: string;
  description: string;
  scope: string;
  status: "healthy" | "delayed" | "partial" | "unauthorized";
  last_success_at: string | null;
  freshness: string;
  cursor: string;
  error: string;
}
export type Integration = Versioned<IntegrationCore>;

export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  detail: string;
  at: string;
  source: "human" | "ai" | "system";
}

export interface ArchiveConsentCore {
  customer_id: string;
  conversation_id: string;
  status: "agreed" | "declined" | "withdrawn";
  scope: string;
  agreed_at: string | null;
  changed_at: string;
}
export type ArchiveConsent = Versioned<ArchiveConsentCore>;

export interface ArchiveConversationCore {
  customer_id: string;
  owner: string;
  kind: "direct" | "group";
  display_name: string;
  participant_count: number;
  started_at: string;
  last_message_at: string;
  consent_id: string;
  message_count: number;
  latest_seq: number;
  sync_state: "healthy" | "seq_gap" | "decrypt_partial" | "outside_recovery_window";
}
export type ArchiveConversation = Versioned<ArchiveConversationCore>;

export interface ArchivedMessageCore {
  conversation_id: string;
  customer_id: string;
  owner: string;
  msgid: string;
  seq: number;
  sender: "customer" | "employee";
  sender_name: string;
  kind: "text" | "link" | "image" | "voice" | "video" | "file";
  text: string | null;
  link_description: string | null;
  media_name: string | null;
  sent_at: string;
  recalled: boolean;
  duplicate_of: string | null;
  decrypt_status: "ok" | "failed";
}
export type ArchivedMessage = Versioned<ArchivedMessageCore>;

export interface ConversationInsightCore {
  batch_id: string;
  title: string;
  category: "问题" | "异议" | "期望结果" | "购买信号";
  signal_type: string;
  customer_segment: string;
  summary: string;
  redacted_quotes: string[];
  message_refs: string[];
  conversation_refs: string[];
  distinct_conversation_count: number;
  confidence: number;
  evidence_strength: EvidenceStrength;
  trend_scope: "individual" | "trend";
  status: "candidate" | "accepted" | "dismissed";
  decision_reason: string;
  decided_by: string | null;
  decided_at: string | null;
  brief_id: string | null;
  invalidated_reason: string | null;
}
export type ConversationInsight = Versioned<ConversationInsightCore>;

export interface ContentBriefCore {
  title: string;
  insight_ids: string[];
  target_segment: string;
  stage: "T" | "I" | "D" | "A";
  primary_angle: string;
  key_facts: string[];
  proof_requirements: string[];
  cta: string;
  due_at: string;
  status: "draft" | "adopted" | "blocked";
  adopted_by: string | null;
  content_family_id: string | null;
  ai_meta: AiMeta | null;
}
export type ContentBrief = Versioned<ContentBriefCore>;

export interface ContentFamilyCore {
  brief_id: string;
  title: string;
  primary_draft_id: string;
  variant_draft_ids: string[];
}
export type ContentFamily = Versioned<ContentFamilyCore>;

export interface PublicationRecordCore {
  draft_id: string;
  content_family_id: string;
  channel: PublicationChannel;
  operator: string;
  published_at: string;
  status: "published" | "results_synced";
  association_window_days: 7;
  visible_customers: number | null;
  likes: number | null;
  comments: number | null;
  synced_at: string | null;
}
export type PublicationRecord = Versioned<PublicationRecordCore>;

export interface ContentOutcomeCore {
  publication_id: string;
  customer_id: string | null;
  type: "inquiry" | "demo" | "offer" | "state_transition";
  detail: string;
  occurred_at: string;
  recorded_by: string;
}
export type ContentOutcome = Versioned<ContentOutcomeCore>;

export interface AnalysisBatchCore {
  seq_from: number;
  seq_to: number;
  started_at: string;
  completed_at: string;
  message_refs: string[];
  insight_ids: string[];
  included_count: number;
  excluded_count: number;
  duplicate_count: number;
  decrypt_failure_count: number;
  cursor_status: "complete" | "gap" | "partial";
  model: string;
}
export type AnalysisBatch = Versioned<AnalysisBatchCore>;

export interface WeeklyRetrospectiveRecordCore {
  week_label: string;
  retrospective: WeeklyRetrospective;
  generated_by: string;
  ai_meta: AiMeta | null;
}
export type WeeklyRetrospectiveRecord = Versioned<WeeklyRetrospectiveRecordCore>;

export interface WeeklyPlan {
  strategy: WeeklyStrategy;
  status: "draft" | "ready";
  generated_by: string;
  generated_at: string;
}

export interface DomainState {
  fixture_version: number;
  role: Role;
  week: number;
  weekly_plan: WeeklyPlan;
  customers: Customer[];
  drafts: Draft[];
  proofs: Proof[];
  approvals: Approval[];
  tasks: Task[];
  integrations: Integration[];
  archive_consents: ArchiveConsent[];
  archive_conversations: ArchiveConversation[];
  archived_messages: ArchivedMessage[];
  conversation_insights: ConversationInsight[];
  content_briefs: ContentBrief[];
  content_families: ContentFamily[];
  publications: PublicationRecord[];
  content_outcomes: ContentOutcome[];
  analysis_batches: AnalysisBatch[];
  weekly_retrospective: WeeklyRetrospectiveRecord;
  generation_runs: GenerationRun[];
  evaluation_candidates: EvaluationCandidate[];
  evaluation_decisions: EvaluationDecision[];
  prompt_versions: PromptVersion[];
  router_versions: RouterVersion[];
  golden_cases: GoldenCase[];
  eval_runs: EvalRun[];
  audits: AuditEvent[];
}

export interface CustomerFilters {
  query: string;
  owner: string;
  state: StateCode | "all";
  evidence: EvidenceStrength | "all";
}

export interface ApiProblem {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  latest?: unknown;
}
