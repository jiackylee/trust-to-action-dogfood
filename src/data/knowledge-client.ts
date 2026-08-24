import type { KnowledgePackVersion, KnowledgeReference, KnowledgeRetrievalRun, KnowledgeSource, MarketingTaskType } from "../domain/types";
import { AiClientError } from "./ai-client";
import { sessionClient } from "./session-client";

export interface KnowledgeStatus {
  configured: boolean;
  pack_path: string | null;
  active_version: KnowledgePackVersion | null;
  versions: KnowledgePackVersion[];
  sources: KnowledgeSource[];
  unresolved_sources: KnowledgeSource[];
  duplicate_sources: KnowledgeSource[];
  recent_retrievals: KnowledgeRetrievalRun[];
  error: { code: string; message: string } | null;
}

async function read<T>(response: Response): Promise<T> {
  const payload = await response.json() as { error?: { code: string; message: string; retryable: boolean; request_id: string } };
  if (!response.ok) throw new AiClientError(payload.error?.code ?? "UNKNOWN", payload.error?.message ?? "知识服务请求失败。", payload.error?.retryable ?? false, payload.error?.request_id ?? "unknown");
  return payload as T;
}

async function post<T>(path: string, body: unknown = {}) {
  const csrf = await sessionClient.writeHeaders();
  return read<T>(await fetch(`/api/v2/knowledge/${path}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...csrf }, body: JSON.stringify(body) }));
}

export const knowledgeClient = {
  async status() { return read<KnowledgeStatus>(await fetch("/api/v2/knowledge/status", { credentials: "same-origin" })); },
  reindex() { return post<KnowledgeStatus>("reindex"); },
  activate(id: string) { return post<KnowledgeStatus>(`versions/${id}/activate`); },
  rollback() { return post<KnowledgeStatus>("rollback"); },
  preview(task_type: MarketingTaskType, query: string, market = "china") {
    return post<{ references: KnowledgeReference[]; skill_route: string[]; conflicts: string[]; run: KnowledgeRetrievalRun }>("retrieval-preview", { task_type, query, market });
  },
};
