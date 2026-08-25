import crypto from "node:crypto";
import type { ZodType } from "zod";
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
import type { AiEndpointScope, AiProtocol, AiProviderId, Customer, ModelProfileVersion, ProviderCapability, ProviderConnectionProfile } from "../src/domain/types";
import { createProviderAdapter, ProviderAdapterError, type ProviderAdapter, type ProviderAdapterOptions } from "./ai-adapters";
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
  provider: AiProviderId;
  protocol: AiProtocol;
  endpoint_scope: AiEndpointScope;
  connection_profile_id: string;
  model_profile_version_id: string;
  model: string;
  fallback_model: string | null;
  fast_model: string;
  fast_model_available: boolean;
  source: AiConfigurationSource;
  configured_at: string | null;
}

export interface ProfileActivationResult {
  configuration: AiConfiguration;
  capability?: ProviderCapability;
}

export interface ConfigurableAiService extends AiService {
  getConfiguration(): AiConfiguration;
  configure(apiKey: string, model: string): Promise<AiConfiguration>;
  resetRuntimeConfiguration(): AiConfiguration;
  testConnection(connection: ProviderConnectionProfile, profile: ModelProfileVersion, apiKey?: string): Promise<ProviderCapability>;
  runSmoke(connection: ProviderConnectionProfile, profile: ModelProfileVersion): Promise<{ passed: number; total: number }>;
  activateProfile(connection: ProviderConnectionProfile, profile: ModelProfileVersion): AiConfiguration;
  clearRuntimeSecret(connectionId: string): AiConfiguration;
}

const PROMPT_VERSION = "trust-to-action-content-loop-v2.3.0";
const CUSTOMER_PROMPT_VERSION = "customer-eval-v2.3.0";
const ROUTER_VERSION = "global-profile-v2.3";
const FALLBACK_CODES = new Set(["RATE_LIMITED", "TIMEOUT", "PROVIDER_UNAVAILABLE", "MODEL_UNAVAILABLE", "REFUSAL", "OUTPUT_TRUNCATED", "SCHEMA_INVALID", "LOW_CONFIDENCE", "MODEL_POLICY_BLOCKED"]);
const SYSTEM_BOUNDARY = `你是 Trust-to-Action 内部增长副驾。只使用输入中明确提供的合成事实和证据引用。
不得编造客户、原话、数据、授权、价格、结果或成交事实。点赞等弱信号不能独立支持 D1/A1。
输出是结构化内部判断，不得声称已经发送、发布、报价或承诺。每条内容只保留一个 CTA。
只输出可供用户核对的证据摘要和未知项，不输出隐藏推理过程。证据不足时保持当前状态并返回 insufficient_evidence。`;

export interface CustomerRoute {
  model: string;
  reason: string;
  tier: "primary";
}

export function selectCustomerRoute(_input: unknown, primaryModel = "gpt-5.6", _fallbackModel = "gpt-5.6-terra"): CustomerRoute {
  return { model: primaryModel, reason: "global_primary", tier: "primary" };
}

export interface CustomerRouteExecutionOptions {
  input: unknown;
  primaryModel: string;
  fastModel: string;
  fastModelAvailable: boolean;
  run(model: string): Promise<AiResult<CustomerEvaluation>>;
}

export async function executeCustomerRoute({ input, primaryModel, fastModel, fastModelAvailable, run }: CustomerRouteExecutionOptions) {
  try {
    const result = await run(primaryModel);
    const customer = (input as { customer?: Customer })?.customer;
    const policy = customer ? validateCustomerEvaluation(customer, result.data) : { allowed: true };
    if (result.data.confidence < 75) throw new AiServiceError(422, "LOW_CONFIDENCE", "主模型置信度低于门槛。", true);
    if (!policy.allowed) throw new AiServiceError(422, "MODEL_POLICY_BLOCKED", "模型输出未通过确定性策略门禁。", true);
    return { ...result, meta: { ...result.meta, router_version: ROUTER_VERSION, route_reason: "global_primary", attempts: 1, escalated_from: null, fallback_from: null } };
  } catch (error) {
    if (!fastModelAvailable || !shouldFallback(error)) throw error;
    const fallback = await run(fastModel);
    return { ...fallback, meta: { ...fallback.meta, router_version: ROUTER_VERSION, route_reason: `global_fallback:${errorCode(error)}`, attempts: 2, escalated_from: primaryModel, fallback_from: primaryModel } };
  }
}

function errorCode(error: unknown) {
  if (error instanceof AiServiceError || error instanceof ProviderAdapterError) return error.code;
  return "PROVIDER_REQUEST_FAILED";
}

function shouldFallback(error: unknown) {
  if (error instanceof AiServiceError || error instanceof ProviderAdapterError) return error.retryable && FALLBACK_CODES.has(error.code);
  return false;
}

function asAiServiceError(error: unknown) {
  if (error instanceof AiServiceError) return error;
  if (error instanceof ProviderAdapterError) return new AiServiceError(error.status, error.code, error.message, error.retryable);
  return new AiServiceError(502, "PROVIDER_REQUEST_FAILED", "模型生成失败，当前操作已阻断。", true);
}

function openAiConnection(source: AiConfigurationSource): ProviderConnectionProfile {
  return {
    id: "connection-openai", revision: 1, updated_at: new Date().toISOString(), tenant_id: "tenant-dogfood-cn", name: "OpenAI 官方云", provider: "openai", endpoint_scope: "public_cloud", protocol: "openai_responses", base_url: "https://api.openai.com/v1", region: "global", auth_mode: "bearer", credential_source: source, credential_ref: "OPENAI_API_KEY", credential_available: source !== "none",
    capabilities: { structured_output: source !== "none", native_json_schema: source !== "none", refusal_signal: source !== "none", usage_reporting: source !== "none", request_id: source !== "none", tested_at: source !== "none" ? new Date().toISOString() : null, notes: ["OpenAI Responses Structured Outputs"] },
    last_tested_at: source !== "none" ? new Date().toISOString() : null, last_error_code: null, created_by: "系统迁移",
  };
}

function openAiProfile(model: string, fallbackModel: string): ModelProfileVersion {
  return {
    id: "model-profile-openai", revision: 1, updated_at: new Date().toISOString(), tenant_id: "tenant-dogfood-cn", name: "OpenAI 全局主模型", connection_profile_id: "connection-openai", provider: "openai", protocol: "openai_responses", endpoint_scope: "public_cloud", primary_model: model, fallback_model: fallbackModel, status: "active", smoke_passed_at: null, smoke_case_count: 0, holdout_run_id: null, data_egress_acknowledged_by: "环境配置", data_egress_acknowledged_at: new Date().toISOString(), activated_by: "环境配置", activated_at: new Date().toISOString(), previous_profile_id: null, created_by: "系统迁移",
  };
}

interface ActiveRuntime {
  connection: ProviderConnectionProfile;
  profile: ModelProfileVersion;
  adapter: ProviderAdapter | null;
  source: AiConfigurationSource;
  configuredAt: string | null;
}

export function createOpenAiServiceManager(options: {
  apiKey?: string;
  model?: string;
  fastModel?: string;
  environment?: NodeJS.ProcessEnv;
  endpointAllowlist?: string[];
  verify?: (apiKey: string, model: string) => Promise<void>;
  adapterFactory?: (options: ProviderAdapterOptions) => ProviderAdapter;
} = {}): ConfigurableAiService {
  const environment = options.environment ?? process.env;
  const environmentApiKey = options.apiKey?.trim() || environment.OPENAI_API_KEY?.trim() || "";
  const environmentModel = options.model?.trim() || "gpt-5.6";
  const environmentFallbackModel = options.fastModel?.trim() || "gpt-5.6-terra";
  const endpointAllowlist = options.endpointAllowlist ?? (environment.AI_ENDPOINT_ALLOWLIST ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const adapterFactory = options.adapterFactory ?? createProviderAdapter;
  const runtimeSecrets = new Map<string, string>();
  const envConnection = openAiConnection(environmentApiKey ? "environment" : "none");
  const envProfile = openAiProfile(environmentModel, environmentFallbackModel);
  let active: ActiveRuntime = {
    connection: envConnection,
    profile: envProfile,
    adapter: environmentApiKey ? adapterFactory({ connection: envConnection, apiKey: environmentApiKey, endpointAllowlist }) : null,
    source: environmentApiKey ? "environment" : "none",
    configuredAt: environmentApiKey ? new Date().toISOString() : null,
  };

  function credential(connection: ProviderConnectionProfile, supplied?: string) {
    if (connection.auth_mode === "none") return "";
    if (supplied?.trim()) return supplied.trim();
    const runtime = runtimeSecrets.get(connection.id);
    if (runtime) return runtime;
    if (connection.credential_ref && environment[connection.credential_ref]?.trim()) return environment[connection.credential_ref]!.trim();
    return "";
  }

  function configuration(): AiConfiguration {
    const fallback = active.profile.fallback_model;
    return {
      configured: Boolean(active.adapter), provider: active.profile.provider, protocol: active.profile.protocol, endpoint_scope: active.profile.endpoint_scope,
      connection_profile_id: active.connection.id, model_profile_version_id: active.profile.id, model: active.profile.primary_model, fallback_model: fallback,
      fast_model: fallback ?? active.profile.primary_model, fast_model_available: Boolean(fallback && active.adapter), source: active.source, configured_at: active.configuredAt,
    };
  }

  async function generate<T>(schema: ZodType<T>, schemaName: string, task: string, input: unknown, promptVersion = PROMPT_VERSION, systemPrompt = SYSTEM_BOUNDARY, validate?: (data: T) => void): Promise<AiResult<T>> {
    if (!active.adapter) throw new AiServiceError(503, "AI_NOT_CONFIGURED", "当前全局模型 Profile 缺少可用凭据。", false);
    const requestRecord = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
    const idempotencyKey = typeof requestRecord?.__idempotency_key === "string" ? requestRecord.__idempotency_key : undefined;
    const modelInput = requestRecord && "__idempotency_key" in requestRecord ? Object.fromEntries(Object.entries(requestRecord).filter(([key]) => key !== "__idempotency_key")) : input;
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(modelInput)).digest("hex").slice(0, 16);
    const startedAt = Date.now();
    const run = async (model: string) => {
      const result = await active.adapter!.generate({ schema, schemaName, systemPrompt, taskPrompt: task, input: modelInput, model, idempotencyKey });
      validate?.(result.data);
      return result;
    };
    let result;
    let attempts = 1;
    let routeReason = "global_primary";
    let fallbackFrom: string | null = null;
    try { result = await run(active.profile.primary_model); }
    catch (cause) {
      const error = asAiServiceError(cause);
      if (!active.profile.fallback_model || !shouldFallback(error)) throw error;
      attempts = 2;
      routeReason = `global_fallback:${error.code}`;
      fallbackFrom = active.profile.primary_model;
      try { result = await run(active.profile.fallback_model); }
      catch (fallbackError) { throw asAiServiceError(fallbackError); }
    }
    const meta: AiMeta = {
      model: fallbackFrom ? active.profile.fallback_model! : active.profile.primary_model,
      provider: active.profile.provider, protocol: active.profile.protocol, endpoint_scope: active.profile.endpoint_scope,
      connection_profile_id: active.connection.id, model_profile_version_id: active.profile.id,
      response_id: result.responseId, prompt_version: promptVersion, generated_at: new Date().toISOString(), router_version: ROUTER_VERSION, route_reason: routeReason,
      attempts, latency_ms: Date.now() - startedAt, input_tokens: result.inputTokens, output_tokens: result.outputTokens, escalated_from: fallbackFrom, fallback_from: fallbackFrom, input_fingerprint: fingerprint,
    };
    return { data: result.data, meta };
  }

  const manager: ConfigurableAiService = {
    get configured() { return Boolean(active.adapter); },
    get model() { return active.profile.primary_model; },
    get fastModel() { return active.profile.fallback_model ?? undefined; },
    getConfiguration: configuration,
    async configure(apiKey, model) {
      const connection = openAiConnection("runtime");
      const profile = openAiProfile(model.trim() || environmentModel, environmentFallbackModel);
      if (options.verify) await options.verify(apiKey.trim(), profile.primary_model);
      else await adapterFactory({ connection, apiKey: apiKey.trim(), endpointAllowlist }).verify(profile.primary_model);
      runtimeSecrets.set(connection.id, apiKey.trim());
      active = { connection, profile, adapter: adapterFactory({ connection, apiKey: apiKey.trim(), endpointAllowlist }), source: "runtime", configuredAt: new Date().toISOString() };
      return configuration();
    },
    resetRuntimeConfiguration() {
      runtimeSecrets.clear();
      active = { connection: envConnection, profile: envProfile, adapter: environmentApiKey ? adapterFactory({ connection: envConnection, apiKey: environmentApiKey, endpointAllowlist }) : null, source: environmentApiKey ? "environment" : "none", configuredAt: environmentApiKey ? new Date().toISOString() : null };
      return configuration();
    },
    async testConnection(connection, profile, apiKey) {
      if (connection.id !== profile.connection_profile_id || connection.provider !== profile.provider || connection.protocol !== profile.protocol) throw new AiServiceError(422, "CAPABILITY_MISMATCH", "模型 Profile 与连接的供应商或协议不一致。", false);
      try {
        const key = credential(connection, apiKey);
        const adapter = adapterFactory({ connection, apiKey: key, endpointAllowlist });
        await adapter.verify(profile.primary_model);
        if (apiKey?.trim()) runtimeSecrets.set(connection.id, apiKey.trim());
        const now = new Date().toISOString();
        return { structured_output: true, native_json_schema: connection.protocol !== "openai_chat", refusal_signal: true, usage_reporting: true, request_id: true, tested_at: now, notes: [connection.protocol === "openai_chat" ? "JSON 模式由 Zod 二次校验" : "原生 JSON Schema 已验证"] };
      } catch (error) { throw asAiServiceError(error); }
    },
    async runSmoke(connection, profile) {
      const key = credential(connection);
      let adapter: ProviderAdapter;
      try { adapter = adapterFactory({ connection, apiKey: key, endpointAllowlist }); }
      catch (error) { throw asAiServiceError(error); }
      const tasks = ["weekly_strategy", "content_brief", "content_draft", "customer_nba", "risk_review", "conversation_insights", "weekly_retrospective"];
      let passed = 0;
      for (let index = 0; index < tasks.length; index += 2) {
        const batch = tasks.slice(index, index + 2).flatMap((task) => [task, task]).map(async (task, taskIndex) => {
          await adapter.generate({ schema: ContentDraftProposalSchema.pick({ title: true }), schemaName: `smoke_${task}`, systemPrompt: "只返回符合 Schema 的 JSON。", taskPrompt: `连接 Smoke：返回一个非空 title，任务 ${task}。`, input: { synthetic: true, case: index * 2 + taskIndex + 1 }, model: profile.primary_model, idempotencyKey: `smoke-${profile.id}-${task}-${taskIndex}` });
          passed += 1;
        });
        try { await Promise.all(batch); }
        catch (error) { throw asAiServiceError(error); }
      }
      return { passed, total: 14 };
    },
    activateProfile(connection, profile) {
      if (connection.id !== profile.connection_profile_id || connection.provider !== profile.provider || connection.protocol !== profile.protocol) throw new AiServiceError(422, "CAPABILITY_MISMATCH", "模型 Profile 与连接不匹配。", false);
      const key = credential(connection);
      try {
        active = { connection, profile, adapter: adapterFactory({ connection, apiKey: key, endpointAllowlist }), source: runtimeSecrets.has(connection.id) ? "runtime" : connection.credential_ref && environment[connection.credential_ref] ? "environment" : "none", configuredAt: new Date().toISOString() };
      } catch (error) { throw asAiServiceError(error); }
      return configuration();
    },
    clearRuntimeSecret(connectionId) {
      runtimeSecrets.delete(connectionId);
      if (active.connection.id === connectionId) {
        const key = credential(active.connection);
        try { active.adapter = adapterFactory({ connection: active.connection, apiKey: key, endpointAllowlist }); }
        catch { active.adapter = null; }
        active.source = key ? "environment" : "none";
        active.configuredAt = key ? new Date().toISOString() : null;
      }
      return configuration();
    },
    weeklyStrategy(input) {
      const context = (input as { brain_context?: MarketingPromptContext }).brain_context;
      return generate(WeeklyStrategySchema, "weekly_strategy", "根据当前经营指标、状态分布、内容和证明资产生成一周运营策略。配比总和必须为 100。", input, context ? `code-${MARKETING_PROMPT_HASHES.weekly_strategy}` : PROMPT_VERSION, context ? buildMarketingPrompt("weekly_strategy", context) : SYSTEM_BOUNDARY);
    },
    contentDraft(input) {
      const context = (input as { brain_context?: MarketingPromptContext }).brain_context;
      return generate(ContentDraftProposalSchema, "content_draft", "生成一条可人工编辑的朋友圈草稿，引用输入中存在的证据，并明确一个 CTA。", input, context ? `code-${MARKETING_PROMPT_HASHES.content_draft}` : PROMPT_VERSION, context ? buildMarketingPrompt("content_draft", context) : SYSTEM_BOUNDARY);
    },
    riskReview(input) { return generate(RiskReviewSchema, "risk_review", "检查事实、客户证明、量化承诺、价格、投诉和敏感信息风险；风险判断只是建议，不能解除确定性审批门禁。", input); },
    customerEvaluation(input) {
      const context = (input as { brain_context?: MarketingPromptContext }).brain_context;
      const customer = (input as { customer?: Customer }).customer;
      const task = `按以下顺序完成客户评估：
1. 仅核对按时间排序且 valid=true 的证据，逐条给出可公开的 evidence_assessment。
2. 判断状态是否保持或最多前进一步；弱信号不能独立推动 D1/A1，C1 必须引用成交事实。
3. 从固定动作集合选择一个下一最佳动作，并列出不建议动作与未知项。
4. 证据不足时 decision=insufficient_evidence、state_after=state_before，不得用高置信度掩盖缺口。`;
      return generate(CustomerEvaluationSchema, "customer_evaluation", task, input, context ? `code-${MARKETING_PROMPT_HASHES.customer_nba}` : CUSTOMER_PROMPT_VERSION, context ? buildMarketingPrompt("customer_nba", context) : SYSTEM_BOUNDARY, (data) => {
        if (data.confidence < 75) throw new AiServiceError(422, "LOW_CONFIDENCE", "模型置信度低于门槛。", true);
        if (customer && !validateCustomerEvaluation(customer, data).allowed) throw new AiServiceError(422, "MODEL_POLICY_BLOCKED", "模型输出未通过确定性策略门禁。", true);
      });
    },
    conversationInsights(input) { return generate(ConversationInsightsSchema, "conversation_insights", "从已经过同意、权限、有效性和脱敏过滤的会话消息中提取问题、异议、期望结果和购买信号。每条洞察必须引用输入中的消息和会话 ID，不得还原个人信息。", input); },
    contentBrief(input) {
      const context = (input as { brain_context?: MarketingPromptContext }).brain_context;
      return generate(ContentBriefProposalSchema, "content_brief", "根据已接受洞察生成一份朋友圈优先的内容 Brief。固定目标客户、阶段、主角度、关键事实、证明需求、唯一 CTA 和截止时间。", input, context ? `code-${MARKETING_PROMPT_HASHES.content_brief}` : PROMPT_VERSION, context ? buildMarketingPrompt("content_brief", context) : SYSTEM_BOUNDARY);
    },
    weeklyRetrospective(input) { return generate(WeeklyRetrospectiveSchema, "weekly_retrospective", "分开复盘平台互动与销售业务结果，提出下周主题候选，并始终声明时间关联不代表因果。", input); },
  };
  return manager;
}

export function createOpenAiService(options: { apiKey?: string; model?: string; fastModel?: string; fastModelAvailable?: boolean } = {}): AiService {
  const manager = createOpenAiServiceManager({ apiKey: options.apiKey, model: options.model, fastModel: options.fastModel });
  if (options.fastModelAvailable === false) {
    const current = manager.getConfiguration();
    const connection = openAiConnection(current.source);
    const profile = { ...openAiProfile(current.model, current.model), fallback_model: null };
    try { manager.activateProfile(connection, profile); } catch { /* missing keys remain blocked */ }
  }
  return manager;
}
