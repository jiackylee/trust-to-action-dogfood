import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createFixtureState } from "../src/domain/fixtures";
import type { DomainState } from "../src/domain/types";

const FIXTURE_VERSION = 5;

export class RepositoryConflictError extends Error {
  constructor() { super("Tenant state changed while the operation was running"); }
}

export interface LoadedState {
  state: DomainState;
  repositoryRevision: number;
}

export interface StateRepository {
  load(tenantId: string): LoadedState;
  save(tenantId: string, state: DomainState, expectedRepositoryRevision: number): LoadedState;
  reset(tenantId: string): LoadedState;
  getIdempotent<T>(tenantId: string, key: string, operation: string): T | null;
  saveIdempotent<T>(tenantId: string, key: string, operation: string, response: T): void;
  close(): void;
}

function stateForStorage(state: DomainState): DomainState {
  return { ...structuredClone(state), role: "operations" };
}

export class SqliteStateRepository implements StateRepository {
  #database: Database.Database;

  constructor(filename = ":memory:") {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.#database = new Database(filename);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("foreign_keys = ON");
    const migrationPath = fileURLToPath(new URL("./migrations/001_initial.sql", import.meta.url));
    this.#database.exec(fs.readFileSync(migrationPath, "utf8"));
  }

  load(tenantId: string): LoadedState {
    const row = this.#database.prepare("SELECT revision, fixture_version, payload_json FROM tenant_state WHERE tenant_id = ?").get(tenantId) as { revision: number; fixture_version: number; payload_json: string } | undefined;
    if (!row || row.fixture_version !== FIXTURE_VERSION) return this.reset(tenantId);
    return { state: JSON.parse(row.payload_json) as DomainState, repositoryRevision: row.revision };
  }

  save(tenantId: string, state: DomainState, expectedRepositoryRevision: number): LoadedState {
    const nextRevision = expectedRepositoryRevision + 1;
    const stored = stateForStorage(state);
    const result = this.#database.prepare("UPDATE tenant_state SET revision = ?, fixture_version = ?, payload_json = ?, updated_at = ? WHERE tenant_id = ? AND revision = ?")
      .run(nextRevision, FIXTURE_VERSION, JSON.stringify(stored), new Date().toISOString(), tenantId, expectedRepositoryRevision);
    if (result.changes !== 1) throw new RepositoryConflictError();
    return { state: stored, repositoryRevision: nextRevision };
  }

  reset(tenantId: string): LoadedState {
    const fixture = stateForStorage(createFixtureState());
    const savedAt = new Date().toISOString();
    const transaction = this.#database.transaction(() => {
      this.#database.prepare("DELETE FROM idempotency_records WHERE tenant_id = ?").run(tenantId);
      this.#database.prepare(`INSERT INTO tenant_state (tenant_id, revision, fixture_version, payload_json, updated_at)
        VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(tenant_id) DO UPDATE SET revision = tenant_state.revision + 1, fixture_version = excluded.fixture_version, payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
        .run(tenantId, FIXTURE_VERSION, JSON.stringify(fixture), savedAt);
      return this.#database.prepare("SELECT revision FROM tenant_state WHERE tenant_id = ?").get(tenantId) as { revision: number };
    });
    const row = transaction();
    return { state: fixture, repositoryRevision: row.revision };
  }

  getIdempotent<T>(tenantId: string, key: string, operation: string): T | null {
    const row = this.#database.prepare("SELECT response_json FROM idempotency_records WHERE tenant_id = ? AND idempotency_key = ? AND operation = ?").get(tenantId, key, operation) as { response_json: string } | undefined;
    return row ? JSON.parse(row.response_json) as T : null;
  }

  saveIdempotent<T>(tenantId: string, key: string, operation: string, response: T) {
    this.#database.prepare(`INSERT INTO idempotency_records (tenant_id, idempotency_key, operation, response_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, idempotency_key, operation) DO UPDATE SET response_json = excluded.response_json`)
      .run(tenantId, key, operation, JSON.stringify(response), new Date().toISOString());
  }

  close() { this.#database.close(); }
}

export function defaultDatabasePath() {
  return process.env.DATA_DB_PATH?.trim() || path.resolve(process.cwd(), "data/trust-to-action-v2.1.sqlite");
}
