import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { Role } from "../src/domain/types";

const COOKIE_NAME = "tta_demo_session";
const SESSION_DURATION_MS = 8 * 60 * 60_000;
const users: Record<Role, { user_id: string; display_name: string }> = {
  operations: { user_id: "demo-operations", display_name: "林澈" },
  sales: { user_id: "demo-sales", display_name: "陈牧" },
  lead: { user_id: "demo-lead", display_name: "周岚" },
};

export interface SessionPayload {
  user_id: string;
  display_name: string;
  tenant_id: string;
  role: Role;
  csrf_token: string;
  expires_at: string;
}

function base64url(value: string) { return Buffer.from(value).toString("base64url"); }
function parseCookies(request: Request) {
  return Object.fromEntries((request.get("cookie") ?? "").split(";").flatMap((item) => {
    const index = item.indexOf("=");
    return index > 0 ? [[item.slice(0, index).trim(), item.slice(index + 1).trim()]] : [];
  }));
}

export class SessionManager {
  readonly securityWarning: string | null;
  #secret: string;
  #secure: boolean;

  constructor(secret: string | undefined, production = process.env.NODE_ENV === "production") {
    if (production && !secret?.trim()) throw new Error("SESSION_SECRET is required outside development");
    this.#secret = secret?.trim() || crypto.randomBytes(32).toString("hex");
    this.#secure = production;
    this.securityWarning = secret?.trim() ? null : "开发环境使用启动期临时会话密钥，服务重启后会话失效";
  }

  create(role: Role): SessionPayload {
    const user = users[role];
    return {
      ...user,
      tenant_id: "tenant-dogfood-cn",
      role,
      csrf_token: crypto.randomBytes(24).toString("base64url"),
      expires_at: new Date(Date.now() + SESSION_DURATION_MS).toISOString(),
    };
  }

  encode(payload: SessionPayload) {
    const body = base64url(JSON.stringify(payload));
    const signature = crypto.createHmac("sha256", this.#secret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  decode(token: string | undefined): SessionPayload | null {
    if (!token) return null;
    const [body, signature] = token.split(".");
    if (!body || !signature) return null;
    const expected = crypto.createHmac("sha256", this.#secret).update(body).digest("base64url");
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
      if (new Date(payload.expires_at).getTime() <= Date.now() || !users[payload.role]) return null;
      return payload;
    } catch {
      return null;
    }
  }

  resolve(request: Request) {
    return this.decode(parseCookies(request)[COOKIE_NAME]);
  }

  set(response: Response, payload: SessionPayload) {
    const attributes = [`${COOKIE_NAME}=${this.encode(payload)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${SESSION_DURATION_MS / 1000}`];
    if (this.#secure) attributes.push("Secure");
    response.setHeader("Set-Cookie", attributes.join("; "));
  }

  public(payload: SessionPayload) {
    return { ...payload, security_warning: this.securityWarning };
  }
}

declare global {
  namespace Express {
    interface Request {
      ttaSession: SessionPayload;
    }
  }
}
