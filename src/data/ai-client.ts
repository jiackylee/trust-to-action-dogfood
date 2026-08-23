import type { AiResult, ContentDraftProposal, CustomerEvaluation, RiskReview, WeeklyStrategy } from "../domain/schemas";
import type { Customer, Draft, Proof, Role } from "../domain/types";

export class AiClientError extends Error {
  constructor(public code: string, message: string, public retryable: boolean, public requestId: string) {
    super(message);
  }
}

export interface AiHealth {
  ok: boolean;
  ai_configured: boolean;
  model: string;
  config_source: "environment" | "runtime" | "none";
  configured_at: string | null;
}

export interface AiConfiguration {
  configured: boolean;
  model: string;
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
  const response = await fetch(`/api/v2/ai/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return readResponse<AiResult<T>>(response);
}

export const aiClient = {
  health: async () => {
    const response = await fetch("/api/v2/health");
    return readResponse<AiHealth>(response);
  },
  async configure(apiKey: string, model: string, role: Role) {
    const response = await fetch("/api/v2/ai/config", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tta-local-config": "1", "x-tta-role": role },
      body: JSON.stringify({ api_key: apiKey, model }),
    });
    return readResponse<AiConfiguration>(response);
  },
  async clearRuntimeConfiguration(role: Role) {
    const response = await fetch("/api/v2/ai/config", {
      method: "DELETE",
      headers: { "x-tta-local-config": "1", "x-tta-role": role },
    });
    return readResponse<AiConfiguration>(response);
  },
  weeklyStrategy(input: unknown) { return post<WeeklyStrategy>("weekly-strategy", input); },
  contentDraft(strategy: WeeklyStrategy, proofs: Proof[], stage: string) { return post<ContentDraftProposal>("content-draft", { strategy, proofs, stage }); },
  riskReview(draft: Draft, proofs: Proof[]) { return post<RiskReview>("risk-review", { draft, proofs }); },
  customerEvaluation(customer: Customer) { return post<CustomerEvaluation>("customer-evaluation", { customer }); },
};
