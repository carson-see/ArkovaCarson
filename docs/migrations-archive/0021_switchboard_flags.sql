-- Migration: 0021_switchboard_flags.sql
-- Description: Production switchboard flags with audit trail
-- Rollback: DROP TABLE IF EXISTS switchboard_flag_history; DROP TABLE IF EXISTS switchboard_flags;

-- =============================================================================
-- SWITCHBOARD FLAGS TABLE
-- =============================================================================
-- Server-side feature flags with defaults

CREATE TABLE switchboard_flags (
  id text PRIMARY KEY,
  value boolean NOT NULL,
  description text,
  default_value boolean NOT NULL,
  is_dangerous boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES profiles(id)
);

-- =============================================================================
-- FLAG HISTORY TABLE
-- =============================================================================
-- Audit trail for flag changes

CREATE TABLE switchboard_flag_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id text NOT NULL REFERENCES switchboard_flags(id) ON DELETE CASCADE,
  old_value boolean,
  new_value boolean NOT NULL,
  changed_by uuid REFERENCES profiles(id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text
);

CREATE INDEX idx_switchboard_flag_history_flag_id ON switchboard_flag_history(flag_id);
CREATE INDEX idx_switchboard_flag_history_changed_at ON switchboard_flag_history(changed_at);

-- =============================================================================
-- FLAG UPDATE TRIGGER
-- =============================================================================
-- Auto-log flag changes

CREATE OR REPLACE FUNCTION log_switchboard_flag_change()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO switchboard_flag_history (flag_id, old_value, new_value, changed_by)
  VALUES (NEW.id, OLD.value, NEW.value, NEW.updated_by);

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER log_flag_change
  BEFORE UPDATE ON switchboard_flags
  FOR EACH ROW
  WHEN (OLD.value IS DISTINCT FROM NEW.value)
  EXECUTE FUNCTION log_switchboard_flag_change();

-- =============================================================================
-- FLAG GETTER FUNCTION
-- =============================================================================
-- Safe flag lookup with default

CREATE OR REPLACE FUNCTION get_flag(p_flag_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_value boolean;
  v_default boolean;
BEGIN
  SELECT value, default_value INTO v_value, v_default
  FROM switchboard_flags
  WHERE id = p_flag_id;

  IF NOT FOUND THEN
    -- Return safe default if flag doesn't exist
    RETURN false;
  END IF;

  RETURN COALESCE(v_value, v_default);
END;
$$;

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

ALTER TABLE switchboard_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE switchboard_flag_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE switchboard_flags FORCE ROW LEVEL SECURITY;
ALTER TABLE switchboard_flag_history FORCE ROW LEVEL SECURITY;

-- Flags: Service role only for modifications
-- Authenticated users can read flags
CREATE POLICY switchboard_flags_read ON switchboard_flags
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY switchboard_flag_history_read ON switchboard_flag_history
  FOR SELECT
  TO authenticated
  USING (true);

-- Grant access
GRANT SELECT ON switchboard_flags TO authenticated;
GRANT SELECT ON switchboard_flag_history TO authenticated;
GRANT ALL ON switchboard_flags TO service_role;
GRANT ALL ON switchboard_flag_history TO service_role;
GRANT EXECUTE ON FUNCTION get_flag(text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_flag(text) TO service_role;

-- =============================================================================
-- SEED DEFAULT FLAGS
-- =============================================================================

INSERT INTO switchboard_flags (id, value, default_value, description, is_dangerous) VALUES
  ('ENABLE_PROD_NETWORK_ANCHORING', false, false, 'Enable production network anchoring (real network fees)', true),
  ('ENABLE_OUTBOUND_WEBHOOKS', false, false, 'Enable outbound webhook delivery', false),
  ('ENABLE_NEW_CHECKOUTS', true, true, 'Allow new checkout sessions', false),
  ('ENABLE_REPORTS', true, true, 'Enable report generation', false),
  ('MAINTENANCE_MODE', false, false, 'Put the app in maintenance mode', true);

-- Comments
COMMENT ON TABLE switchboard_flags IS 'Server-side feature flags with defaults';
COMMENT ON TABLE switchboard_flag_history IS 'Audit trail for flag changes';
COMMENT ON FUNCTION get_flag IS 'Safe flag lookup with default';
