// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AiProtocol, AiProviderId, ProviderConnectionProfile } from "../src/domain/types";
import { createProviderAdapter } from "./ai-adapters";

interface LiveProviderCase {
  name: string;
  flag: string;
  provider: AiProviderId;
  protocol: AiProtocol;
  baseUrl: string;
  modelEnv: string;
  defaultModel: string;
  keyEnv: string;
  authMode: "bearer" | "x-api-key";
}

const cases: LiveProviderCase[] = [
  { name: "OpenAI", flag: "RUN_LIVE_OPENAI_TEST", provider: "openai", protocol: "openai_responses", baseUrl: "https://api.openai.com/v1", modelEnv: "OPENAI_MODEL", defaultModel: "gpt-5.6", keyEnv: "OPENAI_API_KEY", authMode: "bearer" },
  { name: "DeepSeek", flag: "RUN_LIVE_DEEPSEEK_TEST", provider: "deepseek", protocol: "openai_responses", baseUrl: "https://api.deepseek.com", modelEnv: "DEEPSEEK_MODEL", defaultModel: "deepseek-chat", keyEnv: "DEEPSEEK_API_KEY", authMode: "bearer" },
  { name: "Anthropic", flag: "RUN_LIVE_ANTHROPIC_TEST", provider: "anthropic", protocol: "anthropic_messages", baseUrl: "https://api.anthropic.com", modelEnv: "ANTHROPIC_MODEL", defaultModel: "claude-sonnet-4-5-20250929", keyEnv: "ANTHROPIC_API_KEY", authMode: "x-api-key" },
  { name: "Qwen", flag: "RUN_LIVE_QWEN_TEST", provider: "qwen", protocol: "openai_responses", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", modelEnv: "QWEN_MODEL", defaultModel: "qwen3.8-max", keyEnv: "DASHSCOPE_API_KEY", authMode: "bearer" },
];

function connection(item: LiveProviderCase): ProviderConnectionProfile {
  return {
    id: `live-${item.provider}`, revision: 1, updated_at: new Date().toISOString(), tenant_id: "tenant-live-synthetic", name: `${item.name} live smoke`, provider: item.provider,
    endpoint_scope: "public_cloud", protocol: item.protocol, base_url: item.baseUrl, region: "declared-by-provider", auth_mode: item.authMode,
    credential_source: "environment", credential_ref: item.keyEnv, credential_available: true,
    capabilities: { structured_output: false, native_json_schema: false, refusal_signal: false, usage_reporting: false, request_id: false, tested_at: null, notes: [] },
    last_tested_at: null, last_error_code: null, created_by: "live-test",
  };
}

describe("explicit live provider connection smoke", () => {
  for (const item of cases) {
    const liveIt = process.env[item.flag] === "1" ? it : it.skip;
    liveIt(`${item.name} returns the minimal structured schema`, async () => {
      const apiKey = process.env[item.keyEnv];
      if (!apiKey) throw new Error(`${item.keyEnv} is required when ${item.flag}=1`);
      const adapter = createProviderAdapter({ connection: connection(item), apiKey });
      await expect(adapter.verify(process.env[item.modelEnv] ?? item.defaultModel)).resolves.toBeUndefined();
    }, 45_000);
  }
});
