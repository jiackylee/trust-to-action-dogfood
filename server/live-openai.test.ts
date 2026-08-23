// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createFixtureState } from "../src/domain/fixtures";
import { createOpenAiService } from "./ai-service";

const enabled = process.env.RUN_LIVE_OPENAI_TEST === "1" && Boolean(process.env.OPENAI_API_KEY);

describe.skipIf(!enabled)("live OpenAI smoke", () => {
  const service = createOpenAiService({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL });
  const fixture = createFixtureState();

  it("generates one strategy and one customer evaluation", async () => {
    const strategy = await service.weeklyStrategy({ metrics: { ready: 4 }, customer_states: { T1: 6 }, drafts: fixture.drafts, proofs: fixture.proofs });
    expect(strategy.data.theme).toBeTruthy();
    const evaluation = await service.customerEvaluation({ customer: fixture.customers.find((item) => item.state === "I1") });
    expect(evaluation.data.evidence_refs.length).toBeGreaterThan(0);
  }, 120_000);
});
