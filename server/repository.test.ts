// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryConflictError, SqliteStateRepository } from "./repository";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function databasePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tta-v2-1-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "pilot.sqlite");
}

describe("SQLite state repository", () => {
  it("persists tenant state across process-style repository restarts", () => {
    const filename = databasePath();
    const first = new SqliteStateRepository(filename);
    const loaded = first.load("tenant-a");
    first.save("tenant-a", { ...loaded.state, week: 9 }, loaded.repositoryRevision);
    first.close();

    const reopened = new SqliteStateRepository(filename);
    expect(reopened.load("tenant-a")).toMatchObject({ state: { week: 9 }, repositoryRevision: 2 });
    reopened.close();
  });

  it("rolls back a stale revision write without changing the latest state", () => {
    const repository = new SqliteStateRepository(":memory:");
    const loaded = repository.load("tenant-a");
    repository.save("tenant-a", { ...loaded.state, week: 6 }, loaded.repositoryRevision);
    expect(() => repository.save("tenant-a", { ...loaded.state, week: 7 }, loaded.repositoryRevision)).toThrow(RepositoryConflictError);
    expect(repository.load("tenant-a").state.week).toBe(6);
    repository.close();
  });

  it("isolates state and idempotency records by tenant", () => {
    const repository = new SqliteStateRepository(":memory:");
    const a = repository.load("tenant-a");
    const b = repository.load("tenant-b");
    repository.save("tenant-a", { ...a.state, week: 11 }, a.repositoryRevision);
    repository.saveIdempotent("tenant-a", "same-key", "customer-evaluation", { candidate_id: "a" });

    expect(repository.load("tenant-a").state.week).toBe(11);
    expect(repository.load("tenant-b").state.week).toBe(b.state.week);
    expect(repository.getIdempotent("tenant-a", "same-key", "customer-evaluation")).toEqual({ candidate_id: "a" });
    expect(repository.getIdempotent("tenant-b", "same-key", "customer-evaluation")).toBeNull();
    repository.close();
  });
});
