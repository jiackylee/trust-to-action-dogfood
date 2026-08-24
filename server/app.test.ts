// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { createFixtureState } from "../src/domain/fixtures";
import type { AiService } from "./ai-service";
import { AiServiceError, createOpenAiServiceManager } from "./ai-service";
import { createApp } from "./app";

const fixture = createFixtureState();
const meta = { model: "mock-openai", response_id: "resp_test", prompt_version: "test-v1", generated_at: new Date().toISOString() };

function service(overrides: Partial<AiService> = {}): AiService {
  return {
    configured: true,
    model: "mock-openai",
    weeklyStrategy: vi.fn(async () => ({ data: fixture.weekly_plan.strategy, meta })),
    contentDraft: vi.fn(async () => ({ data: { title: "草稿", stage: "T" as const, target_segment: "T0", objective: "建立信任", body: "正文", cta: "查看清单", expected_transition: "T0 → T1", evidence_refs: [], risk_flags: [], approval_required: false }, meta })),
    riskReview: vi.fn(async () => ({ data: { summary: "通过", risk_flags: [], claims: [], approval_recommended: false, suggested_revision: "" }, meta })),
    customerEvaluation: vi.fn(async (input: unknown) => { const { customer } = input as { customer: typeof fixture.customers[number] }; return { data: { ...customer.evaluation!, state_before: customer.state, state_after: customer.state, evidence_refs: [customer.evidence[0].id] }, meta }; }),
    conversationInsights: vi.fn(async () => ({ data: { insights: [{ title: "流程失控", category: "问题" as const, signal_type: "跟进遗漏", customer_segment: "销售团队", summary: "缺少统一跟进记录。", redacted_quotes: ["跟进主要依赖个人记录。"], message_refs: ["message-01-3"], conversation_refs: ["conv-01"], confidence: 82, evidence_strength: "medium" as const, recommended_angle: "建立最小跟进闭环" }], excluded_message_count: 0, analysis_note: "仅使用有效脱敏消息" }, meta })),
    contentBrief: vi.fn(async () => ({ data: { title: "最小跟进闭环", target_segment: "销售团队", stage: "T" as const, primary_angle: "不用增加字段也能开始", key_facts: ["统一负责人和复查时间"], proof_requirements: [], cta: "回复清单", due_at: "2026-08-25T10:00:00+08:00", insight_refs: ["insight-01"] }, meta })),
    weeklyRetrospective: vi.fn(async () => ({ data: fixture.weekly_retrospective.retrospective, meta })),
    ...overrides,
  };
}

let server: Server | null = null;
afterEach(() => new Promise<void>((resolve) => {
  if (!server) return resolve();
  const current = server;
  server = null;
  current.closeAllConnections?.();
  current.close(() => resolve());
}));

async function call(path: string, options: { body?: unknown; method?: string; headers?: Record<string, string> } = {}, aiService = service()) {
  const app = createApp({ aiService });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server address missing");
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  return fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: { ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

describe("AI BFF contracts", () => {
  it("returns health without exposing a key", async () => {
    const response = await call("/api/v2/health");
    expect(await response.json()).toEqual({ ok: true, ai_configured: true, model: "mock-openai", config_source: "environment", configured_at: null });
  });

  it("validates and enables an in-memory configuration without echoing the secret", async () => {
    const secret = "local-test-secret-that-must-never-be-returned";
    const verify = vi.fn(async () => undefined);
    const manager = createOpenAiServiceManager({ verify });
    const response = await call("/api/v2/ai/config", {
      body: { api_key: secret, model: "gpt-test" },
      headers: { "x-tta-local-config": "1", "x-tta-role": "operations" },
    }, manager);
    const serialized = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(serialized)).toMatchObject({ configured: true, model: "gpt-test", source: "runtime" });
    expect(serialized).not.toContain(secret);
    expect(verify).toHaveBeenCalledWith(secret, "gpt-test");
  });

  it("rejects configuration requests without the local UI header", async () => {
    const manager = createOpenAiServiceManager({ verify: vi.fn(async () => undefined) });
    const response = await call("/api/v2/ai/config", { body: { api_key: "local-test-secret-that-is-long-enough", model: "gpt-test" } }, manager);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "LOCAL_CONFIG_FORBIDDEN" } });
    expect(manager.getConfiguration().source).toBe("none");
  });

  it("rejects AI configuration from the sales role", async () => {
    const manager = createOpenAiServiceManager({ verify: vi.fn(async () => undefined) });
    const response = await call("/api/v2/ai/config", {
      body: { api_key: "role-test-secret-that-is-long-enough", model: "gpt-test" },
      headers: { "x-tta-local-config": "1", "x-tta-role": "sales" },
    }, manager);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "ROLE_FORBIDDEN" } });
  });

  it("preserves the working configuration when candidate validation fails", async () => {
    const verify = vi.fn(async () => { throw new AiServiceError(503, "OPENAI_AUTH_FAILED", "密钥无效", false); });
    const manager = createOpenAiServiceManager({ apiKey: "environment-test-secret-that-is-long-enough", model: "gpt-env", verify });
    const response = await call("/api/v2/ai/config", {
      body: { api_key: "invalid-test-secret-that-is-long-enough", model: "gpt-next" },
      headers: { "x-tta-local-config": "1", "x-tta-role": "lead" },
    }, manager);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "OPENAI_AUTH_FAILED" } });
    expect(manager.getConfiguration()).toMatchObject({ configured: true, model: "gpt-env", source: "environment" });
  });

  it("clears the runtime key and restores environment configuration", async () => {
    const verify = vi.fn(async () => undefined);
    const manager = createOpenAiServiceManager({ apiKey: "environment-test-secret-that-is-long-enough", model: "gpt-env", verify });
    await manager.configure("runtime-test-secret-that-is-long-enough", "gpt-runtime");
    const response = await call("/api/v2/ai/config", {
      method: "DELETE",
      headers: { "x-tta-local-config": "1", "x-tta-role": "operations" },
    }, manager);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: true, model: "gpt-env", source: "environment" });
    expect(manager.getConfiguration().source).toBe("environment");
  });

  it("returns structured weekly strategy metadata", async () => {
    const response = await call("/api/v2/ai/weekly-strategy", { body: { metrics: {}, customer_states: {}, drafts: [], proofs: [] } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { theme: fixture.weekly_plan.strategy.theme }, meta: { response_id: "resp_test" } });
  });

  it("maps a 429 into the explicit error contract", async () => {
    const ai = service({ weeklyStrategy: vi.fn(async () => { throw new AiServiceError(429, "OPENAI_RATE_LIMITED", "稍后重试", true); }) });
    const response = await call("/api/v2/ai/weekly-strategy", { body: { metrics: {}, customer_states: {}, drafts: [], proofs: [] } }, ai);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "OPENAI_RATE_LIMITED", retryable: true } });
  });

  it("blocks invalid model strategy ratios", async () => {
    const bad = { ...fixture.weekly_plan.strategy, ratio: { trust: 10, interest: 10, desire: 10, action: 10 } };
    const ai = service({ weeklyStrategy: vi.fn(async () => ({ data: bad, meta })) });
    const response = await call("/api/v2/ai/weekly-strategy", { body: { metrics: {}, customer_states: {}, drafts: [], proofs: [] } }, ai);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "POLICY_BLOCKED" } });
  });

  it("blocks low-quality customer evidence", async () => {
    const customer = fixture.customers.find((item) => item.state === "T0")!;
    const ai = service({ customerEvaluation: vi.fn(async () => ({ data: { ...customer.evaluation!, state_before: "T0" as const, state_after: "D1" as const, evidence_refs: [customer.evidence[0].id] }, meta })) });
    const response = await call("/api/v2/ai/customer-evaluation", { body: { customer } }, ai);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "POLICY_BLOCKED" } });
  });

  it("filters archive input and returns structured conversation insights", async () => {
    const messages = fixture.archived_messages.filter((item) => item.conversation_id === "conv-01");
    const consents = fixture.archive_consents.filter((item) => item.conversation_id === "conv-01");
    const ai = service();
    const response = await call("/api/v2/ai/conversation-insights", { body: { messages, consents } }, ai);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { insights: [{ message_refs: ["message-01-3"] }] }, meta: { response_id: "resp_test" } });
    expect(ai.conversationInsights).toHaveBeenCalledWith(expect.objectContaining({ messages: expect.arrayContaining([expect.objectContaining({ id: "message-01-3", redacted_text: expect.any(String) })]) }));
  });

  it("blocks unconsented archive analysis and unknown model references", async () => {
    const withdrawnMessages = fixture.archived_messages.filter((item) => item.conversation_id === "conv-09");
    const withdrawnConsent = fixture.archive_consents.filter((item) => item.conversation_id === "conv-09");
    const blocked = await call("/api/v2/ai/conversation-insights", { body: { messages: withdrawnMessages, consents: withdrawnConsent } });
    expect(blocked.status).toBe(422);
    expect(await blocked.json()).toMatchObject({ error: { code: "PRIVACY_POLICY_BLOCKED" } });

    const messages = fixture.archived_messages.filter((item) => item.conversation_id === "conv-01");
    const consents = fixture.archive_consents.filter((item) => item.conversation_id === "conv-01");
    const ai = service({ conversationInsights: vi.fn(async () => ({ data: { insights: [{ title: "越权引用", category: "问题" as const, signal_type: "测试", customer_segment: "测试", summary: "测试", redacted_quotes: ["测试"], message_refs: ["message-unknown"], conversation_refs: ["conv-01"], confidence: 90, evidence_strength: "strong" as const, recommended_angle: "测试" }], excluded_message_count: 0, analysis_note: "" }, meta })) });
    const unknown = await call("/api/v2/ai/conversation-insights", { body: { messages, consents } }, ai);
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toMatchObject({ error: { code: "UNKNOWN_ARCHIVE_REFERENCE" } });
  });

  it("allows Briefs only from accepted insights and returns a causal caveat in retrospectives", async () => {
    const accepted = fixture.conversation_insights.find((item) => item.status === "accepted")!;
    const brief = await call("/api/v2/ai/content-brief", { body: { accepted_insights: [accepted], historical_outcomes: fixture.content_outcomes } });
    expect(brief.status).toBe(200);
    const dismissed = fixture.conversation_insights.find((item) => item.status === "dismissed")!;
    const blocked = await call("/api/v2/ai/content-brief", { body: { accepted_insights: [dismissed], historical_outcomes: [] } });
    expect(blocked.status).toBe(422);
    expect(await blocked.json()).toMatchObject({ error: { code: "INSIGHT_NOT_ACCEPTED" } });

    const retrospective = await call("/api/v2/ai/weekly-retrospective", { body: { insights: fixture.conversation_insights, briefs: fixture.content_briefs, publications: fixture.publications, outcomes: fixture.content_outcomes } });
    expect(retrospective.status).toBe(200);
    expect(await retrospective.json()).toMatchObject({ data: { caveat: "时间关联，不代表因果" } });
  });
});
