-- Expand audit_events.event_category CHECK constraint to include categories
-- already used in worker code: SECURITY, COMPLIANCE, NOTIFICATION, PLATFORM.
-- Without this, inserts from emergency-access, compliance-report,
-- directory-opt-out, regulatory-change-scan, email/sender, and
-- ruleEventBackpressure would violate the constraint at runtime.
--
-- ROLLBACK: ALTER TABLE audit_events DROP CONSTRAINT audit_events_event_category_valid;
--           ALTER TABLE audit_events ADD CONSTRAINT audit_events_event_category_valid
--             CHECK (event_category IN (
--               'AUTH','ANCHOR','PROFILE','ORG','ADMIN','SYSTEM',
--               'ORGANIZATION','WEBHOOK','API','AI','BILLING','VERIFICATION','USER'
--             ));

BEGIN;

ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_event_category_valid;

ALTER TABLE audit_events ADD CONSTRAINT audit_events_event_category_valid CHECK (
  event_category IN (
    'AUTH', 'ANCHOR', 'PROFILE', 'ORG', 'ADMIN', 'SYSTEM',
    'ORGANIZATION', 'WEBHOOK', 'API', 'AI', 'BILLING', 'VERIFICATION', 'USER',
    'SECURITY', 'COMPLIANCE', 'NOTIFICATION', 'PLATFORM'
  )
);

COMMENT ON COLUMN audit_events.event_category IS
  'Event category. CHECK constraint: AUTH, ANCHOR, PROFILE, ORG, ADMIN, SYSTEM, '
  'ORGANIZATION, WEBHOOK, API, AI, BILLING, VERIFICATION, USER, '
  'SECURITY, COMPLIANCE, NOTIFICATION, PLATFORM';

NOTIFY pgrst, 'reload schema';

COMMIT;
