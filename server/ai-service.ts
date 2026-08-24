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
  source: AiConfigurationSource;
  configured_at: string | null;
}

export interface ConfigurableAiService extends AiService {
  getConfiguration(): AiConfiguration;
  configure(apiKey: string, model: string): Promise<AiConfiguration>;
  resetRuntimeConfiguration(): AiConfiguration;
}

const PROMPT_VERSION = "trust-to-action-content-loop-v2.0.0";
const SYSTEM_BOUNDARY = `你是 Trust-to-Action 内部增长副驾。只使用输入中明确提供的合成事实和证据引用。
不得编造客户、原话、数据、授权、价格、结果或成交事实。点赞等弱信号不能独立支持 D1/A1。
输出是结构化内部判断，不得声称已经发送、发布、报价或承诺。每条内容只保留一个 CTA。`;

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

export function createOpenAiService(options: { apiKey?: string; model?: string } = {}): AiService {
  const apiKey = options.apiKey?.trim();
  const model = options.model?.trim() || "gpt-5.6";
  const client = apiKey ? new OpenAI({ apiKey, timeout: 45_000, maxRetries: 1 }) : null;

  async function generate<T>(schema: z.ZodType<T>, schemaName: string, task: string, input: unknown): Promise<AiResult<T>> {
    if (!client) throw new AiServiceError(503, "AI_NOT_CONFIGURED", "未配置 OPENAI_API_KEY，真实模型能力已阻断。", false);
    try {
      const response = await client.responses.parse({
        model,
        input: [
          { role: "system", content: `${SYSTEM_BOUNDARY}\n\n当前任务：${task}` },
          { role: "user", content: JSON.stringify(input) },
        ],
        text: { format: zodTextFormat(schema, schemaName) },
      });
      if (!response.output_parsed) {
        const refusal = JSON.stringify(response.output).includes("refusal");
        throw new AiServiceError(422, refusal ? "MODEL_REFUSAL" : "MODEL_OUTPUT_INVALID", refusal ? "模型拒绝处理当前输入。" : "模型未返回可校验的结构化结果。", false);
      }
      const data = schema.safeParse(response.output_parsed);
      if (!data.success) throw new AiServiceError(502, "MODEL_SCHEMA_INVALID", "模型输出未通过结构校验。", true);
      const meta: AiMeta = { model, response_id: response.id, prompt_version: PROMPT_VERSION, generated_at: new Date().toISOString() };
      return { data: data.data, meta };
    } catch (error) {
      throw mapOpenAiError(error);
    }
  }

  return {
    configured: Boolean(client),
    model,
    weeklyStrategy(input) {
      return generate(WeeklyStrategySchema, "weekly_strategy", "根据当前经营指标、状态分布、内容和证明资产生成一周运营策略。配比总和必须为 100。", input);
    },
    contentDraft(input) {
      return generate(ContentDraftProposalSchema, "content_draft", "生成一条可人工编辑的朋友圈草稿，引用输入中存在的证据，并明确一个 CTA。", input);
    },
    riskReview(input) {
      return generate(RiskReviewSchema, "risk_review", "检查事实、客户证明、量化承诺、价格、投诉和敏感信息风险；风险判断只是建议，不能解除确定性审批门禁。", input);
    },
    customerEvaluation(input) {
      return generate(CustomerEvaluationSchema, "customer_evaluation", "根据按时间排序的有效证据判断客户状态和下一最佳动作。状态最多前进一步，C1 只能引用成交事实。", input);
    },
    conversationInsights(input) {
      return generate(ConversationInsightsSchema, "conversation_insights", "从已经过同意、权限、有效性和脱敏过滤的会话消息中提取问题、异议、期望结果和购买信号。每条洞察必须引用输入中的消息和会话 ID，不得还原个人信息。", input);
    },
    contentBrief(input) {
      return generate(ContentBriefProposalSchema, "content_brief", "根据已接受洞察生成一份朋友圈优先的内容 Brief。固定目标客户、阶段、主角度、关键事实、证明需求、唯一 CTA 和截止时间。", input);
    },
    weeklyRetrospective(input) {
      return generate(WeeklyRetrospectiveSchema, "weekly_retrospective", "分开复盘平台互动与销售业务结果，提出下周主题候选，并始终声明时间关联不代表因果。", input);
    },
  };
}

export function createOpenAiServiceManager(options: {
  apiKey?: string;
  model?: string;
  verify?: (apiKey: string, model: string) => Promise<void>;
} = {}): ConfigurableAiService {
  const environmentApiKey = options.apiKey?.trim() || "";
  const environmentModel = options.model?.trim() || "gpt-5.6";
  const verify = options.verify ?? verifyOpenAiConfiguration;
  let current = createOpenAiService({ apiKey: environmentApiKey, model: environmentModel });
  let source: AiConfigurationSource = environmentApiKey ? "environment" : "none";
  let configuredAt: string | null = environmentApiKey ? new Date().toISOString() : null;

  function configuration(): AiConfiguration {
    return { configured: current.configured, model: current.model, source, configured_at: configuredAt };
  }

  return {
    get configured() { return current.configured; },
    get model() { return current.model; },
    getConfiguration: configuration,
    async configure(apiKey, model) {
      const nextApiKey = apiKey.trim();
      const nextModel = model.trim() || environmentModel;
      await verify(nextApiKey, nextModel);
      current = createOpenAiService({ apiKey: nextApiKey, model: nextModel });
      source = "runtime";
      configuredAt = new Date().toISOString();
      return configuration();
    },
    resetRuntimeConfiguration() {
      current = createOpenAiService({ apiKey: environmentApiKey, model: environmentModel });
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
