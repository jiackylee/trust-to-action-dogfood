import type { DomainState, Role } from "../domain/types";

export interface DemoSession {
  user_id: string;
  display_name: string;
  tenant_id: string;
  role: Role;
  csrf_token: string;
  expires_at: string;
  security_warning: string | null;
}

let currentSession: DemoSession | null = null;
let pendingSession: Promise<DemoSession> | null = null;

async function parse<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: { code?: string; message?: string; retryable?: boolean } };
  if (!response.ok) throw { status: response.status, code: body.error?.code ?? "SESSION_ERROR", message: body.error?.message ?? "演示会话不可用", retryable: body.error?.retryable ?? false };
  return body;
}

export const sessionClient = {
  async get(force = false) {
    if (!force && currentSession) return currentSession;
    if (!force && pendingSession) return pendingSession;
    pendingSession = fetch("/api/v2/session", { credentials: "same-origin" })
      .then((response) => parse<DemoSession>(response))
      .then((session) => { currentSession = session; return session; })
      .finally(() => { pendingSession = null; });
    return pendingSession;
  },
  async writeHeaders() {
    const session = await this.get();
    return { "x-csrf-token": session.csrf_token };
  },
  async switchRole(role: Role) {
    const session = await this.get();
    const response = await fetch("/api/v2/session/demo", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrf_token },
      body: JSON.stringify({ role }),
    });
    const result = await parse<{ session: DemoSession; state: DomainState }>(response);
    currentSession = result.session;
    return result;
  },
  clear() {
    currentSession = null;
    pendingSession = null;
  },
};
