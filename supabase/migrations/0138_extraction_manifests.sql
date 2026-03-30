-- VAI-01: Extraction Manifests — Cryptographic Binding of AI Output
-- Creates the extraction_manifests table to store signed manifests that
-- cryptographically bind every AI extraction to its source document hash.
-- Enables queryable provenance chain: Source → AI → Anchor.

CREATE TABLE IF NOT EXISTS extraction_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Source binding
  fingerprint char(64) NOT NULL,          -- SHA-256 of source document (links to anchors.fingerprint)
  -- AI model identity
  model_id text NOT NULL,                 -- Provider name: 'gemini', 'nessie', 'together'
  model_version text NOT NULL,            -- Model identifier (e.g., 'gemini-2.5-flash', 'nessie-v2')
  -- Extraction output
  extracted_fields jsonb NOT NULL,        -- Full extracted fields object
  confidence_scores jsonb NOT NULL,       -- Per-field and overall confidence: { overall, grounding, fields: {} }
  -- Cryptographic manifest
  manifest_hash char(64) NOT NULL,        -- SHA-256 of canonical manifest JSON
  -- Provenance linkage
  anchor_id uuid REFERENCES anchors(id) ON DELETE SET NULL,
  usage_event_id uuid,                    -- Links to ai_usage_events.id (no FK — may be cleaned up)
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Metadata
  extraction_timestamp timestamptz NOT NULL DEFAULT now(),
  prompt_version text,                    -- SHA-256 prefix of extraction prompt (links to ai_usage_events.prompt_version)
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for provenance queries
CREATE INDEX idx_extraction_manifests_fingerprint ON extraction_manifests(fingerprint);
CREATE INDEX idx_extraction_manifests_anchor_id ON extraction_manifests(anchor_id);
CREATE INDEX idx_extraction_manifests_manifest_hash ON extraction_manifests(manifest_hash);
CREATE INDEX idx_extraction_manifests_org_id ON extraction_manifests(org_id);
CREATE INDEX idx_extraction_manifests_created_at ON extraction_manifests(created_at DESC);

-- RLS (Constitution 1.4)
ALTER TABLE extraction_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_manifests FORCE ROW LEVEL SECURITY;

-- Org members can read their org's manifests
CREATE POLICY extraction_manifests_org_read ON extraction_manifests
  FOR SELECT USING (
    org_id IN (
      SELECT org_id FROM org_members WHERE user_id = auth.uid()
    )
  );

-- Users can read their own manifests
CREATE POLICY extraction_manifests_own_read ON extraction_manifests
  FOR SELECT USING (user_id = auth.uid());

-- Service role can do everything (worker inserts)
CREATE POLICY extraction_manifests_service ON extraction_manifests
  FOR ALL USING (auth.role() = 'service_role');

-- GRANT to authenticated users (RLS-01 pattern)
GRANT SELECT ON extraction_manifests TO authenticated;

-- ROLLBACK:
-- DROP TABLE IF EXISTS extraction_manifests CASCADE;
