import { createFixtureState } from "../domain/fixtures";
import { actorForRole, can, canAccessCustomer, canActOnTask, canViewRawConversation } from "../domain/permissions";
import { draftApprovalRisks, insightTrendScope, isMaterialDraftChange, proofCompleteness, proofIsUsable, validateCustomerEvaluation, validateInsightLineage } from "../domain/policy";
import type { AiMeta, CustomerEvaluation, WeeklyRetrospective } from "../domain/schemas";
import type { AnalysisBatch, ApiProblem, Approval, ContentBrief, ContentOutcome, ConversationInsight, DomainState, Draft, NbaDecision, Proof, ProofCore, PublicationRecord, Role, Task } from "../domain/types";

const STORAGE_KEY = "trust-to-action-dogfood-v2";
const FIXTURE_VERSION = 4;

type NewProof = Omit<ProofCore, "completeness" | "missing_fields" | "referenced_by">;

export interface DataClient {
  getState(): Promise<DomainState>;
  setRole(role: Role): Promise<DomainState>;
  saveDraft(draft: Draft, expectedRevision: number): Promise<DomainState>;
  submitDraftApproval(id: string, expectedRevision: number): Promise<DomainState>;
  saveProof(proof: Proof, expectedRevision: number): Promise<DomainState>;
  createProof(proof: NewProof): Promise<DomainState>;
  applyCustomerEvaluation(customerId: string, evaluation: CustomerEvaluation, meta: AiMeta, expectedRevision: number): Promise<DomainState>;
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

class MockDataClient implements DataClient {
  #state: DomainState;

  constructor() { this.#state = this.#load(); }

  #load() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as DomainState | null;
      if (parsed?.fixture_version === FIXTURE_VERSION) return parsed;
    } catch {
      // Corrupted or old synthetic state is safely replaced by the current fixture.
    }
    return createFixtureState();
  }

  #persist(next: DomainState) {
    this.#state = next;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return structuredClone(next);
  }

  async #latency() { await new Promise((resolve) => window.setTimeout(resolve, 90)); }
  async getState() { await this.#latency(); return structuredClone(this.#state); }
  async setRole(role: Role) { await this.#latency(); return this.#persist({ ...this.#state, role }); }

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

  async applyCustomerEvaluation(customerId: string, evaluation: CustomerEvaluation, meta: AiMeta, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "evaluate_customer")) throw problem(403, "FORBIDDEN", "当前角色不能评估客户");
    const customer = this.#state.customers.find((item) => item.id === customerId);
    if (!customer || !canAccessCustomer(this.#state.role, customer)) throw problem(404, "NOT_FOUND", "客户不存在或不在当前可见范围");
    if (customer.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "客户状态已更新", true, customer);
    const policy = validateCustomerEvaluation(customer, evaluation);
    if (!policy.allowed) throw problem(422, policy.code, policy.reasons.join("；"));
    const updated = { ...customer, state: evaluation.state_after, confidence: evaluation.confidence, review_at: evaluation.next_review_at, evaluation, evaluation_meta: { model: meta.model, response_id: meta.response_id, prompt_version: meta.prompt_version }, nba_decision: null, revision: expectedRevision + 1, updated_at: now() };
    const audit = { id: id("audit"), actor: "OpenAI", action: "自动写入客户状态与下一最佳动作", detail: `${customer.name} · ${customer.state} → ${evaluation.state_after} · ${evaluation.recommendation} · ${meta.response_id}`, at: now(), source: "ai" as const };
    return this.#persist({ ...this.#state, customers: this.#state.customers.map((item) => item.id === customerId ? updated : item), audits: [audit, ...this.#state.audits] });
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
  async reset() { await this.#latency(); localStorage.removeItem(STORAGE_KEY); return this.#persist(createFixtureState()); }
}

class HttpDataClient implements DataClient {
  async #request(path: string, init?: RequestInit) {
    const response = await fetch(`/api/v2${path}`, { headers: { "content-type": "application/json", ...init?.headers }, ...init });
    const body = await response.json();
    if (!response.ok) throw body.error ?? problem(response.status, "HTTP_ERROR", "数据请求失败", response.status >= 500);
    return body as DomainState;
  }
  getState() { return this.#request("/state"); }
  setRole(role: Role) { return this.#request("/role", { method: "PUT", body: JSON.stringify({ role }) }); }
  saveDraft(draft: Draft, expectedRevision: number) { return this.#request(`/drafts/${draft.id}`, { method: "PUT", body: JSON.stringify({ draft, expected_revision: expectedRevision }) }); }
  submitDraftApproval(idValue: string, expectedRevision: number) { return this.#request(`/drafts/${idValue}/approval`, { method: "POST", body: JSON.stringify({ expected_revision: expectedRevision }) }); }
  saveProof(proof: Proof, expectedRevision: number) { return this.#request(`/proofs/${proof.id}`, { method: "PUT", body: JSON.stringify({ proof, expected_revision: expectedRevision }) }); }
  createProof(proof: NewProof) { return this.#request("/proofs", { method: "POST", body: JSON.stringify({ proof }) }); }
  applyCustomerEvaluation(customerId: string, evaluation: CustomerEvaluation, meta: AiMeta, expectedRevision: number) { return this.#request(`/customers/${customerId}/evaluation`, { method: "POST", body: JSON.stringify({ evaluation, meta, expected_revision: expectedRevision }) }); }
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
  restoreSnapshot(snapshot: DomainState) { return this.#request("/undo", { method: "POST", body: JSON.stringify({ snapshot }) }); }
  reset() { return this.#request("/reset", { method: "POST" }); }
}

export function createDataClient(mode = import.meta.env.VITE_DATA_MODE ?? "mock"): DataClient {
  return mode === "http" ? new HttpDataClient() : new MockDataClient();
}
