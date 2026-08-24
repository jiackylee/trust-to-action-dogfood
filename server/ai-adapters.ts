import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z, type ZodType } from "zod";
import type { AiEndpointScope, AiProtocol, AiProviderId, ProviderConnectionProfile } from "../src/domain/types";

export interface AdapterResult<T> {
  data: T;
  responseId: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AdapterGenerateInput<T> {
  schema: ZodType<T>;
  schemaName: string;
  systemPrompt: string;
  taskPrompt: string;
  input: unknown;
  model: string;
  idempotencyKey?: string;
}

export interface ProviderAdapter {
  provider: AiProviderId;
  protocol: AiProtocol;
  endpointScope: AiEndpointScope;
  generate<T>(input: AdapterGenerateInput<T>): Promise<AdapterResult<T>>;
  verify(model: string): Promise<void>;
}

export class ProviderAdapterError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

export interface ProviderAdapterOptions {
  connection: ProviderConnectionProfile;
  apiKey?: string;
  timeoutMs?: number;
  endpointAllowlist?: string[];
  allowLoopbackHttp?: boolean;
}

const VERIFY_SCHEMA = z.object({ ok: z.literal(true) });
const BUILTIN_HOSTS: Record<Exclude<AiProviderId, "custom">, string[]> = {
  openai: ["api.openai.com"],
  deepseek: ["api.deepseek.com"],
  anthropic: ["api.anthropic.com"],
  qwen: ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"],
};

function normalizedUrl(value: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ProviderAdapterError(422, "ENDPOINT_BLOCKED", "模型端点不是有效 URL。", false); }
  if (url.username || url.password || url.search || url.hash) throw new ProviderAdapterError(422, "ENDPOINT_BLOCKED", "模型端点不得包含凭据、查询参数或片段。", false);
  return url;
}

export function assertEndpointAllowed(connection: ProviderConnectionProfile, endpointAllowlist: string[] = [], allowLoopbackHttp = process.env.NODE_ENV !== "production") {
  const url = normalizedUrl(connection.base_url);
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  const metadataHost = url.hostname.toLowerCase();
  if (metadataHost === "metadata.google.internal" || metadataHost === "169.254.169.254" || metadataHost === "169.254.170.2" || metadataHost === "100.100.100.200" || metadataHost.startsWith("169.254.")) {
    throw new ProviderAdapterError(422, "ENDPOINT_BLOCKED", "禁止连接云元数据地址。", false);
  }
  if (url.protocol !== "https:" && !(allowLoopbackHttp && connection.endpoint_scope === "private" && loopback && url.protocol === "http:")) {
    throw new ProviderAdapterError(422, "ENDPOINT_BLOCKED", "云端和局域网模型端点必须使用 HTTPS；开发环境仅允许 loopback HTTP。", false);
  }
  if (connection.provider !== "custom") {
    if (!BUILTIN_HOSTS[connection.provider].includes(url.hostname)) throw new ProviderAdapterError(422, "ENDPOINT_BLOCKED", "内置供应商只能连接官方 API 域名。", false);
  } else if (!loopback && !endpointAllowlist.includes(url.hostname)) {
    throw new ProviderAdapterError(422, "ENDPOINT_BLOCKED", "企业私有模型域名未列入 AI_ENDPOINT_ALLOWLIST。", false);
  }
  return url.toString().replace(/\/$/u, "");
}

function providerMessage(provider: AiProviderId, suffix: string) {
  const label = provider === "qwen" ? "Qwen" : provider === "custom" ? "企业私有模型" : provider[0].toUpperCase() + provider.slice(1);
  return `${label} ${suffix}`;
}

function mapStatus(provider: AiProviderId, status: number, body = "") {
  if (status === 401 || status === 403) return new ProviderAdapterError(503, "PROVIDER_AUTH_FAILED", providerMessage(provider, "凭据无效或无模型权限。"), false);
  if (status === 404) return new ProviderAdapterError(422, "MODEL_UNAVAILABLE", providerMessage(provider, "当前凭据无法访问所选模型。"), false);
  if (status === 429) return new ProviderAdapterError(429, "RATE_LIMITED", providerMessage(provider, "请求过于频繁，请稍后重试。"), true);
  if (status >= 500) return new ProviderAdapterError(502, "MODEL_UNAVAILABLE", providerMessage(provider, "服务暂时不可用。"), true);
  const refused = /refus|safety|content.?filter/iu.test(body);
  return new ProviderAdapterError(502, refused ? "REFUSAL" : "MODEL_UNAVAILABLE", refused ? providerMessage(provider, "拒绝处理当前输入。") : providerMessage(provider, "请求失败。"), refused || status >= 500);
}

export function mapProviderError(provider: AiProviderId, error: unknown) {
  if (error instanceof ProviderAdapterError) return error;
  if (error instanceof OpenAI.APIError) return mapStatus(provider, error.status ?? 502, error.message);
  if (error instanceof Anthropic.APIError) return mapStatus(provider, error.status ?? 502, error.message);
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError" || /timeout/iu.test(error.message))) {
    return new ProviderAdapterError(504, "TIMEOUT", providerMessage(provider, "生成超时，当前操作已阻断。"), true);
  }
  return new ProviderAdapterError(502, "MODEL_UNAVAILABLE", providerMessage(provider, "生成失败。"), true);
}

function authHeaders(connection: ProviderConnectionProfile, apiKey?: string): Record<string, string> {
  if (connection.auth_mode === "none") return {};
  if (!apiKey) throw new ProviderAdapterError(503, "PROVIDER_AUTH_FAILED", "当前连接缺少可用凭据。", false);
  return connection.auth_mode === "x-api-key" ? { "x-api-key": apiKey } : { authorization: `Bearer ${apiKey}` };
}

function endpoint(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/u, "")}/${path.replace(/^\//u, "")}`;
}

function responseText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as { content?: unknown }).content) ? (item as { content: unknown[] }).content : [];
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") return (part as { text: string }).text;
    }
  }
  return "";
}

function parseStructured<T>(schema: ZodType<T>, text: string) {
  if (!text.trim()) throw new ProviderAdapterError(502, "SCHEMA_INVALID", "模型返回空结果。", true);
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new ProviderAdapterError(502, "SCHEMA_INVALID", "模型返回的内容不是有效 JSON。", true); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProviderAdapterError(502, "SCHEMA_INVALID", "模型输出未通过业务 Schema 校验。", true);
  return parsed.data;
}

function createOpenAiResponsesAdapter(options: ProviderAdapterOptions, baseUrl: string): ProviderAdapter {
  const { connection, timeoutMs = 30_000 } = options;
  const client = new OpenAI({ apiKey: options.apiKey || "credential-not-required", baseURL: baseUrl, timeout: timeoutMs, maxRetries: 0 });
  const adapter: ProviderAdapter = {
    provider: connection.provider,
    protocol: connection.protocol,
    endpointScope: connection.endpoint_scope,
    async generate<T>(input: AdapterGenerateInput<T>) {
      try {
        const response = await client.responses.parse({
          model: input.model,
          input: [
            { role: "system", content: `${input.systemPrompt}\n\n当前任务：${input.taskPrompt}` },
            { role: "user", content: JSON.stringify(input.input) },
          ],
          text: { format: zodTextFormat(input.schema, input.schemaName) },
        }, input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined);
        if (!response.output_parsed) {
          const serialized = JSON.stringify(response.output);
          const code = serialized.includes("refusal") ? "REFUSAL" : "SCHEMA_INVALID";
          throw new ProviderAdapterError(422, code, code === "REFUSAL" ? "模型拒绝处理当前输入。" : "模型未返回可校验的结构化结果。", code !== "REFUSAL");
        }
        const parsed = input.schema.safeParse(response.output_parsed);
        if (!parsed.success) throw new ProviderAdapterError(502, "SCHEMA_INVALID", "模型输出未通过业务 Schema 校验。", true);
        return { data: parsed.data, responseId: response.id, inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 };
      } catch (error) { throw mapProviderError(connection.provider, error); }
    },
    async verify(model) {
      await adapter.generate({ schema: VERIFY_SCHEMA, schemaName: "connection_test", systemPrompt: "Return JSON only.", taskPrompt: "Return {\"ok\":true}.", input: { synthetic: true }, model });
    },
  };
  return adapter;
}

function createAnthropicAdapter(options: ProviderAdapterOptions, baseUrl: string): ProviderAdapter {
  const { connection, timeoutMs = 30_000 } = options;
  const client = new Anthropic({ apiKey: options.apiKey, baseURL: baseUrl, timeout: timeoutMs, maxRetries: 0 });
  const adapter: ProviderAdapter = {
    provider: connection.provider,
    protocol: connection.protocol,
    endpointScope: connection.endpoint_scope,
    async generate<T>(input: AdapterGenerateInput<T>) {
      try {
        const response = await client.messages.parse({
          model: input.model,
          max_tokens: 4096,
          system: `${input.systemPrompt}\n\n当前任务：${input.taskPrompt}`,
          messages: [{ role: "user", content: JSON.stringify(input.input) }],
          output_config: { format: zodOutputFormat(input.schema) },
        }, input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined);
        if (response.stop_reason === "max_tokens") throw new ProviderAdapterError(422, "OUTPUT_TRUNCATED", "Anthropic 输出因 Token 上限被截断。", true);
        if (String(response.stop_reason) === "refusal") throw new ProviderAdapterError(422, "REFUSAL", "Anthropic 拒绝处理当前输入。", true);
        if (!response.parsed_output) throw new ProviderAdapterError(502, "SCHEMA_INVALID", "Anthropic 未返回可校验的结构化结果。", true);
        const parsed = input.schema.safeParse(response.parsed_output);
        if (!parsed.success) throw new ProviderAdapterError(502, "SCHEMA_INVALID", "Anthropic 输出未通过业务 Schema 校验。", true);
        return { data: parsed.data, responseId: response.id, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
      } catch (error) { throw mapProviderError(connection.provider, error); }
    },
    async verify(model) {
      await adapter.generate({ schema: VERIFY_SCHEMA, schemaName: "connection_test", systemPrompt: "Return JSON only.", taskPrompt: "Return {\"ok\":true}.", input: { synthetic: true }, model });
    },
  };
  return adapter;
}

function createRawCompatibleAdapter(options: ProviderAdapterOptions, baseUrl: string): ProviderAdapter {
  const { connection, timeoutMs = 30_000 } = options;
  const adapter: ProviderAdapter = {
    provider: connection.provider,
    protocol: connection.protocol,
    endpointScope: connection.endpoint_scope,
    async generate<T>(input: AdapterGenerateInput<T>) {
      const headers: Record<string, string> = { "content-type": "application/json", ...authHeaders(connection, options.apiKey) };
      if (input.idempotencyKey) headers["idempotency-key"] = input.idempotencyKey;
      const messages = [
        { role: "system", content: `${input.systemPrompt}\n\n当前任务：${input.taskPrompt}\n必须只返回 JSON。` },
        { role: "user", content: JSON.stringify(input.input) },
      ];
      const jsonSchema = z.toJSONSchema(input.schema);
      const isResponses = connection.protocol === "openai_responses";
      const body = isResponses
        ? { model: input.model, input: messages, text: { format: { type: "json_schema", name: input.schemaName, strict: true, schema: jsonSchema } } }
        : { model: input.model, messages, response_format: { type: "json_object" }, temperature: 0, max_tokens: 4096 };
      try {
        const response = await fetch(endpoint(baseUrl, isResponses ? "responses" : "chat/completions"), { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
        const raw = await response.text();
        if (!response.ok) throw mapStatus(connection.provider, response.status, raw);
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(raw) as Record<string, unknown>; }
        catch { throw new ProviderAdapterError(502, "SCHEMA_INVALID", "模型端点返回了无效 JSON 响应。", true); }
        if (payload.status === "incomplete" || (payload.incomplete_details as { reason?: unknown } | undefined)?.reason === "max_output_tokens") {
          throw new ProviderAdapterError(422, "OUTPUT_TRUNCATED", "模型输出因 Token 上限被截断。", true);
        }
        const message = (payload.choices as Array<{ message?: { content?: unknown; refusal?: unknown } }> | undefined)?.[0]?.message;
        if (message?.refusal || JSON.stringify(payload.output ?? []).includes('"type":"refusal"')) {
          throw new ProviderAdapterError(422, "REFUSAL", "模型拒绝处理当前输入。", true);
        }
        const text = isResponses
          ? responseText(payload)
          : String(message?.content ?? "");
        const data = parseStructured(input.schema, text);
        const usage = (payload.usage ?? {}) as { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
        return { data, responseId: String(payload.id ?? response.headers.get("x-request-id") ?? crypto.randomUUID()), inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0, outputTokens: usage.output_tokens ?? usage.completion_tokens ?? 0 };
      } catch (error) { throw mapProviderError(connection.provider, error); }
    },
    async verify(model) {
      await adapter.generate({ schema: VERIFY_SCHEMA, schemaName: "connection_test", systemPrompt: "Return JSON only.", taskPrompt: "Return {\"ok\":true}.", input: { synthetic: true }, model });
    },
  };
  return adapter;
}

export function createProviderAdapter(options: ProviderAdapterOptions): ProviderAdapter {
  const baseUrl = assertEndpointAllowed(options.connection, options.endpointAllowlist, options.allowLoopbackHttp);
  if (options.connection.auth_mode !== "none" && !options.apiKey) throw new ProviderAdapterError(503, "PROVIDER_AUTH_FAILED", "当前连接缺少可用凭据。", false);
  if (options.connection.protocol === "anthropic_messages") return createAnthropicAdapter(options, baseUrl);
  if (options.connection.provider === "custom") return createRawCompatibleAdapter(options, baseUrl);
  if (options.connection.protocol === "openai_chat") return createRawCompatibleAdapter(options, baseUrl);
  return createOpenAiResponsesAdapter(options, baseUrl);
}

export const PROVIDER_CATALOG = [
  { id: "openai" as const, label: "OpenAI", endpoint_scope: "public_cloud" as const, protocols: ["openai_responses" as const], base_urls: ["https://api.openai.com/v1"], model_presets: ["gpt-5.6", "gpt-5.6-terra"] },
  { id: "deepseek" as const, label: "DeepSeek", endpoint_scope: "public_cloud" as const, protocols: ["openai_responses" as const], base_urls: ["https://api.deepseek.com"], model_presets: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "anthropic" as const, label: "Anthropic", endpoint_scope: "public_cloud" as const, protocols: ["anthropic_messages" as const], base_urls: ["https://api.anthropic.com"], model_presets: ["claude-sonnet-4-5-20250929"] },
  { id: "qwen" as const, label: "Qwen", endpoint_scope: "public_cloud" as const, protocols: ["openai_responses" as const, "openai_chat" as const], base_urls: ["https://dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"], model_presets: ["qwen3.8-max", "qwen3.7-plus"] },
  { id: "custom" as const, label: "企业私有端点", endpoint_scope: "private" as const, protocols: ["openai_responses" as const, "openai_chat" as const], base_urls: [], model_presets: [] },
] as const;
