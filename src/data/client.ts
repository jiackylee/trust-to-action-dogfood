import { createFixtureState } from "../domain/fixtures";
import { sessionClient } from "./session-client";
import { actorForRole, can, canAccessCustomer, canActOnTask, canViewRawConversation } from "../domain/permissions";
import { draftApprovalRisks, insightTrendScope, isMaterialDraftChange, proofCompleteness, proofIsUsable, validateCustomerEvaluation, validateInsightLineage } from "../domain/policy";
import { candidateIsStale, evidenceFingerprint, scoreGoldenReplay } from "../domain/quality";
import type { AiMeta, CustomerEvaluation, WeeklyRetrospective } from "../domain/schemas";
import type { AnalysisBatch, ApiProblem, Approval, ContentBrief, ContentOutcome, ConversationInsight, DomainState, Draft, EvalRun, EvaluationCandidate, EvaluationDecision, EvaluationDecisionKind, EvaluationReasonCode, EvaluationReviewOutcome, GenerationRun, KnowledgePackVersion, KnowledgeRetrievalRun, KnowledgeSource, MarketingDecisionCandidate, MarketingDecisionDecision, MarketingDecisionKind, MarketingDecisionOutput, MarketingDecisionReasonCode, MarketingReviewOutcome, MarketingTaskType, ModelProfileVersion, NbaDecision, Proof, ProofCore, ProviderCapability, ProviderConnectionProfile, PublicationRecord, Role, Task } from "../domain/types";

const STORAGE_KEY = "trust-to-action-dogfood-v2-3";
const FIXTURE_VERSION = 8;

export type NewProof = Omit<ProofCore, "completeness" | "missing_fields" | "referenced_by">;

export interface DataClient {
  getState(): Promise<DomainState>;
  setRole(role: Role): Promise<DomainState>;
  saveDraft(draft: Draft, expectedRevision: number): Promise<DomainState>;
  submitDraftApproval(id: string, expectedRevision: number): Promise<DomainState>;
  saveProof(proof: Proof, expectedRevision: number): Promise<DomainState>;
  createProof(proof: NewProof): Promise<DomainState>;
  decideEvaluationCandidate(customerId: string, candidateId: string, decision: EvaluationDecisionKind, evaluation: CustomerEvaluation | null, reasonCode: EvaluationReasonCode | null, reasonNote: string, expectedRevision: number): Promise<DomainState>;
  recordEvaluationReview(decisionId: string, outcome: EvaluationReviewOutcome, reason: string, expectedRevision: number): Promise<DomainState>;
  saveMarketingCandidate(candidate: MarketingDecisionCandidate): Promise<DomainState>;
  decideMarketingCandidate(candidateId: string, decision: MarketingDecisionKind, output: MarketingDecisionOutput | null, reasonCode: MarketingDecisionReasonCode | null, reasonNote: string, expectedRevision: number): Promise<DomainState>;
  recordMarketingReview(decisionId: string, outcome: MarketingReviewOutcome, reason: string, expectedRevision: number): Promise<DomainState>;
  runGoldenEvaluation(marketingBrainVersionId: string, routerVersionId: string, split: "development" | "holdout"): Promise<DomainState>;
  startLiveHoldout(marketingBrainVersionId: string, routerVersionId: string, idempotencyKey: string): Promise<DomainState>;
  pauseLiveHoldout(runId: string, expectedRevision: number): Promise<DomainState>;
  createRouterVersion(name: string, description: string, confidenceThreshold: number): Promise<DomainState>;
  promoteAiVersion(kind: "brain" | "router", versionId: string, expectedRevision: number): Promise<DomainState>;
  rollbackAiVersion(kind: "brain" | "router", versionId: string, expectedRevision: number): Promise<DomainState>;
  decideNba(customerId: string, decision: NbaDecision["decision"], action: string, reason: string, expectedRevision: number): Promise<DomainState>;
  addCustomerNote(customerId: string, text: string, expectedRevision: number): Promise<DomainState>;
  decideApproval(id: string, decision: "approved" | "returned", reason: string, expectedRevision: number): Promise<DomainState>;
  recordTaskOutcome(id: string, outcome: string, expectedRevision: number): Promise<DomainState>;
  saveInsightBatch(batch: AnalysisBatch, insights: ConversationInsight[]): Promise<DomainState>;
  decideInsight(id: string, decision: "accepted" | "dismissed", reason: string, edits: Partial<Pick<ConversationInsight, "title" | "summary" | "customer_segment">>, expectedRevision: number): Promise<DomainState>;
  saveBrief(brief: ContentBrief, expectedRevision: number): Promise<DomainState>;
  recordRawAccess(conversationId: string, purpose: string): Promise<DomainState>;
  markPublished(draftId: string, expectedRevision: number): Promise<DomainState>;
  syncPublicationResults(id: string, expectedRevision: number): Promise<DomainState>;
  recordContentOutcome(publicationId: string, type: ContentOutcome["type"], detail: string, customerId: string | null): Promise<DomainState>;
  saveWeeklyRetrospective(retrospective: WeeklyRetrospective, meta: AiMeta | null, generatedBy: string, expectedRevision: number): Promise<DomainState>;
  saveWeeklyPlan(strategy: DomainState["weekly_plan"]["strategy"], generatedBy: string): Promise<DomainState>;
  restoreSnapshot(snapshot: DomainState): Promise<DomainState>;
  reset(): Promise<DomainState>;
}

function problem(status: number, code: string, message: string, retryable = false, latest?: unknown): ApiProblem {
  return { status, code, message, retryable, latest };
}

function now() { return new Date().toISOString(); }
function id(prefix: string) { return `${prefix}-${crypto.randomUUID()}`; }

function samePromptHashes(left: Record<MarketingTaskType, string>, right: Record<MarketingTaskType, string>) {
  return (["weekly_strategy", "content_brief", "content_draft", "customer_nba"] as MarketingTaskType[]).every((task) => left[task] === right[task]);
}

function sameBrainBinding(left: DomainState["marketing_brain_versions"][number], knowledgePackId: string, promptHashes: Record<MarketingTaskType, string>) {
  return left.knowledge_pack_version_id === knowledgePackId && samePromptHashes(left.prompt_hashes, promptHashes);
}

function recalculateProofReferences(proofs: Proof[], drafts: Draft[]) {
  return proofs.map((proof) => ({ ...proof, referenced_by: drafts.filter((draft) => draft.evidence_refs.includes(proof.id)).map((draft) => draft.id) }));
}

function normalizeProof(proof: Proof): Proof {
  const completeness = proofCompleteness(proof);
  const expired = new Date(proof.expires_at).getTime() < Date.now();
  const status = proof.status === "revoked" || expired
    ? "revoked" as const
    : completeness.missing_fields.length
      ? "incomplete" as const
      : proof.authorization.every((item) => item === "仅内部")
        ? "internal_only" as const
        : "usable" as const;
  return { ...proof, ...completeness, status };
}

export interface StateDataClientOptions {
  initialState: DomainState;
  persist?: (state: DomainState) => void;
  latency?: () => Promise<void>;
  reset?: () => DomainState;
}

export class StateDataClient implements DataClient {
  #state: DomainState;
  #persistState: (state: DomainState) => void;
  #wait: () => Promise<void>;
  #resetState: () => DomainState;

  constructor(options: StateDataClientOptions) {
    this.#state = structuredClone(options.initialState);
    this.#persistState = options.persist ?? (() => undefined);
    this.#wait = options.latency ?? (async () => undefined);
    this.#resetState = options.reset ?? createFixtureState;
  }

  #persist(next: DomainState) {
    this.#state = next;
    this.#persistState(next);
    return structuredClone(next);
  }

  async #latency() { await this.#wait(); }
  async getState() { await this.#latency(); return structuredClone(this.#state); }
  async setRole(role: Role) { await this.#latency(); return this.#persist({ ...this.#state, role }); }

  async createProviderConnection(connection: ProviderConnectionProfile) {
    await this.#latency();
    if (!can(this.#state.role, "configure_ai")) throw problem(403, "FORBIDDEN", "当前角色不能配置模型连接");
    if (this.#state.provider_connections.some((item) => item.id === connection.id)) throw problem(409, "VERSION_CONFLICT", "模型连接 ID 已存在");
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: "创建模型连接", detail: `${connection.name} · ${connection.provider} · ${connection.protocol}`, at: now(), source: "human" as const };
    return this.#persist({ ...this.#state, provider_connections: [connection, ...this.#state.provider_connections], audits: [audit, ...this.#state.audits] });
  }

  async createModelProfile(profile: ModelProfileVersion) {
    await this.#latency();
    if (!can(this.#state.role, "configure_ai")) throw problem(403, "FORBIDDEN", "当前角色不能创建模型 Profile");
    const connection = this.#state.provider_connections.find((item) => item.id === profile.connection_profile_id);
    if (!connection) throw problem(404, "CONNECTION_NOT_FOUND", "模型连接不存在");
    if (connection.provider !== profile.provider || connection.protocol !== profile.protocol) throw problem(422, "CAPABILITY_MISMATCH", "模型 Profile 与连接协议不一致");
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: "创建模型 Profile", detail: `${profile.name} · ${profile.primary_model}`, at: now(), source: "human" as const };
    return this.#persist({ ...this.#state, model_profiles: [profile, ...this.#state.model_profiles], audits: [audit, ...this.#state.audits] });
  }

  async recordConnectionTest(connectionId: string, capability: ProviderCapability, credentialSource: "environment" | "runtime" | "none", expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "configure_ai")) throw problem(403, "FORBIDDEN", "当前角色不能测试模型连接");
    const connection = this.#state.provider_connections.find((item) => item.id === connectionId);
    if (!connection) throw problem(404, "CONNECTION_NOT_FOUND", "模型连接不存在");
    if (connection.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "模型连接已更新", true, connection);
    const testedAt = now();
    const updated: ProviderConnectionProfile = { ...connection, capabilities: capability, credential_source: credentialSource, credential_available: connection.auth_mode === "none" || credentialSource !== "none", last_tested_at: testedAt, last_error_code: null, revision: connection.revision + 1, updated_at: testedAt };
    const profiles = this.#state.model_profiles.map((item): ModelProfileVersion => item.connection_profile_id === connectionId && ["draft", "credential_missing"].includes(item.status) ? { ...item, status: "connection_verified", revision: item.revision + 1, updated_at: testedAt } : item);
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: "验证模型连接", detail: `${connection.name} · Structured Output 可用`, at: testedAt, source: "human" as const };
    return this.#persist({ ...this.#state, provider_connections: this.#state.provider_connections.map((item) => item.id === connectionId ? updated : item), model_profiles: profiles, audits: [audit, ...this.#state.audits] });
  }

  async clearConnectionCredential(connectionId: string) {
    await this.#latency();
    if (!can(this.#state.role, "configure_ai")) throw problem(403, "FORBIDDEN", "当前角色不能清除模型凭据");
    const changedAt = now();
    const connections = this.#state.provider_connections.map((item): ProviderConnectionProfile => item.id === connectionId
      ? { ...item, credential_source: item.credential_ref ? "environment" : "none", credential_available: false, revision: item.revision + 1, updated_at: changedAt }
      : item);
    const profiles = this.#state.model_profiles.map((item): ModelProfileVersion => item.connection_profile_id === connectionId && item.status === "active" ? { ...item, status: "credential_missing", revision: item.revision + 1, updated_at: changedAt } : item);
    return this.#persist({ ...this.#state, provider_connections: connections, model_profiles: profiles, audits: [{ id: id("audit"), actor: actorForRole(this.#state.role), action: "清除模型会话凭据", detail: connectionId, at: changedAt, source: "human" as const }, ...this.#state.audits] });
  }

  async markModelProfileSmoke(profileId: string, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "configure_ai")) throw problem(403, "FORBIDDEN", "当前角色不能运行模型 Smoke");
    const profile = this.#state.model_profiles.find((item) => item.id === profileId);
    if (!profile) throw problem(404, "PROFILE_NOT_FOUND", "模型 Profile 不存在");
    if (profile.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "模型 Profile 已更新", true, profile);
    const testedAt = now();
    const updated: ModelProfileVersion = { ...profile, status: "trial_ready", smoke_passed_at: testedAt, smoke_case_count: 14, revision: profile.revision + 1, updated_at: testedAt };
    return this.#persist({ ...this.#state, model_profiles: this.#state.model_profiles.map((item) => item.id === profileId ? updated : item), audits: [{ id: id("audit"), actor: actorForRole(this.#state.role), action: "完成模型 Smoke", detail: `${profile.name} · 14/14`, at: testedAt, source: "ai" as const }, ...this.#state.audits] });
  }

  async activateModelProfile(profileId: string, expectedRevision: number, dataEgressAcknowledged: boolean) {
    await this.#latency();
    if (this.#state.role !== "lead") throw problem(403, "FORBIDDEN", "只有负责人可以激活全局模型 Profile");
    const profile = this.#state.model_profiles.find((item) => item.id === profileId);
    if (!profile) throw problem(404, "PROFILE_NOT_FOUND", "模型 Profile 不存在");
    if (profile.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "模型 Profile 已更新", true, profile);
    if (!["trial_ready", "enterprise_ready", "active"].includes(profile.status)) throw problem(422, "SMOKE_REQUIRED", "模型 Profile 必须先通过 14 条 Smoke");
    if (profile.endpoint_scope === "public_cloud" && !dataEgressAcknowledged) throw problem(422, "DATA_EGRESS_ACK_REQUIRED", "激活公有云模型前必须确认数据去向");
    const activatedAt = now();
    const current = this.#state.model_profiles.find((item) => item.status === "active" && item.id !== profileId);
    const profiles = this.#state.model_profiles.map((item): ModelProfileVersion => {
      if (item.id === profileId) return { ...item, status: "active", previous_profile_id: current?.id ?? item.previous_profile_id, data_egress_acknowledged_by: profile.endpoint_scope === "public_cloud" ? actorForRole(this.#state.role) : item.data_egress_acknowledged_by, data_egress_acknowledged_at: profile.endpoint_scope === "public_cloud" ? activatedAt : item.data_egress_acknowledged_at, activated_by: actorForRole(this.#state.role), activated_at: activatedAt, revision: item.revision + 1, updated_at: activatedAt };
      if (item.status === "active") return { ...item, status: item.holdout_run_id ? "enterprise_ready" : "trial_ready", revision: item.revision + 1, updated_at: activatedAt };
      return item;
    });
    const candidates = this.#state.marketing_candidates.map((item): MarketingDecisionCandidate => item.status === "pending" ? { ...item, status: "stale", revision: item.revision + 1, updated_at: activatedAt } : item);
    const evaluationCandidates = this.#state.evaluation_candidates.map((item): EvaluationCandidate => item.status === "pending" ? { ...item, status: "stale", revision: item.revision + 1, updated_at: activatedAt } : item);
    const brains = this.#state.marketing_brain_versions.map((item) => item.status === "published" ? { ...item, model_profile_version_id: profileId, revision: item.revision + 1, updated_at: activatedAt } : item);
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: "激活全局模型 Profile", detail: `${profile.provider} · ${profile.primary_model} · 待处理候选已过期`, at: activatedAt, source: "human" as const };
    return this.#persist({ ...this.#state, model_profiles: profiles, marketing_brain_versions: brains, marketing_candidates: candidates, evaluation_candidates: evaluationCandidates, audits: [audit, ...this.#state.audits] });
  }

  async syncKnowledgeCatalog(versions: KnowledgePackVersion[], sources: KnowledgeSource[], retrievalRuns: KnowledgeRetrievalRun[], promptHashes?: Record<MarketingTaskType, string>) {
    await this.#latency();
    const nextActive = versions.find((item) => item.status === "active");
    const publishedBrain = this.#state.marketing_brain_versions.find((item) => item.status === "published");
    const desiredHashes = promptHashes ?? publishedBrain?.prompt_hashes;
    const bindingChanged = Boolean(nextActive && publishedBrain && desiredHashes && !sameBrainBinding(publishedBrain, nextActive.id, desiredHashes));
    const nowValue = now();
    let brains = this.#state.marketing_brain_versions;
    if (bindingChanged && nextActive && publishedBrain && desiredHashes && !brains.some((item) => item.status === "draft" && sameBrainBinding(item, nextActive.id, desiredHashes))) {
      const suffix = `${nextActive.id}-${Object.values(desiredHashes).join("")}`.replace(/[^a-zA-Z0-9]/gu, "").slice(-18);
      brains = [...brains, {
        ...publishedBrain,
        id: `brain-candidate-${suffix}`,
        revision: 1,
        updated_at: nowValue,
        name: `营销大脑 2.2 · ${nextActive.name}`,
        status: "draft",
        prompt_hashes: desiredHashes,
        knowledge_pack_version_id: nextActive.id,
        created_by: actorForRole(this.#state.role),
        published_by: null,
        published_at: null,
      }];
    }
    const candidates = this.#state.marketing_candidates.map((item): MarketingDecisionCandidate => item.status === "pending" && bindingChanged
      ? { ...item, status: "stale", revision: item.revision + 1, updated_at: nowValue }
      : item);
    return this.#persist({ ...this.#state, knowledge_pack_versions: versions, knowledge_sources: sources, knowledge_retrieval_runs: retrievalRuns, marketing_brain_versions: brains, marketing_candidates: candidates });
  }

  async saveDraft(draft: Draft, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "edit_draft")) throw problem(403, "FORBIDDEN", "当前角色不能编辑内容草稿");
    const current = this.#state.drafts.find((item) => item.id === draft.id);
    if (!current) throw problem(404, "NOT_FOUND", "草稿不存在");
    if (current.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "草稿已被其他操作更新", true, current);

    const material = isMaterialDraftChange(current, draft);
    const risks = draftApprovalRisks(draft, this.#state.proofs);
    const approvalRequired = risks.length > 0;
    const saved: Draft = {
      ...draft,
      risk_flags: risks,
      approval_required: approvalRequired,
      approval_status: approvalRequired ? (material ? "required" : draft.approval_status) : "not_required",
      status: approvalRequired && (material || draft.approval_status !== "approved") ? "review" : draft.status,
      revision: expectedRevision + 1,
      updated_at: now(),
    };
    const invalidated = material && this.#state.approvals.some((item) => item.object_type === "draft" && item.object_id === draft.id && ["pending", "approved"].includes(item.status));
    const approvals = this.#state.approvals.map((item): Approval => item.object_type === "draft" && item.object_id === draft.id && ["pending", "approved"].includes(item.status)
      ? { ...item, status: "returned", reason: "草稿发生实质修改，原审批已失效。", revision: item.revision + 1, updated_at: now() }
      : item);
    const audit = invalidated ? [{ id: id("audit"), actor: actorForRole(this.#state.role), action: "实质修改使审批失效", detail: `${draft.title} · 原版本 v${current.revision}`, at: now(), source: "human" as const }] : [];
    return this.#persist({ ...this.#state, drafts: this.#state.drafts.map((item) => item.id === draft.id ? saved : item), approvals, audits: [...audit, ...this.#state.audits] });
  }

  async submitDraftApproval(draftId: string, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "edit_draft")) throw problem(403, "FORBIDDEN", "只有运营可以提交内容审批");
    const draft = this.#state.drafts.find((item) => item.id === draftId);
    if (!draft) throw problem(404, "NOT_FOUND", "草稿不存在");
    if (draft.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "草稿已更新，请检查最新版本后再提交", true, draft);
    const risks = draftApprovalRisks(draft, this.#state.proofs);
    if (!risks.length) throw problem(422, "APPROVAL_NOT_REQUIRED", "当前草稿未命中敏感审批门禁");
    const invalidProof = draft.evidence_refs.map((proofId) => this.#state.proofs.find((item) => item.id === proofId)).find((proof) => !proof || !proofIsUsable(proof) || !proof.authorization.includes(draft.channel));
    if (invalidProof) throw problem(422, "PROOF_NOT_AUTHORIZED", "引用证明必须可用且已授权用于当前发布渠道");

    const submittedAt = now();
    const approval: Approval = {
      id: id("approval"), revision: 1, updated_at: submittedAt,
      object_id: draft.id, object_type: "draft", object_revision: draft.revision,
      title: draft.title, type: risks.join(" + "), requester: actorForRole(this.#state.role), approver: "周岚",
      status: "pending", summary: `${draft.channel} · ${draft.objective} · ${draft.cta}`,
      risk_flags: risks, evidence_refs: [...draft.evidence_refs], reason: "",
      due_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    };
    const oldApprovals = this.#state.approvals.map((item): Approval => item.object_type === "draft" && item.object_id === draft.id && item.status === "pending"
      ? { ...item, status: "returned", reason: "已由更新版本的审批申请替代。", revision: item.revision + 1, updated_at: submittedAt }
      : item);
    const updatedDraft: Draft = { ...draft, approval_required: true, approval_status: "pending", status: "review", updated_at: submittedAt };
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: "提交敏感审批", detail: `${draft.title} · 内容版本 v${draft.revision}`, at: submittedAt, source: "human" as const };
    return this.#persist({ ...this.#state, drafts: this.#state.drafts.map((item) => item.id === draft.id ? updatedDraft : item), approvals: [approval, ...oldApprovals], audits: [audit, ...this.#state.audits] });
  }

  async saveProof(proof: Proof, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "edit_proof")) throw problem(403, "FORBIDDEN", "只有运营可以维护证明资产");
    const current = this.#state.proofs.find((item) => item.id === proof.id);
    if (!current) throw problem(404, "NOT_FOUND", "证明资产不存在");
    if (current.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "证明资产已更新", true, current);
    const saved = normalizeProof({ ...proof, revision: expectedRevision + 1, updated_at: now() });
    let proofs = this.#state.proofs.map((item) => item.id === proof.id ? saved : item);
    const blockedDraftIds = new Set(this.#state.drafts.filter((draft) => draft.evidence_refs.includes(saved.id) && (!proofIsUsable(saved) || !saved.authorization.includes(draft.channel))).map((draft) => draft.id));
    const drafts = this.#state.drafts.map((draft): Draft => blockedDraftIds.has(draft.id)
      ? { ...draft, approval_required: true, approval_status: "required", status: "blocked", risk_flags: draftApprovalRisks(draft, proofs), updated_at: now() }
      : draft);
    proofs = recalculateProofReferences(proofs, drafts);
    const approvals = this.#state.approvals.map((approval): Approval => approval.object_type === "draft" && blockedDraftIds.has(approval.object_id) && ["pending", "approved"].includes(approval.status)
      ? { ...approval, status: "returned", reason: "引用证明的状态或授权范围已变化，需重新检查。", revision: approval.revision + 1, updated_at: now() }
      : approval);
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: blockedDraftIds.size ? "证明变更并阻断引用草稿" : "更新证明资产", detail: `${saved.title} · ${saved.status} · 影响 ${blockedDraftIds.size} 条草稿`, at: now(), source: "human" as const };
    return this.#persist({ ...this.#state, proofs, drafts, approvals, audits: [audit, ...this.#state.audits] });
  }

  async createProof(input: NewProof) {
    await this.#latency();
    if (!can(this.#state.role, "edit_proof")) throw problem(403, "FORBIDDEN", "只有运营可以新增证明资产");
    const created = normalizeProof({ ...input, id: id("proof"), revision: 1, updated_at: now(), completeness: 0, missing_fields: [], referenced_by: [] });
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: "新增证明资产", detail: `${created.title} · ${created.completeness}% 完整`, at: now(), source: "human" as const };
    return this.#persist({ ...this.#state, proofs: [created, ...this.#state.proofs], audits: [audit, ...this.#state.audits] });
  }

  async saveEvaluationCandidate(run: GenerationRun, candidate: EvaluationCandidate) {
    await this.#latency();
    if (!can(this.#state.role, "evaluate_customer")) throw problem(403, "FORBIDDEN", "当前角色不能生成客户评估");
    const customer = this.#state.customers.find((item) => item.id === candidate.customer_id);
    if (!customer || !canAccessCustomer(this.#state.role, customer)) throw problem(404, "NOT_FOUND", "客户不存在或不在当前可见范围");
    if (customer.revision !== candidate.customer_revision || evidenceFingerprint(customer) !== candidate.evidence_fingerprint) throw problem(409, "STALE_EVALUATION_INPUT", "客户或证据已变化，候选未保存", true, customer);
    const savedAt = now();
    const previous = this.#state.evaluation_candidates.map((item): EvaluationCandidate => item.customer_id === customer.id && item.status === "pending"
      ? { ...item, status: "stale", revision: item.revision + 1, updated_at: savedAt }
      : item);
    const audit = { id: id("audit"), actor: run.provider ?? "AI", action: "生成客户评估候选", detail: `${customer.name} · ${candidate.evaluation.state_before} → ${candidate.evaluation.state_after} · ${candidate.evaluation.recommendation} · ${run.model}`, at: savedAt, source: "ai" as const };
    return this.#persist({ ...this.#state, generation_runs: [run, ...this.#state.generation_runs], evaluation_candidates: [candidate, ...previous], audits: [audit, ...this.#state.audits] });
  }

  async saveGenerationRun(run: GenerationRun) {
    await this.#latency();
    if (!can(this.#state.role, "evaluate_customer")) throw problem(403, "FORBIDDEN", "当前角色不能记录客户评估运行");
    const customer = this.#state.customers.find((item) => item.id === run.subject_id);
    if (!customer || !canAccessCustomer(this.#state.role, customer)) throw problem(404, "NOT_FOUND", "客户不存在或不在当前可见范围");
    const audit = { id: id("audit"), actor: run.provider ?? "AI", action: run.status === "blocked" ? "客户评估被策略阻断" : "客户评估生成失败", detail: `${customer.name} · ${run.model} · ${run.error_code ?? "UNKNOWN"}`, at: run.created_at, source: "ai" as const };
    return this.#persist({ ...this.#state, generation_runs: [run, ...this.#state.generation_runs], audits: [audit, ...this.#state.audits] });
  }

  async decideEvaluationCandidate(customerId: string, candidateId: string, decision: EvaluationDecisionKind, evaluation: CustomerEvaluation | null, reasonCode: EvaluationReasonCode | null, reasonNote: string, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "review_evaluation")) throw problem(403, "FORBIDDEN", "只有负责销售可以判断 AI 候选");
    const customer = this.#state.customers.find((item) => item.id === customerId);
    if (!customer || !canAccessCustomer(this.#state.role, customer)) throw problem(404, "NOT_FOUND", "客户不存在或不在当前可见范围");
    const candidate = this.#state.evaluation_candidates.find((item) => item.id === candidateId && item.customer_id === customer.id);
    if (!candidate) throw problem(404, "CANDIDATE_NOT_FOUND", "评估候选不存在");
    if (candidate.status !== "pending") throw problem(409, "CANDIDATE_ALREADY_DECIDED", "该候选已处理", false, candidate);
    if (customer.revision !== expectedRevision || candidate.customer_revision !== customer.revision || candidateIsStale(this.#state, candidate)) throw problem(409, "STALE_EVALUATION_CANDIDATE", "客户或证据已变化，请重新生成候选", true, customer);
    if (decision !== "accepted" && !reasonCode) throw problem(422, "REASON_REQUIRED", "修改或拒绝候选时必须选择原因");
    if (reasonCode === "other" && !reasonNote.trim()) throw problem(422, "REASON_NOTE_REQUIRED", "选择其他原因时必须补充说明");
    const finalEvaluation = decision === "accepted" ? candidate.evaluation : decision === "modified" ? evaluation : null;
    if (decision === "modified" && !finalEvaluation) throw problem(422, "EVALUATION_REQUIRED", "修改后采用必须提供完整评估");
    if (finalEvaluation) {
      const policy = validateCustomerEvaluation(customer, finalEvaluation);
      if (!policy.allowed) throw problem(422, policy.code, policy.reasons.join("；"));
    }
    const decidedAt = now();
    const decisionId = id("evaluation-decision");
    const decidedWithin48Hours = new Date(decidedAt).getTime() - new Date(candidate.created_at).getTime() <= 48 * 60 * 60_000;
    const record: EvaluationDecision = {
      id: decisionId, revision: 1, updated_at: decidedAt, candidate_id: candidate.id, customer_id: customer.id, decision,
      original_evaluation: candidate.evaluation, final_evaluation: finalEvaluation, reason_code: decision === "accepted" ? null : reasonCode,
      reason_note: reasonNote.trim(), actor: actorForRole(this.#state.role), decided_at: decidedAt, reviewed_within_48h: decidedWithin48Hours,
      review_outcome: null, review_reason: "", reviewed_at: null,
    };
    const updatedCandidate: EvaluationCandidate = { ...candidate, status: decision, decided_at: decidedAt, decision_id: decisionId, revision: candidate.revision + 1, updated_at: decidedAt };
    const updatedCustomer = finalEvaluation ? {
      ...customer,
      state: finalEvaluation.state_after,
      confidence: finalEvaluation.confidence,
      review_at: finalEvaluation.next_review_at,
      evaluation: finalEvaluation,
      evaluation_meta: { model: candidate.ai_meta.model, response_id: candidate.ai_meta.response_id, prompt_version: candidate.ai_meta.prompt_version },
      nba_decision: null,
      revision: customer.revision + 1,
      updated_at: decidedAt,
    } : customer;
    const label = decision === "accepted" ? "原样采用 AI 首稿" : decision === "modified" ? "修改后采用 AI 首稿" : "拒绝 AI 首稿";
    const audit = { id: id("audit"), actor: record.actor, action: label, detail: `${customer.name} · ${candidate.evaluation.state_after} · ${candidate.evaluation.recommendation}${reasonCode ? ` · ${reasonCode}` : ""}`, at: decidedAt, source: "human" as const };
    return this.#persist({
      ...this.#state,
      customers: this.#state.customers.map((item) => item.id === customer.id ? updatedCustomer : item),
      evaluation_candidates: this.#state.evaluation_candidates.map((item) => item.id === candidate.id ? updatedCandidate : item),
      evaluation_decisions: [record, ...this.#state.evaluation_decisions],
      audits: [audit, ...this.#state.audits],
    });
  }

  async recordEvaluationReview(decisionId: string, outcome: EvaluationReviewOutcome, reason: string, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "review_evaluation")) throw problem(403, "FORBIDDEN", "只有销售可以记录 7 天复查结果");
    const decision = this.#state.evaluation_decisions.find((item) => item.id === decisionId);
    if (!decision) throw problem(404, "DECISION_NOT_FOUND", "评估决策不存在");
    const customer = this.#state.customers.find((item) => item.id === decision.customer_id);
    if (!customer || !canAccessCustomer(this.#state.role, customer)) throw problem(404, "NOT_FOUND", "客户不存在或不在当前可见范围");
    if (decision.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "复查记录已更新", true, decision);
    if (outcome !== "retained" && !reason.trim()) throw problem(422, "REVIEW_REASON_REQUIRED", "撤销或新增证据必须说明原因");
    const reviewedAt = now();
    const updated: EvaluationDecision = { ...decision, review_outcome: outcome, review_reason: reason.trim(), reviewed_at: reviewedAt, revision: decision.revision + 1, updated_at: reviewedAt };
    const labels = { retained: "AI 判断 7 天后保持有效", quality_reversal: "AI 判断因质量问题撤销", new_evidence: "新增证据推动后续变化" };
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: labels[outcome], detail: `${customer.name}${reason ? ` · ${reason}` : ""}`, at: reviewedAt, source: "human" as const };
    return this.#persist({ ...this.#state, evaluation_decisions: this.#state.evaluation_decisions.map((item) => item.id === decision.id ? updated : item), audits: [audit, ...this.#state.audits] });
  }

  async saveMarketingCandidate(candidate: MarketingDecisionCandidate) {
    await this.#latency();
    const required = candidate.task_type === "customer_nba" ? "evaluate_customer" : candidate.task_type === "weekly_strategy" ? "generate_strategy" : candidate.task_type === "content_brief" ? "manage_brief" : "edit_draft";
    if (!can(this.#state.role, required)) throw problem(403, "FORBIDDEN", "当前角色不能生成该营销决策候选");
    const activeBrain = this.#state.marketing_brain_versions.find((item) => item.status === "published");
    const activeFacts = this.#state.tenant_fact_versions.find((item) => item.status === "published");
    if (!activeBrain || !activeFacts) throw problem(422, "MARKETING_BRAIN_NOT_PUBLISHED", "营销脑或企业事实版本尚未发布");
    if (candidate.envelope.marketing_brain_version !== activeBrain.id || candidate.envelope.tenant_fact_version !== activeFacts.id) throw problem(409, "STALE_MARKETING_BRAIN_BINDING", "营销脑或企业事实版本已变化，候选未保存", true);
    const savedAt = now();
    const previous = this.#state.marketing_candidates.map((item): MarketingDecisionCandidate => item.task_type === candidate.task_type && item.subject_id === candidate.subject_id && item.status === "pending"
      ? { ...item, status: "stale", revision: item.revision + 1, updated_at: savedAt }
      : item);
    const audit = { id: id("audit"), actor: candidate.envelope.ai_meta.provider ?? "AI", action: "生成营销决策候选", detail: `${candidate.task_type} · ${candidate.subject_id} · ${candidate.envelope.knowledge_refs.length} 条知识引用`, at: savedAt, source: "ai" as const };
    return this.#persist({ ...this.#state, marketing_candidates: [candidate, ...previous], audits: [audit, ...this.#state.audits] });
  }

  async decideMarketingCandidate(candidateId: string, decision: MarketingDecisionKind, output: MarketingDecisionOutput | null, reasonCode: MarketingDecisionReasonCode | null, reasonNote: string, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "review_marketing_output")) throw problem(403, "FORBIDDEN", "当前角色不能审阅营销决策候选");
    const candidate = this.#state.marketing_candidates.find((item) => item.id === candidateId);
    if (!candidate) throw problem(404, "MARKETING_CANDIDATE_NOT_FOUND", "营销决策候选不存在");
    if (candidate.status !== "pending") throw problem(409, "CANDIDATE_ALREADY_DECIDED", "该候选已处理", false, candidate);
    const customerTask = candidate.task_type === "customer_nba";
    if ((customerTask && this.#state.role !== "sales") || (!customerTask && this.#state.role !== "operations")) throw problem(403, "FORBIDDEN", customerTask ? "只有负责销售可以审阅客户 NBA" : "只有运营可以审阅内容与策略候选");
    const activeBrain = this.#state.marketing_brain_versions.find((item) => item.status === "published");
    const activeFacts = this.#state.tenant_fact_versions.find((item) => item.status === "published");
    const activeKnowledge = this.#state.knowledge_pack_versions.find((item) => item.status === "active");
    if (!activeBrain || !activeFacts || !activeKnowledge || candidate.envelope.marketing_brain_version !== activeBrain.id || candidate.envelope.tenant_fact_version !== activeFacts.id || candidate.envelope.knowledge_pack_version !== activeKnowledge.id) throw problem(409, "STALE_MARKETING_CANDIDATE", "知识、事实或营销脑版本已变化，请重新生成候选", true);
    const subject = candidate.task_type === "customer_nba" ? this.#state.customers.find((item) => item.id === candidate.subject_id)
      : candidate.task_type === "content_brief" ? this.#state.content_briefs.find((item) => item.id === candidate.subject_id)
        : candidate.task_type === "content_draft" ? this.#state.drafts.find((item) => item.id === candidate.subject_id) : null;
    if (subject && (subject.revision !== expectedRevision || subject.revision !== candidate.subject_revision)) throw problem(409, "STALE_MARKETING_CANDIDATE", "业务对象已变化，请重新生成候选", true, subject);
    if (decision !== "accepted" && !reasonCode) throw problem(422, "REASON_REQUIRED", "修改或拒绝候选时必须选择原因");
    if (decision !== "accepted" && !reasonNote.trim()) throw problem(422, "REASON_NOTE_REQUIRED", "修改或拒绝候选时必须说明原因");
    const finalOutput = decision === "accepted" ? candidate.envelope.output : decision === "modified" ? output : null;
    if (decision === "modified" && !finalOutput) throw problem(422, "OUTPUT_REQUIRED", "修改后采用必须提供完整输出");

    let customers = this.#state.customers;
    let drafts = this.#state.drafts;
    let briefs = this.#state.content_briefs;
    let weeklyPlan = this.#state.weekly_plan;
    const decidedAt = now();
    if (finalOutput && candidate.task_type === "customer_nba") {
      const customer = subject as DomainState["customers"][number];
      const evaluation = finalOutput as CustomerEvaluation;
      if (!canAccessCustomer(this.#state.role, customer)) throw problem(404, "NOT_FOUND", "客户不在当前销售可见范围");
      const policy = validateCustomerEvaluation(customer, evaluation);
      if (!policy.allowed) throw problem(422, policy.code, policy.reasons.join("；"));
      customers = customers.map((item) => item.id === customer.id ? { ...item, state: evaluation.state_after, confidence: evaluation.confidence, review_at: evaluation.next_review_at, evaluation, evaluation_meta: { model: candidate.envelope.ai_meta.model, response_id: candidate.envelope.ai_meta.response_id, prompt_version: candidate.envelope.ai_meta.prompt_version }, revision: item.revision + 1, updated_at: decidedAt } : item);
    } else if (finalOutput && candidate.task_type === "weekly_strategy") {
      const strategy = finalOutput as DomainState["weekly_plan"]["strategy"];
      if (Object.values(strategy.ratio).reduce((sum, value) => sum + value, 0) !== 100) throw problem(422, "POLICY_BLOCKED", "T/I/D/A 配比总和必须为 100");
      weeklyPlan = { strategy, status: "ready", generated_by: actorForRole(this.#state.role), generated_at: decidedAt };
    } else if (finalOutput && candidate.task_type === "content_brief") {
      const proposal = finalOutput as import("../domain/schemas").ContentBriefProposal;
      briefs = briefs.map((item) => item.id === candidate.subject_id ? { ...item, title: proposal.title, target_segment: proposal.target_segment, stage: proposal.stage, primary_angle: proposal.primary_angle, key_facts: proposal.key_facts, proof_requirements: proposal.proof_requirements, cta: proposal.cta, due_at: proposal.due_at, insight_ids: proposal.insight_refs, status: "adopted", adopted_by: actorForRole(this.#state.role), ai_meta: candidate.envelope.ai_meta, revision: item.revision + 1, updated_at: decidedAt } : item);
    } else if (finalOutput && candidate.task_type === "content_draft") {
      const proposal = finalOutput as import("../domain/schemas").ContentDraftProposal;
      const current = subject as Draft;
      const next = { ...current, title: proposal.title, stage: proposal.stage, segment: proposal.target_segment, objective: proposal.objective, body: proposal.body, cta: proposal.cta, expected_transition: proposal.expected_transition, evidence_refs: proposal.evidence_refs, risk_flags: proposal.risk_flags, approval_required: proposal.approval_required, approval_status: proposal.approval_required ? "required" as const : "not_required" as const, status: proposal.approval_required ? "review" as const : "ready" as const, revision: current.revision + 1, updated_at: decidedAt };
      drafts = drafts.map((item) => item.id === current.id ? next : item);
    }
    const decisionId = id("marketing-decision");
    const record: MarketingDecisionDecision = { id: decisionId, revision: 1, updated_at: decidedAt, candidate_id: candidate.id, task_type: candidate.task_type, subject_id: candidate.subject_id, decision, original_output: candidate.envelope.output, final_output: finalOutput, reason_code: decision === "accepted" ? null : reasonCode, reason_note: reasonNote.trim(), actor: actorForRole(this.#state.role), decided_at: decidedAt, reviewed_within_48h: new Date(decidedAt).getTime() - new Date(candidate.created_at).getTime() <= 48 * 60 * 60_000, review_outcome: null, review_reason: "", reviewed_at: null };
    const updatedCandidate: MarketingDecisionCandidate = { ...candidate, status: decision, decided_at: decidedAt, decision_id: decisionId, revision: candidate.revision + 1, updated_at: decidedAt };
    const audit = { id: id("audit"), actor: record.actor, action: decision === "accepted" ? "原样采用营销决策" : decision === "modified" ? "修改后采用营销决策" : "拒绝营销决策", detail: `${candidate.task_type} · ${candidate.subject_id}${reasonCode ? ` · ${reasonCode}` : ""}`, at: decidedAt, source: "human" as const };
    return this.#persist({ ...this.#state, customers, drafts, content_briefs: briefs, weekly_plan: weeklyPlan, marketing_candidates: this.#state.marketing_candidates.map((item) => item.id === candidate.id ? updatedCandidate : item), marketing_decisions: [record, ...this.#state.marketing_decisions], audits: [audit, ...this.#state.audits] });
  }

  async recordMarketingReview(decisionId: string, outcome: MarketingReviewOutcome, reason: string, expectedRevision: number) {
    await this.#latency();
    const decision = this.#state.marketing_decisions.find((item) => item.id === decisionId);
    if (!decision) throw problem(404, "DECISION_NOT_FOUND", "营销决策不存在");
    const expectedRole = decision.task_type === "customer_nba" ? "sales" : "operations";
    if (this.#state.role !== expectedRole || decision.actor !== actorForRole(this.#state.role)) throw problem(403, "FORBIDDEN", "只能复查本人已采用的营销决策");
    if (decision.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "复查记录已更新", true, decision);
    if (outcome !== "retained" && !reason.trim()) throw problem(422, "REVIEW_REASON_REQUIRED", "质量撤销或新增证据必须说明原因");
    const reviewedAt = now();
    const updated: MarketingDecisionDecision = { ...decision, review_outcome: outcome, review_reason: reason.trim(), reviewed_at: reviewedAt, revision: decision.revision + 1, updated_at: reviewedAt };
    return this.#persist({ ...this.#state, marketing_decisions: this.#state.marketing_decisions.map((item) => item.id === decision.id ? updated : item), audits: [{ id: id("audit"), actor: decision.actor, action: "营销决策 7 天复查", detail: `${decision.task_type} · ${outcome}${reason ? ` · ${reason}` : ""}`, at: reviewedAt, source: "human" }, ...this.#state.audits] });
  }

  async runGoldenEvaluation(marketingBrainVersionId: string, routerVersionId: string, split: "development" | "holdout") {
    await this.#latency();
    if (!can(this.#state.role, "manage_ai_quality")) throw problem(403, "FORBIDDEN", "只有运营可以运行黄金集评测");
    const brain = this.#state.marketing_brain_versions.find((item) => item.id === marketingBrainVersionId);
    const router = this.#state.router_versions.find((item) => item.id === routerVersionId);
    if (!brain || !router) throw problem(404, "AI_VERSION_NOT_FOUND", "营销脑或路由版本不存在");
    const cases = this.#state.golden_cases.filter((item) => item.split === split);
    const candidateVersion = !brain.name.includes("2.1") || !router.name.includes("v2.0");
    const startedAt = now();
    const run: EvalRun = {
      id: id("eval"), revision: 1, updated_at: startedAt, marketing_brain_version_id: brain.id, router_version_id: router.id, split, mode: "replay", status: "completed",
      case_count: cases.length, score: scoreGoldenReplay(cases, candidateVersion), started_at: startedAt, completed_at: startedAt, generated_by: actorForRole(this.#state.role),
    };
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: "运行 AI 黄金集评测", detail: `${brain.name} · ${router.name} · ${split} ${cases.length} 条 · ${run.score?.passed ? "通过" : "未通过"}`, at: startedAt, source: "system" as const };
    return this.#persist({ ...this.#state, eval_runs: [...this.#state.eval_runs, run], audits: [audit, ...this.#state.audits] });
  }

  async startLiveHoldout(_marketingBrainVersionId: string, _routerVersionId: string, _idempotencyKey: string): Promise<DomainState> {
    throw problem(501, "LIVE_EVAL_HTTP_REQUIRED", "真实 Holdout 只在 HTTP + SQLite 模式下可用");
  }

  async pauseLiveHoldout(_runId: string, _expectedRevision: number): Promise<DomainState> {
    throw problem(501, "LIVE_EVAL_HTTP_REQUIRED", "真实 Holdout 只在 HTTP + SQLite 模式下可用");
  }

  async createRouterVersion(name: string, description: string, confidenceThreshold: number) {
    await this.#latency();
    if (!can(this.#state.role, "manage_ai_quality")) throw problem(403, "FORBIDDEN", "只有运营可以创建路由候选");
    if (!name.trim() || !description.trim()) throw problem(422, "VERSION_FIELDS_REQUIRED", "版本名称和变更说明不能为空");
    if (this.#state.router_versions.some((item) => item.name === name.trim())) throw problem(409, "VERSION_NAME_EXISTS", "路由版本名称已存在");
    if (!Number.isInteger(confidenceThreshold) || confidenceThreshold < 50 || confidenceThreshold > 95) throw problem(422, "ROUTER_THRESHOLD_INVALID", "Terra 升级阈值必须为 50 到 95 的整数");
    const createdAt = now();
    const version = { id: id("router"), revision: 1, updated_at: createdAt, name: name.trim(), status: "draft" as const, primary_model: "gpt-5.6", fast_model: "gpt-5.6-terra", confidence_threshold: confidenceThreshold, description: description.trim(), created_by: actorForRole(this.#state.role), published_by: null, published_at: null };
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: "创建路由候选", detail: `${version.name} · Terra < ${confidenceThreshold} 升级`, at: createdAt, source: "human" as const };
    return this.#persist({ ...this.#state, router_versions: [...this.#state.router_versions, version], audits: [audit, ...this.#state.audits] });
  }

  async promoteAiVersion(kind: "brain" | "router", versionId: string, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "publish_ai_version")) throw problem(403, "FORBIDDEN", "只有负责人可以发布 AI 版本");
    const versions = kind === "brain" ? this.#state.marketing_brain_versions : this.#state.router_versions;
    const version = versions.find((item) => item.id === versionId);
    if (!version) throw problem(404, "AI_VERSION_NOT_FOUND", "AI 版本不存在");
    if (version.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "AI 版本已更新", true, version);
    if (version.status !== "draft") throw problem(409, "VERSION_NOT_DRAFT", "只有候选版本可以发布", false, version);
    const qualifyingRun = [...this.#state.eval_runs].reverse().find((item) => item.split === "holdout" && item.status === "completed" && item.score?.passed && (kind === "brain" ? item.marketing_brain_version_id === version.id : item.router_version_id === version.id));
    if (!qualifyingRun) throw problem(422, "QUALITY_GATE_BLOCKED", "锁定 Holdout 尚未通过全部发布门槛");
    const publishedAt = now();
    const promoted = versions.map((item) => item.id === version.id
      ? { ...item, status: "published" as const, published_by: actorForRole(this.#state.role), published_at: publishedAt, revision: item.revision + 1, updated_at: publishedAt }
      : item.status === "published" ? { ...item, status: "archived" as const, revision: item.revision + 1, updated_at: publishedAt } : item);
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: kind === "brain" ? "发布营销脑版本" : "发布路由版本", detail: `${version.name} · Holdout ${qualifyingRun.score?.macro_adoption_rate}% 决策有效采用`, at: publishedAt, source: "human" as const };
    const candidates = kind === "brain" ? this.#state.marketing_candidates.map((item): MarketingDecisionCandidate => item.status === "pending" ? { ...item, status: "stale", revision: item.revision + 1, updated_at: publishedAt } : item) : this.#state.marketing_candidates;
    return this.#persist({ ...this.#state, marketing_brain_versions: kind === "brain" ? promoted as DomainState["marketing_brain_versions"] : this.#state.marketing_brain_versions, router_versions: kind === "router" ? promoted as DomainState["router_versions"] : this.#state.router_versions, marketing_candidates: candidates, audits: [audit, ...this.#state.audits] });
  }

  async rollbackAiVersion(kind: "brain" | "router", versionId: string, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "publish_ai_version")) throw problem(403, "FORBIDDEN", "只有负责人可以回滚 AI 版本");
    const versions = kind === "brain" ? this.#state.marketing_brain_versions : this.#state.router_versions;
    const version = versions.find((item) => item.id === versionId);
    if (!version) throw problem(404, "AI_VERSION_NOT_FOUND", "AI 版本不存在");
    if (version.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "AI 版本已更新", true, version);
    if (version.status !== "archived" || !version.published_at) throw problem(422, "ROLLBACK_TARGET_INVALID", "只能回滚到曾经发布过的归档版本");
    const rolledBackAt = now();
    const rolledBack = versions.map((item) => item.id === version.id
      ? { ...item, status: "published" as const, published_by: actorForRole(this.#state.role), published_at: rolledBackAt, revision: item.revision + 1, updated_at: rolledBackAt }
      : item.status === "published" ? { ...item, status: "archived" as const, revision: item.revision + 1, updated_at: rolledBackAt } : item);
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: kind === "brain" ? "回滚营销脑版本" : "回滚路由版本", detail: `${version.name} · 恢复上一已验证版本`, at: rolledBackAt, source: "human" as const };
    const candidates = kind === "brain" ? this.#state.marketing_candidates.map((item): MarketingDecisionCandidate => item.status === "pending" ? { ...item, status: "stale", revision: item.revision + 1, updated_at: rolledBackAt } : item) : this.#state.marketing_candidates;
    return this.#persist({ ...this.#state, marketing_brain_versions: kind === "brain" ? rolledBack as DomainState["marketing_brain_versions"] : this.#state.marketing_brain_versions, router_versions: kind === "router" ? rolledBack as DomainState["router_versions"] : this.#state.router_versions, marketing_candidates: candidates, audits: [audit, ...this.#state.audits] });
  }

  async decideNba(customerId: string, decision: NbaDecision["decision"], action: string, reason: string, expectedRevision: number) {
    await this.#latency();
    const customer = this.#state.customers.find((item) => item.id === customerId);
    if (!customer || !canAccessCustomer(this.#state.role, customer)) throw problem(404, "NOT_FOUND", "客户不存在或不在当前可见范围");
    if (!can(this.#state.role, "record_task")) throw problem(403, "FORBIDDEN", "只有销售可以处理下一最佳动作");
    if (customer.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "客户已更新，请检查最新状态", true, customer);
    const finalAction = (action || customer.evaluation?.recommendation || "继续观察").trim();
    if (!finalAction) throw problem(422, "ACTION_REQUIRED", "请填写要执行的动作");
    if (decision !== "accepted" && !reason.trim()) throw problem(422, "REASON_REQUIRED", "修改或拒绝建议时必须填写原因");

    let tasks = this.#state.tasks;
    let taskId: string | null = null;
    if (decision !== "rejected") {
      const existing = tasks.find((task) => task.customer_id === customer.id && task.status !== "done");
      taskId = existing?.id ?? id("task");
      const task: Task = existing
        ? { ...existing, title: `${finalAction} · ${customer.name}`, type: finalAction, owner: actorForRole(this.#state.role), status: "pending", revision: existing.revision + 1, updated_at: now() }
        : { id: taskId, revision: 1, updated_at: now(), customer_id: customer.id, title: `${finalAction} · ${customer.name}`, type: finalAction, owner: actorForRole(this.#state.role), priority: ["D1", "A1", "C1"].includes(customer.state) ? "high" : "medium", due_at: customer.review_at, status: "pending", outcome: "" };
      tasks = existing ? tasks.map((item) => item.id === existing.id ? task : item) : [task, ...tasks];
    }
    const decidedAt = now();
    const nbaDecision: NbaDecision = { decision, action: finalAction, reason: reason.trim(), actor: actorForRole(this.#state.role), decided_at: decidedAt, task_id: taskId };
    const labels = { accepted: "采纳下一最佳动作", modified: "修改下一最佳动作", rejected: "拒绝下一最佳动作" };
    const audit = { id: id("audit"), actor: nbaDecision.actor, action: labels[decision], detail: `${customer.name} · ${finalAction}${reason ? ` · ${reason}` : ""}`, at: decidedAt, source: "human" as const };
    const updated = { ...customer, nba_decision: nbaDecision, revision: customer.revision + 1, updated_at: decidedAt };
    return this.#persist({ ...this.#state, customers: this.#state.customers.map((item) => item.id === customer.id ? updated : item), tasks, audits: [audit, ...this.#state.audits] });
  }

  async addCustomerNote(customerId: string, text: string, expectedRevision: number) {
    await this.#latency();
    const customer = this.#state.customers.find((item) => item.id === customerId);
    if (!customer || !canAccessCustomer(this.#state.role, customer)) throw problem(404, "NOT_FOUND", "客户不存在或不在当前可见范围");
    if (customer.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "客户已更新，请重新提交笔记", true, customer);
    if (!text.trim()) throw problem(422, "NOTE_REQUIRED", "笔记内容不能为空");
    const at = now();
    const actor = actorForRole(this.#state.role);
    const note = { id: id("note"), text: text.trim(), actor, at };
    const updated = { ...customer, notes: [note, ...customer.notes], revision: customer.revision + 1, updated_at: at };
    const audit = { id: id("audit"), actor, action: "记录客户人工笔记", detail: `${customer.name} · ${text.trim()}`, at, source: "human" as const };
    return this.#persist({ ...this.#state, customers: this.#state.customers.map((item) => item.id === customer.id ? updated : item), audits: [audit, ...this.#state.audits] });
  }

  async decideApproval(idValue: string, decision: "approved" | "returned", reason: string, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "decide_approval")) throw problem(403, "FORBIDDEN", "只有负责人可以处理敏感审批");
    const approval = this.#state.approvals.find((item) => item.id === idValue);
    if (!approval) throw problem(404, "NOT_FOUND", "审批不存在");
    if (approval.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "审批已被处理", true, approval);
    if (approval.status !== "pending") throw problem(409, "APPROVAL_ALREADY_DECIDED", "该审批已处理", false, approval);
    const object = approval.object_type === "draft" ? this.#state.drafts.find((item) => item.id === approval.object_id) : this.#state.proofs.find((item) => item.id === approval.object_id);
    if (!object || object.revision !== approval.object_revision) throw problem(409, "STALE_APPROVAL", "审批对应的对象版本已变化，请提交新审批", false, object);
    if (decision === "approved" && approval.object_type === "draft") {
      const draft = object as Draft;
      const invalidProof = draft.evidence_refs.map((proofId) => this.#state.proofs.find((item) => item.id === proofId)).find((proof) => !proof || !proofIsUsable(proof) || !proof.authorization.includes(draft.channel));
      if (invalidProof) throw problem(422, "PROOF_NOT_AUTHORIZED", "引用证明已失效或未授权用于当前发布渠道");
    }
    const updated: Approval = { ...approval, status: decision, reason: reason.trim(), revision: expectedRevision + 1, updated_at: now() };
    const drafts = this.#state.drafts.map((draft) => draft.id === approval.object_id && approval.object_type === "draft"
      ? { ...draft, approval_status: decision, status: decision === "approved" ? "ready" as const : "blocked" as const, updated_at: now() }
      : draft);
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: decision === "approved" ? "批准敏感内容" : "退回敏感内容", detail: `${approval.title} · 内容版本 v${approval.object_revision} · ${reason}`, at: now(), source: "human" as const };
    return this.#persist({ ...this.#state, approvals: this.#state.approvals.map((item) => item.id === idValue ? updated : item), drafts, audits: [audit, ...this.#state.audits] });
  }

  async recordTaskOutcome(idValue: string, outcome: string, expectedRevision: number) {
    await this.#latency();
    const task = this.#state.tasks.find((item) => item.id === idValue);
    if (!task) throw problem(404, "NOT_FOUND", "任务不存在");
    if (!canActOnTask(this.#state.role, task)) throw problem(403, "FORBIDDEN", "销售只能回填自己负责的任务");
    if (task.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "任务已被更新", true, task);
    const updated: Task = { ...task, status: "done", outcome: outcome.trim(), revision: expectedRevision + 1, updated_at: now() };
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: "回填销售动作结果", detail: `${task.title} · ${outcome.trim()}`, at: now(), source: "human" as const };
    return this.#persist({ ...this.#state, tasks: this.#state.tasks.map((item) => item.id === idValue ? updated : item), audits: [audit, ...this.#state.audits] });
  }

  async saveInsightBatch(batch: AnalysisBatch, insights: ConversationInsight[]) {
    await this.#latency();
    if (!can(this.#state.role, "decide_insight")) throw problem(403, "FORBIDDEN", "只有运营可以保存会话洞察批次");
    for (const insight of insights) {
      const lineage = validateInsightLineage(insight, this.#state.archived_messages, this.#state.archive_consents);
      if (!lineage.allowed) throw problem(422, lineage.code, lineage.reasons.join("；"));
    }
    const savedAt = now();
    const nextBatch = { ...batch, revision: batch.revision + 1, updated_at: savedAt };
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: "保存会话洞察批次", detail: `${insights.length} 条候选 · 输入 ${batch.included_count} 条有效消息`, at: savedAt, source: "ai" as const };
    return this.#persist({ ...this.#state, analysis_batches: [nextBatch, ...this.#state.analysis_batches.filter((item) => item.id !== batch.id)], conversation_insights: [...insights, ...this.#state.conversation_insights.filter((current) => !insights.some((item) => item.id === current.id))], audits: [audit, ...this.#state.audits] });
  }

  async decideInsight(idValue: string, decision: "accepted" | "dismissed", reason: string, edits: Partial<Pick<ConversationInsight, "title" | "summary" | "customer_segment">>, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "decide_insight")) throw problem(403, "FORBIDDEN", "只有运营可以判断会话洞察");
    const insight = this.#state.conversation_insights.find((item) => item.id === idValue);
    if (!insight) throw problem(404, "NOT_FOUND", "洞察不存在");
    if (insight.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "洞察已被更新", true, insight);
    const edited = Object.values(edits).some((value) => typeof value === "string" && value.trim());
    if ((decision === "dismissed" || edited) && !reason.trim()) throw problem(422, "REASON_REQUIRED", "忽略或编辑洞察时必须填写原因");
    const lineage = validateInsightLineage(insight, this.#state.archived_messages, this.#state.archive_consents);
    if (decision === "accepted" && !lineage.allowed) throw problem(422, lineage.code, lineage.reasons.join("；"));
    const decidedAt = now();
    const updated: ConversationInsight = {
      ...insight, ...edits, status: decision, decision_reason: reason.trim(), decided_by: actorForRole(this.#state.role), decided_at: decidedAt,
      trend_scope: insightTrendScope(insight.conversation_refs), revision: expectedRevision + 1, updated_at: decidedAt,
    };
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: decision === "accepted" ? "接受会话洞察" : "忽略会话洞察", detail: `${insight.title} · ${updated.trend_scope === "trend" ? "趋势" : "个体信号"} · ${reason.trim() || "无修改"}`, at: decidedAt, source: "human" as const };
    return this.#persist({ ...this.#state, conversation_insights: this.#state.conversation_insights.map((item) => item.id === idValue ? updated : item), audits: [audit, ...this.#state.audits] });
  }

  async saveBrief(brief: ContentBrief, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "manage_brief")) throw problem(403, "FORBIDDEN", "只有运营可以维护内容 Brief");
    const current = this.#state.content_briefs.find((item) => item.id === brief.id);
    if (!current) throw problem(404, "NOT_FOUND", "内容 Brief 不存在");
    if (current.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "内容 Brief 已更新", true, current);
    const insights = brief.insight_ids.map((insightId) => this.#state.conversation_insights.find((item) => item.id === insightId));
    if (!insights.length || insights.some((insight) => !insight || insight.status !== "accepted" || insight.invalidated_reason)) throw problem(422, "INSIGHT_NOT_ACCEPTED", "Brief 只能引用已接受且有效的会话洞察");
    const savedAt = now();
    const saved: ContentBrief = { ...brief, status: "adopted", adopted_by: actorForRole(this.#state.role), revision: expectedRevision + 1, updated_at: savedAt };
    const linkedInsights = this.#state.conversation_insights.map((insight): ConversationInsight => brief.insight_ids.includes(insight.id) ? { ...insight, brief_id: brief.id, revision: insight.revision + 1, updated_at: savedAt } : insight);
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: "采用内容 Brief", detail: `${brief.title} · ${brief.insight_ids.length} 条洞察血缘`, at: savedAt, source: "human" as const };
    return this.#persist({ ...this.#state, content_briefs: this.#state.content_briefs.map((item) => item.id === brief.id ? saved : item), conversation_insights: linkedInsights, audits: [audit, ...this.#state.audits] });
  }

  async recordRawAccess(conversationId: string, purpose: string) {
    await this.#latency();
    const conversation = this.#state.archive_conversations.find((item) => item.id === conversationId);
    if (!conversation || !canViewRawConversation(this.#state.role, conversation)) throw problem(403, "RAW_ACCESS_FORBIDDEN", "当前角色无权查看该会话原文");
    if (!purpose.trim()) throw problem(422, "PURPOSE_REQUIRED", "查看会话原文前必须选择用途");
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: "查看会话原文", detail: `${conversation.id} · 用途：${purpose.trim()}`, at: now(), source: "human" as const };
    return this.#persist({ ...this.#state, audits: [audit, ...this.#state.audits] });
  }

  async markPublished(draftId: string, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "mark_publish")) throw problem(403, "FORBIDDEN", "只有运营可以标记人工发布");
    const draft = this.#state.drafts.find((item) => item.id === draftId);
    if (!draft) throw problem(404, "NOT_FOUND", "草稿不存在");
    if (draft.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "草稿已被更新", true, draft);
    if (draft.published_at) throw problem(409, "ALREADY_PUBLISHED", "该草稿已标记发布", false, draft);
    const blockedProof = draft.evidence_refs.map((proofId) => this.#state.proofs.find((proof) => proof.id === proofId)).find((proof) => !proof || !proofIsUsable(proof) || !proof.authorization.includes(draft.channel));
    if (blockedProof || (draft.approval_required && draft.approval_status !== "approved")) throw problem(422, "PUBLICATION_BLOCKED", "证据授权或敏感审批门禁尚未满足");
    const publishedAt = now();
    const publication: PublicationRecord = { id: id("publication"), revision: 1, updated_at: publishedAt, draft_id: draft.id, content_family_id: draft.content_family_id ?? "unlinked", channel: draft.channel, operator: actorForRole(this.#state.role), published_at: publishedAt, status: "published", association_window_days: 7, visible_customers: null, likes: null, comments: null, synced_at: null };
    const updated: Draft = { ...draft, published_at: publishedAt, status: "done", revision: expectedRevision + 1, updated_at: publishedAt };
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: "标记人工发布", detail: `${draft.title} · ${draft.channel} · 未调用发送接口`, at: publishedAt, source: "human" as const };
    return this.#persist({ ...this.#state, drafts: this.#state.drafts.map((item) => item.id === draft.id ? updated : item), publications: [publication, ...this.#state.publications], audits: [audit, ...this.#state.audits] });
  }

  async syncPublicationResults(idValue: string, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "mark_publish")) throw problem(403, "FORBIDDEN", "只有运营可以同步合成朋友圈结果");
    const publication = this.#state.publications.find((item) => item.id === idValue);
    if (!publication) throw problem(404, "NOT_FOUND", "发布记录不存在");
    if (publication.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "发布结果已更新", true, publication);
    const seed = this.#state.publications.findIndex((item) => item.id === idValue) + 1;
    const syncedAt = now();
    const updated: PublicationRecord = { ...publication, status: "results_synced", visible_customers: 70 + seed * 13, likes: 3 + seed * 2, comments: seed % 5, synced_at: syncedAt, revision: expectedRevision + 1, updated_at: syncedAt };
    const audit = { id: id("audit"), actor: "合成朋友圈同步器", action: "同步平台互动结果", detail: `${publication.id} · 可见 ${updated.visible_customers} · 点赞 ${updated.likes} · 评论 ${updated.comments}`, at: syncedAt, source: "system" as const };
    return this.#persist({ ...this.#state, publications: this.#state.publications.map((item) => item.id === idValue ? updated : item), audits: [audit, ...this.#state.audits] });
  }

  async recordContentOutcome(publicationId: string, type: ContentOutcome["type"], detail: string, customerId: string | null) {
    await this.#latency();
    if (!can(this.#state.role, "record_content_outcome")) throw problem(403, "FORBIDDEN", "只有销售可以回填内容业务结果");
    if (!this.#state.publications.some((item) => item.id === publicationId)) throw problem(404, "NOT_FOUND", "发布记录不存在");
    if (!detail.trim()) throw problem(422, "OUTCOME_REQUIRED", "请填写业务结果");
    const recordedAt = now();
    const outcome: ContentOutcome = { id: id("outcome"), revision: 1, updated_at: recordedAt, publication_id: publicationId, customer_id: customerId, type, detail: detail.trim(), occurred_at: recordedAt, recorded_by: actorForRole(this.#state.role) };
    const audit = { id: id("audit"), actor: actorForRole(this.#state.role), action: "回填内容业务结果", detail: `${publicationId} · ${type} · ${detail.trim()}`, at: recordedAt, source: "human" as const };
    return this.#persist({ ...this.#state, content_outcomes: [outcome, ...this.#state.content_outcomes], audits: [audit, ...this.#state.audits] });
  }

  async saveWeeklyRetrospective(retrospective: WeeklyRetrospective, meta: AiMeta | null, generatedBy: string, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "generate_strategy")) throw problem(403, "FORBIDDEN", "只有运营可以保存周复盘");
    const current = this.#state.weekly_retrospective;
    if (current.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "周复盘已更新", true, current);
    const savedAt = now();
    return this.#persist({ ...this.#state, weekly_retrospective: { ...current, retrospective, generated_by: generatedBy, ai_meta: meta, revision: expectedRevision + 1, updated_at: savedAt }, audits: [{ id: id("audit"), actor: generatedBy, action: "保存周复盘", detail: `${retrospective.week_label} · ${retrospective.next_week_candidates.length} 个下周策略候选`, at: savedAt, source: meta ? "ai" as const : "human" as const }, ...this.#state.audits] });
  }

  async saveWeeklyPlan(strategy: DomainState["weekly_plan"]["strategy"], generatedBy: string) {
    await this.#latency();
    if (!can(this.#state.role, "generate_strategy")) throw problem(403, "FORBIDDEN", "只有运营角色可以生成周策略");
    return this.#persist({ ...this.#state, weekly_plan: { strategy, status: "ready", generated_by: generatedBy, generated_at: now() } });
  }

  async restoreSnapshot(snapshot: DomainState) { await this.#latency(); return this.#persist(structuredClone(snapshot)); }
  async reset() { await this.#latency(); return this.#persist(this.#resetState()); }
}

function loadBrowserState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as DomainState | null;
    if (parsed?.fixture_version === FIXTURE_VERSION) return parsed;
  } catch {
    // Corrupted or old synthetic state is safely replaced by the current fixture.
  }
  return createFixtureState();
}

class MockDataClient extends StateDataClient {
  constructor() {
    super({
      initialState: loadBrowserState(),
      persist: (state) => localStorage.setItem(STORAGE_KEY, JSON.stringify(state)),
      latency: () => new Promise((resolve) => window.setTimeout(resolve, 90)),
      reset: () => { localStorage.removeItem(STORAGE_KEY); return createFixtureState(); },
    });
  }
}

class HttpDataClient implements DataClient {
  async #request(path: string, init?: RequestInit) {
    const method = init?.method?.toUpperCase() ?? "GET";
    const csrf = method === "GET" || method === "HEAD" ? {} : await sessionClient.writeHeaders();
    const response = await fetch(`/api/v2${path}`, { ...init, credentials: "same-origin", headers: { "content-type": "application/json", ...csrf, ...init?.headers } });
    const body = await response.json();
    if (!response.ok) throw body.error ?? problem(response.status, "HTTP_ERROR", "数据请求失败", response.status >= 500);
    return body as DomainState;
  }
  getState() { return this.#request("/state"); }
  async setRole(role: Role) { return (await sessionClient.switchRole(role)).state; }
  saveDraft(draft: Draft, expectedRevision: number) { return this.#request(`/drafts/${draft.id}`, { method: "PUT", body: JSON.stringify({ draft, expected_revision: expectedRevision }) }); }
  submitDraftApproval(idValue: string, expectedRevision: number) { return this.#request(`/drafts/${idValue}/approval`, { method: "POST", body: JSON.stringify({ expected_revision: expectedRevision }) }); }
  saveProof(proof: Proof, expectedRevision: number) { return this.#request(`/proofs/${proof.id}`, { method: "PUT", body: JSON.stringify({ proof, expected_revision: expectedRevision }) }); }
  createProof(proof: NewProof) { return this.#request("/proofs", { method: "POST", body: JSON.stringify({ proof }) }); }
  decideEvaluationCandidate(customerId: string, candidateId: string, decision: EvaluationDecisionKind, evaluation: CustomerEvaluation | null, reasonCode: EvaluationReasonCode | null, reasonNote: string, expectedRevision: number) { return this.#request(`/customers/${customerId}/evaluation-decisions`, { method: "POST", body: JSON.stringify({ candidate_id: candidateId, decision, evaluation, reason_code: reasonCode, reason_note: reasonNote, expected_revision: expectedRevision }) }); }
  recordEvaluationReview(decisionId: string, outcome: EvaluationReviewOutcome, reason: string, expectedRevision: number) { return this.#request(`/evaluation-decisions/${decisionId}/review`, { method: "POST", body: JSON.stringify({ outcome, reason, expected_revision: expectedRevision }) }); }
  saveMarketingCandidate(candidate: MarketingDecisionCandidate) { return this.#request("/marketing/candidates", { method: "POST", body: JSON.stringify({ candidate }) }); }
  decideMarketingCandidate(candidateId: string, decision: MarketingDecisionKind, output: MarketingDecisionOutput | null, reasonCode: MarketingDecisionReasonCode | null, reasonNote: string, expectedRevision: number) { return this.#request(`/marketing/candidates/${candidateId}/decision`, { method: "POST", body: JSON.stringify({ decision, output, reason_code: reasonCode, reason_note: reasonNote, expected_revision: expectedRevision }) }); }
  recordMarketingReview(decisionId: string, outcome: MarketingReviewOutcome, reason: string, expectedRevision: number) { return this.#request(`/marketing/decisions/${decisionId}/review`, { method: "POST", body: JSON.stringify({ outcome, reason, expected_revision: expectedRevision }) }); }
  runGoldenEvaluation(marketingBrainVersionId: string, routerVersionId: string, split: "development" | "holdout") { return this.#request("/ai-quality/eval-runs", { method: "POST", body: JSON.stringify({ marketing_brain_version_id: marketingBrainVersionId, router_version_id: routerVersionId, split }) }); }
  startLiveHoldout(marketingBrainVersionId: string, routerVersionId: string, idempotencyKey: string) { return this.#request("/ai-quality/live-holdout-runs", { method: "POST", body: JSON.stringify({ marketing_brain_version_id: marketingBrainVersionId, router_version_id: routerVersionId, usage_confirmed: true, idempotency_key: idempotencyKey }) }); }
  pauseLiveHoldout(runId: string, expectedRevision: number) { return this.#request(`/ai-quality/live-holdout-runs/${runId}/pause`, { method: "POST", body: JSON.stringify({ expected_revision: expectedRevision }) }); }
  createRouterVersion(name: string, description: string, confidenceThreshold: number) { return this.#request("/ai-quality/router-versions", { method: "POST", body: JSON.stringify({ name, description, confidence_threshold: confidenceThreshold }) }); }
  promoteAiVersion(kind: "brain" | "router", versionId: string, expectedRevision: number) { return this.#request(`/ai-quality/${kind}-versions/${versionId}/promote`, { method: "POST", body: JSON.stringify({ expected_revision: expectedRevision }) }); }
  rollbackAiVersion(kind: "brain" | "router", versionId: string, expectedRevision: number) { return this.#request(`/ai-quality/${kind}-versions/${versionId}/rollback`, { method: "POST", body: JSON.stringify({ expected_revision: expectedRevision }) }); }
  decideNba(customerId: string, decision: NbaDecision["decision"], action: string, reason: string, expectedRevision: number) { return this.#request(`/customers/${customerId}/nba`, { method: "POST", body: JSON.stringify({ decision, action, reason, expected_revision: expectedRevision }) }); }
  addCustomerNote(customerId: string, text: string, expectedRevision: number) { return this.#request(`/customers/${customerId}/notes`, { method: "POST", body: JSON.stringify({ text, expected_revision: expectedRevision }) }); }
  decideApproval(idValue: string, decision: "approved" | "returned", reason: string, expectedRevision: number) { return this.#request(`/approvals/${idValue}`, { method: "PUT", body: JSON.stringify({ decision, reason, expected_revision: expectedRevision }) }); }
  recordTaskOutcome(idValue: string, outcome: string, expectedRevision: number) { return this.#request(`/tasks/${idValue}/outcome`, { method: "POST", body: JSON.stringify({ outcome, expected_revision: expectedRevision }) }); }
  saveInsightBatch(batch: AnalysisBatch, insights: ConversationInsight[]) { return this.#request("/insight-batches", { method: "POST", body: JSON.stringify({ batch, insights }) }); }
  decideInsight(idValue: string, decision: "accepted" | "dismissed", reason: string, edits: Partial<Pick<ConversationInsight, "title" | "summary" | "customer_segment">>, expectedRevision: number) { return this.#request(`/insights/${idValue}/decision`, { method: "POST", body: JSON.stringify({ decision, reason, edits, expected_revision: expectedRevision }) }); }
  saveBrief(brief: ContentBrief, expectedRevision: number) { return this.#request(`/briefs/${brief.id}`, { method: "PUT", body: JSON.stringify({ brief, expected_revision: expectedRevision }) }); }
  recordRawAccess(conversationId: string, purpose: string) { return this.#request(`/archive/conversations/${conversationId}/access`, { method: "POST", body: JSON.stringify({ purpose }) }); }
  markPublished(draftId: string, expectedRevision: number) { return this.#request(`/drafts/${draftId}/publication`, { method: "POST", body: JSON.stringify({ expected_revision: expectedRevision }) }); }
  syncPublicationResults(idValue: string, expectedRevision: number) { return this.#request(`/publications/${idValue}/sync`, { method: "POST", body: JSON.stringify({ expected_revision: expectedRevision }) }); }
  recordContentOutcome(publicationId: string, type: ContentOutcome["type"], detail: string, customerId: string | null) { return this.#request(`/publications/${publicationId}/outcomes`, { method: "POST", body: JSON.stringify({ type, detail, customer_id: customerId }) }); }
  saveWeeklyRetrospective(retrospective: WeeklyRetrospective, meta: AiMeta | null, generatedBy: string, expectedRevision: number) { return this.#request("/weekly-retrospective", { method: "PUT", body: JSON.stringify({ retrospective, meta, generated_by: generatedBy, expected_revision: expectedRevision }) }); }
  saveWeeklyPlan(strategy: DomainState["weekly_plan"]["strategy"], generatedBy: string) { return this.#request("/weekly-plan", { method: "PUT", body: JSON.stringify({ strategy, generated_by: generatedBy }) }); }
  restoreSnapshot(_snapshot: DomainState) { return this.#request("/undo", { method: "POST", body: JSON.stringify({}) }); }
  reset() { return this.#request("/reset", { method: "POST" }); }
}

export function createDataClient(mode = import.meta.env.VITE_DATA_MODE ?? "http"): DataClient {
  return mode === "http" ? new HttpDataClient() : new MockDataClient();
}
