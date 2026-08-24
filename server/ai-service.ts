import crypto from "node:crypto";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import {
  ContentDraftProposalSchema,
  ContentBriefProposalSchema,
  ConversationInsightsSchema,
  CustomerEvaluationSchema,
  RiskReviewSchema,
  WeeklyStrategySchema,
  WeeklyRetrospectiveSchema,
  type AiMeta,
  type AiResult,
  type ContentDraftProposal,
  type ContentBriefProposal,
  type ConversationInsights,
  type CustomerEvaluation,
  type RiskReview,
  type WeeklyStrategy,
  type WeeklyRetrospective,
} from "../src/domain/schemas";
import { validateCustomerEvaluation } from "../src/domain/policy";
import type { Customer } from "../src/domain/types";
import type { MarketingPromptContext } from "./prompts";
import { buildMarketingPrompt, MARKETING_PROMPT_HASHES } from "./prompts";

export class AiServiceError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

export interface AiService {
  configured: boolean;
  model: string;
  fastModel?: string;
  weeklyStrategy(input: unknown): Promise<AiResult<WeeklyStrategy>>;
  contentDraft(input: unknown): Promise<AiResult<ContentDraftProposal>>;
  riskReview(input: unknown): Promise<AiResult<RiskReview>>;
  customerEvaluation(input: unknown): Promise<AiResult<CustomerEvaluation>>;
  conversationInsights(input: unknown): Promise<AiResult<ConversationInsights>>;
  contentBrief(input: unknown): Promise<AiResult<ContentBriefProposal>>;
  weeklyRetrospective(input: unknown): Promise<AiResult<WeeklyRetrospective>>;
}

export type AiConfigurationSource = "environment" | "runtime" | "none";

export interface AiConfiguration {
  configured: boolean;
  model: string;
  fast_model: string;
  fast_model_available: boolean;
  source: AiConfigurationSource;
  configured_at: string | null;
}

export interface ConfigurableAiService extends AiService {
  getConfiguration(): AiConfiguration;
  configure(apiKey: string, model: string): Promise<AiConfiguration>;
  resetRuntimeConfiguration(): AiConfiguration;
}

const PROMPT_VERSION = "trust-to-action-content-loop-v2.0.0";
const CUSTOMER_PROMPT_VERSION = "customer-eval-v2.1.0-rc1";
const ROUTER_VERSION = "router-v2.1-risk-first";
const SYSTEM_BOUNDARY = `你是 Trust-to-Action 内部增长副驾。只使用输入中明确提供的合成事实和证据引用。
不得编造客户、原话、数据、授权、价格、结果或成交事实。点赞等弱信号不能独立支持 D1/A1。
输出是结构化内部判断，不得声称已经发送、发布、报价或承诺。每条内容只保留一个 CTA。
只输出可供用户核对的证据摘要和未知项，不输出隐藏推理过程。证据不足时保持当前状态并返回 insufficient_evidence。`;

export interface CustomerRoute {
  model: string;
  reason: string;
  tier: "fast" | "primary";
}

export interface CustomerRouteExecutionOptions {
  input: unknown;
  primaryModel: string;
  fastModel: string;
  fastModelAvailable: boolean;
  run(model: string): Promise<AiResult<CustomerEvaluation>>;
}

export function selectCustomerRoute(input: unknown, primaryModel = "gpt-5.6", fastModel = "gpt-5.6-terra"): CustomerRoute {
  const customer = (input as { customer?: Customer })?.customer;
  if (!customer) return { model: primaryModel, reason: "missing_typed_context", tier: "primary" };
  const validEvidence = customer.evidence.filter((item) => item.valid);
  const sensitive = validEvidence.some((item) => /价格|报价|合同|成交|投诉|敏感|排期/iu.test(`${item.type} ${item.text}`));
  const hasTransaction = validEvidence.some((item) => item.transaction_fact);
  const hasConflict = customer.evidence.some((item) => !item.valid) || new Set(validEvidence.map((item) => item.strength)).size > 2;
  const simple = ["T0", "T1"].includes(customer.state) && !customer.anomaly && !sensitive && !hasTransaction && !hasConflict;
  return simple
    ? { model: fastModel, reason: "simple_t0_t1", tier: "fast" }
    : { model: primaryModel, reason: customer.anomaly ? "customer_anomaly" : hasTransaction ? "transaction_fact" : sensitive ? "sensitive_or_commercial" : hasConflict ? "evidence_conflict" : "advanced_state", tier: "primary" };
}

export async function executeCustomerRoute({ input, primaryModel, fastModel, fastModelAvailable, run }: CustomerRouteExecutionOptions) {
  const selected = fastModelAvailable
    ? selectCustomerRoute(input, primaryModel, fastModel)
    : { model: primaryModel, reason: "fast_model_unavailable", tier: "primary" as const };
  if (selected.tier === "primary") {
    const result = await run(primaryModel);
    return { ...result, meta: { ...result.meta, router_version: ROUTER_VERSION, route_reason: selected.reason, attempts: 1, escalated_from: null } };
  }

  try {
    const fast = await run(fastModel);
    const customer = (input as { customer?: Customer }).customer;
    const policy = customer ? validateCustomerEvaluation(customer, fast.data) : { allowed: false };
    if (fast.data.confidence < 75) throw new AiServiceError(422, "LOW_CONFIDENCE", "轻量模型置信度低于路由门槛。", true);
    if (!policy.allowed) throw new AiServiceError(422, "FAST_MODEL_POLICY_BLOCKED", "轻量模型输出未通过策略门禁。", true);
    return { ...fast, meta: { ...fast.meta, router_version: ROUTER_VERSION, route_reason: selected.reason, attempts: 1, escalated_from: null } };
  } catch {
    const primary = await run(primaryModel);
    return { ...primary, meta: { ...primary.meta, router_version: ROUTER_VERSION, route_reason: `${selected.reason}:escalated`, attempts: 2, escalated_from: fastModel } };
  }
}

function mapOpenAiError(error: unknown): AiServiceError {
  if (error instanceof AiServiceError) return error;
  if (error instanceof OpenAI.APIError) {
    if (error.status === 429) return new AiServiceError(429, "OPENAI_RATE_LIMITED", "模型请求过于频繁，请稍后重试。", true);
    if (error.status === 401 || error.status === 403) return new AiServiceError(503, "OPENAI_AUTH_FAILED", "OpenAI API 密钥无效或无模型权限。", false);
    if (error.status === 404) return new AiServiceError(422, "OPENAI_MODEL_UNAVAILABLE", "当前 API Key 无法访问所选模型。", false);
    if (error.status && error.status >= 500) return new AiServiceError(502, "OPENAI_UNAVAILABLE", "OpenAI 服务暂时不可用。", true);
    return new AiServiceError(502, "OPENAI_REQUEST_FAILED", "OpenAI 请求失败。", Boolean(error.status && error.status >= 500));
  }
  if (error instanceof Error && (error.name === "AbortError" || /timeout/iu.test(error.message))) {
    return new AiServiceError(504, "OPENAI_TIMEOUT", "模型生成超时，当前操作已阻断。", true);
  }
  return new AiServiceError(502, "OPENAI_UNKNOWN_ERROR", "模型生成失败，当前操作已阻断。", true);
}

async function verifyOpenAiConfiguration(apiKey: string, model: string) {
  const client = new OpenAI({ apiKey, timeout: 15_000, maxRetries: 0 });
  try {
    await client.models.retrieve(model);
  } catch (error) {
    throw mapOpenAiError(error);
  }
}

export function createOpenAiService(options: { apiKey?: string; model?: string; fastModel?: string; fastModelAvailable?: boolean } = {}): AiService {
  const apiKey = options.apiKey?.trim();
  const model = options.model?.trim() || "gpt-5.6";
  const fastModel = options.fastModel?.trim() || "gpt-5.6-terra";
  const fastModelAvailable = options.fastModelAvailable ?? true;
  const client = apiKey ? new OpenAI({ apiKey, timeout: 30_000, maxRetries: 0 }) : null;

  async function generate<T>(schema: z.ZodType<T>, schemaName: string, task: string, input: unknown, selectedModel = model, promptVersion = PROMPT_VERSION, systemPrompt = SYSTEM_BOUNDARY): Promise<AiResult<T>> {
    if (!client) throw new AiServiceError(503, "AI_NOT_CONFIGURED", "未配置 OPENAI_API_KEY，真实模型能力已阻断。", false);
    const requestRecord = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
    const idempotencyKey = typeof requestRecord?.__idempotency_key === "string" ? requestRecord.__idempotency_key : undefined;
    const modelInput = requestRecord && "__idempotency_key" in requestRecord
      ? Object.fromEntries(Object.entries(requestRecord).filter(([key]) => key !== "__idempotency_key"))
      : input;
    const startedAt = Date.now();
    try {
      const response = await client.responses.parse({
        model: selectedModel,
        input: [
          { role: "system", content: `${systemPrompt}\n\n当前任务：${task}` },
          { role: "user", content: JSON.stringify(modelInput) },
        ],
        text: { format: zodTextFormat(schema, schemaName) },
      }, idempotencyKey ? { idempotencyKey } : undefined);
      if (!response.output_parsed) {
        const refusal = JSON.stringify(response.output).includes("refusal");
        throw new AiServiceError(422, refusal ? "MODEL_REFUSAL" : "MODEL_OUTPUT_INVALID", refusal ? "模型拒绝处理当前输入。" : "模型未返回可校验的结构化结果。", false);
      }
      const data = schema.safeParse(response.output_parsed);
      if (!data.success) throw new AiServiceError(502, "MODEL_SCHEMA_INVALID", "模型输出未通过结构校验。", true);
      const meta: AiMeta = {
        model: selectedModel,
        response_id: response.id,
        prompt_version: promptVersion,
        generated_at: new Date().toISOString(),
        latency_ms: Date.now() - startedAt,
        input_tokens: response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
        input_fingerprint: crypto.createHash("sha256").update(JSON.stringify(modelInput)).digest("hex").slice(0, 16),
      };
      return { data: data.data, meta };
    } catch (error) {
      throw mapOpenAiError(error);
    }
  }

  return {
    configured: Boolean(client),
    model,
    fastModel,
    weeklyStrategy(input) {
      const context = (input as { brain_context?: MarketingPromptContext }).brain_context;
      return generate(WeeklyStrategySchema, "weekly_strategy", "根据当前经营指标、状态分布、内容和证明资产生成一周运营策略。配比总和必须为 100。", input, model, context ? `code-${MARKETING_PROMPT_HASHES.weekly_strategy}` : PROMPT_VERSION, context ? buildMarketingPrompt("weekly_strategy", context) : SYSTEM_BOUNDARY);
    },
    contentDraft(input) {
      const context = (input as { brain_context?: MarketingPromptContext }).brain_context;
      const selected = (input as { low_risk_rewrite?: boolean }).low_risk_rewrite && fastModelAvailable ? fastModel : model;
      return generate(ContentDraftProposalSchema, "content_draft", "生成一条可人工编辑的朋友圈草稿，引用输入中存在的证据，并明确一个 CTA。", input, selected, context ? `code-${MARKETING_PROMPT_HASHES.content_draft}` : PROMPT_VERSION, context ? buildMarketingPrompt("content_draft", context) : SYSTEM_BOUNDARY);
    },
    riskReview(input) {
      return generate(RiskReviewSchema, "risk_review", "检查事实、客户证明、量化承诺、价格、投诉和敏感信息风险；风险判断只是建议，不能解除确定性审批门禁。", input);
    },
    async customerEvaluation(input) {
      const context = (input as { brain_context?: MarketingPromptContext }).brain_context;
      const task = `按以下顺序完成客户评估：
1. 仅核对按时间排序且 valid=true 的证据，逐条给出可公开的 evidence_assessment。
2. 判断状态是否保持或最多前进一步；弱信号不能独立推动 D1/A1，C1 必须引用成交事实。
3. 从固定动作集合选择一个下一最佳动作，并列出不建议动作与未知项。
4. 证据不足时 decision=insufficient_evidence、state_after=state_before，不得用高置信度掩盖缺口。`;
      return executeCustomerRoute({
        input,
        primaryModel: model,
        fastModel,
        fastModelAvailable,
        run: (selectedModel) => generate(CustomerEvaluationSchema, "customer_evaluation", task, input, selectedModel, context ? `code-${MARKETING_PROMPT_HASHES.customer_nba}` : CUSTOMER_PROMPT_VERSION, context ? buildMarketingPrompt("customer_nba", context) : SYSTEM_BOUNDARY),
      });
    },
    conversationInsights(input) {
      return generate(ConversationInsightsSchema, "conversation_insights", "从已经过同意、权限、有效性和脱敏过滤的会话消息中提取问题、异议、期望结果和购买信号。每条洞察必须引用输入中的消息和会话 ID，不得还原个人信息。", input);
    },
    contentBrief(input) {
      const context = (input as { brain_context?: MarketingPromptContext }).brain_context;
      return generate(ContentBriefProposalSchema, "content_brief", "根据已接受洞察生成一份朋友圈优先的内容 Brief。固定目标客户、阶段、主角度、关键事实、证明需求、唯一 CTA 和截止时间。", input, model, context ? `code-${MARKETING_PROMPT_HASHES.content_brief}` : PROMPT_VERSION, context ? buildMarketingPrompt("content_brief", context) : SYSTEM_BOUNDARY);
    },
    weeklyRetrospective(input) {
      return generate(WeeklyRetrospectiveSchema, "weekly_retrospective", "分开复盘平台互动与销售业务结果，提出下周主题候选，并始终声明时间关联不代表因果。", input);
    },
  };
}

export function createOpenAiServiceManager(options: {
  apiKey?: string;
  model?: string;
  fastModel?: string;
  verify?: (apiKey: string, model: string) => Promise<void>;
} = {}): ConfigurableAiService {
  const environmentApiKey = options.apiKey?.trim() || "";
  const environmentModel = options.model?.trim() || "gpt-5.6";
  const environmentFastModel = options.fastModel?.trim() || "gpt-5.6-terra";
  const verify = options.verify ?? verifyOpenAiConfiguration;
  let fastModelAvailable = true;
  let current = createOpenAiService({ apiKey: environmentApiKey, model: environmentModel, fastModel: environmentFastModel, fastModelAvailable });
  let source: AiConfigurationSource = environmentApiKey ? "environment" : "none";
  let configuredAt: string | null = environmentApiKey ? new Date().toISOString() : null;

  function configuration(): AiConfiguration {
    return { configured: current.configured, model: current.model, fast_model: current.fastModel ?? environmentFastModel, fast_model_available: fastModelAvailable, source, configured_at: configuredAt };
  }

  return {
    get configured() { return current.configured; },
    get model() { return current.model; },
    get fastModel() { return current.fastModel; },
    getConfiguration: configuration,
    async configure(apiKey, model) {
      const nextApiKey = apiKey.trim();
      const nextModel = model.trim() || environmentModel;
      await verify(nextApiKey, nextModel);
      try {
        await verify(nextApiKey, environmentFastModel);
        fastModelAvailable = true;
      } catch {
        fastModelAvailable = false;
      }
      current = createOpenAiService({ apiKey: nextApiKey, model: nextModel, fastModel: environmentFastModel, fastModelAvailable });
      source = "runtime";
      configuredAt = new Date().toISOString();
      return configuration();
    },
    resetRuntimeConfiguration() {
      fastModelAvailable = true;
      current = createOpenAiService({ apiKey: environmentApiKey, model: environmentModel, fastModel: environmentFastModel, fastModelAvailable });
      source = environmentApiKey ? "environment" : "none";
      configuredAt = environmentApiKey ? new Date().toISOString() : null;
      return configuration();
    },
    weeklyStrategy(input) { return current.weeklyStrategy(input); },
    contentDraft(input) { return current.contentDraft(input); },
    riskReview(input) { return current.riskReview(input); },
    customerEvaluation(input) { return current.customerEvaluation(input); },
    conversationInsights(input) { return current.conversationInsights(input); },
    contentBrief(input) { return current.contentBrief(input); },
    weeklyRetrospective(input) { return current.weeklyRetrospective(input); },
  };
}
