// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createFixtureState } from "../src/domain/fixtures";
import { createOpenAiService } from "./ai-service";

const enabled = process.env.RUN_LIVE_OPENAI_TEST === "1" && Boolean(process.env.OPENAI_API_KEY);

describe.skipIf(!enabled)("live OpenAI smoke", () => {
  const service = createOpenAiService({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL, fastModel: process.env.OPENAI_FAST_MODEL });
  const fixture = createFixtureState();

  it("evaluates one Terra-simple case and one primary high-risk case", async () => {
    const source = fixture.customers[0];
    const simple = {
      ...source,
      state: "T0" as const,
      anomaly: null,
      evidence: [{ ...source.evidence[0], id: "live-simple-evidence", strength: "weak" as const, type: "内容浏览", text: "查看了合成知识内容", valid: true, transaction_fact: false }],
    };
    const simpleResult = await service.customerEvaluation({ customer: simple });
    expect(simpleResult.meta).toMatchObject({ model: process.env.OPENAI_FAST_MODEL ?? "gpt-5.6-terra", attempts: 1 });
    expect(simpleResult.data.evidence_refs).toEqual(["live-simple-evidence"]);

    const highRisk = fixture.customers.find((item) => item.state === "A1" || item.anomaly)!;
    const highRiskResult = await service.customerEvaluation({ customer: highRisk });
    expect(highRiskResult.meta).toMatchObject({ model: process.env.OPENAI_MODEL ?? "gpt-5.6", attempts: 1 });
    expect(highRiskResult.data.evidence_refs.length).toBeGreaterThan(0);
  }, 120_000);
});
