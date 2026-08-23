import { createFixtureState } from "../domain/fixtures";
import type { CustomerEvaluation } from "../domain/schemas";
import { validateCustomerEvaluation } from "../domain/policy";
import type { ApiProblem, Approval, DomainState, Draft, Role, Task } from "../domain/types";
import type { AiMeta } from "../domain/schemas";
import { can } from "../domain/permissions";

const STORAGE_KEY = "trust-to-action-dogfood-v2";
const FIXTURE_VERSION = 2;

export interface DataClient {
  getState(): Promise<DomainState>;
  setRole(role: Role): Promise<DomainState>;
  saveDraft(draft: Draft, expectedRevision: number): Promise<DomainState>;
  applyCustomerEvaluation(customerId: string, evaluation: CustomerEvaluation, meta: AiMeta, expectedRevision: number): Promise<DomainState>;
  decideApproval(id: string, decision: "approved" | "returned", reason: string, expectedRevision: number): Promise<DomainState>;
  recordTaskOutcome(id: string, outcome: string, expectedRevision: number): Promise<DomainState>;
  saveWeeklyPlan(strategy: DomainState["weekly_plan"]["strategy"], generatedBy: string): Promise<DomainState>;
  restoreSnapshot(snapshot: DomainState): Promise<DomainState>;
  reset(): Promise<DomainState>;
}

function problem(status: number, code: string, message: string, retryable = false, latest?: unknown): ApiProblem {
  return { status, code, message, retryable, latest };
}

function now() {
  return new Date().toISOString();
}

function actorFor(role: Role) {
  return role === "operations" ? "林澈" : role === "sales" ? "陈牧" : "周岚";
}

class MockDataClient implements DataClient {
  #state: DomainState;

  constructor() {
    this.#state = this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as DomainState | null;
      if (parsed?.fixture_version === FIXTURE_VERSION) return parsed;
    } catch {
      // Reset corrupted demo state instead of propagating invalid browser data.
    }
    return createFixtureState();
  }

  #persist(next: DomainState) {
    this.#state = next;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return structuredClone(next);
  }

  async #latency() {
    await new Promise((resolve) => window.setTimeout(resolve, 90));
  }

  async getState() { await this.#latency(); return structuredClone(this.#state); }

  async setRole(role: Role) {
    await this.#latency();
    return this.#persist({ ...this.#state, role });
  }

  async saveDraft(draft: Draft, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "edit_draft")) throw problem(403, "FORBIDDEN", "当前角色不能编辑内容草稿");
    const current = this.#state.drafts.find((item) => item.id === draft.id);
    if (!current) throw problem(404, "NOT_FOUND", "草稿不存在");
    if (current.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "草稿已被其他操作更新", true, current);
    const saved = { ...draft, revision: expectedRevision + 1, updated_at: now() };
    return this.#persist({ ...this.#state, drafts: this.#state.drafts.map((item) => item.id === draft.id ? saved : item) });
  }

  async applyCustomerEvaluation(customerId: string, evaluation: CustomerEvaluation, meta: AiMeta, expectedRevision: number) {
    await this.#latency();
    const customer = this.#state.customers.find((item) => item.id === customerId);
    if (!customer) throw problem(404, "NOT_FOUND", "客户不存在");
    if (customer.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "客户状态已更新", true, customer);
    const policy = validateCustomerEvaluation(customer, evaluation);
    if (!policy.allowed) throw problem(422, policy.code, policy.reasons.join("；"));
    const updated = { ...customer, state: evaluation.state_after, confidence: evaluation.confidence, review_at: evaluation.next_review_at, evaluation, evaluation_meta: { model: meta.model, response_id: meta.response_id, prompt_version: meta.prompt_version }, revision: expectedRevision + 1, updated_at: now() };
    const audit = { id: `audit-${Date.now()}`, actor: "OpenAI", action: "自动写入客户状态与 NBA", detail: `${customer.name} · ${customer.state} → ${evaluation.state_after} · ${evaluation.recommendation} · ${meta.response_id}`, at: now(), source: "ai" as const };
    return this.#persist({ ...this.#state, customers: this.#state.customers.map((item) => item.id === customerId ? updated : item), audits: [audit, ...this.#state.audits] });
  }

  async decideApproval(id: string, decision: "approved" | "returned", reason: string, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "decide_approval")) throw problem(403, "FORBIDDEN", "只有负责人可以处理敏感审批");
    const approval = this.#state.approvals.find((item) => item.id === id);
    if (!approval) throw problem(404, "NOT_FOUND", "审批不存在");
    if (approval.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "审批已被处理", true, approval);
    const updated: Approval = { ...approval, status: decision, reason, revision: expectedRevision + 1, updated_at: now() };
    const drafts = this.#state.drafts.map((draft) => draft.id === approval.object_id ? { ...draft, approval_status: decision, status: decision === "approved" ? "ready" as const : "blocked" as const, revision: draft.revision + 1, updated_at: now() } : draft);
    const audit = { id: `audit-${Date.now()}`, actor: actorFor(this.#state.role), action: decision === "approved" ? "批准敏感内容" : "退回敏感内容", detail: `${approval.title} · ${reason}`, at: now(), source: "human" as const };
    return this.#persist({ ...this.#state, approvals: this.#state.approvals.map((item) => item.id === id ? updated : item), drafts, audits: [audit, ...this.#state.audits] });
  }

  async recordTaskOutcome(id: string, outcome: string, expectedRevision: number) {
    await this.#latency();
    if (!can(this.#state.role, "record_task")) throw problem(403, "FORBIDDEN", "只有销售角色可以回填执行结果");
    const task = this.#state.tasks.find((item) => item.id === id);
    if (!task) throw problem(404, "NOT_FOUND", "任务不存在");
    if (task.revision !== expectedRevision) throw problem(409, "VERSION_CONFLICT", "任务已被更新", true, task);
    const updated: Task = { ...task, status: "done", outcome, revision: expectedRevision + 1, updated_at: now() };
    return this.#persist({ ...this.#state, tasks: this.#state.tasks.map((item) => item.id === id ? updated : item) });
  }

  async saveWeeklyPlan(strategy: DomainState["weekly_plan"]["strategy"], generatedBy: string) {
    await this.#latency();
    if (!can(this.#state.role, "generate_strategy")) throw problem(403, "FORBIDDEN", "只有运营角色可以生成周策略");
    return this.#persist({ ...this.#state, weekly_plan: { strategy, status: "ready", generated_by: generatedBy, generated_at: now() } });
  }

  async restoreSnapshot(snapshot: DomainState) {
    await this.#latency();
    return this.#persist(structuredClone(snapshot));
  }

  async reset() {
    await this.#latency();
    localStorage.removeItem(STORAGE_KEY);
    return this.#persist(createFixtureState());
  }
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
  applyCustomerEvaluation(customerId: string, evaluation: CustomerEvaluation, meta: AiMeta, expectedRevision: number) { return this.#request(`/customers/${customerId}/evaluation`, { method: "POST", body: JSON.stringify({ evaluation, meta, expected_revision: expectedRevision }) }); }
  decideApproval(id: string, decision: "approved" | "returned", reason: string, expectedRevision: number) { return this.#request(`/approvals/${id}`, { method: "PUT", body: JSON.stringify({ decision, reason, expected_revision: expectedRevision }) }); }
  recordTaskOutcome(id: string, outcome: string, expectedRevision: number) { return this.#request(`/tasks/${id}/outcome`, { method: "POST", body: JSON.stringify({ outcome, expected_revision: expectedRevision }) }); }
  saveWeeklyPlan(strategy: DomainState["weekly_plan"]["strategy"], generatedBy: string) { return this.#request("/weekly-plan", { method: "PUT", body: JSON.stringify({ strategy, generated_by: generatedBy }) }); }
  restoreSnapshot(snapshot: DomainState) { return this.#request("/undo", { method: "POST", body: JSON.stringify({ snapshot }) }); }
  reset() { return this.#request("/reset", { method: "POST" }); }
}

export function createDataClient(mode = import.meta.env.VITE_DATA_MODE ?? "mock"): DataClient {
  return mode === "http" ? new HttpDataClient() : new MockDataClient();
}
