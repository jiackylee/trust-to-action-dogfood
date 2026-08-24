import type { AiResult, ContentBriefProposal, ContentDraftProposal, ConversationInsights, CustomerEvaluation, RiskReview, WeeklyRetrospective, WeeklyStrategy } from "../domain/schemas";
import type { ArchiveConsent, ArchivedMessage, ContentBrief, ContentOutcome, ConversationInsight, Customer, Draft, EvaluationCandidate, GenerationRun, Proof, PublicationRecord, Role } from "../domain/types";
import { sessionClient } from "./session-client";

export class AiClientError extends Error {
  constructor(public code: string, message: string, public retryable: boolean, public requestId: string) {
    super(message);
  }
}

export interface AiHealth {
  ok: boolean;
  ai_configured: boolean;
  model: string;
  fast_model: string;
  fast_model_available: boolean;
  data_mode: string;
  session_warning: string | null;
  config_source: "environment" | "runtime" | "none";
  configured_at: string | null;
}

export interface AiConfiguration {
  configured: boolean;
  model: string;
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
};
