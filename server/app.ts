import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { EvidenceSchema, StateCodeSchema, WeeklyStrategySchema } from "../src/domain/schemas";
import { validateCustomerEvaluation } from "../src/domain/policy";
import { archiveMessageEligibility } from "../src/domain/policy";
import type { ArchiveConsent, ArchivedMessage, Customer } from "../src/domain/types";
import { AiServiceError, type AiConfiguration, type AiService, type ConfigurableAiService } from "./ai-service";

const CustomerRequestSchema = z.object({
  customer: z.object({
    id: z.string(),
    revision: z.number().int(),
    updated_at: z.string(),
    name: z.string(),
    company: z.string(),
    title: z.string(),
    owner: z.string(),
    shared: z.boolean(),
    industry: z.string(),
    size: z.string(),
    source: z.string(),
    tags: z.array(z.string()),
    state: StateCodeSchema,
    confidence: z.number(),
    evidence_strength: z.enum(["weak", "medium", "strong"]),
    last_interaction: z.string(),
    last_interaction_at: z.string(),
    review_at: z.string(),
    anomaly: z.string().nullable(),
    kf_summary: z.string(),
    evidence: z.array(EvidenceSchema),
  }).passthrough(),
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

function isConfigurable(service: AiService): service is ConfigurableAiService {
  return "configure" in service && typeof service.configure === "function" && "getConfiguration" in service && typeof service.getConfiguration === "function";
}

function describeConfiguration(service: AiService): AiConfiguration {
  return isConfigurable(service)
    ? service.getConfiguration()
    : { configured: service.configured, model: service.model, source: service.configured ? "environment" : "none", configured_at: null };
}

function assertLocalConfigurationRequest(request: Request) {
  const remote = request.socket.remoteAddress ?? "";
  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!loopback || request.get("x-tta-local-config") !== "1") {
    throw new AiServiceError(403, "LOCAL_CONFIG_FORBIDDEN", "AI 配置只允许从本机产品界面提交。", false);
  }
  const role = request.get("x-tta-role");
  if (role !== "operations" && role !== "lead") {
    throw new AiServiceError(403, "ROLE_FORBIDDEN", "只有运营或负责人可以修改 AI 配置。", false);
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

export function createApp({ aiService, serveDist = false }: { aiService: AiService; serveDist?: boolean }) {
  const app = express();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    const requestId = request.get("x-request-id") || crypto.randomUUID();
    response.locals.requestId = requestId;
    response.setHeader("x-request-id", requestId);
    response.setHeader("cache-control", "no-store");
    next();
  });
  app.use(express.json({ limit: "128kb" }));

  app.get("/api/v2/health", (_request, response) => {
    const configuration = describeConfiguration(aiService);
    response.json({ ok: true, ai_configured: configuration.configured, model: configuration.model, config_source: configuration.source, configured_at: configuration.configured_at });
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

  aiRouter.post("/weekly-strategy", async (request, response, next) => {
    try {
      const input = StrategyRequestSchema.parse(request.body);
      const result = await aiService.weeklyStrategy(input);
      const ratio = result.data.ratio;
      if (ratio.trust + ratio.interest + ratio.desire + ratio.action !== 100) throw new AiServiceError(422, "POLICY_BLOCKED", "内容配比总和必须为 100。", false);
      response.json(result);
    } catch (error) { next(error); }
  });

  aiRouter.post("/content-draft", async (request, response, next) => {
    try { response.json(await aiService.contentDraft(ContentDraftRequestSchema.parse(request.body))); }
    catch (error) { next(error); }
  });

  aiRouter.post("/risk-review", async (request, response, next) => {
    try { response.json(await aiService.riskReview(RiskRequestSchema.parse(request.body))); }
    catch (error) { next(error); }
  });

  aiRouter.post("/customer-evaluation", async (request, response, next) => {
    try {
      const input = CustomerRequestSchema.parse(request.body);
      const result = await aiService.customerEvaluation(input);
      const policy = validateCustomerEvaluation(input.customer as unknown as Customer, result.data);
      if (!policy.allowed) throw new AiServiceError(422, policy.code, policy.reasons.join("；"), false);
      response.json(result);
    } catch (error) { next(error); }
  });

  aiRouter.post("/conversation-insights", async (request, response, next) => {
    try {
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
      const input = ContentBriefRequestSchema.parse(request.body);
      if (input.accepted_insights.some((insight) => insight.status !== "accepted" || insight.invalidated_reason)) throw new AiServiceError(422, "INSIGHT_NOT_ACCEPTED", "内容 Brief 只能使用已接受且有效的洞察。", false);
      const result = await aiService.contentBrief(input);
      const allowed = new Set(input.accepted_insights.map((insight) => String(insight.id)));
      if (result.data.insight_refs.some((id) => !allowed.has(id))) throw new AiServiceError(422, "UNKNOWN_INSIGHT_REFERENCE", "模型 Brief 引用了未知洞察。", false);
      response.json(result);
    } catch (error) { next(error); }
  });

  aiRouter.post("/weekly-retrospective", async (request, response, next) => {
    try { response.json(await aiService.weeklyRetrospective(RetrospectiveRequestSchema.parse(request.body))); }
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
