CREATE TABLE IF NOT EXISTS knowledge_pack_versions (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  pack_version_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  pack_version_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  task_csv TEXT NOT NULL,
  skill TEXT NOT NULL,
  market_csv TEXT NOT NULL,
  knowledge_kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (tenant_id, id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
  content,
  heading,
  content='knowledge_chunks',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
  INSERT INTO knowledge_chunks_fts(rowid, content, heading)
  VALUES (new.rowid, json_extract(new.payload_json, '$.content'), json_extract(new.payload_json, '$.heading_path'));
END;

CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
  INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts, rowid, content, heading)
  VALUES ('delete', old.rowid, json_extract(old.payload_json, '$.content'), json_extract(old.payload_json, '$.heading_path'));
END;

CREATE TABLE IF NOT EXISTS knowledge_retrieval_runs (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_filter
  ON knowledge_chunks(tenant_id, pack_version_id, skill, knowledge_kind);

CREATE INDEX IF NOT EXISTS idx_knowledge_sources_pack
  ON knowledge_sources(tenant_id, pack_version_id, status);
