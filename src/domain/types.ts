import type { CustomerEvaluation, Evidence, EvidenceStrength, StateCode, WeeklyStrategy } from "./schemas";

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
