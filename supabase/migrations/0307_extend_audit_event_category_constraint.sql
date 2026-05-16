-- Extend audit_events_event_category_valid CHECK constraint to include
-- categories already in use by production code: SECURITY, PLATFORM,
-- COMPLIANCE, NOTIFICATION. Without this, every INSERT using these
-- categories silently fails (fire-and-forget void pattern swallows errors).
--
-- ROLLBACK: ALTER TABLE audit_events DROP CONSTRAINT audit_events_event_category_valid;
--           ALTER TABLE audit_events ADD CONSTRAINT audit_events_event_category_valid
--             CHECK (event_category = ANY(ARRAY['AUTH','ANCHOR','PROFILE','ORG','ADMIN','SYSTEM','ORGANIZATION','WEBHOOK','API','AI','BILLING','VERIFICATION','USER']));

ALTER TABLE audit_events DROP CONSTRAINT audit_events_event_category_valid;

ALTER TABLE audit_events ADD CONSTRAINT audit_events_event_category_valid
  CHECK (event_category = ANY(ARRAY[
    'AUTH','ANCHOR','PROFILE','ORG','ADMIN','SYSTEM','ORGANIZATION',
    'WEBHOOK','API','AI','BILLING','VERIFICATION','USER',
    'SECURITY','PLATFORM','COMPLIANCE','NOTIFICATION'
  ]));

NOTIFY pgrst, 'reload schema';
