// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomerEvaluation } from "../src/domain/schemas";
import { createFixtureState } from "../src/domain/fixtures";
import type { AiService } from "./ai-service";
import { KnowledgeService } from "./knowledge-service";
import { LiveHoldoutRunner } from "./live-eval-runner";
import { MARKETING_PROMPT_HASHES } from "./prompts";
import { SqliteStateRepository } from "./repository";

const fixture = createFixtureState();
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function createPack() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tta-live-eval-pack-"));
  const paragraph = "企微营销必须引用证据并选择下一动作。聚焦窄市场，运行可测实验，明确目标客户与唯一 CTA，以行动结果复查；授权、事实和审批门禁优先。";
  const holdoutQueries = fixture.golden_cases.filter((item) => item.split === "holdout").map((item) => item.query).join("。\n");
  for (const skill of ["enterprise-wechat-friend-marketing", "marketing-growth-system"]) {
    const directory = path.join(root, "skills", skill);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "SKILL.md"), `# ${skill}\n\n## 企微增长规则\n\n${holdoutQueries}\n\n${Array(30).fill(paragraph).join("\n\n")}`, "utf8");
  }
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createService() {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  async function run<T>(create: () => T) {
    calls += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 3));
    active -= 1;
    return { data: create(), meta: { model: "gpt-5.6", response_id: `resp-live-${calls}`, prompt_version: "code-live-test", generated_at: new Date().toISOString(), latency_ms: 1200, input_tokens: 100, output_tokens: 40 } };
  }
  const service: AiService = {
    configured: true,
    model: "gpt-5.6",
    fastModel: "gpt-5.6-terra",
    weeklyStrategy: vi.fn(async (input: unknown) => run(() => ({ ...fixture.weekly_plan.strategy, evidence_refs: (input as { business_evidence: Array<{ id: string }> }).business_evidence.map((item) => item.id) }))),
    contentBrief: vi.fn(async (input: unknown) => run(() => ({
      title: "合成 Brief", target_segment: "企服团队", stage: "I" as const, primary_angle: "下一动作可追溯", key_facts: ["只使用合成事实"], proof_requirements: [], cta: "回复清单", due_at: "2026-08-30T10:00:00.000Z",
      insight_refs: (input as { accepted_insights: Array<{ id: string }> }).accepted_insights.map((item) => item.id),
    }))),
    contentDraft: vi.fn(async (input: unknown) => run(() => ({
      title: "合成草稿", stage: "I" as const, target_segment: "企服团队", objective: "验证下一动作", body: "用可追溯证据选择下一动作。", cta: "回复清单", expected_transition: "T1 → I1",
      evidence_refs: (input as { proofs: Array<{ id: string }> }).proofs.map((item) => item.id), risk_flags: [], approval_required: false,
    }))),
    customerEvaluation: vi.fn(async (input: unknown) => run(() => {
      const customer = (input as { customer: typeof fixture.customers[number] }).customer;
      const evidenceId = customer.evidence[0].id;
      const item = fixture.golden_cases.find((candidate) => candidate.expected_evidence_refs.includes(evidenceId))!;
      return {
        ...fixture.customers[0].evaluation,
        decision: "recommend",
        objective: "选择可追溯下一动作",
        target_segment: item.industry,
        state_before: item.state_before,
        state_after: item.expected_state,
        confidence: 86,
        evidence_refs: customer.evidence.map((evidence) => evidence.id),
        recommendation: item.acceptable_nba[0],
        not_recommended: ["自动外发"],
        draft: "人工跟进草稿",
        cta: "确认下一步",
        expected_transition: `${item.state_before} → ${item.expected_state}`,
        risk_flags: [],
        approval_required: false,
        next_review_at: "2026-08-30T10:00:00.000Z",
        evidence_assessment: customer.evidence.map((evidence) => ({ evidence_id: evidence.id, supports: "both" as const, weight: evidence.strength, summary: "合成有效证据" })),
        uncertainties: [],
      } satisfies CustomerEvaluation;
    })),
    riskReview: vi.fn(async () => run(() => ({ summary: "通过", risk_flags: [], claims: [], approval_recommended: false, suggested_revision: "" }))),
    conversationInsights: vi.fn(async () => run(() => ({ insights: [], excluded_message_count: 0, analysis_note: "" }))),
    weeklyRetrospective: vi.fn(async () => run(() => fixture.weekly_retrospective.retrospective)),
  };
  return { service, stats: () => ({ calls, maximum }) };
}

async function waitFor(repository: SqliteStateRepository, predicate: (status: string) => boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = [...repository.load("tenant-dogfood-cn").state.eval_runs].reverse().find((item) => item.mode === "live");
    if (run && predicate(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const latest = [...repository.load("tenant-dogfood-cn").state.eval_runs].reverse().find((item) => item.mode === "live");
  throw new Error(`live Holdout did not reach expected status: ${latest?.status} ${latest?.processed_count}/${latest?.case_count} failed=${latest?.failed_count} ${latest?.case_results?.find((item) => item.status === "failed")?.error_code ?? ""}`);
}

describe("live Holdout runner", () => {
  it("requires explicit start, limits concurrency, resumes and preserves per-case idempotency", async () => {
    const repository = new SqliteStateRepository(":memory:");
    cleanup.push(() => repository.close());
    const knowledge = new KnowledgeService({ packPath: createPack() });
    cleanup.push(() => knowledge.close());
    const indexed = knowledge.reindex("tenant-dogfood-cn");
    knowledge.activate("tenant-dogfood-cn", indexed.version.id);
    const loaded = repository.load("tenant-dogfood-cn");
    const published = loaded.state.marketing_brain_versions.find((item) => item.status === "published")!;
    repository.save("tenant-dogfood-cn", {
      ...loaded.state,
      marketing_brain_versions: loaded.state.marketing_brain_versions.map((item) => item.id === published.id ? { ...item, knowledge_pack_version_id: indexed.version.id, prompt_hashes: MARKETING_PROMPT_HASHES } : item),
    }, loaded.repositoryRevision);
    const ai = createService();
    const runner = new LiveHoldoutRunner(repository, ai.service, knowledge);
    const idempotencyKey = "live-holdout-contract-idempotency";
    runner.start({ tenantId: "tenant-dogfood-cn", actor: "周岚", marketingBrainVersionId: published.id, routerVersionId: "router-v2.1-rc1", idempotencyKey });

    let paused = false;
    for (let attempt = 0; attempt < 20 && !paused; attempt += 1) {
      const current = [...repository.load("tenant-dogfood-cn").state.eval_runs].reverse().find((item) => item.mode === "live")!;
      try { runner.pause("tenant-dogfood-cn", current.id, "周岚", current.revision); paused = true; }
      catch { await new Promise((resolve) => setTimeout(resolve, 2)); }
    }
    expect(paused).toBe(true);
    const pausedRun = await waitFor(repository, (status) => status === "paused");
    expect(pausedRun.case_results?.filter((item) => item.status === "completed").length).toBeLessThan(88);

    runner.start({ tenantId: "tenant-dogfood-cn", actor: "周岚", marketingBrainVersionId: published.id, routerVersionId: "router-v2.1-rc1", idempotencyKey });
    const completed = await waitFor(repository, (status) => status === "completed");
    expect(completed.case_results).toHaveLength(88);
    expect(completed.case_results?.every((item) => item.status === "completed" && item.idempotency_key.includes(item.case_id))).toBe(true);
    expect(completed.input_tokens).toBe(8_800);
    expect(completed.output_tokens).toBe(3_520);
    expect(completed.score).toMatchObject({ knowledge_citation_precision: 100, business_evidence_precision: 100, policy_violations: 0, privacy_leaks: 0 });
    expect(ai.stats()).toEqual({ calls: 88, maximum: 2 });

    runner.start({ tenantId: "tenant-dogfood-cn", actor: "周岚", marketingBrainVersionId: published.id, routerVersionId: "router-v2.1-rc1", idempotencyKey });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ai.stats().calls).toBe(88);
  }, 20_000);
});
