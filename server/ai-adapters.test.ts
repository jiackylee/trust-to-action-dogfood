// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFixtureState } from "../src/domain/fixtures";
import type { AiProviderId, ProviderConnectionProfile } from "../src/domain/types";
import { assertEndpointAllowed, createProviderAdapter, ProviderAdapterError } from "./ai-adapters";

function connection(overrides: Partial<ProviderConnectionProfile> = {}): ProviderConnectionProfile {
  return {
    id: "connection-test", revision: 1, updated_at: new Date().toISOString(), tenant_id: "tenant-dogfood-cn", name: "测试连接",
    provider: "custom", endpoint_scope: "private", protocol: "openai_chat", base_url: "http://127.0.0.1:8000/v1", region: "enterprise-local", auth_mode: "none",
    credential_source: "none", credential_ref: null, credential_available: true,
    capabilities: { structured_output: false, native_json_schema: false, refusal_signal: false, usage_reporting: false, request_id: false, tested_at: null, notes: [] },
    last_tested_at: null, last_error_code: null, created_by: "测试", ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("provider adapter endpoint policy", () => {
  it.each([
    "https://user:secret@models.example.com/v1",
    "https://models.example.com/v1?key=secret",
    "https://models.example.com/v1#secret",
    "https://169.254.169.254/v1",
    "https://metadata.google.internal/v1",
    "https://100.100.100.200/v1",
  ])("blocks credential and metadata endpoint %s", (baseUrl) => {
    expect(() => assertEndpointAllowed(connection({ base_url: baseUrl }), [new URL(baseUrl).hostname])).toThrowError(expect.objectContaining({ code: "ENDPOINT_BLOCKED" }));
  });

  it("requires allowlisting for private non-loopback hosts", () => {
    expect(() => assertEndpointAllowed(connection({ base_url: "https://models.corp.example/v1" }))).toThrowError(expect.objectContaining({ code: "ENDPOINT_BLOCKED" }));
    expect(assertEndpointAllowed(connection({ base_url: "https://models.corp.example/v1" }), ["models.corp.example"])).toBe("https://models.corp.example/v1");
  });

  it("allows loopback HTTP only outside production", () => {
    expect(assertEndpointAllowed(connection(), [], true)).toBe("http://127.0.0.1:8000/v1");
    expect(() => assertEndpointAllowed(connection(), [], false)).toThrowError(expect.objectContaining({ code: "ENDPOINT_BLOCKED" }));
  });
});

describe("provider adapter protocols", () => {
  it.each([
    ["openai", "openai_responses", "https://api.openai.com/v1"],
    ["deepseek", "openai_responses", "https://api.deepseek.com"],
    ["anthropic", "anthropic_messages", "https://api.anthropic.com"],
    ["qwen", "openai_responses", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
  ] as const)("creates the %s %s adapter", (provider, protocol, baseUrl) => {
    const adapter = createProviderAdapter({ connection: connection({ provider, protocol, base_url: baseUrl, endpoint_scope: "public_cloud", auth_mode: provider === "anthropic" ? "x-api-key" : "bearer" }), apiKey: "test-provider-credential" });
    expect(adapter).toMatchObject({ provider, protocol, endpointScope: "public_cloud" });
  });

  it("parses Chat JSON and normalizes token usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "chat-1", choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }), { status: 200, headers: { "content-type": "application/json" } })));
    const adapter = createProviderAdapter({ connection: connection() });
    const result = await adapter.generate({ schema: z.object({ ok: z.literal(true) }), schemaName: "ok", systemPrompt: "test", taskPrompt: "test", input: {}, model: "enterprise-test" });
    expect(result).toEqual({ data: { ok: true }, responseId: "chat-1", inputTokens: 12, outputTokens: 4 });
  });

  it("maps empty Responses output, refusal and truncation to stable errors", async () => {
    const payloads = [
      [{ id: "resp-empty", output: [], usage: {} }, "SCHEMA_INVALID"],
      [{ id: "resp-refusal", output: [{ content: [{ type: "refusal", refusal: "no" }] }], usage: {} }, "REFUSAL"],
      [{ id: "resp-cut", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: {} }, "OUTPUT_TRUNCATED"],
    ] as const;
    const adapter = createProviderAdapter({ connection: connection({ protocol: "openai_responses" }) });
    for (const [payload, code] of payloads) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })));
      await expect(adapter.generate({ schema: z.object({ ok: z.literal(true) }), schemaName: "ok", systemPrompt: "test", taskPrompt: "test", input: {}, model: "enterprise-test" })).rejects.toMatchObject({ code });
    }
  });

  it("never requires a public-provider SDK object in the business result", async () => {
    const state = createFixtureState();
    const providers = new Set<AiProviderId>(state.generation_runs.map((item) => item.provider ?? "openai"));
    expect([...providers].sort()).toEqual(["anthropic", "custom", "deepseek", "openai", "qwen"]);
    expect(state.generation_runs.every((item) => item.attempts.every((attempt) => !Object.hasOwn(attempt, "sdk")))).toBe(true);
  });
});

describe("adapter error type", () => {
  it("keeps normalized retryability without exposing credentials", () => {
    const error = new ProviderAdapterError(429, "RATE_LIMITED", "请求过于频繁", true);
    expect(error).toMatchObject({ status: 429, code: "RATE_LIMITED", retryable: true });
    expect(JSON.stringify(error)).not.toContain("credential");
  });
});
