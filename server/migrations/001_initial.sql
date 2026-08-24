CREATE TABLE IF NOT EXISTS tenant_state (
  tenant_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  fixture_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key, operation)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created_at ON idempotency_records(created_at);
