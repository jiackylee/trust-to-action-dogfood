import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { createFixtureState } from "../domain/fixtures";
import { AppStore } from "../store/AppStore";
import { Dashboard } from "./Dashboard";

describe("operating dashboard", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.endsWith("/api/v2/state")
        ? createFixtureState()
        : { ok: true, ai_configured: false, model: "gpt-5.6", fast_model: "gpt-5.6-terra", fast_model_available: true, data_mode: "http-sqlite", session_warning: null, config_source: "none", configured_at: null };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
  });

  it("links metrics directly to filtered work queues", async () => {
    render(<MemoryRouter><AppStore><Dashboard /></AppStore></MemoryRouter>);
    await screen.findByRole("heading", { name: "内容经营台" });
    expect(screen.getByText("待判断洞察").closest("a")).toHaveAttribute("href", "/insights?status=candidate");
    expect(screen.getByText("待审批").closest("a")).toHaveAttribute("href", "/execution?tab=approvals");
    expect(screen.getByText("证据缺口").closest("a")).toHaveAttribute("href", "/proofs?readiness=gap");
    await waitFor(() => expect(localStorage.getItem("trust-to-action-dogfood-v2-1")).toBeNull());
  });
});
