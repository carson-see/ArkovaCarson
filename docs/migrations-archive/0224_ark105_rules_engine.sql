-- Migration 0224: ARK-105 — Rules Engine data model
--
-- PURPOSE
-- -------
-- Org-configurable automation rules: triggers × conditions × actions.
-- Foundation for SCRUM-1010 CIBA epic. Sprint 1 delivers the schema,
-- Zod types, RLS, and audit-event wiring. The execution worker (ARK-106),
-- scheduled reminders (ARK-107), no-code wizard (ARK-108), semantic match
-- (ARK-109), and NL authoring (ARK-110) build on top of this table.
--
-- JIRA: SCRUM-1017 (ARK-105)
-- EPIC: SCRUM-1010 (CIBA)
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS organization_rule_executions;
--   DROP TABLE IF EXISTS organization_rules;
--   DROP TYPE IF EXISTS org_rule_trigger_type;
--   DROP TYPE IF EXISTS org_rule_action_type;
--   DROP TYPE IF EXISTS org_rule_execution_status;

-- =============================================================================
-- 1. Enums — trigger + action + execution status
-- =============================================================================

CREATE TYPE org_rule_trigger_type AS ENUM (
  'ESIGN_COMPLETED',           -- INT-12: DocuSign / Adobe envelope finalized
  'WORKSPACE_FILE_MODIFIED',   -- INT-10: Google Drive / SharePoint file touched
  'CONNECTOR_DOCUMENT_RECEIVED', -- INT-13: ATS / background-check arrival
  'MANUAL_UPLOAD',             -- User uploads through the app
  'SCHEDULED_CRON',            -- Time-based rule (e.g. sweep old pending docs)
  'QUEUE_DIGEST',              -- ARK-107: scheduled reminder of pending queue
  'EMAIL_INTAKE'               -- upload@<org>.arkova.ai forwarding
);

CREATE TYPE org_rule_action_type AS ENUM (
  'AUTO_ANCHOR',         -- Queue for next batch
  'FAST_TRACK_ANCHOR',   -- Trigger C: instant anchor at full fee
  'QUEUE_FOR_REVIEW',    -- ARK-101: add to pending_resolution queue
  'FLAG_COLLISION',      -- Detect multi-version webhook bursts
  'NOTIFY',              -- Slack / email only; no anchor
  'FORWARD_TO_URL'       -- Allowlisted outbound webhook
);

CREATE TYPE org_rule_execution_status AS ENUM (
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'RETRYING',
  'DLQ'                  -- Max retries exhausted, parked for investigation
);

-- =============================================================================
-- 2. organization_rules table
-- =============================================================================

CREATE TABLE organization_rules (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  description         TEXT,

  trigger_type        org_rule_trigger_type NOT NULL,
  trigger_config      JSONB NOT NULL DEFAULT '{}'::jsonb,

  action_type         org_rule_action_type NOT NULL,
  action_config       JSONB NOT NULL DEFAULT '{}'::jsonb,

  enabled             BOOLEAN NOT NULL DEFAULT false,

  -- Versioned so schema evolution doesn't invalidate historical rules.
  -- Zod validator is selected per schema_version on the worker side.
  schema_version      SMALLINT NOT NULL DEFAULT 1,

  created_by_user_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_executed_at    TIMESTAMPTZ,
  execution_count     BIGINT NOT NULL DEFAULT 0,

  CONSTRAINT organization_rules_name_length
    CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT organization_rules_description_length
    CHECK (description IS NULL OR char_length(description) <= 1000),
  -- JSONB bloat cap: reject configs > ~16 KB to prevent abuse.
  CONSTRAINT organization_rules_trigger_config_size
    CHECK (pg_column_size(trigger_config) <= 16384),
  CONSTRAINT organization_rules_action_config_size
    CHECK (pg_column_size(action_config) <= 16384)
);

CREATE INDEX idx_organization_rules_org_enabled
  ON organization_rules(org_id, enabled)
  WHERE enabled = true;

CREATE INDEX idx_organization_rules_org_trigger
  ON organization_rules(org_id, trigger_type);

CREATE INDEX idx_organization_rules_last_executed
  ON organization_rules(last_executed_at DESC NULLS LAST)
  WHERE enabled = true;

CREATE TRIGGER set_organization_rules_updated_at
  BEFORE UPDATE ON organization_rules
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

COMMENT ON TABLE organization_rules IS
  'Org-configurable automation rules. Trigger on event types; dispatch action types; config in JSONB validated by Zod at write-path.';
COMMENT ON COLUMN organization_rules.schema_version IS
  'Bump when trigger_config / action_config schema changes incompatibly.';

ALTER TABLE organization_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_rules FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON organization_rules TO authenticated;

-- Org members can view enabled rules for their orgs.
CREATE POLICY organization_rules_select ON organization_rules
  FOR SELECT TO authenticated
  USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

-- Only org owners + admins can create rules.
CREATE POLICY organization_rules_insert ON organization_rules
  FOR INSERT TO authenticated
  WITH CHECK (
    org_id IN (
      SELECT org_id FROM org_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

CREATE POLICY organization_rules_update ON organization_rules
  FOR UPDATE TO authenticated
  USING (
    org_id IN (
      SELECT org_id FROM org_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    org_id IN (
      SELECT org_id FROM org_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

CREATE POLICY organization_rules_delete ON organization_rules
  FOR DELETE TO authenticated
  USING (
    org_id IN (
      SELECT org_id FROM org_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

-- =============================================================================
-- 3. organization_rule_executions table
-- =============================================================================

CREATE TABLE organization_rule_executions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id             UUID NOT NULL REFERENCES organization_rules(id) ON DELETE CASCADE,
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- External event that triggered this execution. Unique within a rule for a
  -- 24h window → prevents duplicate webhook processing (ARK-106 idempotency).
  trigger_event_id    TEXT NOT NULL,

  status              org_rule_execution_status NOT NULL DEFAULT 'PENDING',

  -- Sanitized payloads for observability. Raw PII must be stripped before
  -- insertion (enforced at the worker layer — see ARK-106).
  input_payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_payload      JSONB,
  error               TEXT,

  attempt_count       SMALLINT NOT NULL DEFAULT 0,
  duration_ms         INTEGER,

  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT organization_rule_executions_trigger_event_id_length
    CHECK (char_length(trigger_event_id) BETWEEN 1 AND 255),
  CONSTRAINT organization_rule_executions_error_length
    CHECK (error IS NULL OR char_length(error) <= 4000)
);

-- Idempotency: a rule cannot run twice for the same trigger event.
CREATE UNIQUE INDEX idx_organization_rule_executions_idempotency
  ON organization_rule_executions(rule_id, trigger_event_id);

CREATE INDEX idx_organization_rule_executions_org_status_created
  ON organization_rule_executions(org_id, status, created_at DESC);

CREATE INDEX idx_organization_rule_executions_rule_created
  ON organization_rule_executions(rule_id, created_at DESC);

-- DLQ inspection index: lets on-call filter stuck executions quickly.
CREATE INDEX idx_organization_rule_executions_dlq
  ON organization_rule_executions(org_id, created_at DESC)
  WHERE status = 'DLQ';

COMMENT ON TABLE organization_rule_executions IS
  'Per-execution record for every rule firing. 24h unique (rule_id, trigger_event_id) enforces ARK-106 idempotency.';

ALTER TABLE organization_rule_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_rule_executions FORCE ROW LEVEL SECURITY;

GRANT SELECT ON organization_rule_executions TO authenticated;

-- Org members can view their org's rule executions for debugging.
CREATE POLICY organization_rule_executions_select ON organization_rule_executions
  FOR SELECT TO authenticated
  USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

-- Inserts / updates are service-role only (worker-originated).

-- =============================================================================
-- 4. Audit event types
-- =============================================================================

-- audit_events.event_type is free-text TEXT (migration 0006). No enum to extend.
-- The worker will emit:
--   ORG_RULE_CREATED, ORG_RULE_UPDATED, ORG_RULE_DELETED,
--   ORG_RULE_ENABLED, ORG_RULE_DISABLED,
--   ORG_RULE_EXECUTED, ORG_RULE_DLQ,
--   RULE_DRAFT_REQUESTED (ARK-110)
-- Details carry full before/after diffs for CRUD events; sanitized
-- input/output for EXECUTED. See SEC-02 for the injection-defense corpus.

-- =============================================================================
-- 5. Schema cache reload
-- =============================================================================

NOTIFY pgrst, 'reload schema';
