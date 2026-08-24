import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { ContentBriefProposalSchema, ContentDraftProposalSchema, CustomerEvaluationSchema, WeeklyStrategySchema, type AiMeta } from "../src/domain/schemas";
import { archiveMessageEligibility, redactArchiveText, validateCustomerEvaluation } from "../src/domain/policy";
import { actorForRole, can, canAccessCustomer } from "../src/domain/permissions";
import { calculateQualityMetrics, evidenceFingerprint } from "../src/domain/quality";
import { StateDataClient } from "../src/data/client";
import type { AiCredentialSource, AnalysisBatch, ApiProblem, ArchiveConsent, ArchivedMessage, ContentBrief, ConversationInsight, Customer, DomainState, Draft, EvaluationCandidate, EvaluationDecisionKind, EvaluationReasonCode, EvaluationReviewOutcome, GenerationRun, MarketingDecisionCandidate, MarketingDecisionKind, MarketingDecisionOutput, MarketingDecisionReasonCode, MarketingReviewOutcome, MarketingTaskType, ModelProfileVersion, Proof, ProviderConnectionProfile, Role } from "../src/domain/types";
import { AiServiceError, type AiConfiguration, type AiService, type ConfigurableAiService } from "./ai-service";
import { PROVIDER_CATALOG } from "./ai-adapters";
import { RepositoryConflictError, SqliteStateRepository, type StateRepository } from "./repository";
import { SessionManager } from "./session";
import { KnowledgeService } from "./knowledge-service";
import { LiveHoldoutRunner } from "./live-eval-runner";
import { MARKETING_PROMPT_HASHES, marketingInputFingerprint, type MarketingPromptContext } from "./prompts";

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

const ProviderConnectionRequestSchema = z.object({
  name: z.string().trim().min(3).max(80),
  provider: z.enum(["openai", "deepseek", "anthropic", "qwen", "custom"]),
  endpoint_scope: z.enum(["public_cloud", "private"]),
  protocol: z.enum(["openai_responses", "openai_chat", "anthropic_messages"]),
  base_url: z.string().trim().url().max(300),
  region: z.string().trim().min(2).max(80),
  auth_mode: z.enum(["bearer", "x-api-key", "none"]),
  credential_ref: z.string().trim().regex(/^[A-Z][A-Z0-9_]{2,63}$/u).nullable().default(null),
});
const ModelProfileRequestSchema = z.object({
  name: z.string().trim().min(3).max(80),
  connection_profile_id: z.string().min(3).max(120),
  primary_model: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9._:/-]+$/u),
  fallback_model: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9._:/-]+$/u).nullable().default(null),
});
const ConnectionTestRequestSchema = z.object({ profile_id: z.string(), api_key: z.string().trim().min(8).max(1024).optional(), expected_revision: z.number().int().min(1) });
const ProfileSmokeRequestSchema = z.object({ expected_revision: z.number().int().min(1) });
const ProfileActivationRequestSchema = z.object({ expected_revision: z.number().int().min(1), data_egress_acknowledged: z.boolean().default(false) });
const ProfileHoldoutRequestSchema = z.object({ usage_confirmed: z.literal(true), idempotency_key: z.string().min(16).max(160) });

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
const EvalRunRequestSchema = z.object({ marketing_brain_version_id: z.string(), router_version_id: z.string(), split: z.enum(["development", "holdout"]) });
const LiveHoldoutRequestSchema = z.object({
  marketing_brain_version_id: z.string(),
  router_version_id: z.string(),
  usage_confirmed: z.literal(true),
  idempotency_key: z.string().min(16).max(160),
});
const LiveHoldoutPauseSchema = z.object({ expected_revision: z.number().int().min(1) });
const RouterVersionRequestSchema = z.object({ name: z.string().trim().min(3).max(80), description: z.string().trim().min(3).max(500), confidence_threshold: z.number().int().min(50).max(95) });
const MarketingGenerateRequestSchema = z.object({
  task_type: z.enum(["weekly_strategy", "content_brief", "content_draft", "customer_nba"]),
  subject_id: z.string().min(1),
  subject_revision: z.number().int().min(0),
  query: z.string().trim().min(3).max(500),
  payload: z.record(z.string(), z.unknown()),
  market: z.string().trim().default("china"),
  idempotency_key: z.string().min(8).max(160),
});
const MarketingDecisionRequestSchema = z.object({
  decision: z.enum(["accepted", "modified", "rejected"]),
  output: z.unknown().nullable(),
  reason_code: z.enum(["wrong_state", "wrong_evidence", "wrong_nba", "missing_context", "risk_compliance", "too_generic", "knowledge_not_applicable", "tenant_fact_wrong", "voice_mismatch", "strategy_too_aggressive", "experiment_weak", "other"]).nullable(),
  reason_note: z.string().max(800),
  expected_revision: z.number().int().min(0),
});
const MarketingReviewSchema = z.object({ outcome: z.enum(["retained", "quality_reversal", "new_evidence"]), reason: z.string().max(800), expected_revision: z.number().int().min(1) });
const KnowledgePreviewSchema = z.object({ task_type: z.enum(["weekly_strategy", "content_brief", "content_draft", "customer_nba"]), query: z.string().trim().min(3).max(500), market: z.string().default("china") });

function isConfigurable(service: AiService): service is ConfigurableAiService {
  return "configure" in service && typeof service.configure === "function" && "getConfiguration" in service && typeof service.getConfiguration === "function";
}

function describeConfiguration(service: AiService): AiConfiguration {
  return isConfigurable(service)
    ? service.getConfiguration()
    : { configured: service.configured, provider: "openai", protocol: "openai_responses", endpoint_scope: "public_cloud", connection_profile_id: "connection-openai", model_profile_version_id: "model-profile-openai", model: service.model, fallback_model: service.fastModel ?? null, fast_model: service.fastModel ?? service.model, fast_model_available: Boolean(service.fastModel), source: service.configured ? "environment" : "none", configured_at: null };
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
      marketing_candidates: withRole.marketing_candidates.filter((item) => item.task_type !== "customer_nba"),
      marketing_decisions: withRole.marketing_decisions.filter((item) => item.task_type !== "customer_nba"),
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
    marketing_candidates: withRole.marketing_candidates.filter((item) => item.task_type === "customer_nba" && customerIds.has(item.subject_id)),
    marketing_decisions: withRole.marketing_decisions.filter((item) => item.task_type === "customer_nba" && item.actor === actor && customerIds.has(item.subject_id)),
    model_profiles: withRole.model_profiles.filter((item) => item.status === "active"),
    provider_connections: withRole.provider_connections.filter((item) => withRole.model_profiles.some((profile) => profile.status === "active" && profile.connection_profile_id === item.id)).map((item) => ({ ...item, base_url: "已隐藏", credential_ref: null, credential_available: false })),
    audits: withRole.audits.filter((item) => item.actor === actor),
  };
}

function stateWithRole(state: DomainState, role: Role) {
  return { ...state, role };
}

const DEMO_RETRIEVAL_QUERIES: Record<MarketingTaskType, string> = {
  weekly_strategy: "企微周策略 客户分组 窄市场 内容实验 证据 授权",
  content_brief: "企微朋友圈 内容 Brief 目标客户 唯一 CTA 证明",
  content_draft: "企微朋友圈 草稿 品牌语气 证据 CTA",
  customer_nba: "企微客户状态 下一动作 跟进 强弱证据",
};

export function bindDemoStateToActiveKnowledge(state: DomainState, tenantId: string, knowledgeService: KnowledgeService) {
  const initialStatus = knowledgeService.status(tenantId);
  const activeKnowledge = initialStatus.active_version;
  const publishedBrain = state.marketing_brain_versions.find((item) => item.status === "published");
  const publishedFacts = state.tenant_fact_versions.find((item) => item.status === "published");
  if (!activeKnowledge || !publishedBrain || !publishedFacts) return state;

  const brain = {
    ...publishedBrain,
    knowledge_pack_version_id: activeKnowledge.id,
    tenant_fact_version_id: publishedFacts.id,
    prompt_hashes: MARKETING_PROMPT_HASHES,
  };
  const candidates = state.marketing_candidates.map((candidate): MarketingDecisionCandidate => {
    if (candidate.status !== "pending") return candidate;
    try {
      const retrieval = knowledgeService.retrieve({ tenantId, taskType: candidate.task_type, query: DEMO_RETRIEVAL_QUERIES[candidate.task_type], market: "china", channels: ["enterprise_wechat"] });
      return {
        ...candidate,
        envelope: {
          ...candidate.envelope,
          knowledge_refs: retrieval.references,
          skill_route: retrieval.skill_route,
          knowledge_conflicts: retrieval.conflicts,
          knowledge_pack_version: activeKnowledge.id,
          tenant_fact_version: publishedFacts.id,
          marketing_brain_version: brain.id,
          prompt_hash: MARKETING_PROMPT_HASHES[candidate.task_type],
          ai_meta: { ...candidate.envelope.ai_meta, prompt_version: `code-${MARKETING_PROMPT_HASHES[candidate.task_type]}` },
        },
      };
    } catch {
      return { ...candidate, status: "stale", revision: candidate.revision + 1, updated_at: new Date().toISOString() };
    }
  });
  const finalStatus = knowledgeService.status(tenantId);
  return {
    ...state,
    knowledge_pack_versions: finalStatus.versions,
    knowledge_sources: finalStatus.sources,
    knowledge_retrieval_runs: finalStatus.recent_retrievals,
    marketing_brain_versions: state.marketing_brain_versions.map((item) => item.id === brain.id ? brain : item),
    marketing_candidates: candidates,
  };
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
  knowledgeService = new KnowledgeService(),
  sessionManager = new SessionManager(process.env.SESSION_SECRET),
}: {
  aiService: AiService;
  serveDist?: boolean;
  repository?: StateRepository;
  knowledgeService?: KnowledgeService;
  sessionManager?: SessionManager;
}) {
  const app = express();
  const liveHoldoutRunner = new LiveHoldoutRunner(repository, aiService, knowledgeService);
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

  app.get("/api/v2/knowledge/status", (request, response, next) => {
    try {
      if (!can(request.ttaSession.role, "preview_knowledge")) throw new AiServiceError(403, "FORBIDDEN", "当前角色不能查看知识治理。", false);
      response.json(knowledgeService.status(request.ttaSession.tenant_id));
    } catch (error) { next(error); }
  });
  app.post("/api/v2/knowledge/reindex", async (request, response, next) => {
    try {
      if (!can(request.ttaSession.role, "manage_knowledge")) throw new AiServiceError(403, "FORBIDDEN", "只有负责人可以重新索引知识包。", false);
      knowledgeService.reindex(request.ttaSession.tenant_id);
      const status = knowledgeService.status(request.ttaSession.tenant_id);
      await mutateState(repository, request, (client) => client.syncKnowledgeCatalog(status.versions, status.sources, status.recent_retrievals, MARKETING_PROMPT_HASHES));
      response.json(status);
    } catch (error) { next(error); }
  });
  app.post("/api/v2/knowledge/versions/:id/activate", async (request, response, next) => {
    try {
      if (!can(request.ttaSession.role, "manage_knowledge")) throw new AiServiceError(403, "FORBIDDEN", "只有负责人可以激活知识版本。", false);
      const status = knowledgeService.activate(request.ttaSession.tenant_id, request.params.id);
      await mutateState(repository, request, (client) => client.syncKnowledgeCatalog(status.versions, status.sources, status.recent_retrievals, MARKETING_PROMPT_HASHES));
      response.json(status);
    } catch (error) { next(error); }
  });
  app.post("/api/v2/knowledge/rollback", async (request, response, next) => {
    try {
      if (!can(request.ttaSession.role, "manage_knowledge")) throw new AiServiceError(403, "FORBIDDEN", "只有负责人可以回滚知识版本。", false);
      const status = knowledgeService.rollback(request.ttaSession.tenant_id);
      await mutateState(repository, request, (client) => client.syncKnowledgeCatalog(status.versions, status.sources, status.recent_retrievals, MARKETING_PROMPT_HASHES));
      response.json(status);
    } catch (error) { next(error); }
  });
  app.post("/api/v2/knowledge/retrieval-preview", async (request, response, next) => {
    try {
      if (!can(request.ttaSession.role, "preview_knowledge")) throw new AiServiceError(403, "FORBIDDEN", "当前角色不能预览知识检索。", false);
      const input = KnowledgePreviewSchema.parse(request.body);
      const result = knowledgeService.retrieve({ tenantId: request.ttaSession.tenant_id, taskType: input.task_type, query: input.query, market: input.market, channels: ["enterprise_wechat"] });
      const status = knowledgeService.status(request.ttaSession.tenant_id);
      await mutateState(repository, request, (client) => client.syncKnowledgeCatalog(status.versions, status.sources, status.recent_retrievals, MARKETING_PROMPT_HASHES));
      response.json(result);
    } catch (error) { next(error); }
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
  app.post("/api/v2/marketing/candidates/:id/decision", async (request, response, next) => {
    try {
      const body = MarketingDecisionRequestSchema.parse(request.body);
      const state = repository.load(request.ttaSession.tenant_id).state;
      const candidate = state.marketing_candidates.find((item) => item.id === request.params.id);
      if (!candidate) throw new AiServiceError(404, "MARKETING_CANDIDATE_NOT_FOUND", "营销决策候选不存在。", false);
      let output: MarketingDecisionOutput | null = null;
      if (body.decision === "modified") {
        output = candidate.task_type === "weekly_strategy" ? WeeklyStrategySchema.parse(body.output)
          : candidate.task_type === "content_brief" ? ContentBriefProposalSchema.parse(body.output)
            : candidate.task_type === "content_draft" ? ContentDraftProposalSchema.parse(body.output)
              : CustomerEvaluationSchema.parse(body.output);
      }
      const knowledge = knowledgeService.status(request.ttaSession.tenant_id).active_version;
      if (!knowledge || knowledge.id !== candidate.envelope.knowledge_pack_version) throw new AiServiceError(409, "STALE_MARKETING_CANDIDATE", "知识版本已变化，请重新生成候选。", true);
      response.json(await mutateState(repository, request, (client) => client.decideMarketingCandidate(candidate.id, body.decision as MarketingDecisionKind, output, body.reason_code as MarketingDecisionReasonCode | null, body.reason_note, body.expected_revision)));
    } catch (error) { next(error); }
  });
  app.post("/api/v2/marketing/decisions/:id/review", async (request, response, next) => {
    try {
      const body = MarketingReviewSchema.parse(request.body);
      response.json(await mutateState(repository, request, (client) => client.recordMarketingReview(request.params.id, body.outcome as MarketingReviewOutcome, body.reason, body.expected_revision)));
    } catch (error) { next(error); }
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
    try { throw new AiServiceError(410, "LEGACY_PROMPT_VERSION_DISABLED", "2.2 Prompt 由代码 builder 和内容哈希版本化，不能创建仅名称与描述的空壳版本。", false); }
    catch (error) { next(error); }
  });
  app.post("/api/v2/ai-quality/router-versions", async (request, response, next) => {
    try { const body = RouterVersionRequestSchema.parse(request.body); response.json(await mutateState(repository, request, (client) => client.createRouterVersion(body.name, body.description, body.confidence_threshold))); }
    catch (error) { next(error); }
  });
  app.post("/api/v2/ai-quality/eval-runs", async (request, response, next) => {
    try { const body = EvalRunRequestSchema.parse(request.body); response.json(await mutateState(repository, request, (client) => client.runGoldenEvaluation(body.marketing_brain_version_id, body.router_version_id, body.split))); }
    catch (error) { next(error); }
  });
  app.post("/api/v2/ai-quality/live-holdout-runs", (request, response, next) => {
    try {
      if (!can(request.ttaSession.role, "publish_ai_version")) throw new AiServiceError(403, "FORBIDDEN", "只有负责人可以确认用量并启动真实 Holdout。", false);
      const body = LiveHoldoutRequestSchema.parse(request.body);
      const state = liveHoldoutRunner.start({ tenantId: request.ttaSession.tenant_id, actor: actorForRole(request.ttaSession.role), marketingBrainVersionId: body.marketing_brain_version_id, routerVersionId: body.router_version_id, idempotencyKey: body.idempotency_key });
      response.status(202).json(stateForRole(state, request.ttaSession.role));
    } catch (error) { next(error); }
  });
  app.post("/api/v2/ai-quality/live-holdout-runs/:id/pause", (request, response, next) => {
    try {
      if (!can(request.ttaSession.role, "publish_ai_version")) throw new AiServiceError(403, "FORBIDDEN", "只有负责人可以暂停真实 Holdout。", false);
      const body = LiveHoldoutPauseSchema.parse(request.body);
      const state = liveHoldoutRunner.pause(request.ttaSession.tenant_id, request.params.id, actorForRole(request.ttaSession.role), body.expected_revision);
      response.json(stateForRole(state, request.ttaSession.role));
    } catch (error) { next(error); }
  });
  app.post("/api/v2/ai-quality/:kind-versions/:id/promote", async (request, response, next) => {
    try {
      const kind = request.params.kind;
      if (kind !== "brain" && kind !== "router") throw new AiServiceError(404, "NOT_FOUND", "AI 版本类型不存在", false);
      const body = ExpectedRevisionSchema.parse(request.body);
      response.json(await mutateState(repository, request, (client) => client.promoteAiVersion(kind, request.params.id, body.expected_revision)));
    } catch (error) { next(error); }
  });
  app.post("/api/v2/ai-quality/:kind-versions/:id/rollback", async (request, response, next) => {
    try {
      const kind = request.params.kind;
      if (kind !== "brain" && kind !== "router") throw new AiServiceError(404, "NOT_FOUND", "AI 版本类型不存在", false);
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
      const hydrated = bindDemoStateToActiveKnowledge(reset.state, request.ttaSession.tenant_id, knowledgeService);
      const saved = hydrated === reset.state ? reset : repository.save(request.ttaSession.tenant_id, hydrated, reset.repositoryRevision);
      response.json(stateForRole(saved.state, request.ttaSession.role));
    } catch (error) { next(error); }
  });

  app.get("/api/v2/health", (_request, response) => {
    const configuration = describeConfiguration(aiService);
    response.json({ ok: true, ai_configured: configuration.configured, knowledge_configured: knowledgeService.configured, provider: configuration.provider, protocol: configuration.protocol, endpoint_scope: configuration.endpoint_scope, connection_profile_id: configuration.connection_profile_id, model_profile_version_id: configuration.model_profile_version_id, model: configuration.model, fallback_model: configuration.fallback_model, fast_model: configuration.fast_model, fast_model_available: configuration.fast_model_available, config_source: configuration.source, configured_at: configuration.configured_at, data_mode: "http-sqlite", session_warning: sessionManager.securityWarning });
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

  app.get("/api/v2/ai/providers", (_request, response) => response.json({ providers: PROVIDER_CATALOG }));

  app.get("/api/v2/ai/connections", (request, response, next) => {
    try {
      if (request.ttaSession.role === "sales") throw new AiServiceError(403, "FORBIDDEN", "销售角色不能查看模型连接配置。", false);
      const state = repository.load(request.ttaSession.tenant_id).state;
      response.json({ connections: state.provider_connections, profiles: state.model_profiles, active: describeConfiguration(aiService) });
    } catch (error) { next(error); }
  });

  app.get("/api/v2/ai/model-profiles", (request, response) => {
    const state = stateForRole(repository.load(request.ttaSession.tenant_id).state, request.ttaSession.role);
    response.json({ profiles: state.model_profiles, active: describeConfiguration(aiService) });
  });

  app.post("/api/v2/ai/connections", async (request, response, next) => {
    try {
      assertLocalConfigurationRequest(request);
      const input = ProviderConnectionRequestSchema.parse(request.body);
      const createdAt = new Date().toISOString();
      const connection: ProviderConnectionProfile = {
        id: `connection-${crypto.randomUUID()}`, revision: 1, updated_at: createdAt, tenant_id: request.ttaSession.tenant_id,
        ...input, credential_source: "none", credential_available: input.auth_mode === "none",
        capabilities: { structured_output: false, native_json_schema: false, refusal_signal: false, usage_reporting: false, request_id: false, tested_at: null, notes: ["等待连接测试"] },
        last_tested_at: null, last_error_code: null, created_by: actorForRole(request.ttaSession.role),
      };
      response.status(201).json(await mutateState(repository, request, (client) => client.createProviderConnection(connection)));
    } catch (error) { next(error); }
  });

  app.post("/api/v2/ai/model-profiles", async (request, response, next) => {
    try {
      assertLocalConfigurationRequest(request);
      const input = ModelProfileRequestSchema.parse(request.body);
      const state = repository.load(request.ttaSession.tenant_id).state;
      const connection = state.provider_connections.find((item) => item.id === input.connection_profile_id);
      if (!connection) throw new AiServiceError(404, "CONNECTION_NOT_FOUND", "模型连接不存在。", false);
      const createdAt = new Date().toISOString();
      const profile: ModelProfileVersion = {
        id: `model-profile-${crypto.randomUUID()}`, revision: 1, updated_at: createdAt, tenant_id: request.ttaSession.tenant_id, name: input.name,
        connection_profile_id: connection.id, provider: connection.provider, protocol: connection.protocol, endpoint_scope: connection.endpoint_scope,
        primary_model: input.primary_model, fallback_model: input.fallback_model, status: "draft", smoke_passed_at: null, smoke_case_count: 0, holdout_run_id: null,
        data_egress_acknowledged_by: null, data_egress_acknowledged_at: null, activated_by: null, activated_at: null, previous_profile_id: null, created_by: actorForRole(request.ttaSession.role),
      };
      response.status(201).json(await mutateState(repository, request, (client) => client.createModelProfile(profile)));
    } catch (error) { next(error); }
  });

  app.post("/api/v2/ai/connections/:id/test", async (request, response, next) => {
    try {
      assertLocalConfigurationRequest(request);
      if (!isConfigurable(aiService)) throw new AiServiceError(501, "LOCAL_CONFIG_UNAVAILABLE", "当前 BFF 不支持多模型连接配置。", false);
      const input = ConnectionTestRequestSchema.parse(request.body);
      const state = repository.load(request.ttaSession.tenant_id).state;
      const connection = state.provider_connections.find((item) => item.id === request.params.id);
      const profile = state.model_profiles.find((item) => item.id === input.profile_id && item.connection_profile_id === request.params.id);
      if (!connection || !profile) throw new AiServiceError(404, "PROFILE_NOT_FOUND", "模型连接或 Profile 不存在。", false);
      if (connection.revision !== input.expected_revision) throw new AiServiceError(409, "VERSION_CONFLICT", "模型连接已更新，请刷新后重试。", true);
      const capability = await aiService.testConnection(connection, profile, input.api_key);
      const source: AiCredentialSource = connection.auth_mode === "none" ? "none" : input.api_key ? "runtime" : connection.credential_ref ? "environment" : "none";
      response.json(await mutateState(repository, request, (client) => client.recordConnectionTest(connection.id, capability, source, input.expected_revision)));
    } catch (error) { next(error); }
  });

  app.delete("/api/v2/ai/connections/:id/runtime-secret", async (request, response, next) => {
    try {
      assertLocalConfigurationRequest(request);
      if (!isConfigurable(aiService)) throw new AiServiceError(501, "LOCAL_CONFIG_UNAVAILABLE", "当前 BFF 不支持多模型连接配置。", false);
      aiService.clearRuntimeSecret(request.params.id);
      response.json(await mutateState(repository, request, (client) => client.clearConnectionCredential(request.params.id)));
    } catch (error) { next(error); }
  });

  app.post("/api/v2/ai/model-profiles/:id/smoke", createRateLimiter(4), async (request, response, next) => {
    try {
      assertLocalConfigurationRequest(request);
      if (!isConfigurable(aiService)) throw new AiServiceError(501, "LOCAL_CONFIG_UNAVAILABLE", "当前 BFF 不支持多模型评测。", false);
      const input = ProfileSmokeRequestSchema.parse(request.body);
      const state = repository.load(request.ttaSession.tenant_id).state;
      const profile = state.model_profiles.find((item) => item.id === request.params.id);
      const connection = state.provider_connections.find((item) => item.id === profile?.connection_profile_id);
      if (!profile || !connection) throw new AiServiceError(404, "PROFILE_NOT_FOUND", "模型 Profile 不存在。", false);
      if (profile.revision !== input.expected_revision) throw new AiServiceError(409, "VERSION_CONFLICT", "模型 Profile 已更新，请刷新后重试。", true);
      const smoke = await aiService.runSmoke(connection, profile);
      if (smoke.passed !== smoke.total || smoke.total !== 14) throw new AiServiceError(422, "SMOKE_FAILED", `模型 Smoke 仅通过 ${smoke.passed}/${smoke.total}。`, false);
      response.json(await mutateState(repository, request, (client) => client.markModelProfileSmoke(profile.id, input.expected_revision)));
    } catch (error) { next(error); }
  });

  app.post("/api/v2/ai/model-profiles/:id/activate", async (request, response, next) => {
    try {
      assertLocalConfigurationRequest(request);
      if (request.ttaSession.role !== "lead") throw new AiServiceError(403, "FORBIDDEN", "只有负责人可以激活全局模型 Profile。", false);
      if (!isConfigurable(aiService)) throw new AiServiceError(501, "LOCAL_CONFIG_UNAVAILABLE", "当前 BFF 不支持多模型激活。", false);
      const input = ProfileActivationRequestSchema.parse(request.body);
      const state = repository.load(request.ttaSession.tenant_id).state;
      const profile = state.model_profiles.find((item) => item.id === request.params.id);
      const connection = state.provider_connections.find((item) => item.id === profile?.connection_profile_id);
      if (!profile || !connection) throw new AiServiceError(404, "PROFILE_NOT_FOUND", "模型 Profile 不存在。", false);
      if (profile.revision !== input.expected_revision) throw new AiServiceError(409, "VERSION_CONFLICT", "模型 Profile 已更新，请刷新后重试。", true);
      if (!["trial_ready", "enterprise_ready", "active"].includes(profile.status)) throw new AiServiceError(422, "SMOKE_REQUIRED", "模型 Profile 必须先通过 14 条 Smoke。", false);
      if (profile.endpoint_scope === "public_cloud" && !input.data_egress_acknowledged) throw new AiServiceError(422, "DATA_EGRESS_ACK_REQUIRED", "激活公有云模型前必须确认数据去向。", false);
      aiService.activateProfile(connection, profile);
      response.json(await mutateState(repository, request, (client) => client.activateModelProfile(profile.id, input.expected_revision, input.data_egress_acknowledged)));
    } catch (error) { next(error); }
  });

  app.post("/api/v2/ai/model-profiles/:id/rollback", async (request, response, next) => {
    try {
      assertLocalConfigurationRequest(request);
      if (request.ttaSession.role !== "lead") throw new AiServiceError(403, "FORBIDDEN", "只有负责人可以回滚全局模型 Profile。", false);
      if (!isConfigurable(aiService)) throw new AiServiceError(501, "LOCAL_CONFIG_UNAVAILABLE", "当前 BFF 不支持多模型回滚。", false);
      const activeState = repository.load(request.ttaSession.tenant_id).state;
      const activeProfile = activeState.model_profiles.find((item) => item.status === "active" && item.id === request.params.id);
      const previous = activeState.model_profiles.find((item) => item.id === activeProfile?.previous_profile_id);
      const connection = activeState.provider_connections.find((item) => item.id === previous?.connection_profile_id);
      if (!activeProfile || !previous || !connection) throw new AiServiceError(409, "ROLLBACK_UNAVAILABLE", "当前 Profile 没有可回滚的上一版本。", false);
      aiService.activateProfile(connection, previous);
      response.json(await mutateState(repository, request, (client) => client.activateModelProfile(previous.id, previous.revision, true)));
    } catch (error) { next(error); }
  });

  app.post("/api/v2/ai/model-profiles/:id/holdout", (request, response, next) => {
    try {
      if (request.ttaSession.role !== "lead") throw new AiServiceError(403, "FORBIDDEN", "只有负责人可以确认用量并启动完整 Holdout。", false);
      const input = ProfileHoldoutRequestSchema.parse(request.body);
      const state = repository.load(request.ttaSession.tenant_id).state;
      const profile = state.model_profiles.find((item) => item.id === request.params.id && item.status === "active");
      const brain = state.marketing_brain_versions.find((item) => item.status === "published");
      if (!profile || !brain) throw new AiServiceError(409, "MODEL_PROFILE_BINDING_MISMATCH", "只有当前激活且已绑定营销脑的 Profile 可以运行 Holdout。", false);
      const next = liveHoldoutRunner.start({ tenantId: request.ttaSession.tenant_id, actor: actorForRole(request.ttaSession.role), marketingBrainVersionId: brain.id, routerVersionId: brain.model_router_version_id, modelProfileVersionId: profile.id, idempotencyKey: input.idempotency_key });
      response.status(202).json(stateForRole(next, request.ttaSession.role));
    } catch (error) { next(error); }
  });

  app.post("/api/v2/marketing/candidates/generate", createRateLimiter(), async (request, response, next) => {
    try {
      const input = MarketingGenerateRequestSchema.parse(request.body);
      const operation = `marketing-${input.task_type}`;
      const cached = repository.getIdempotent<{ candidate: MarketingDecisionCandidate }>(request.ttaSession.tenant_id, input.idempotency_key, operation);
      if (cached) { response.json(cached); return; }
      const required = input.task_type === "customer_nba" ? "evaluate_customer" : input.task_type === "weekly_strategy" ? "generate_strategy" : input.task_type === "content_brief" ? "manage_brief" : "edit_draft";
      if (!can(request.ttaSession.role, required)) throw new AiServiceError(403, "FORBIDDEN", "当前角色不能生成该营销决策候选。", false);

      let state = stateWithRole(repository.load(request.ttaSession.tenant_id).state, request.ttaSession.role);
      const customer = input.task_type === "customer_nba" ? state.customers.find((item) => item.id === input.subject_id) : null;
      const brief = input.task_type === "content_brief" ? state.content_briefs.find((item) => item.id === input.subject_id) : null;
      const draft = input.task_type === "content_draft" ? state.drafts.find((item) => item.id === input.subject_id) : null;
      const subject = customer ?? brief ?? draft;
      if (input.task_type !== "weekly_strategy" && !subject) throw new AiServiceError(404, "SUBJECT_NOT_FOUND", "营销决策关联的业务对象不存在。", false);
      if (customer && !canAccessCustomer(request.ttaSession.role, customer)) throw new AiServiceError(404, "NOT_FOUND", "客户不存在或不在当前可见范围。", false);
      if ((subject?.revision ?? 1) !== input.subject_revision) throw new AiServiceError(409, "VERSION_CONFLICT", "业务对象已更新，请刷新后重试。", true);

      const retrieval = knowledgeService.retrieve({ tenantId: request.ttaSession.tenant_id, taskType: input.task_type, query: input.query, market: input.market, channels: ["enterprise_wechat"], stages: draft ? [draft.stage] : brief ? [brief.stage] : undefined });
      let knowledgeStatus = knowledgeService.status(request.ttaSession.tenant_id);
      await mutateState(repository, request, (client) => client.syncKnowledgeCatalog(knowledgeStatus.versions, knowledgeStatus.sources, knowledgeStatus.recent_retrievals, MARKETING_PROMPT_HASHES));
      state = stateWithRole(repository.load(request.ttaSession.tenant_id).state, request.ttaSession.role);
      const activeBrain = state.marketing_brain_versions.find((item) => item.status === "published");
      const factVersion = state.tenant_fact_versions.find((item) => item.status === "published");
      const activeKnowledge = knowledgeStatus.active_version;
      if (!activeBrain || !factVersion || !activeKnowledge) throw new AiServiceError(422, "MARKETING_BRAIN_NOT_PUBLISHED", "知识、企业事实或营销脑版本尚未发布。", false);
      const promptBindingChanged = (Object.keys(MARKETING_PROMPT_HASHES) as MarketingTaskType[]).some((task) => activeBrain.prompt_hashes[task] !== MARKETING_PROMPT_HASHES[task]);
      if (activeBrain.knowledge_pack_version_id !== activeKnowledge.id || activeBrain.tenant_fact_version_id !== factVersion.id || promptBindingChanged) {
        throw new AiServiceError(409, "MARKETING_BRAIN_BINDING_PENDING", "知识包、企业事实或代码化 Prompt 已变化，负责人需先评测并发布新的营销脑版本。", false);
      }
      const today = Date.now();
      const facts = factVersion.facts.filter((item) => item.status === "published" && new Date(item.valid_from).getTime() <= today && (!item.expires_at || new Date(item.expires_at).getTime() >= today));
      if (!facts.length) throw new AiServiceError(422, "TENANT_FACTS_NOT_PUBLISHED", "没有已发布且有效的企业事实，生成已阻断。", false);

      const businessEvidenceRefs = input.task_type === "customer_nba" ? customer!.evidence.filter((item) => item.valid).map((item) => item.id)
        : input.task_type === "content_brief" ? brief!.insight_ids.filter((id) => state.conversation_insights.some((item) => item.id === id && item.status === "accepted" && !item.invalidated_reason))
          : input.task_type === "content_draft" ? [...new Set([...draft!.evidence_refs, ...(state.content_briefs.find((item) => item.id === draft!.brief_id)?.insight_ids ?? [])])]
            : [...state.conversation_insights.filter((item) => item.status === "accepted" && !item.invalidated_reason).map((item) => item.id), ...state.proofs.filter((item) => item.status === "usable").map((item) => item.id)];
      if (!businessEvidenceRefs.length) throw new AiServiceError(422, "BUSINESS_EVIDENCE_REQUIRED", "没有可用的业务证据，营销决策生成已阻断。", false);
      const brainContext: MarketingPromptContext = { skill_route: retrieval.skill_route, knowledge_refs: retrieval.references, tenant_facts: facts, business_evidence_refs: businessEvidenceRefs, knowledge_conflicts: retrieval.conflicts, growth_posture: "aggressive" };

      let generated: { data: MarketingDecisionOutput; meta: AiMeta };
      if (input.task_type === "weekly_strategy") {
        generated = await aiService.weeklyStrategy({ ...input.payload, accepted_insights: state.conversation_insights.filter((item) => item.status === "accepted"), historical_outcomes: state.content_outcomes, brain_context: brainContext });
        const ratio = generated.data as ReturnType<typeof WeeklyStrategySchema.parse>;
        if (ratio.ratio.trust + ratio.ratio.interest + ratio.ratio.desire + ratio.ratio.action !== 100) throw new AiServiceError(422, "POLICY_BLOCKED", "内容配比总和必须为 100。", false);
        if (ratio.evidence_refs.some((id) => !businessEvidenceRefs.includes(id))) throw new AiServiceError(422, "UNKNOWN_BUSINESS_REFERENCE", "周策略引用了未知业务证据。", false);
      } else if (input.task_type === "content_brief") {
        const accepted = state.conversation_insights.filter((item) => brief!.insight_ids.includes(item.id) && item.status === "accepted" && !item.invalidated_reason);
        if (!accepted.length) throw new AiServiceError(422, "INSIGHT_NOT_ACCEPTED", "内容 Brief 只能使用已接受且有效的洞察。", false);
        generated = await aiService.contentBrief({ accepted_insights: accepted, historical_outcomes: state.content_outcomes, brain_context: brainContext });
        if ((generated.data as ReturnType<typeof ContentBriefProposalSchema.parse>).insight_refs.some((id) => !businessEvidenceRefs.includes(id))) throw new AiServiceError(422, "UNKNOWN_INSIGHT_REFERENCE", "Brief 引用了未知洞察。", false);
      } else if (input.task_type === "content_draft") {
        const selectedProofs = state.proofs.filter((item) => draft!.evidence_refs.includes(item.id));
        generated = await aiService.contentDraft({ strategy: state.weekly_plan.strategy, proofs: selectedProofs, stage: draft!.stage, brief: state.content_briefs.find((item) => item.id === draft!.brief_id), accepted_insights: state.conversation_insights.filter((item) => item.status === "accepted"), historical_outcomes: state.content_outcomes, low_risk_rewrite: !draft!.approval_required, brain_context: brainContext });
        if ((generated.data as ReturnType<typeof ContentDraftProposalSchema.parse>).evidence_refs.some((id) => !businessEvidenceRefs.includes(id))) throw new AiServiceError(422, "UNKNOWN_BUSINESS_REFERENCE", "草稿引用了未知业务证据。", false);
      } else {
        generated = await aiService.customerEvaluation({ customer, brain_context: brainContext });
        const policy = validateCustomerEvaluation(customer!, generated.data as ReturnType<typeof CustomerEvaluationSchema.parse>);
        if (!policy.allowed) throw new AiServiceError(422, policy.code, policy.reasons.join("；"), false);
      }

      knowledgeStatus = knowledgeService.status(request.ttaSession.tenant_id);
      const createdAt = new Date().toISOString();
      const fingerprint = marketingInputFingerprint({ task_type: input.task_type, subject_id: input.subject_id, subject_revision: input.subject_revision, payload: input.payload }, brainContext);
      const candidate: MarketingDecisionCandidate = {
        id: `marketing-candidate-${crypto.randomUUID()}`, revision: 1, updated_at: createdAt, task_type: input.task_type as MarketingTaskType, subject_id: input.subject_id,
        subject_revision: input.subject_revision, evidence_fingerprint: fingerprint,
        envelope: { task_type: input.task_type as MarketingTaskType, output: generated.data, business_evidence_refs: businessEvidenceRefs, knowledge_refs: retrieval.references, skill_route: retrieval.skill_route,
          assumptions: ["当前结果基于合成业务数据", "服务容量与人工执行边界保持不变"], knowledge_conflicts: retrieval.conflicts,
          measurement_plan: ["48 小时内完成候选审阅", "采用后 7 天记录保持有效、质量撤销或新增证据"], growth_posture: "aggressive", ai_meta: { ...generated.meta, input_fingerprint: fingerprint },
          knowledge_pack_version: activeKnowledge.id, tenant_fact_version: factVersion.id, marketing_brain_version: activeBrain.id, prompt_hash: MARKETING_PROMPT_HASHES[input.task_type], input_fingerprint: fingerprint },
        status: "pending", created_at: createdAt, expires_at: new Date(Date.now() + 48 * 60 * 60_000).toISOString(), decided_at: null, decision_id: null,
      };
      await mutateState(repository, request, (client) => client.saveMarketingCandidate(candidate));
      const result = { candidate };
      repository.saveIdempotent(request.ttaSession.tenant_id, input.idempotency_key, operation, result);
      response.json(result);
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
      const configuration = describeConfiguration(aiService);
      const createdAt = new Date().toISOString();
      const run: GenerationRun = {
        id: `run-${crypto.randomUUID()}`, revision: 1, updated_at: createdAt, task: "customer_evaluation", subject_id: customer.id,
        status: failure.status === 422 ? "blocked" : "failed", provider: configuration.provider, protocol: configuration.protocol, connection_profile_id: configuration.connection_profile_id, model_profile_version_id: configuration.model_profile_version_id, endpoint_scope: configuration.endpoint_scope, model: aiService.model, prompt_version: "customer-eval-v2.3.0",
        router_version: "global-profile-v2.3", route_reason: "generation_failed", attempts: [{ provider: configuration.provider, protocol: configuration.protocol, endpoint_scope: configuration.endpoint_scope, model: aiService.model, status: "failed", latency_ms: Date.now() - startedAt, response_id: null, error_code: failure.code }],
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
        status: "blocked", provider: result.meta.provider, protocol: result.meta.protocol, connection_profile_id: result.meta.connection_profile_id, model_profile_version_id: result.meta.model_profile_version_id, endpoint_scope: result.meta.endpoint_scope, model: result.meta.model, prompt_version: result.meta.prompt_version, router_version: result.meta.router_version ?? "global-profile-v2.3", route_reason: result.meta.route_reason ?? "policy_blocked",
        attempts: [{ provider: result.meta.provider, protocol: result.meta.protocol, endpoint_scope: result.meta.endpoint_scope, model: result.meta.model, status: "failed", latency_ms: result.meta.latency_ms ?? Date.now() - startedAt, response_id: result.meta.response_id, error_code: policy.code }], latency_ms: result.meta.latency_ms ?? Date.now() - startedAt,
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
      provider: meta.provider,
      protocol: meta.protocol,
      connection_profile_id: meta.connection_profile_id,
      model_profile_version_id: meta.model_profile_version_id,
      endpoint_scope: meta.endpoint_scope,
      model: meta.model,
      prompt_version: meta.prompt_version,
      router_version: meta.router_version ?? "global-profile-v2.3",
      route_reason: meta.route_reason ?? "primary_default",
      attempts: attempts > 1 && meta.escalated_from
        ? [{ provider: meta.provider, protocol: meta.protocol, endpoint_scope: meta.endpoint_scope, model: meta.escalated_from, status: "escalated", latency_ms: 0, response_id: null, error_code: "MODEL_FALLBACK" }, { provider: meta.provider, protocol: meta.protocol, endpoint_scope: meta.endpoint_scope, model: meta.model, status: "success", latency_ms: meta.latency_ms ?? 0, response_id: meta.response_id, error_code: null }]
        : [{ provider: meta.provider, protocol: meta.protocol, endpoint_scope: meta.endpoint_scope, model: meta.model, status: "success", latency_ms: meta.latency_ms ?? 0, response_id: meta.response_id, error_code: null }],
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
