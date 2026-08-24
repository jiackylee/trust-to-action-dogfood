// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { SessionManager } from "./session";

describe("signed demo sessions", () => {
  it("accepts an authentic session and rejects a forged signature", () => {
    const manager = new SessionManager("test-session-secret-that-is-at-least-32-bytes");
    const payload = manager.create("sales");
    const token = manager.encode(payload);
    expect(manager.decode(token)).toMatchObject({ role: "sales", user_id: "demo-sales", tenant_id: "tenant-dogfood-cn" });
    const forged = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    expect(manager.decode(forged)).toBeNull();
  });

  it("rejects expired signed sessions", () => {
    const manager = new SessionManager("test-session-secret-that-is-at-least-32-bytes");
    const expired = { ...manager.create("operations"), expires_at: "2020-01-01T00:00:00.000Z" };
    expect(manager.decode(manager.encode(expired))).toBeNull();
  });

  it("requires a configured production secret and emits strict cookie attributes", () => {
    expect(() => new SessionManager(undefined, true)).toThrow("SESSION_SECRET is required");
    const manager = new SessionManager("test-session-secret-that-is-at-least-32-bytes", true);
    const setHeader = vi.fn();
    manager.set({ setHeader } as unknown as Response, manager.create("lead"));
    expect(setHeader).toHaveBeenCalledWith("Set-Cookie", expect.stringMatching(/HttpOnly; SameSite=Strict;.*Secure/));
  });
});
