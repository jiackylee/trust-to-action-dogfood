import { describe, expect, it } from "vitest";
import { createFixtureState } from "../domain/fixtures";
import { canAccessCustomer } from "../domain/permissions";
import { StateDataClient } from "./client";

function salesClient() {
  const state = createFixtureState();
  const createdAt = new Date(Date.now() - 60 * 60_000).toISOString();
  state.evaluation_candidates = state.evaluation_candidates.map((item) => item.status === "pending" ? { ...item, created_at: createdAt, expires_at: new Date(Date.now() + 47 * 60 * 60_000).toISOString() } : item);
  return new StateDataClient({ initialState: { ...state, role: "sales" } });
}

async function reviewableCandidate(client: StateDataClient) {
  const state = await client.getState();
  const candidate = state.evaluation_candidates.find((item) => item.status === "pending" && canAccessCustomer("sales", state.customers.find((customer) => customer.id === item.customer_id)!))!;
  return { state, candidate, customer: state.customers.find((item) => item.id === candidate.customer_id)! };
}

describe("evaluation candidate decisions", () => {
  it("writes customer state only after an original sales adoption", async () => {
    const client = salesClient();
    const { candidate, customer } = await reviewableCandidate(client);
    const decided = await client.decideEvaluationCandidate(customer.id, candidate.id, "accepted", null, null, "", customer.revision);
    expect(decided.evaluation_candidates.find((item) => item.id === candidate.id)).toMatchObject({ status: "accepted", decision_id: expect.any(String) });
    expect(decided.evaluation_decisions[0]).toMatchObject({ candidate_id: candidate.id, decision: "accepted", reviewed_within_48h: true, reason_code: null });
    expect(decided.customers.find((item) => item.id === customer.id)).toMatchObject({ state: candidate.evaluation.state_after, confidence: candidate.evaluation.confidence, revision: customer.revision + 1 });
  });

  it("requires structured reasons for modified or rejected output", async () => {
    const client = salesClient();
    const { candidate, customer } = await reviewableCandidate(client);
    await expect(client.decideEvaluationCandidate(customer.id, candidate.id, "rejected", null, null, "", customer.revision)).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await expect(client.decideEvaluationCandidate(customer.id, candidate.id, "modified", candidate.evaluation, "other", "", customer.revision)).rejects.toMatchObject({ code: "REASON_NOTE_REQUIRED" });
  });

  it("expires a candidate immediately after customer context changes", async () => {
    const client = salesClient();
    const { candidate, customer } = await reviewableCandidate(client);
    await client.addCustomerNote(customer.id, "客户补充了新的实施窗口。", customer.revision);
    await expect(client.decideEvaluationCandidate(customer.id, candidate.id, "accepted", null, null, "", customer.revision + 1)).rejects.toMatchObject({ status: 409, code: "STALE_EVALUATION_CANDIDATE" });
  });

  it("records quality reversal separately from normal new-evidence movement", async () => {
    const client = salesClient();
    const { candidate, customer } = await reviewableCandidate(client);
    const accepted = await client.decideEvaluationCandidate(customer.id, candidate.id, "accepted", null, null, "", customer.revision);
    const decision = accepted.evaluation_decisions[0];
    const reviewed = await client.recordEvaluationReview(decision.id, "new_evidence", "客户主动询问价格，新增强证据。", decision.revision);
    expect(reviewed.evaluation_decisions.find((item) => item.id === decision.id)).toMatchObject({ review_outcome: "new_evidence", review_reason: expect.stringContaining("新增强证据") });
    expect(reviewed.audits[0].action).toBe("新增证据推动后续变化");
  });
});

describe("AI version governance", () => {
  it("creates an atomic marketing-brain candidate when knowledge or code hashes change", async () => {
    const initial = createFixtureState();
    const published = initial.marketing_brain_versions.find((item) => item.status === "published")!;
    const nextPack = { ...initial.knowledge_pack_versions[0], id: "knowledge-next", name: "private-pack-next", status: "active" as const };
    const hashes = { weekly_strategy: "code-weekly-next", content_brief: "code-brief-next", content_draft: "code-draft-next", customer_nba: "code-nba-next" };
    const client = new StateDataClient({ initialState: initial });

    const synced = await client.syncKnowledgeCatalog([nextPack], initial.knowledge_sources, initial.knowledge_retrieval_runs, hashes);
    expect(synced.marketing_brain_versions.find((item) => item.id === published.id)).toMatchObject({ status: "published", knowledge_pack_version_id: published.knowledge_pack_version_id, prompt_hashes: published.prompt_hashes });
    expect(synced.marketing_brain_versions).toEqual(expect.arrayContaining([expect.objectContaining({ status: "draft", knowledge_pack_version_id: nextPack.id, prompt_hashes: hashes })]));
    expect(synced.marketing_candidates.some((item) => item.status === "stale")).toBe(true);
  });

  it("evaluates a code-bound marketing brain and reserves release and rollback for the lead", async () => {
    const client = new StateDataClient({ initialState: createFixtureState() });
    const state = await client.getState();
    const brain = state.marketing_brain_versions.find((item) => item.id === "brain-v2.2-rc2")!;
    const router = state.router_versions.find((item) => item.id === "router-v2.1-rc1")!;
    expect(brain.prompt_hashes).toMatchObject({ weekly_strategy: expect.stringContaining("code-") });
    await client.runGoldenEvaluation(brain.id, router.id, "holdout");
    await expect(client.promoteAiVersion("brain", brain.id, brain.revision)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    await client.setRole("lead");
    const promoted = await client.promoteAiVersion("brain", brain.id, brain.revision);
    expect(promoted.marketing_brain_versions.find((item) => item.id === brain.id)?.status).toBe("published");
    const previous = promoted.marketing_brain_versions.find((item) => item.id === "brain-v2.2-published")!;
    expect(previous.status).toBe("archived");
    const rolledBack = await client.rollbackAiVersion("brain", previous.id, previous.revision);
    expect(rolledBack.marketing_brain_versions.find((item) => item.id === previous.id)?.status).toBe("published");
    expect(rolledBack.marketing_brain_versions.find((item) => item.id === brain.id)?.status).toBe("archived");
  });

  it("blocks release before a qualifying locked Holdout run", async () => {
    const client = new StateDataClient({ initialState: { ...createFixtureState(), role: "lead" } });
    const brain = (await client.getState()).marketing_brain_versions.find((item) => item.id === "brain-v2.2-rc2")!;
    await expect(client.promoteAiVersion("brain", brain.id, brain.revision)).rejects.toMatchObject({ code: "QUALITY_GATE_BLOCKED" });
  });
});
