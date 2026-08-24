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

describe("customer model routing", () => {
  it("routes only simple T0/T1 scenarios to Terra", () => {
    const simple = simpleCustomer();
    expect(selectCustomerRoute({ customer: simple })).toMatchObject({ model: "gpt-5.6-terra", tier: "fast", reason: "simple_t0_t1" });
    expect(selectCustomerRoute({ customer: { ...simple, state: "D1" } })).toMatchObject({ model: "gpt-5.6", tier: "primary" });
    expect(selectCustomerRoute({ customer: { ...simple, anomaly: "证据冲突" } })).toMatchObject({ model: "gpt-5.6", tier: "primary", reason: "customer_anomaly" });
  });

  it("uses Terra once when its output clears confidence and policy gates", async () => {
    const customer = simpleCustomer();
    const run = vi.fn(async (model: string) => result(customer.evaluation!, model));
    const output = await executeCustomerRoute({ input: { customer }, primaryModel: "gpt-5.6", fastModel: "gpt-5.6-terra", fastModelAvailable: true, run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("gpt-5.6-terra");
    expect(output.meta).toMatchObject({ model: "gpt-5.6-terra", attempts: 1, escalated_from: null });
  });

  it("upgrades Terra at most once when confidence is low", async () => {
    const customer = simpleCustomer();
    const run = vi.fn(async (model: string) => result({ ...customer.evaluation!, confidence: model === "gpt-5.6-terra" ? 74 : 88 }, model));
    const output = await executeCustomerRoute({ input: { customer }, primaryModel: "gpt-5.6", fastModel: "gpt-5.6-terra", fastModelAvailable: true, run });
    expect(run.mock.calls.map(([model]) => model)).toEqual(["gpt-5.6-terra", "gpt-5.6"]);
    expect(output.meta).toMatchObject({ model: "gpt-5.6", attempts: 2, escalated_from: "gpt-5.6-terra", route_reason: "simple_t0_t1:escalated" });
  });

  it("uses the primary model directly when Terra is unavailable", async () => {
    const customer = simpleCustomer();
    const run = vi.fn(async (model: string) => result(customer.evaluation!, model));
    const output = await executeCustomerRoute({ input: { customer }, primaryModel: "gpt-5.6", fastModel: "gpt-5.6-terra", fastModelAvailable: false, run });
    expect(run).toHaveBeenCalledExactlyOnceWith("gpt-5.6");
    expect(output.meta).toMatchObject({ attempts: 1, route_reason: "fast_model_unavailable" });
  });

  it("blocks after a primary-model failure and never downgrades", async () => {
    const customer = { ...simpleCustomer(), state: "D1" as const };
    const run = vi.fn(async () => { throw new AiServiceError(504, "OPENAI_TIMEOUT", "timeout", true); });
    await expect(executeCustomerRoute({ input: { customer }, primaryModel: "gpt-5.6", fastModel: "gpt-5.6-terra", fastModelAvailable: true, run })).rejects.toMatchObject({ code: "OPENAI_TIMEOUT" });
    expect(run).toHaveBeenCalledExactlyOnceWith("gpt-5.6");
  });
});
