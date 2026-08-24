// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureState } from "../src/domain/fixtures";
import type { AiService } from "./ai-service";
import { bindDemoStateToActiveKnowledge, createApp } from "./app";
import { KnowledgeService } from "./knowledge-service";
import { MARKETING_PROMPT_HASHES } from "./prompts";
import { SqliteStateRepository } from "./repository";

const fixture = createFixtureState();
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function createPack() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tta-marketing-pack-"));
  const sources = ["enterprise-wechat-friend-marketing", "marketing-growth-system"];
  for (const source of sources) {
    const directory = path.join(root, "skills", source);
    fs.mkdirSync(directory, { recursive: true });
    const paragraph = source.includes("wechat")
      ? "企微策略必须引用有效业务证据，授权、频控和证明审批优先，禁止自动外发。客户分组与下一动作必须可追溯。"
      : "进攻型增长聚焦窄市场，提高内容密度，快速运行可测实验，再放大已经验证的有效组合。";
    fs.writeFileSync(path.join(directory, "SKILL.md"), `# ${source}\n\n## 策略与门禁\n\n${Array(24).fill(paragraph).join("\n\n")}`, "utf8");
  }
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function service(): AiService {
  const meta = { model: "gpt-5.6", response_id: "response-marketing-test", prompt_version: "code-test", generated_at: new Date().toISOString(), latency_ms: 1200 };
  return {
    configured: true, model: "gpt-5.6", fastModel: "gpt-5.6-terra",
    weeklyStrategy: vi.fn(async () => ({ data: fixture.weekly_plan.strategy, meta })),
    contentDraft: vi.fn(async () => ({ data: { title: fixture.drafts[0].title, stage: fixture.drafts[0].stage, target_segment: fixture.drafts[0].segment, objective: fixture.drafts[0].objective, body: fixture.drafts[0].body, cta: fixture.drafts[0].cta, expected_transition: fixture.drafts[0].expected_transition, evidence_refs: fixture.drafts[0].evidence_refs, risk_flags: [], approval_required: false }, meta })),
    customerEvaluation: vi.fn(async (input: unknown) => { const customer = (input as { customer: typeof fixture.customers[number] }).customer; return { data: { ...customer.evaluation!, state_before: customer.state, state_after: customer.state, evidence_refs: customer.evidence.filter((item) => item.valid).slice(0, 1).map((item) => item.id) }, meta }; }),
    contentBrief: vi.fn(async () => ({ data: { title: fixture.content_briefs[0].title, target_segment: fixture.content_briefs[0].target_segment, stage: fixture.content_briefs[0].stage, primary_angle: fixture.content_briefs[0].primary_angle, key_facts: fixture.content_briefs[0].key_facts, proof_requirements: fixture.content_briefs[0].proof_requirements, cta: fixture.content_briefs[0].cta, due_at: fixture.content_briefs[0].due_at, insight_refs: fixture.content_briefs[0].insight_ids }, meta })),
    riskReview: vi.fn(async () => ({ data: { summary: "", risk_flags: [], claims: [], approval_recommended: false, suggested_revision: "" }, meta })),
    conversationInsights: vi.fn(async () => ({ data: { insights: [], excluded_message_count: 0, analysis_note: "" }, meta })),
    weeklyRetrospective: vi.fn(async () => ({ data: fixture.weekly_retrospective.retrospective, meta })),
  };
}

async function open(knowledgeService: KnowledgeService, repository = new SqliteStateRepository(":memory:")) {
  cleanup.push(() => repository.close());
  const app = createApp({ aiService: service(), knowledgeService, repository });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const root = `http://127.0.0.1:${address.port}`;
  const sessionResponse = await fetch(`${root}/api/v2/session`);
  const cookie = sessionResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
  const session = await sessionResponse.json() as { csrf_token: string };
  const request = (url: string, body: unknown) => fetch(`${root}${url}`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": session.csrf_token }, body: JSON.stringify(body) });
  return { root, cookie, request };
}

describe("marketing brain contracts", () => {
  it("rebinds reset-only synthetic candidates to the active local knowledge pack", () => {
    const knowledge = new KnowledgeService({ packPath: createPack() });
    cleanup.push(() => knowledge.close());
    const indexed = knowledge.reindex("tenant-dogfood-cn");
    knowledge.activate("tenant-dogfood-cn", indexed.version.id);
    const bound = bindDemoStateToActiveKnowledge(createFixtureState(), "tenant-dogfood-cn", knowledge);
    const pending = bound.marketing_candidates.filter((item) => item.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((item) => item.envelope.knowledge_pack_version === indexed.version.id && item.envelope.knowledge_refs.length > 0)).toBe(true);
    expect(bound.marketing_brain_versions.find((item) => item.status === "published")?.prompt_hashes).toEqual(MARKETING_PROMPT_HASHES);
  });

  it("blocks generation when private knowledge is not configured", async () => {
    const knowledge = new KnowledgeService({ packPath: null });
    cleanup.push(() => knowledge.close());
    const client = await open(knowledge);
    const response = await client.request("/api/v2/marketing/candidates/generate", { task_type: "weekly_strategy", subject_id: "weekly-plan", subject_revision: 1, query: "企微周策略客户分组", payload: {}, market: "china", idempotency_key: "knowledge-missing-contract" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "KNOWLEDGE_NOT_CONFIGURED" } });
  });

  it("persists a cited candidate and requires review before writing", async () => {
    const knowledge = new KnowledgeService({ packPath: createPack() });
    cleanup.push(() => knowledge.close());
    const indexed = knowledge.reindex("tenant-dogfood-cn");
    knowledge.activate("tenant-dogfood-cn", indexed.version.id);
    const repository = new SqliteStateRepository(":memory:");
    const loaded = repository.load("tenant-dogfood-cn");
    const state = loaded.state;
    const publishedBrain = state.marketing_brain_versions.find((item) => item.status === "published")!;
    repository.save("tenant-dogfood-cn", {
      ...state,
      knowledge_pack_versions: knowledge.status("tenant-dogfood-cn").versions,
      knowledge_sources: knowledge.status("tenant-dogfood-cn").sources,
      marketing_brain_versions: state.marketing_brain_versions.map((item) => item.id === publishedBrain.id ? { ...item, knowledge_pack_version_id: indexed.version.id, prompt_hashes: MARKETING_PROMPT_HASHES } : item),
    }, loaded.repositoryRevision);
    const client = await open(knowledge, repository);
    const generated = await client.request("/api/v2/marketing/candidates/generate", { task_type: "weekly_strategy", subject_id: "weekly-plan", subject_revision: 1, query: "企微策略客户分组窄市场证据门禁", payload: {}, market: "china", idempotency_key: "marketing-candidate-contract" });
    expect(generated.status).toBe(200);
    const body = await generated.json() as { candidate: { id: string; envelope: { knowledge_refs: unknown[]; skill_route: string[]; marketing_brain_version: string } } };
    expect(body.candidate.envelope.knowledge_refs.length).toBeGreaterThan(0);
    expect(body.candidate.envelope.skill_route).toEqual(["enterprise-wechat-friend-marketing", "marketing-growth-system"]);
    const stateBefore = await (await fetch(`${client.root}/api/v2/state`, { headers: { cookie: client.cookie } })).json() as typeof fixture;
    expect(stateBefore.marketing_candidates.find((item) => item.id === body.candidate.id)?.status).toBe("pending");
    const decision = await client.request(`/api/v2/marketing/candidates/${body.candidate.id}/decision`, { decision: "accepted", output: null, reason_code: null, reason_note: "", expected_revision: 1 });
    expect(decision.status).toBe(200);
    expect(await decision.json()).toMatchObject({ marketing_candidates: expect.arrayContaining([expect.objectContaining({ id: body.candidate.id, status: "accepted" })]), marketing_decisions: expect.arrayContaining([expect.objectContaining({ candidate_id: body.candidate.id, decision: "accepted" })]) });
  });
});
