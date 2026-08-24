import { beforeEach, describe, expect, it } from "vitest";
import { createDataClient } from "./client";

describe("MockDataClient versioning", () => {
  beforeEach(() => localStorage.clear());

  it("returns a 409 conflict with the latest object", async () => {
    const client = createDataClient("mock");
    const state = await client.getState();
    const draft = state.drafts[0];
    await client.saveDraft({ ...draft, title: "first save" }, draft.revision);
    await expect(client.saveDraft({ ...draft, title: "stale save" }, draft.revision)).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT", latest: { title: "first save", revision: 2 } });
  });

  it("blocks writes outside the current role", async () => {
    const client = createDataClient("mock");
    const state = await client.setRole("sales");
    await expect(client.saveDraft(state.drafts[0], state.drafts[0].revision)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it("invalidates an approval after a material draft edit", async () => {
    const client = createDataClient("mock");
    const state = await client.getState();
    const draft = state.drafts.find((item) => item.id === "draft-03")!;
    const next = await client.saveDraft({ ...draft, body: `${draft.body}\n补充说明` }, draft.revision);
    expect(next.drafts.find((item) => item.id === draft.id)).toMatchObject({ approval_status: "required", revision: 2 });
    expect(next.approvals.find((item) => item.id === "approval-01")).toMatchObject({ status: "returned", reason: expect.stringContaining("实质修改") });
  });

  it("blocks an approval whose source object revision is stale", async () => {
    const client = createDataClient("mock");
    const state = await client.getState();
    const proof = state.proofs.find((item) => item.id === "proof-04")!;
    await client.saveProof({ ...proof, process: `${proof.process} 人工复核。` }, proof.revision);
    const leadState = await client.setRole("lead");
    const approval = leadState.approvals.find((item) => item.id === "approval-04")!;
    await expect(client.decideApproval(approval.id, "approved", "同意内部复盘", approval.revision)).rejects.toMatchObject({ status: 409, code: "STALE_APPROVAL" });
  });

  it("requires a usable proof authorized for the draft channel", async () => {
    const client = createDataClient("mock");
    const state = await client.getState();
    const draft = state.drafts.find((item) => item.id === "draft-03")!;
    const saved = await client.saveDraft({ ...draft, channel: "官网" }, draft.revision);
    const latest = saved.drafts.find((item) => item.id === draft.id)!;
    await expect(client.submitDraftApproval(latest.id, latest.revision)).rejects.toMatchObject({ status: 422, code: "PROOF_NOT_AUTHORIZED" });
  });

  it("persists NBA decisions, tasks and customer notes", async () => {
    const client = createDataClient("mock");
    const sales = await client.setRole("sales");
    const customer = sales.customers.find((item) => item.owner === "陈牧")!;
    const decided = await client.decideNba(customer.id, "accepted", customer.evaluation!.recommendation, "", customer.revision);
    const updated = decided.customers.find((item) => item.id === customer.id)!;
    expect(updated.nba_decision).toMatchObject({ decision: "accepted", actor: "陈牧", task_id: expect.any(String) });
    expect(decided.tasks.find((item) => item.id === updated.nba_decision!.task_id)).toMatchObject({ owner: "陈牧", customer_id: customer.id });
    const noted = await client.addCustomerNote(customer.id, "客户确认下周可安排演示。", updated.revision);
    expect(noted.customers.find((item) => item.id === customer.id)?.notes[0]).toMatchObject({ actor: "陈牧", text: "客户确认下周可安排演示。" });
    expect(noted.audits[0].action).toBe("记录客户人工笔记");
  });

  it("requires a reason when rejecting an NBA and blocks another owner's task", async () => {
    const client = createDataClient("mock");
    const sales = await client.setRole("sales");
    const customer = sales.customers.find((item) => item.owner === "陈牧")!;
    await expect(client.decideNba(customer.id, "rejected", "继续观察", "", customer.revision)).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    const foreignTask = sales.tasks.find((item) => item.owner !== "陈牧")!;
    await expect(client.recordTaskOutcome(foreignTask.id, "无效回填", foreignTask.revision)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it("blocks dependent drafts immediately when proof authorization is revoked", async () => {
    const client = createDataClient("mock");
    const state = await client.getState();
    const proof = state.proofs.find((item) => item.id === "proof-01")!;
    const next = await client.saveProof({ ...proof, status: "revoked", authorization: [] }, proof.revision);
    expect(next.drafts.find((item) => item.id === "draft-03")).toMatchObject({ status: "blocked", approval_status: "required" });
    expect(next.proofs.find((item) => item.id === proof.id)?.referenced_by).toContain("draft-03");
  });
});
