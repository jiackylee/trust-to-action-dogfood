// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ConfigurableAiService } from "./ai-service";
import { restorePersistedModelProfile } from "./model-profile-runtime";
import { SqliteStateRepository } from "./repository";

function service(): ConfigurableAiService {
  return {
    configured: false, model: "none", getConfiguration: vi.fn(() => ({ configured: false, provider: "openai", protocol: "openai_responses", endpoint_scope: "public_cloud", connection_profile_id: "none", model_profile_version_id: "none", model: "none", fallback_model: null, fast_model: "none", fast_model_available: false, source: "none", configured_at: null })),
    configure: vi.fn(), resetRuntimeConfiguration: vi.fn(), testConnection: vi.fn(), runSmoke: vi.fn(), activateProfile: vi.fn(), clearRuntimeSecret: vi.fn(),
    weeklyStrategy: vi.fn(), contentDraft: vi.fn(), riskReview: vi.fn(), customerEvaluation: vi.fn(), conversationInsights: vi.fn(), contentBrief: vi.fn(), weeklyRetrospective: vi.fn(),
  } as unknown as ConfigurableAiService;
}

describe("persisted model Profile restore", () => {
  it("marks a runtime-only active Profile credential_missing after restart", () => {
    const repository = new SqliteStateRepository(":memory:");
    const ai = service();
    expect(restorePersistedModelProfile(repository, ai, "tenant-dogfood-cn", {})).toBe("credential_missing");
    const state = repository.load("tenant-dogfood-cn").state;
    expect(state.model_profiles.find((item) => item.id === "model-profile-openai")?.status).toBe("credential_missing");
    expect(ai.activateProfile).not.toHaveBeenCalled();
    repository.close();
  });

  it("restores the same provider when its environment reference is available", () => {
    const repository = new SqliteStateRepository(":memory:");
    const ai = service();
    expect(restorePersistedModelProfile(repository, ai, "tenant-dogfood-cn", { OPENAI_API_KEY: "server-only-test-key" })).toBe("restored");
    expect(ai.activateProfile).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai" }), expect.objectContaining({ primary_model: "gpt-5.6" }));
    expect(repository.load("tenant-dogfood-cn").state.provider_connections.find((item) => item.id === "connection-openai")).toMatchObject({ credential_source: "environment", credential_available: true });
    repository.close();
  });
});
