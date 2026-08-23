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
});
