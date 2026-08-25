import type { AiResult, ContentBriefProposal, ContentDraftProposal, ConversationInsights, CustomerEvaluation, RiskReview, WeeklyRetrospective, WeeklyStrategy } from "../domain/schemas";
import type { AiEndpointScope, AiProtocol, AiProviderId, ArchiveConsent, ArchivedMessage, ContentBrief, ContentOutcome, ConversationInsight, Customer, DomainState, Draft, EvaluationCandidate, GenerationRun, MarketingDecisionCandidate, MarketingTaskType, Proof, PublicationRecord, Role } from "../domain/types";
import { sessionClient } from "./session-client";

export class AiClientError extends Error {
  constructor(public code: string, message: string, public retryable: boolean, public requestId: string) {
    super(message);
  }
}

export interface AiHealth {
  ok: boolean;
  ai_configured: boolean;
  knowledge_configured?: boolean;
  provider: AiProviderId;
  protocol: AiProtocol;
  endpoint_scope: AiEndpointScope;
  connection_profile_id: string;
  model_profile_version_id: string;
  model: string;
  fallback_model: string | null;
  fast_model: string;
  fast_model_available: boolean;
  data_mode: string;
  session_warning: string | null;
  config_source: "environment" | "runtime" | "none";
  configured_at: string | null;
}

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
  source: AiHealth["config_source"];
  configured_at: string | null;
}

async function readResponse<T>(response: Response): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AiClientError("INVALID_SERVER_RESPONSE", "本地 AI 服务返回了无法识别的响应。", response.status >= 500, response.headers.get("x-request-id") ?? "unknown");
  }
  if (!response.ok) {
    const problem = (payload as { error?: { code?: string; message?: string; retryable?: boolean; request_id?: string } }).error;
    throw new AiClientError(
      problem?.code ?? "UNKNOWN",
      problem?.message ?? "AI 请求失败。",
      problem?.retryable ?? response.status >= 500,
      problem?.request_id ?? response.headers.get("x-request-id") ?? "unknown",
    );
  }
  return payload as T;
}

async function post<T>(path: string, body: unknown): Promise<AiResult<T>> {
  const csrf = await sessionClient.writeHeaders();
  const response = await fetch(`/api/v2/ai/${path}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...csrf }, body: JSON.stringify(body) });
  return readResponse<AiResult<T>>(response);
}

async function postRaw<T>(path: string, body: unknown): Promise<T> {
  const csrf = await sessionClient.writeHeaders();
  const response = await fetch(`/api/v2/ai/${path}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...csrf }, body: JSON.stringify(body) });
  return readResponse<T>(response);
}

export const aiClient = {
  health: async () => {
    const response = await fetch("/api/v2/health");
    return readResponse<AiHealth>(response);
  },
  async configure(apiKey: string, model: string, role: Role) {
    const csrf = await sessionClient.writeHeaders();
    const response = await fetch("/api/v2/ai/config", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-tta-local-config": "1", ...csrf },
      body: JSON.stringify({ api_key: apiKey, model }),
    });
    return readResponse<AiConfiguration>(response);
  },
  async clearRuntimeConfiguration(role: Role) {
    const csrf = await sessionClient.writeHeaders();
    const response = await fetch("/api/v2/ai/config", {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "x-tta-local-config": "1", ...csrf },
    });
    return readResponse<AiConfiguration>(response);
  },
  async createConnection(input: { name: string; provider: AiProviderId; endpoint_scope: AiEndpointScope; protocol: AiProtocol; base_url: string; region: string; auth_mode: "bearer" | "x-api-key" | "none"; credential_ref: string | null }) {
    const csrf = await sessionClient.writeHeaders();
    const response = await fetch("/api/v2/ai/connections", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-tta-local-config": "1", ...csrf }, body: JSON.stringify(input) });
    return readResponse<DomainState>(response);
  },
  async createModelProfile(input: { name: string; connection_profile_id: string; primary_model: string; fallback_model: string | null }) {
    const csrf = await sessionClient.writeHeaders();
    const response = await fetch("/api/v2/ai/model-profiles", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-tta-local-config": "1", ...csrf }, body: JSON.stringify(input) });
    return readResponse<DomainState>(response);
  },
  async testConnection(connectionId: string, profileId: string, apiKey: string, expectedRevision: number) {
    const csrf = await sessionClient.writeHeaders();
    const response = await fetch(`/api/v2/ai/connections/${connectionId}/test`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-tta-local-config": "1", ...csrf }, body: JSON.stringify({ profile_id: profileId, api_key: apiKey || undefined, expected_revision: expectedRevision }) });
    return readResponse<DomainState>(response);
  },
  async clearConnectionSecret(connectionId: string) {
    const csrf = await sessionClient.writeHeaders();
    const response = await fetch(`/api/v2/ai/connections/${connectionId}/runtime-secret`, { method: "DELETE", credentials: "same-origin", headers: { "x-tta-local-config": "1", ...csrf } });
    return readResponse<DomainState>(response);
  },
  async runProfileSmoke(profileId: string, expectedRevision: number) {
    const csrf = await sessionClient.writeHeaders();
    const response = await fetch(`/api/v2/ai/model-profiles/${profileId}/smoke`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-tta-local-config": "1", ...csrf }, body: JSON.stringify({ expected_revision: expectedRevision }) });
    return readResponse<DomainState>(response);
  },
  async activateProfile(profileId: string, expectedRevision: number, dataEgressAcknowledged: boolean) {
    const csrf = await sessionClient.writeHeaders();
    const response = await fetch(`/api/v2/ai/model-profiles/${profileId}/activate`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-tta-local-config": "1", ...csrf }, body: JSON.stringify({ expected_revision: expectedRevision, data_egress_acknowledged: dataEgressAcknowledged }) });
    return readResponse<DomainState>(response);
  },
  async rollbackProfile(profileId: string) {
    const csrf = await sessionClient.writeHeaders();
    const response = await fetch(`/api/v2/ai/model-profiles/${profileId}/rollback`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-tta-local-config": "1", ...csrf }, body: "{}" });
    return readResponse<DomainState>(response);
  },
  async runProfileHoldout(profileId: string) {
    const csrf = await sessionClient.writeHeaders();
    const response = await fetch(`/api/v2/ai/model-profiles/${profileId}/holdout`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...csrf }, body: JSON.stringify({ usage_confirmed: true, idempotency_key: `profile-holdout-${profileId}-${crypto.randomUUID()}` }) });
    return readResponse<DomainState>(response);
  },
  weeklyStrategy(input: unknown) { return post<WeeklyStrategy>("weekly-strategy", input); },
  contentDraft(strategy: WeeklyStrategy, proofs: Proof[], stage: string, brief?: ContentBrief, acceptedInsights?: ConversationInsight[], historicalOutcomes?: ContentOutcome[]) { return post<ContentDraftProposal>("content-draft", { strategy, proofs, stage, brief, accepted_insights: acceptedInsights ?? [], historical_outcomes: historicalOutcomes ?? [] }); },
  riskReview(draft: Draft, proofs: Proof[]) { return post<RiskReview>("risk-review", { draft, proofs }); },
  customerEvaluation(customer: Customer) {
    return postRaw<{ candidate: EvaluationCandidate; run: GenerationRun }>("customer-evaluation", { customer_id: customer.id, customer_revision: customer.revision, idempotency_key: `customer-eval-${customer.id}-${customer.revision}-${crypto.randomUUID()}` });
  },
  customerEvaluationBatch(customerIds: string[]) {
    return postRaw<{ results: Array<{ customer_id: string; candidate?: EvaluationCandidate; run?: GenerationRun; error?: { code: string; message: string; retryable: boolean } }> }>("customer-evaluations/batch", { customer_ids: customerIds.slice(0, 10), idempotency_key: `customer-batch-${crypto.randomUUID()}` });
  },
  conversationInsights(messages: ArchivedMessage[], consents: ArchiveConsent[]) { return post<ConversationInsights>("conversation-insights", { messages, consents }); },
  contentBrief(insights: ConversationInsight[], historicalOutcomes: ContentOutcome[]) { return post<ContentBriefProposal>("content-brief", { accepted_insights: insights, historical_outcomes: historicalOutcomes }); },
  weeklyRetrospective(insights: ConversationInsight[], briefs: ContentBrief[], publications: PublicationRecord[], outcomes: ContentOutcome[]) { return post<WeeklyRetrospective>("weekly-retrospective", { insights, briefs, publications, outcomes }); },
  async marketingCandidate(taskType: MarketingTaskType, subjectId: string, subjectRevision: number, query: string, payload: Record<string, unknown>, market = "china") {
    const csrf = await sessionClient.writeHeaders();
    const response = await fetch("/api/v2/marketing/candidates/generate", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...csrf }, body: JSON.stringify({ task_type: taskType, subject_id: subjectId, subject_revision: subjectRevision, query, payload, market, idempotency_key: `${taskType}-${subjectId}-${subjectRevision}-${crypto.randomUUID()}` }) });
    return readResponse<{ candidate: MarketingDecisionCandidate }>(response);
  },
};
