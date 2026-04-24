ALTER TABLE anchors ADD COLUMN IF NOT EXISTS sub_type TEXT;
CREATE INDEX IF NOT EXISTS idx_anchors_sub_type ON anchors (sub_type) WHERE sub_type IS NOT NULL;
COMMENT ON COLUMN anchors.sub_type IS 'GRE-01: Fine-grained credential sub-type (e.g., official_undergraduate, nursing_rn). Nullable.';
NOTIFY pgrst, 'reload schema';;
