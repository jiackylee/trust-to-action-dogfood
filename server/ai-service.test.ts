// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { AiResult, CustomerEvaluation } from "../src/domain/schemas";
import { createFixtureState } from "../src/domain/fixtures";
import type { Customer } from "../src/domain/types";
import { AiServiceError, executeCustomerRoute, selectCustomerRoute } from "./ai-service";

function simpleCustomer(): Customer {
  const source = createFixtureState().customers[0];
  const evidence = [{ ...source.evidence[0], id: "simple-evidence", strength: "weak" as const, type: "内容浏览", text: "查看了知识内容", valid: true, transaction_fact: false }];
  const evaluation: CustomerEvaluation = {
    ...source.evaluation!,
    decision: "recommend",
    state_before: "T0",
    state_after: "T0",
    confidence: 82,
    evidence_refs: [evidence[0].id],
    recommendation: "继续观察",
    evidence_assessment: [{ evidence_id: evidence[0].id, supports: "both", weight: "weak", summary: "只有内容浏览弱信号" }],
    uncertainties: ["尚无主动咨询"],
  };
  return { ...source, state: "T0", anomaly: null, evidence, evaluation };
}

function result(evaluation: CustomerEvaluation, model: string): AiResult<CustomerEvaluation> {
  return { data: evaluation, meta: { model, response_id: `resp-${model}`, prompt_version: "test", generated_at: new Date().toISOString() } };
}

describe("global model profile fallback", () => {
  it("starts every scenario from the global primary model", () => {
    const simple = simpleCustomer();
    expect(selectCustomerRoute({ customer: simple })).toMatchObject({ model: "gpt-5.6", tier: "primary", reason: "global_primary" });
    expect(selectCustomerRoute({ customer: { ...simple, state: "D1" } }, "deepseek-chat")).toMatchObject({ model: "deepseek-chat", tier: "primary", reason: "global_primary" });
  });

  it("uses the primary model when output clears confidence and policy gates", async () => {
    const customer = simpleCustomer();
    const run = vi.fn(async (model: string) => result(customer.evaluation!, model));
    const output = await executeCustomerRoute({ input: { customer }, primaryModel: "gpt-5.6", fastModel: "gpt-5.6-terra", fastModelAvailable: true, run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("gpt-5.6");
    expect(output.meta).toMatchObject({ model: "gpt-5.6", attempts: 1, fallback_from: null, route_reason: "global_primary" });
  });

  it("falls back at most once when the primary result is low confidence", async () => {
    const customer = simpleCustomer();
    const run = vi.fn(async (model: string) => result({ ...customer.evaluation!, confidence: model === "gpt-5.6" ? 74 : 88 }, model));
    const output = await executeCustomerRoute({ input: { customer }, primaryModel: "gpt-5.6", fastModel: "gpt-5.6-terra", fastModelAvailable: true, run });
    expect(run.mock.calls.map(([model]) => model)).toEqual(["gpt-5.6", "gpt-5.6-terra"]);
    expect(output.meta).toMatchObject({ model: "gpt-5.6-terra", attempts: 2, fallback_from: "gpt-5.6", route_reason: "global_fallback:LOW_CONFIDENCE" });
  });

  it("falls back for a retryable provider outage but not a non-retryable model error", async () => {
    const customer = simpleCustomer();
    const retryableRun = vi.fn(async (model: string) => {
      if (model === "gpt-5.6") throw new AiServiceError(502, "MODEL_UNAVAILABLE", "provider unavailable", true);
      return result(customer.evaluation!, model);
    });
    const output = await executeCustomerRoute({ input: { customer }, primaryModel: "gpt-5.6", fastModel: "gpt-5.6-terra", fastModelAvailable: true, run: retryableRun });
    expect(retryableRun.mock.calls.map(([model]) => model)).toEqual(["gpt-5.6", "gpt-5.6-terra"]);
    expect(output.meta).toMatchObject({ attempts: 2, fallback_from: "gpt-5.6", route_reason: "global_fallback:MODEL_UNAVAILABLE" });

    const unavailableModel = vi.fn(async () => { throw new AiServiceError(422, "MODEL_UNAVAILABLE", "model missing", false); });
    await expect(executeCustomerRoute({ input: { customer }, primaryModel: "gpt-5.6", fastModel: "gpt-5.6-terra", fastModelAvailable: true, run: unavailableModel })).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    expect(unavailableModel).toHaveBeenCalledExactlyOnceWith("gpt-5.6");
  });

  it("blocks when no same-profile fallback is configured", async () => {
    const customer = simpleCustomer();
    const run = vi.fn(async (model: string) => result({ ...customer.evaluation!, confidence: 74 }, model));
    await expect(executeCustomerRoute({ input: { customer }, primaryModel: "gpt-5.6", fastModel: "gpt-5.6-terra", fastModelAvailable: false, run })).rejects.toMatchObject({ code: "LOW_CONFIDENCE" });
    expect(run).toHaveBeenCalledExactlyOnceWith("gpt-5.6");
  });

  it("does not fallback for authentication or hard input failures", async () => {
    const customer = { ...simpleCustomer(), state: "D1" as const };
    const run = vi.fn(async () => { throw new AiServiceError(503, "PROVIDER_AUTH_FAILED", "auth", false); });
    await expect(executeCustomerRoute({ input: { customer }, primaryModel: "gpt-5.6", fastModel: "gpt-5.6-terra", fastModelAvailable: true, run })).rejects.toMatchObject({ code: "PROVIDER_AUTH_FAILED" });
    expect(run).toHaveBeenCalledExactlyOnceWith("gpt-5.6");
  });
});
