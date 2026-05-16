-- Expand audit_events event_category CHECK to include categories used by
-- worker-only code paths (COMPLIANCE, NOTIFICATION, PLATFORM, SECURITY).
-- These categories have been silently rejected since the fire-and-forget
-- void inserts swallow the constraint violation error.
--
-- ROLLBACK: ALTER TABLE public.audit_events DROP CONSTRAINT audit_events_event_category_valid;
--           ALTER TABLE public.audit_events ADD CONSTRAINT audit_events_event_category_valid
--             CHECK (event_category = ANY (ARRAY['AUTH','ANCHOR','PROFILE','ORG','ADMIN','SYSTEM','ORGANIZATION','WEBHOOK','API','AI','BILLING','VERIFICATION','USER']));

BEGIN;

ALTER TABLE public.audit_events DROP CONSTRAINT audit_events_event_category_valid;

ALTER TABLE public.audit_events ADD CONSTRAINT audit_events_event_category_valid
  CHECK (event_category = ANY (ARRAY[
    'AUTH',
    'ANCHOR',
    'PROFILE',
    'ORG',
    'ADMIN',
    'SYSTEM',
    'ORGANIZATION',
    'WEBHOOK',
    'API',
    'AI',
    'BILLING',
    'VERIFICATION',
    'USER',
    'COMPLIANCE',
    'NOTIFICATION',
    'PLATFORM',
    'SECURITY'
  ]));

COMMIT;
