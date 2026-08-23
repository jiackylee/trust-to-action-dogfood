import { describe, expect, it } from "vitest";
import { createFixtureState } from "./fixtures";
import { can, canAccessCustomer, canActOnTask } from "./permissions";
import { deterministicDraftRisks, draftApprovalRisks, proofCompleteness, validateCustomerEvaluation } from "./policy";

describe("customer evaluation policy", () => {
  it("blocks a weak signal from jumping to D1", () => {
    const customer = createFixtureState().customers.find((item) => item.state === "T0")!;
    const evaluation = { ...customer.evaluation!, state_before: "T0" as const, state_after: "D1" as const, evidence_refs: [customer.evidence[0].id] };
    const decision = validateCustomerEvaluation(customer, evaluation);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("状态最多前进一步");
    expect(decision.reasons).toContain("D1/A1 必须引用有效强证据");
  });

  it("allows one-step movement with valid strong evidence", () => {
    const customer = createFixtureState().customers.find((item) => item.state === "I1")!;
    const evaluation = { ...customer.evaluation!, state_before: "I1" as const, state_after: "D1" as const, evidence_refs: [customer.evidence[0].id] };
    expect(validateCustomerEvaluation(customer, evaluation)).toEqual({ allowed: true, code: "OK", reasons: [] });
  });

  it("requires a transaction fact for C1", () => {
    const customer = createFixtureState().customers.find((item) => item.state === "A1")!;
    const evaluation = { ...customer.evaluation!, state_before: "A1" as const, state_after: "C1" as const, evidence_refs: [customer.evidence[0].id] };
    expect(validateCustomerEvaluation(customer, evaluation).reasons).toContain("C1 必须存在明确成交事实");
  });

  it("blocks unknown and revoked evidence", () => {
    const customer = createFixtureState().customers.find((item) => item.anomaly === "证据授权已撤销")!;
    const revoked = { ...customer.evaluation!, evidence_refs: [customer.evidence[0].id] };
    expect(validateCustomerEvaluation(customer, revoked).allowed).toBe(false);
    const unknown = { ...customer.evaluation!, evidence_refs: ["evi-missing"] };
    expect(validateCustomerEvaluation(customer, unknown).reasons).toContain("存在未知证据引用");
  });
});
describe("deterministic gates and role permissions", () => {
  it("marks sensitive claims and revoked proof references", () => {
    const state = createFixtureState();
    const flags = deterministicDraftRisks({ title: "客户 Offer", body: "7 人团队两周提升 30% 并获得报价", evidence_refs: ["proof-05"] }, state.proofs);
    expect(flags).toEqual(expect.arrayContaining(["价格 / Offer", "客户证明 / 量化结果", "证据授权已撤销"]));
  });

  it("enforces the permission matrix", () => {
    expect(can("operations", "edit_draft")).toBe(true);
    expect(can("sales", "edit_draft")).toBe(false);
    expect(can("sales", "record_task")).toBe(true);
    expect(can("lead", "decide_approval")).toBe(true);
    expect(can("operations", "decide_approval")).toBe(false);
    expect(can("sales", "configure_ai")).toBe(false);
    expect(can("lead", "configure_ai")).toBe(true);
  });

  it("limits sales to owned or shared customers and owned tasks", () => {
    expect(canAccessCustomer("sales", { owner: "陈牧", shared: false })).toBe(true);
    expect(canAccessCustomer("sales", { owner: "许清", shared: true })).toBe(true);
    expect(canAccessCustomer("sales", { owner: "许清", shared: false })).toBe(false);
    expect(canActOnTask("sales", { owner: "陈牧" })).toBe(true);
    expect(canActOnTask("sales", { owner: "何川" })).toBe(false);
  });

  it("requires publication-channel authorization and recalculates proof completeness", () => {
    const state = createFixtureState();
    const draft = { ...state.drafts[2], channel: "官网" as const };
    expect(draftApprovalRisks(draft, state.proofs)).toContain("证明未授权用于官网");
    expect(proofCompleteness({ ...state.proofs[0], baseline: "" })).toMatchObject({ completeness: 86, missing_fields: ["基线"] });
  });
});
