-- Migration: 0004_anchors.sql
-- Description: Create anchors table for document fingerprints
-- Rollback: DROP TABLE IF EXISTS anchors;

-- Anchors table - stores fingerprints only, NO document content
CREATE TABLE anchors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owner references
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  org_id uuid NULL REFERENCES organizations(id) ON DELETE SET NULL,

  -- Document fingerprint (SHA-256 hash, 64 hex chars)
  fingerprint char(64) NOT NULL,

  -- Document metadata (no content stored)
  filename text NOT NULL,
  file_size bigint NULL,
  file_mime text NULL,

  -- Anchor status
  status anchor_status NOT NULL DEFAULT 'PENDING',

  -- On-chain reference (populated when secured)
  chain_tx_id text NULL,
  chain_block_height bigint NULL,
  chain_timestamp timestamptz NULL,

  -- Retention and legal hold
  legal_hold boolean NOT NULL DEFAULT false,
  retention_until timestamptz NULL,

  -- Soft delete
  deleted_at timestamptz NULL,

  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Constraints

  -- Fingerprint must be valid SHA-256 hex (64 chars, hex only)
  CONSTRAINT anchors_fingerprint_format CHECK (fingerprint ~ '^[A-Fa-f0-9]{64}$'),

  -- Filename length limit
  CONSTRAINT anchors_filename_length CHECK (char_length(filename) >= 1 AND char_length(filename) <= 255),

  -- Filename must not contain control characters (ASCII 0-31, 127)
  CONSTRAINT anchors_filename_no_control_chars CHECK (filename !~ '[\x00-\x1F\x7F]'),

  -- File size must be positive if provided
  CONSTRAINT anchors_file_size_positive CHECK (file_size IS NULL OR file_size > 0),

  -- Legal hold prevents deletion
  CONSTRAINT anchors_legal_hold_no_delete CHECK (
    legal_hold = false OR deleted_at IS NULL
  ),

  -- Chain data consistency: if secured, must have tx_id
  CONSTRAINT anchors_chain_data_consistency CHECK (
    status != 'SECURED' OR chain_tx_id IS NOT NULL
  )
);

-- Indexes
CREATE INDEX idx_anchors_user_id ON anchors(user_id);
CREATE INDEX idx_anchors_org_id ON anchors(org_id) WHERE org_id IS NOT NULL;
CREATE INDEX idx_anchors_fingerprint ON anchors(fingerprint);
CREATE INDEX idx_anchors_status ON anchors(status);
CREATE INDEX idx_anchors_created_at ON anchors(created_at);
CREATE INDEX idx_anchors_legal_hold ON anchors(legal_hold) WHERE legal_hold = true;
CREATE INDEX idx_anchors_deleted_at ON anchors(deleted_at) WHERE deleted_at IS NOT NULL;

-- Unique constraint: same user can't anchor same fingerprint twice (unless deleted)
CREATE UNIQUE INDEX idx_anchors_user_fingerprint_unique
  ON anchors(user_id, fingerprint)
  WHERE deleted_at IS NULL;

-- Trigger for updated_at
CREATE TRIGGER set_anchors_updated_at
  BEFORE UPDATE ON anchors
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- Comments
COMMENT ON TABLE anchors IS 'Document fingerprint anchors - NO document content stored';
COMMENT ON COLUMN anchors.fingerprint IS 'SHA-256 hash of document, 64 hex characters';
COMMENT ON COLUMN anchors.filename IS 'Original filename (metadata only)';
COMMENT ON COLUMN anchors.status IS 'Anchor status: PENDING, SECURED, REVOKED';
COMMENT ON COLUMN anchors.legal_hold IS 'If true, anchor cannot be deleted';
COMMENT ON COLUMN anchors.chain_tx_id IS 'On-chain transaction ID when secured';
