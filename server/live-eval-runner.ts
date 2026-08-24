import crypto from "node:crypto";
import type { AiResult, ContentBriefProposal, ContentDraftProposal, CustomerEvaluation, WeeklyStrategy } from "../src/domain/schemas";
import { validateCustomerEvaluation } from "../src/domain/policy";
import { scoreLiveHoldoutResults } from "../src/domain/quality";
import type { Customer, DomainState, EvalRun, GoldenCase, KnowledgeReference, LiveEvalCaseResult, LiveEvalGraderChecks, MarketingDecisionOutput, MarketingTaskType, TenantFactRecord } from "../src/domain/types";
import { AiServiceError, type AiService } from "./ai-service";
import { KnowledgeService } from "./knowledge-service";
import { MARKETING_PROMPT_HASHES, type MarketingPromptContext } from "./prompts";
import { RepositoryConflictError, type StateRepository } from "./repository";

const MAX_CONCURRENCY = 2;
const TASKS: MarketingTaskType[] = ["weekly_strategy", "content_brief", "content_draft", "customer_nba"];

interface StartLiveHoldoutInput {
  tenantId: string;
  actor: string;
  marketingBrainVersionId: string;
  routerVersionId: string;
  idempotencyKey: string;
}

interface EvaluationContext {
  state: DomainState;
  item: GoldenCase;
  brainContext: MarketingPromptContext;
  idempotencyKey: string;
  knownSources: Set<string>;
  forbiddenSources: Set<string>;
}

function now() { return new Date().toISOString(); }

function extractBusinessRefs(task: MarketingTaskType, output: MarketingDecisionOutput) {
  if (task === "content_brief") return (output as ContentBriefProposal).insight_refs;
  if (task === "customer_nba") return (output as CustomerEvaluation).evidence_refs;
  return (output as WeeklyStrategy | ContentDraftProposal).evidence_refs;
}

function syntheticCustomer(base: Customer, item: GoldenCase): Customer {
  const advancingToC1 = item.expected_state === "C1" && item.state_before !== "C1";
  const strongCommercial = item.evidence_strength === "strong" && ["D1", "A1"].includes(item.expected_state);
  const text = advancingToC1 ? "已记录合成成交事实" : strongCommercial ? "主动询问实施、价格与下一步" : item.evidence_strength === "weak" ? "点赞了一条朋友圈内容" : "主动索要案例并说明团队规模";
  return {
    ...structuredClone(base),
    id: `live-${item.id}`,
    revision: 1,
    updated_at: now(),
    name: `合成客户 ${item.id}`,
    company: `${item.industry}合成企业`,
    industry: item.industry,
    state: item.state_before,
    confidence: item.evidence_strength === "strong" ? 82 : item.evidence_strength === "medium" ? 68 : 42,
    evidence_strength: item.evidence_strength,
    anomaly: item.anomaly,
    evaluation: null,
    evaluation_meta: null,
    evidence: [{
      id: item.expected_evidence_refs[0],
      strength: item.evidence_strength,
      type: advancingToC1 ? "成交事实" : strongCommercial ? "主动商业咨询" : item.evidence_strength === "weak" ? "朋友圈点赞" : "主动咨询",
      text,
      occurred_at: item.anomaly === "数据过期" ? "2026-07-01T09:00:00.000Z" : "2026-08-23T09:00:00.000Z",
      source: "合成黄金集",
      valid: true,
      transaction_fact: advancingToC1,
    }, ...item.expected_evidence_refs.slice(1).map((id) => ({
      id,
      strength: "strong" as const,
      type: item.state_before === "C1" ? "历史成交事实" : "历史状态依据",
      text: item.state_before === "C1" ? "已记录支撑当前状态的合成成交事实" : "已记录支撑当前状态的历史强证据",
      occurred_at: "2026-08-10T09:00:00.000Z",
      source: "合成黄金集历史",
      valid: true,
      transaction_fact: item.state_before === "C1",
    }))],
    notes: [],
    nba_decision: null,
  };
}

function outputContainsPrivacy(output: MarketingDecisionOutput) {
  const text = JSON.stringify(output);
  return /(?:1[3-9]\d{9}|\d{17}[\dXx]|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/u.test(text);
}

function outputContainsUnsupportedExecutionClaim(output: MarketingDecisionOutput) {
  return /已经(?:自动)?(?:发布|发送|私聊|报价)|保证(?:成交|增长|转化)|承诺\s*\d+%/u.test(JSON.stringify(output));
}

function gradeOutput(context: EvaluationContext, output: MarketingDecisionOutput, customer: Customer | null, knowledgeRefs: KnowledgeReference[]): LiveEvalGraderChecks {
  const { item, knownSources, forbiddenSources } = context;
  const businessRefs = extractBusinessRefs(item.task_type, output);
  const businessEvidencePrecise = businessRefs.length > 0 && businessRefs.every((id) => item.expected_evidence_refs.includes(id));
  const knowledgeText = knowledgeRefs.slice(0, 5).map((ref) => `${ref.source_title} ${ref.heading_path.join(" ")} ${ref.excerpt}`).join(" ");
  const knowledgeHitAt5 = item.expected_knowledge_terms.every((term) => knowledgeText.includes(term));
  const knowledgeCitationPrecise = knowledgeRefs.length > 0 && knowledgeRefs.every((ref) => knownSources.has(ref.source_id));
  const forbiddenSourceHit = knowledgeRefs.some((ref) => forbiddenSources.has(ref.source_id));
  const evaluation = item.task_type === "customer_nba" ? output as CustomerEvaluation : null;
  const policy = evaluation && customer ? validateCustomerEvaluation(customer, evaluation) : { allowed: true };
  const stateCorrect = !evaluation || evaluation.state_after === item.expected_state;
  const nbaAcceptable = !evaluation || item.acceptable_nba.includes(evaluation.recommendation);
  const policyViolation = !policy.allowed
    || (item.task_type === "weekly_strategy" && Object.values((output as WeeklyStrategy).ratio).reduce((sum, value) => sum + value, 0) !== 100)
    || outputContainsUnsupportedExecutionClaim(output);
  const privacyLeak = outputContainsPrivacy(output);
  const unsupportedFact = outputContainsUnsupportedExecutionClaim(output);
  const effectiveAdoption = stateCorrect && nbaAcceptable && businessEvidencePrecise && knowledgeHitAt5 && knowledgeCitationPrecise
    && !policyViolation && !privacyLeak && !forbiddenSourceHit && !unsupportedFact && item.future_event !== "quality_reversal";
  return {
    reviewed: true,
    state_correct: stateCorrect,
    nba_acceptable: nbaAcceptable,
    evidence_precise: businessEvidencePrecise,
    knowledge_hit_at_5: knowledgeHitAt5,
    knowledge_citation_precise: knowledgeCitationPrecise,
    business_evidence_precise: businessEvidencePrecise,
    policy_violation: policyViolation,
    privacy_leak: privacyLeak,
    forbidden_source_hit: forbiddenSourceHit,
    unsupported_fact: unsupportedFact,
    effective_adoption: effectiveAdoption,
  };
}

export class LiveHoldoutRunner {
  #active = new Map<string, Promise<void>>();

  constructor(
    private repository: StateRepository,
    private aiService: AiService,
    private knowledgeService: KnowledgeService,
  ) {}

  start(input: StartLiveHoldoutInput) {
    if (!this.aiService.configured) throw new AiServiceError(503, "AI_NOT_CONFIGURED", "真实 Holdout 需要先配置 OpenAI API Key。", false);
    const status = this.knowledgeService.status(input.tenantId);
    if (!status.active_version) throw new AiServiceError(422, "KNOWLEDGE_NOT_CONFIGURED", "真实 Holdout 需要已激活的知识包。", false);
    let runId = "";
    this.#update(input.tenantId, (state) => {
      const brain = state.marketing_brain_versions.find((item) => item.id === input.marketingBrainVersionId);
      const router = state.router_versions.find((item) => item.id === input.routerVersionId);
      const facts = state.tenant_fact_versions.find((item) => item.id === brain?.tenant_fact_version_id && item.status === "published");
      if (!brain || !router) throw new AiServiceError(404, "AI_VERSION_NOT_FOUND", "营销脑或路由版本不存在。", false);
      if (!facts) throw new AiServiceError(422, "TENANT_FACTS_NOT_PUBLISHED", "营销脑绑定的企业事实未发布。", false);
      if (brain.knowledge_pack_version_id !== status.active_version?.id) throw new AiServiceError(409, "KNOWLEDGE_BINDING_MISMATCH", "营销脑未绑定当前激活知识包。", false);
      if (TASKS.some((task) => brain.prompt_hashes[task] !== MARKETING_PROMPT_HASHES[task])) throw new AiServiceError(409, "PROMPT_BINDING_MISMATCH", "营销脑未绑定当前代码化 Prompt，请先完成离线评测和发布。", false);
      if (router.primary_model !== this.aiService.model || router.fast_model !== (this.aiService.fastModel ?? router.fast_model)) throw new AiServiceError(409, "ROUTER_BINDING_MISMATCH", "当前 BFF 模型配置与所选路由版本不一致。", false);
      const cases = state.golden_cases.filter((item) => item.split === "holdout");
      if (cases.length !== 88) throw new AiServiceError(422, "HOLDOUT_SIZE_INVALID", `锁定 Holdout 应为 88 条，当前为 ${cases.length} 条。`, false);
      const existing = state.eval_runs.find((item) => item.mode === "live" && item.idempotency_key === input.idempotencyKey)
        ?? [...state.eval_runs].reverse().find((item) => item.mode === "live" && item.marketing_brain_version_id === brain.id && item.router_version_id === router.id && item.status !== "completed");
      const startedAt = now();
      if (existing) {
        runId = existing.id;
        if (existing.status === "completed") return state;
        const resumedResults = (existing.case_results ?? []).map((item): LiveEvalCaseResult => item.status === "running" || (item.status === "failed" && item.retryable && item.attempt_count < 3)
          ? { ...item, status: "pending", started_at: null, completed_at: null, error_code: null }
          : item);
        const resumed: EvalRun = { ...existing, status: "running", completed_at: null, case_results: resumedResults, revision: existing.revision + 1, updated_at: startedAt };
        return { ...state, eval_runs: state.eval_runs.map((item) => item.id === existing.id ? resumed : item) };
      }
      runId = `eval-live-${crypto.randomUUID()}`;
      const run: EvalRun = {
        id: runId,
        revision: 1,
        updated_at: startedAt,
        marketing_brain_version_id: brain.id,
        router_version_id: router.id,
        split: "holdout",
        mode: "live",
        status: "running",
        case_count: cases.length,
        score: null,
        started_at: startedAt,
        completed_at: null,
        generated_by: input.actor,
        usage_confirmed_by: input.actor,
        usage_confirmed_at: startedAt,
        idempotency_key: input.idempotencyKey,
        processed_count: 0,
        successful_count: 0,
        failed_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        case_results: cases.map((item) => ({
          case_id: item.id,
          task_type: item.task_type,
          status: "pending",
          idempotency_key: `${runId}:${item.id}`,
          attempt_count: 0,
          retryable: true,
          started_at: null,
          completed_at: null,
          model: null,
          response_id: null,
          latency_ms: 0,
          input_tokens: 0,
          output_tokens: 0,
          error_code: null,
          checks: null,
        })),
      };
      return { ...state, eval_runs: [...state.eval_runs, run], audits: [{ id: `audit-${crypto.randomUUID()}`, actor: input.actor, action: "确认并启动真实 Holdout", detail: `${brain.name} · ${router.name} · 88 条 · 最大并发 ${MAX_CONCURRENCY}`, at: startedAt, source: "human" }, ...state.audits] };
    });
    this.#schedule(input.tenantId, runId);
    return this.repository.load(input.tenantId).state;
  }

  pause(tenantId: string, runId: string, actor: string, expectedRevision: number) {
    return this.#update(tenantId, (state) => {
      const run = state.eval_runs.find((item) => item.id === runId && item.mode === "live");
      if (!run) throw new AiServiceError(404, "LIVE_EVAL_NOT_FOUND", "真实 Holdout 运行不存在。", false);
      if (run.revision !== expectedRevision) throw new AiServiceError(409, "VERSION_CONFLICT", "评测进度已更新，请刷新后重试。", true);
      if (run.status !== "running") throw new AiServiceError(409, "LIVE_EVAL_NOT_RUNNING", "只有运行中的 Holdout 可以暂停。", false);
      const pausedAt = now();
      const paused = { ...run, status: "paused" as const, revision: run.revision + 1, updated_at: pausedAt };
      return { ...state, eval_runs: state.eval_runs.map((item) => item.id === run.id ? paused : item), audits: [{ id: `audit-${crypto.randomUUID()}`, actor, action: "暂停真实 Holdout", detail: `${run.processed_count ?? 0}/${run.case_count} 条已处理`, at: pausedAt, source: "human" }, ...state.audits] };
    });
  }

  #schedule(tenantId: string, runId: string) {
    const key = `${tenantId}:${runId}`;
    const active = this.#active.get(key);
    if (active) {
      void active.then(() => {
        const run = this.repository.load(tenantId).state.eval_runs.find((item) => item.id === runId);
        if (run?.status === "running") this.#schedule(tenantId, runId);
      });
      return;
    }
    const execution = this.#execute(tenantId, runId).finally(() => this.#active.delete(key));
    this.#active.set(key, execution);
  }

  async #execute(tenantId: string, runId: string) {
    while (true) {
      const loaded = this.repository.load(tenantId);
      const run = loaded.state.eval_runs.find((item) => item.id === runId);
      if (!run || run.status !== "running") return;
      const pending = (run.case_results ?? []).filter((item) => item.status === "pending").slice(0, MAX_CONCURRENCY);
      if (!pending.length) {
        this.#finish(tenantId, runId);
        return;
      }
      const startedAt = now();
      this.#update(tenantId, (state) => ({
        ...state,
        eval_runs: state.eval_runs.map((item) => item.id !== runId ? item : {
          ...item,
          case_results: (item.case_results ?? []).map((result) => pending.some((next) => next.case_id === result.case_id)
            ? { ...result, status: "running" as const, attempt_count: result.attempt_count + 1, started_at: startedAt }
            : result),
          revision: item.revision + 1,
          updated_at: startedAt,
        }),
      }));
      const latest = this.repository.load(tenantId).state;
      const claimed = latest.eval_runs.find((item) => item.id === runId)?.case_results?.filter((item) => pending.some((next) => next.case_id === item.case_id)) ?? [];
      const completed = await Promise.all(claimed.map((result) => this.#evaluateCase(tenantId, runId, latest, result)));
      this.#update(tenantId, (state) => {
        const current = state.eval_runs.find((item) => item.id === runId);
        if (!current) return state;
        const updates = new Map(completed.map((item) => [item.case_id, item]));
        const caseResults = (current.case_results ?? []).map((item) => updates.get(item.case_id) ?? item);
        const processed = caseResults.filter((item) => item.status === "completed" || item.status === "failed").length;
        const successful = caseResults.filter((item) => item.status === "completed").length;
        const failed = caseResults.filter((item) => item.status === "failed").length;
        const updatedAt = now();
        return {
          ...state,
          eval_runs: state.eval_runs.map((item) => item.id !== runId ? item : {
            ...item,
            case_results: caseResults,
            processed_count: processed,
            successful_count: successful,
            failed_count: failed,
            input_tokens: caseResults.reduce((sum, result) => sum + result.input_tokens, 0),
            output_tokens: caseResults.reduce((sum, result) => sum + result.output_tokens, 0),
            revision: item.revision + 1,
            updated_at: updatedAt,
          }),
        };
      });
    }
  }

  async #evaluateCase(tenantId: string, runId: string, state: DomainState, result: LiveEvalCaseResult): Promise<LiveEvalCaseResult> {
    const item = state.golden_cases.find((candidate) => candidate.id === result.case_id);
    if (!item) return { ...result, status: "failed", retryable: false, completed_at: now(), error_code: "GOLDEN_CASE_NOT_FOUND" };
    try {
      const retrieval = this.knowledgeService.retrieve({ tenantId, taskType: item.task_type, query: item.query, market: "china", channels: ["enterprise_wechat"] });
      const knowledgeStatus = this.knowledgeService.status(tenantId);
      const run = state.eval_runs.find((candidate) => candidate.id === runId);
      const brain = state.marketing_brain_versions.find((candidate) => candidate.id === run?.marketing_brain_version_id);
      if (!run || !brain || brain.knowledge_pack_version_id !== knowledgeStatus.active_version?.id || TASKS.some((task) => brain.prompt_hashes[task] !== MARKETING_PROMPT_HASHES[task])) {
        throw new AiServiceError(409, "MARKETING_BRAIN_BINDING_CHANGED", "运行中的营销脑、知识包或代码 Prompt 绑定已变化。", false);
      }
      const factVersion = state.tenant_fact_versions.find((version) => version.id === brain.tenant_fact_version_id && version.status === "published");
      if (!factVersion) throw new AiServiceError(409, "TENANT_FACT_BINDING_CHANGED", "运行中的企业事实绑定已变化。", false);
      const facts = (factVersion?.facts ?? []).filter((fact) => fact.status === "published") as TenantFactRecord[];
      const brainContext: MarketingPromptContext = {
        skill_route: retrieval.skill_route,
        knowledge_refs: retrieval.references,
        tenant_facts: facts,
        business_evidence_refs: item.expected_evidence_refs,
        knowledge_conflicts: retrieval.conflicts,
        growth_posture: "aggressive",
      };
      const base = state.customers[0];
      const customer = item.task_type === "customer_nba" && base ? syntheticCustomer(base, item) : null;
      let generated: AiResult<MarketingDecisionOutput>;
      const common = { brain_context: brainContext, __idempotency_key: result.idempotency_key };
      if (item.task_type === "weekly_strategy") {
        generated = await this.aiService.weeklyStrategy({ ...common, metrics: { synthetic_case: item.scenario }, customer_states: { [item.state_before]: 8 }, business_evidence: item.expected_evidence_refs.map((id) => ({ id, summary: item.scenario })), drafts: [], proofs: [] });
      } else if (item.task_type === "content_brief") {
        generated = await this.aiService.contentBrief({ ...common, accepted_insights: item.expected_evidence_refs.map((id) => ({ id, status: "accepted", title: item.scenario, summary: item.query, independent_conversations: 3, customer_segment: item.industry })), historical_outcomes: [] });
      } else if (item.task_type === "content_draft") {
        generated = await this.aiService.contentDraft({ ...common, strategy: state.weekly_plan.strategy, stage: "I", brief: { title: item.scenario, target_segment: item.industry, cta: "回复资料" }, proofs: item.expected_evidence_refs.map((id) => ({ id, status: "usable", title: "合成授权证明", result: "形成可追溯下一动作", authorization: ["朋友圈"] })), accepted_insights: [], historical_outcomes: [], low_risk_rewrite: !item.anomaly });
      } else {
        generated = await this.aiService.customerEvaluation({ ...common, customer });
      }
      const knownSources = new Set(knowledgeStatus.sources.filter((source) => source.status === "ready").map((source) => source.id));
      const forbiddenSources = new Set(knowledgeStatus.sources.filter((source) => source.status !== "ready").map((source) => source.id));
      const checks = gradeOutput({ state, item, brainContext, idempotencyKey: result.idempotency_key, knownSources, forbiddenSources }, generated.data, customer, retrieval.references);
      return {
        ...result,
        status: "completed",
        retryable: false,
        completed_at: now(),
        model: generated.meta.model,
        response_id: generated.meta.response_id,
        latency_ms: generated.meta.latency_ms ?? 0,
        input_tokens: generated.meta.input_tokens ?? 0,
        output_tokens: generated.meta.output_tokens ?? 0,
        error_code: null,
        checks,
      };
    } catch (error) {
      const serviceError = error instanceof AiServiceError ? error : new AiServiceError(502, "LIVE_EVAL_CASE_FAILED", "真实评测案例执行失败。", true);
      return { ...result, status: "failed", retryable: serviceError.retryable, completed_at: now(), error_code: serviceError.code, checks: null };
    }
  }

  #finish(tenantId: string, runId: string) {
    this.#update(tenantId, (state) => {
      const run = state.eval_runs.find((item) => item.id === runId);
      if (!run || run.status !== "running") return state;
      const cases = state.golden_cases.filter((item) => item.split === "holdout");
      const failed = (run.case_results ?? []).filter((item) => item.status === "failed").length;
      const completedAt = now();
      const finished: EvalRun = {
        ...run,
        status: failed ? "failed" : "completed",
        score: scoreLiveHoldoutResults(cases, run.case_results ?? []),
        completed_at: completedAt,
        revision: run.revision + 1,
        updated_at: completedAt,
      };
      return { ...state, eval_runs: state.eval_runs.map((item) => item.id === run.id ? finished : item), audits: [{ id: `audit-${crypto.randomUUID()}`, actor: run.generated_by, action: "真实 Holdout 运行结束", detail: `${run.successful_count ?? 0}/${run.case_count} 条成功 · ${failed} 条失败 · ${finished.score?.passed ? "通过" : "未通过"}`, at: completedAt, source: "system" }, ...state.audits] };
    });
  }

  #update(tenantId: string, update: (state: DomainState) => DomainState) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const loaded = this.repository.load(tenantId);
      const next = update(structuredClone(loaded.state));
      try {
        return this.repository.save(tenantId, next, loaded.repositoryRevision).state;
      } catch (error) {
        if (!(error instanceof RepositoryConflictError) || attempt === 4) throw error;
      }
    }
    throw new RepositoryConflictError();
  }
}
