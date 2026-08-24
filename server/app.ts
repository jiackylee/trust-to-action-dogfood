import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { CustomerEvaluationSchema, WeeklyStrategySchema } from "../src/domain/schemas";
import { archiveMessageEligibility, redactArchiveText, validateCustomerEvaluation } from "../src/domain/policy";
import { actorForRole, can, canAccessCustomer } from "../src/domain/permissions";
import { calculateQualityMetrics, evidenceFingerprint } from "../src/domain/quality";
import { StateDataClient } from "../src/data/client";
import type { AnalysisBatch, ApiProblem, ArchiveConsent, ArchivedMessage, ContentBrief, ConversationInsight, Customer, DomainState, Draft, EvaluationCandidate, EvaluationDecisionKind, EvaluationReasonCode, EvaluationReviewOutcome, GenerationRun, Proof, Role } from "../src/domain/types";
import { AiServiceError, type AiConfiguration, type AiService, type ConfigurableAiService } from "./ai-service";
import { RepositoryConflictError, SqliteStateRepository, type StateRepository } from "./repository";
import { SessionManager } from "./session";

const CustomerRequestSchema = z.object({
  customer_id: z.string().optional(),
  customer_revision: z.number().int().optional(),
  idempotency_key: z.string().min(8).max(120).optional(),
  customer: z.record(z.string(), z.unknown()).optional(),
}).refine((input) => input.customer_id || input.customer, { message: "customer_id is required" });

const CustomerBatchRequestSchema = z.object({
  customer_ids: z.array(z.string()).min(1).max(10),
  idempotency_key: z.string().min(8).max(120),
});

const ContentDraftRequestSchema = z.object({
  strategy: WeeklyStrategySchema,
  proofs: z.array(z.record(z.string(), z.unknown())).max(12),
  stage: z.enum(["T", "I", "D", "A"]),
  brief: z.record(z.string(), z.unknown()).optional(),
  accepted_insights: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  historical_outcomes: z.array(z.record(z.string(), z.unknown())).max(50).default([]),
});

const RiskRequestSchema = z.object({
  draft: z.record(z.string(), z.unknown()),
  proofs: z.array(z.record(z.string(), z.unknown())).max(12),
  accepted_insights: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
  historical_outcomes: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
});

const ConversationInsightsRequestSchema = z.object({
  messages: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
  consents: z.array(z.record(z.string(), z.unknown())).max(500),
});

const ContentBriefRequestSchema = z.object({
  accepted_insights: z.array(z.record(z.string(), z.unknown())).min(1).max(12),
  historical_outcomes: z.array(z.record(z.string(), z.unknown())).max(50).default([]),
});

const RetrospectiveRequestSchema = z.object({
  insights: z.array(z.record(z.string(), z.unknown())).max(30),
  briefs: z.array(z.record(z.string(), z.unknown())).max(20),
  publications: z.array(z.record(z.string(), z.unknown())).max(50),
  outcomes: z.array(z.record(z.string(), z.unknown())).max(100),
});

const StrategyRequestSchema = z.object({
  current_plan: z.unknown().optional(),
  metrics: z.record(z.string(), z.unknown()),
  customer_states: z.record(z.string(), z.number()),
  drafts: z.array(z.record(z.string(), z.unknown())).max(20),
  proofs: z.array(z.record(z.string(), z.unknown())).max(12),
});

const AiConfigurationRequestSchema = z.object({
  api_key: z.string().trim().min(20).max(512),
  model: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/u),
});

const ExpectedRevisionSchema = z.object({ expected_revision: z.number().int().min(0) });
const DemoRoleSchema = z.object({ role: z.enum(["operations", "sales", "lead"]) });
const CandidateDecisionSchema = z.object({
  candidate_id: z.string(),
  decision: z.enum(["accepted", "modified", "rejected"]),
  evaluation: CustomerEvaluationSchema.nullable(),
  reason_code: z.enum(["wrong_state", "wrong_evidence", "wrong_nba", "missing_context", "risk_compliance", "too_generic", "other"]).nullable(),
  reason_note: z.string().max(500),
  expected_revision: z.number().int().min(0),
});
const EvaluationReviewSchema = z.object({ outcome: z.enum(["retained", "quality_reversal", "new_evidence"]), reason: z.string().max(500), expected_revision: z.number().int().min(1) });
const EvalRunRequestSchema = z.object({ prompt_version_id: z.string(), router_version_id: z.string(), split: z.enum(["development", "holdout"]) });
const PromptVersionRequestSchema = z.object({ name: z.string().trim().min(3).max(80), description: z.string().trim().min(3).max(500) });
const RouterVersionRequestSchema = PromptVersionRequestSchema.extend({ confidence_threshold: z.number().int().min(50).max(95) });

function isConfigurable(service: AiService): service is ConfigurableAiService {
  return "configure" in service && typeof service.configure === "function" && "getConfiguration" in service && typeof service.getConfiguration === "function";
}

function describeConfiguration(service: AiService): AiConfiguration {
  return isConfigurable(service)
    ? service.getConfiguration()
    : { configured: service.configured, model: service.model, fast_model: service.fastModel ?? "gpt-5.6-terra", fast_model_available: true, source: service.configured ? "environment" : "none", configured_at: null };
}

function assertLocalConfigurationRequest(request: Request) {
  const remote = request.socket.remoteAddress ?? "";
  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!loopback || request.get("x-tta-local-config") !== "1") {
    throw new AiServiceError(403, "LOCAL_CONFIG_FORBIDDEN", "AI 配置只允许从本机产品界面提交。", false);
  }
  const role = request.ttaSession.role;
  if (role !== "operations" && role !== "lead") {
    throw new AiServiceError(403, "ROLE_FORBIDDEN", "只有运营或负责人可以修改 AI 配置。", false);
  }
}

function asServiceError(error: unknown) {
  if (error instanceof AiServiceError) return error;
  if (error instanceof RepositoryConflictError) return new AiServiceError(409, "REPOSITORY_CONFLICT", "数据已被其他会话更新，请加载最新状态后重试。", true);
  const problem = error as Partial<ApiProblem> | null;
  if (problem?.status && problem.code && problem.message) return new AiServiceError(problem.status, problem.code, problem.message, problem.retryable ?? false);
  return error;
}

function stateForRole(state: DomainState, role: Role) {
  const withRole = { ...state, role };
  if (role === "operations") {
    return {
      ...withRole,
      archive_conversations: withRole.archive_conversations.map((item) => ({ ...item, display_name: `脱敏会话 ${item.id}` })),
      archived_messages: withRole.archived_messages.map((item) => ({
        ...item,
        sender_name: item.sender === "customer" ? "客户（已脱敏）" : item.sender_name,
        text: item.text ? redactArchiveText(item.text) : null,
      })),
    };
  }
  if (role !== "sales") return withRole;

  const actor = actorForRole(role);
  const customers = withRole.customers.filter((item) => canAccessCustomer(role, item));
  const customerIds = new Set(customers.map((item) => item.id));
  const conversations = withRole.archive_conversations.filter((item) => item.owner === actor);
  const conversationIds = new Set(conversations.map((item) => item.id));
  return {
    ...withRole,
    customers,
    tasks: withRole.tasks.filter((item) => item.owner === actor),
    approvals: [],
    archive_conversations: conversations,
    archive_consents: withRole.archive_consents.filter((item) => conversationIds.has(item.conversation_id)),
    archived_messages: withRole.archived_messages.filter((item) => conversationIds.has(item.conversation_id)),
    generation_runs: withRole.generation_runs.filter((item) => customerIds.has(item.subject_id)),
    evaluation_candidates: withRole.evaluation_candidates.filter((item) => customerIds.has(item.customer_id)),
    evaluation_decisions: withRole.evaluation_decisions.filter((item) => item.actor === actor && customerIds.has(item.customer_id)),
    audits: withRole.audits.filter((item) => item.actor === actor),
  };
}

function stateWithRole(state: DomainState, role: Role) {
  return { ...state, role };
}

async function mutateState(repository: StateRepository, request: Request, operation: (client: StateDataClient) => Promise<DomainState>, onCommitted?: (previous: DomainState) => void) {
  const loaded = repository.load(request.ttaSession.tenant_id);
  let pending: DomainState | null = null;
  const client = new StateDataClient({ initialState: stateWithRole(loaded.state, request.ttaSession.role), persist: (state) => { pending = state; } });
  try {
    const result = await operation(client);
    const saved = repository.save(request.ttaSession.tenant_id, pending ?? result, loaded.repositoryRevision);
    onCommitted?.(structuredClone(loaded.state));
    return stateForRole(saved.state, request.ttaSession.role);
  } catch (error) {
    throw asServiceError(error);
  }
}

function createRateLimiter(limit = 20, windowMs = 5 * 60_000) {
  const calls: number[] = [];
  return (_request: Request, response: Response, next: NextFunction) => {
    const threshold = Date.now() - windowMs;
    while (calls[0] && calls[0] < threshold) calls.shift();
    if (calls.length >= limit) {
      response.status(429).json({ error: { code: "LOCAL_RATE_LIMITED", message: "本地模型调用达到频率上限，请稍后重试。", retryable: true, request_id: response.locals.requestId } });
      return;
    }
    calls.push(Date.now());
    next();
  };
}

export function createApp({
  aiService,
  serveDist = false,
  repository = new SqliteStateRepository(":memory:"),
  sessionManager = new SessionManager(process.env.SESSION_SECRET),
}: {
  aiService: AiService;
  serveDist?: boolean;
  repository?: StateRepository;
  sessionManager?: SessionManager;
}) {
  const app = express();
  const undoSnapshots = new Map<string, { state: DomainState; expiresAt: number }>();
  const undoKey = (request: Request) => `${request.ttaSession.tenant_id}:${request.ttaSession.user_id}:${request.ttaSession.csrf_token}`;
  const rememberUndo = (request: Request) => (state: DomainState) => undoSnapshots.set(undoKey(request), { state, expiresAt: Date.now() + 10_000 });
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    const requestId = request.get("x-request-id") || crypto.randomUUID();
    response.locals.requestId = requestId;
    response.setHeader("x-request-id", requestId);
    response.setHeader("cache-control", "no-store");
    next();
  });
  app.use(express.json({ limit: "1mb" }));

  app.use("/api/v2", (request, response, next) => {
    let session = sessionManager.resolve(request);
    if (!session) {
      session = sessionManager.create("operations");
      sessionManager.set(response, session);
    }
    request.ttaSession = session;
    const safeMethod = request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
    if (!safeMethod && request.get("x-csrf-token") !== session.csrf_token) {
      response.status(403).json({ error: { code: "CSRF_INVALID", message: "会话校验已失效，请刷新页面后重试。", retryable: true, request_id: response.locals.requestId } });
      return;
    }
    next();
  });

  app.get("/api/v2/session", (request, response) => {
    response.json(sessionManager.public(request.ttaSession));
  });

  app.post("/api/v2/session/demo", (request, response, next) => {
    try {
      const { role } = DemoRoleSchema.parse(request.body);
      const session = sessionManager.create(role);
      sessionManager.set(response, session);
      const loaded = repository.load(session.tenant_id);
      response.json({ session: sessionManager.public(session), state: stateForRole(loaded.state, role) });
    } catch (error) { next(error); }
  });

  app.get("/api/v2/state", (request, response) => {
    const loaded = repository.load(request.ttaSession.tenant_id);
    response.json(stateForRole(loaded.state, request.ttaSession.role));
  });

  app.put("/api/v2/drafts/:id", async (request, response, next) => {
    try {
      const body = request.body as { draft: Draft; expected_revision: number };
      response.json(await mutateState(repository, request, (client) => client.saveDraft(body.draft, body.expected_revision)));
    } catch (error) { next(error); }
  });
  app.post("/api/v2/drafts/:id/approval", async (request, response, next) => {
    try { const body = ExpectedRevisionSchema.parse(request.body); response.json(await mutateState(repository, request, (client) => client.submitDraftApproval(request.params.id, body.expected_revision))); }
    catch (error) { next(error); }
  });
  app.put("/api/v2/proofs/:id", async (request, response, next) => {
    try { const body = request.body as { proof: Proof; expected_revision: number }; response.json(await mutateState(repository, request, (client) => client.saveProof(body.proof, body.expected_revision))); }
    catch (error) { next(error); }
  });
  app.post("/api/v2/proofs", async (request, response, next) => {
    try { response.json(await mutateState(repository, request, (client) => client.createProof(request.body.proof))); }
    catch (error) { next(error); }
  });
  app.post("/api/v2/customers/:id/evaluation-decisions", async (request, response, next) => {
    try {
      const body = CandidateDecisionSchema.parse(request.body);
      response.json(await mutateState(repository, request, (client) => client.decideEvaluationCandidate(request.params.id, body.candidate_id, body.decision as EvaluationDecisionKind, body.evaluation, body.reason_code as EvaluationReasonCode | null, body.reason_note, body.expected_revision)));
    } catch (error) { next(error); }
  });
  app.post("/api/v2/evaluation-decisions/:id/review", async (request, response, next) => {
    try { const body = EvaluationReviewSchema.parse(request.body); response.json(await mutateState(repository, request, (client) => client.recordEvaluationReview(request.params.id, body.outcome as EvaluationReviewOutcome, body.reason, body.expected_revision))); }
    catch (error) { next(error); }
  });
  app.post("/api/v2/customers/:id/nba", async (request, response, next) => {
    try { const body = request.body; response.json(await mutateState(repository, request, (client) => client.decideNba(request.params.id, body.decision, body.action, body.reason, body.expected_revision))); }
    catch (error) { next(error); }
  });
  app.post("/api/v2/customers/:id/notes", async (request, response, next) => {
    try { const body = request.body; response.json(await mutateState(repository, request, (client) => client.addCustomerNote(request.params.id, body.text, body.expected_revision))); }
    catch (error) { next(error); }
  });
  app.put("/api/v2/approvals/:id", async (request, response, next) => {
    try { const body = request.body; response.json(await mutateState(repository, request, (client) => client.decideApproval(request.params.id, body.decision, body.reason, body.expected_revision), rememberUndo(request))); }
    catch (error) { next(error); }
  });
  app.post("/api/v2/tasks/:id/outcome", async (request, response, next) => {
    try { const body = request.body; response.json(await mutateState(repository, request, (client) => client.recordTaskOutcome(request.params.id, body.outcome, body.expected_revision), rememberUndo(request))); }
    catch (error) { next(error); }
  });
  app.post("/api/v2/insight-batches", async (request, response, next) => {
    try { const body = request.body as { batch: AnalysisBatch; insights: ConversationInsight[] }; response.json(await mutateState(repository, request, (client) => client.saveInsightBatch(body.batch, body.insights))); }
    catch (error) { next(error); }
  });
  app.post("/api/v2/insights/:id/decision", async (request, response, next) => {
    try { const body = request.body; response.json(await mutateState(repository, request, (client) => client.decideInsight(request.params.id, body.decision, body.reason, body.edits, body.expected_revision))); }
    catch (error) { next(error); }
  });
  app.put("/api/v2/briefs/:id", async (request, response, next) => {
    try { const body = request.body as { brief: ContentBrief; expected_revision: number }; response.json(await mutateState(repository, request, (client) => client.saveBrief(body.brief, body.expected_revision))); }
    catch (error) { next(error); }
  });
  app.post("/api/v2/archive/conversations/:id/access", async (request, response, next) => {
    try { response.json(await mutateState(repository, request, (client) => client.recordRawAccess(request.params.id, request.body.purpose))); }
    catch (error) { next(error); }
  });
  app.post("/api/v2/drafts/:id/publication", async (request, response, next) => {
    try { const body = ExpectedRevisionSchema.parse(request.body); response.json(await mutateState(repository, request, (client) => client.markPublished(request.params.id, body.expected_revision), rememberUndo(request))); }
    catch (error) { next(error); }
  });
  app.post("/api/v2/publications/:id/sync", async (request, response, next) => {
    try { const body = ExpectedRevisionSchema.parse(request.body); response.json(await mutateState(repository, request, (client) => client.syncPublicationResults(request.params.id, body.expected_revision))); }
    catch (error) { next(error); }
  });
  app.post("/api/v2/publications/:id/outcomes", async (request, response, next) => {
    try { const body = request.body; response.json(await mutateState(repository, request, (client) => client.recordContentOutcome(request.params.id, body.type, body.detail, body.customer_id))); }
    catch (error) { next(error); }
  });
  app.put("/api/v2/weekly-retrospective", async (request, response, next) => {
    try { const body = request.body; response.json(await mutateState(repository, request, (client) => client.saveWeeklyRetrospective(body.retrospective, body.meta, body.generated_by, body.expected_revision))); }
    catch (error) { next(error); }
  });
  app.put("/api/v2/weekly-plan", async (request, response, next) => {
    try { const body = request.body; response.json(await mutateState(repository, request, (client) => client.saveWeeklyPlan(body.strategy, body.generated_by))); }
    catch (error) { next(error); }
  });
  app.get("/api/v2/ai-quality/metrics", (request, response, next) => {
    try {
      if (!can(request.ttaSession.role, "view_ai_quality")) throw new AiServiceError(403, "FORBIDDEN", "当前角色不能查看 AI 质量数据", false);
      response.json(calculateQualityMetrics(stateForRole(repository.load(request.ttaSession.tenant_id).state, request.ttaSession.role)));
    } catch (error) { next(error); }
  });
  app.get("/api/v2/ai-quality/runs", (request, response, next) => {
    try {
      if (!can(request.ttaSession.role, "view_ai_quality")) throw new AiServiceError(403, "FORBIDDEN", "当前角色不能查看 AI 运行记录", false);
      const state = stateForRole(repository.load(request.ttaSession.tenant_id).state, request.ttaSession.role);
      response.json({ generation_runs: state.generation_runs, eval_runs: state.eval_runs });
    } catch (error) { next(error); }
  });
  app.get("/api/v2/ai-quality/golden-cases", (request, response, next) => {
    try {
      if (request.ttaSession.role === "sales") throw new AiServiceError(403, "FORBIDDEN", "黄金集仅对运营和负责人开放", false);
      response.json({ cases: repository.load(request.ttaSession.tenant_id).state.golden_cases });
    } catch (error) { next(error); }
  });
  app.post("/api/v2/ai-quality/prompt-versions", async (request, response, next) => {
    try { const body = PromptVersionRequestSchema.parse(request.body); response.json(await mutateState(repository, request, (client) => client.createPromptVersion(body.name, body.description))); }
    catch (error) { next(error); }
  });
  app.post("/api/v2/ai-quality/router-versions", async (request, response, next) => {
    try { const body = RouterVersionRequestSchema.parse(request.body); response.json(await mutateState(repository, request, (client) => client.createRouterVersion(body.name, body.description, body.confidence_threshold))); }
    catch (error) { next(error); }
  });
  app.post("/api/v2/ai-quality/eval-runs", async (request, response, next) => {
    try { const body = EvalRunRequestSchema.parse(request.body); response.json(await mutateState(repository, request, (client) => client.runGoldenEvaluation(body.prompt_version_id, body.router_version_id, body.split))); }
    catch (error) { next(error); }
  });
  app.post("/api/v2/ai-quality/:kind-versions/:id/promote", async (request, response, next) => {
    try {
      const kind = request.params.kind;
      if (kind !== "prompt" && kind !== "router") throw new AiServiceError(404, "NOT_FOUND", "AI 版本类型不存在", false);
      const body = ExpectedRevisionSchema.parse(request.body);
      response.json(await mutateState(repository, request, (client) => client.promoteAiVersion(kind, request.params.id, body.expected_revision)));
    } catch (error) { next(error); }
  });
  app.post("/api/v2/ai-quality/:kind-versions/:id/rollback", async (request, response, next) => {
    try {
      const kind = request.params.kind;
      if (kind !== "prompt" && kind !== "router") throw new AiServiceError(404, "NOT_FOUND", "AI 版本类型不存在", false);
      const body = ExpectedRevisionSchema.parse(request.body);
      response.json(await mutateState(repository, request, (client) => client.rollbackAiVersion(kind, request.params.id, body.expected_revision)));
    } catch (error) { next(error); }
  });
  app.post("/api/v2/undo", async (request, response, next) => {
    try {
      const key = undoKey(request);
      const snapshot = undoSnapshots.get(key);
      undoSnapshots.delete(key);
      if (!snapshot || snapshot.expiresAt < Date.now()) throw new AiServiceError(409, "UNDO_EXPIRED", "撤销窗口已结束，请按当前状态继续处理。", false);
      const loaded = repository.load(request.ttaSession.tenant_id);
      const saved = repository.save(request.ttaSession.tenant_id, snapshot.state, loaded.repositoryRevision);
      response.json(stateForRole(saved.state, request.ttaSession.role));
    } catch (error) { next(error); }
  });
  app.post("/api/v2/reset", async (request, response, next) => {
    try {
      undoSnapshots.delete(undoKey(request));
      const reset = repository.reset(request.ttaSession.tenant_id);
      response.json(stateForRole(reset.state, request.ttaSession.role));
    } catch (error) { next(error); }
  });

  app.get("/api/v2/health", (_request, response) => {
    const configuration = describeConfiguration(aiService);
    response.json({ ok: true, ai_configured: configuration.configured, model: configuration.model, fast_model: configuration.fast_model, fast_model_available: configuration.fast_model_available, config_source: configuration.source, configured_at: configuration.configured_at, data_mode: "http-sqlite", session_warning: sessionManager.securityWarning });
  });

  app.get("/api/v2/ai/config", (_request, response) => {
    response.json(describeConfiguration(aiService));
  });

  app.post("/api/v2/ai/config", async (request, response, next) => {
    try {
      assertLocalConfigurationRequest(request);
      if (!isConfigurable(aiService)) throw new AiServiceError(501, "LOCAL_CONFIG_UNAVAILABLE", "当前 BFF 不支持运行时配置。", false);
      const input = AiConfigurationRequestSchema.parse(request.body);
      response.json(await aiService.configure(input.api_key, input.model));
    } catch (error) { next(error); }
  });

  app.delete("/api/v2/ai/config", (request, response, next) => {
    try {
      assertLocalConfigurationRequest(request);
      if (!isConfigurable(aiService)) throw new AiServiceError(501, "LOCAL_CONFIG_UNAVAILABLE", "当前 BFF 不支持运行时配置。", false);
      response.json(aiService.resetRuntimeConfiguration());
    } catch (error) { next(error); }
  });

  const aiRouter = express.Router();
  aiRouter.use(createRateLimiter());

  async function generateCustomerCandidate(request: Request, customerId: string, expectedRevision: number | undefined, idempotencyKey: string) {
    const operation = "customer-evaluation";
    type CachedGeneration = { candidate: EvaluationCandidate; run: GenerationRun } | { error: { status: number; code: string; message: string; retryable: boolean } };
    const cached = repository.getIdempotent<CachedGeneration>(request.ttaSession.tenant_id, idempotencyKey, operation);
    if (cached && "error" in cached) throw new AiServiceError(cached.error.status, cached.error.code, cached.error.message, cached.error.retryable);
    if (cached) return cached;
    const loaded = repository.load(request.ttaSession.tenant_id);
    const state = stateWithRole(loaded.state, request.ttaSession.role);
    if (!can(request.ttaSession.role, "evaluate_customer")) throw new AiServiceError(403, "FORBIDDEN", "当前角色不能评估客户", false);
    const customer = state.customers.find((item) => item.id === customerId);
    if (!customer || !canAccessCustomer(request.ttaSession.role, customer)) throw new AiServiceError(404, "NOT_FOUND", "客户不存在或不在当前可见范围", false);
    if (expectedRevision !== undefined && expectedRevision !== customer.revision) throw new AiServiceError(409, "VERSION_CONFLICT", "客户已更新，请加载最新状态后重试。", true);
    const fingerprint = evidenceFingerprint(customer);
    const startedAt = Date.now();
    let result: Awaited<ReturnType<AiService["customerEvaluation"]>>;
    try {
      result = await aiService.customerEvaluation({ customer });
    } catch (cause) {
      const failure = asServiceError(cause) as AiServiceError;
      const createdAt = new Date().toISOString();
      const run: GenerationRun = {
        id: `run-${crypto.randomUUID()}`, revision: 1, updated_at: createdAt, task: "customer_evaluation", subject_id: customer.id,
        status: failure.status === 422 ? "blocked" : "failed", model: aiService.model, prompt_version: "customer-eval-v2.1.0-rc1",
        router_version: "router-v2.1-risk-first", route_reason: "generation_failed", attempts: [{ model: aiService.model, status: "failed", latency_ms: Date.now() - startedAt, response_id: null, error_code: failure.code }],
        latency_ms: Date.now() - startedAt, input_tokens: 0, output_tokens: 0, input_fingerprint: fingerprint, response_id: null, error_code: failure.code, created_at: createdAt,
      };
      await mutateState(repository, request, (client) => client.saveGenerationRun(run));
      if (!failure.retryable) repository.saveIdempotent(request.ttaSession.tenant_id, idempotencyKey, operation, { error: { status: failure.status, code: failure.code, message: failure.message, retryable: failure.retryable } });
      throw failure;
    }
    const policy = validateCustomerEvaluation(customer, result.data);
    if (!policy.allowed) {
      const blocked = new AiServiceError(422, policy.code, policy.reasons.join("；"), false);
      const createdAt = new Date().toISOString();
      const run: GenerationRun = {
        id: `run-${crypto.randomUUID()}`, revision: 1, updated_at: createdAt, task: "customer_evaluation", subject_id: customer.id,
        status: "blocked", model: result.meta.model, prompt_version: result.meta.prompt_version, router_version: result.meta.router_version ?? "router-v2.1-risk-first", route_reason: result.meta.route_reason ?? "policy_blocked",
        attempts: [{ model: result.meta.model, status: "failed", latency_ms: result.meta.latency_ms ?? Date.now() - startedAt, response_id: result.meta.response_id, error_code: policy.code }], latency_ms: result.meta.latency_ms ?? Date.now() - startedAt,
        input_tokens: result.meta.input_tokens ?? 0, output_tokens: result.meta.output_tokens ?? 0, input_fingerprint: fingerprint, response_id: result.meta.response_id, error_code: policy.code, created_at: createdAt,
      };
      await mutateState(repository, request, (client) => client.saveGenerationRun(run));
      repository.saveIdempotent(request.ttaSession.tenant_id, idempotencyKey, operation, { error: { status: blocked.status, code: blocked.code, message: blocked.message, retryable: blocked.retryable } });
      throw blocked;
    }
    const createdAt = new Date().toISOString();
    const runId = `run-${crypto.randomUUID()}`;
    const candidateId = `candidate-${crypto.randomUUID()}`;
    const meta = { ...result.meta, input_fingerprint: fingerprint };
    const attempts = meta.attempts ?? 1;
    const run: GenerationRun = {
      id: runId,
      revision: 1,
      updated_at: createdAt,
      task: "customer_evaluation",
      subject_id: customer.id,
      status: "success",
      model: meta.model,
      prompt_version: meta.prompt_version,
      router_version: meta.router_version ?? "router-v2.1-risk-first",
      route_reason: meta.route_reason ?? "primary_default",
      attempts: attempts > 1 && meta.escalated_from
        ? [{ model: meta.escalated_from, status: "escalated", latency_ms: 0, response_id: null, error_code: "ROUTER_ESCALATED" }, { model: meta.model, status: "success", latency_ms: meta.latency_ms ?? 0, response_id: meta.response_id, error_code: null }]
        : [{ model: meta.model, status: "success", latency_ms: meta.latency_ms ?? 0, response_id: meta.response_id, error_code: null }],
      latency_ms: meta.latency_ms ?? 0,
      input_tokens: meta.input_tokens ?? 0,
      output_tokens: meta.output_tokens ?? 0,
      input_fingerprint: fingerprint,
      response_id: meta.response_id,
      error_code: null,
      created_at: createdAt,
    };
    const candidate: EvaluationCandidate = {
      id: candidateId,
      revision: 1,
      updated_at: createdAt,
      customer_id: customer.id,
      customer_revision: customer.revision,
      evidence_fingerprint: fingerprint,
      evaluation: result.data,
      ai_meta: meta,
      run_id: run.id,
      status: "pending",
      created_at: createdAt,
      expires_at: new Date(Date.now() + 48 * 60 * 60_000).toISOString(),
      decided_at: null,
      decision_id: null,
    };
    await mutateState(repository, request, (client) => client.saveEvaluationCandidate(run, candidate));
    const response = { candidate, run };
    repository.saveIdempotent(request.ttaSession.tenant_id, idempotencyKey, operation, response);
    return response;
  }

  aiRouter.post("/weekly-strategy", async (request, response, next) => {
    try {
      if (!can(request.ttaSession.role, "generate_strategy")) throw new AiServiceError(403, "FORBIDDEN", "只有运营可以生成周策略", false);
      const input = StrategyRequestSchema.parse(request.body);
      const result = await aiService.weeklyStrategy(input);
      const ratio = result.data.ratio;
      if (ratio.trust + ratio.interest + ratio.desire + ratio.action !== 100) throw new AiServiceError(422, "POLICY_BLOCKED", "内容配比总和必须为 100。", false);
      response.json(result);
    } catch (error) { next(error); }
  });

  aiRouter.post("/content-draft", async (request, response, next) => {
    try {
      if (!can(request.ttaSession.role, "edit_draft")) throw new AiServiceError(403, "FORBIDDEN", "只有运营可以生成内容草稿", false);
      response.json(await aiService.contentDraft(ContentDraftRequestSchema.parse(request.body)));
    }
    catch (error) { next(error); }
  });

  aiRouter.post("/risk-review", async (request, response, next) => {
    try {
      if (!can(request.ttaSession.role, "edit_draft")) throw new AiServiceError(403, "FORBIDDEN", "只有运营可以运行内容风险检查", false);
      response.json(await aiService.riskReview(RiskRequestSchema.parse(request.body)));
    }
    catch (error) { next(error); }
  });

  aiRouter.post("/customer-evaluation", async (request, response, next) => {
    try {
      const input = CustomerRequestSchema.parse(request.body);
      const customerId = input.customer_id ?? String(input.customer?.id ?? "");
      const revision = input.customer_revision ?? (typeof input.customer?.revision === "number" ? input.customer.revision : undefined);
      response.json(await generateCustomerCandidate(request, customerId, revision, input.idempotency_key ?? response.locals.requestId));
    } catch (error) { next(error); }
  });

  aiRouter.post("/customer-evaluations/batch", async (request, response, next) => {
    try {
      const input = CustomerBatchRequestSchema.parse(request.body);
      const results = [];
      for (const customerId of input.customer_ids) {
        try {
          const generated = await generateCustomerCandidate(request, customerId, undefined, `${input.idempotency_key}:${customerId}`);
          results.push({ customer_id: customerId, ...generated });
        } catch (error) {
          const problem = asServiceError(error) as AiServiceError;
          results.push({ customer_id: customerId, error: { code: problem.code ?? "INTERNAL_ERROR", message: problem.message ?? "生成失败", retryable: problem.retryable ?? false } });
        }
      }
      response.json({ results });
    } catch (error) { next(error); }
  });

  aiRouter.post("/conversation-insights", async (request, response, next) => {
    try {
      if (!can(request.ttaSession.role, "decide_insight")) throw new AiServiceError(403, "FORBIDDEN", "只有运营可以生成会话洞察", false);
      const input = ConversationInsightsRequestSchema.parse(request.body);
      const consents = input.consents as unknown as ArchiveConsent[];
      const eligible = (input.messages as unknown as ArchivedMessage[]).flatMap((message) => {
        const consent = consents.find((item) => item.conversation_id === message.conversation_id);
        const policy = archiveMessageEligibility(message, consent);
        return policy.eligible ? [{ id: message.id, conversation_id: message.conversation_id, customer_id: message.customer_id, kind: message.kind, redacted_text: policy.redacted_text, sent_at: message.sent_at }] : [];
      });
      if (!eligible.length) throw new AiServiceError(422, "PRIVACY_POLICY_BLOCKED", "没有通过同意、有效性与脱敏门禁的消息。", false);
      const result = await aiService.conversationInsights({ messages: eligible, excluded_message_count: input.messages.length - eligible.length });
      const allowedMessageIds = new Set(eligible.map((message) => message.id));
      const allowedConversationIds = new Set(eligible.map((message) => message.conversation_id));
      if (result.data.insights.some((insight) => insight.message_refs.some((id) => !allowedMessageIds.has(id)) || insight.conversation_refs.some((id) => !allowedConversationIds.has(id)))) {
        throw new AiServiceError(422, "UNKNOWN_ARCHIVE_REFERENCE", "模型洞察引用了未授权或不存在的消息。", false);
      }
      response.json(result);
    } catch (error) { next(error); }
  });

  aiRouter.post("/content-brief", async (request, response, next) => {
    try {
      if (!can(request.ttaSession.role, "manage_brief")) throw new AiServiceError(403, "FORBIDDEN", "只有运营可以生成内容 Brief", false);
      const input = ContentBriefRequestSchema.parse(request.body);
      if (input.accepted_insights.some((insight) => insight.status !== "accepted" || insight.invalidated_reason)) throw new AiServiceError(422, "INSIGHT_NOT_ACCEPTED", "内容 Brief 只能使用已接受且有效的洞察。", false);
      const result = await aiService.contentBrief(input);
      const allowed = new Set(input.accepted_insights.map((insight) => String(insight.id)));
      if (result.data.insight_refs.some((id) => !allowed.has(id))) throw new AiServiceError(422, "UNKNOWN_INSIGHT_REFERENCE", "模型 Brief 引用了未知洞察。", false);
      response.json(result);
    } catch (error) { next(error); }
  });

  aiRouter.post("/weekly-retrospective", async (request, response, next) => {
    try {
      if (!can(request.ttaSession.role, "generate_strategy")) throw new AiServiceError(403, "FORBIDDEN", "只有运营可以生成周复盘", false);
      response.json(await aiService.weeklyRetrospective(RetrospectiveRequestSchema.parse(request.body)));
    }
    catch (error) { next(error); }
  });

  app.use("/api/v2/ai", aiRouter);

  if (serveDist) {
    const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
    const dist = path.resolve(currentDirectory, "../dist");
    app.use(express.static(dist, { index: false, maxAge: 0 }));
    app.use((request, response, next) => {
      if (request.method !== "GET" || request.path.startsWith("/api/")) return next();
      response.sendFile(path.join(dist, "index.html"));
    });
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: { code: "INVALID_REQUEST", message: "请求数据未通过结构校验。", retryable: false, request_id: response.locals.requestId } });
      return;
    }
    const problem = error instanceof AiServiceError ? error : new AiServiceError(500, "INTERNAL_ERROR", "服务处理失败。", true);
    response.status(problem.status).json({ error: { code: problem.code, message: problem.message, retryable: problem.retryable, request_id: response.locals.requestId } });
  });

  return app;
}
