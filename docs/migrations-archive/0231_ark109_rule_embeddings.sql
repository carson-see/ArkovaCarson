-- Migration 0231: ARK-109 — rule_embeddings cache table
--
-- PURPOSE
-- -------
-- Cache rule-description and document-metadata embeddings so we don't pay
-- Gemini's per-call latency on every rule evaluation. Keyed by a content
-- hash (so identical descriptions across rules share a cached vector)
-- plus model_version (so a model upgrade invalidates the cache cleanly).
--
-- The embedding itself is stored as `text` in this migration (JSON-encoded
-- float array). A later migration can swap in `pgvector` + HNSW when the
-- table grows — the interface in `services/worker/src/ai/ruleMatcher.ts`
-- hides the representation.
--
-- JIRA: SCRUM-1021 (ARK-109)
-- EPIC: SCRUM-1010 (CIBA)
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS rule_embeddings;

CREATE TABLE IF NOT EXISTS rule_embeddings (
  content_hash    TEXT NOT NULL,
  model_version   TEXT NOT NULL,
  embedding       TEXT NOT NULL,  -- JSON-encoded float[]; swap to vector later
  dimensions      SMALLINT NOT NULL CHECK (dimensions BETWEEN 64 AND 4096),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, model_version),
  CONSTRAINT rule_embeddings_hash_shape CHECK (content_hash ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_rule_embeddings_last_used
  ON rule_embeddings(last_used_at DESC);

COMMENT ON TABLE rule_embeddings IS
  'ARK-109 cache of vector embeddings for rule descriptions + document metadata. Keyed by SHA-256 of normalized content + model_version for clean invalidation on model upgrade.';

ALTER TABLE rule_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_embeddings FORCE ROW LEVEL SECURITY;

-- Reads are service-role only — the cache isn't user-visible.
-- (No GRANT to authenticated.)

NOTIFY pgrst, 'reload schema';
