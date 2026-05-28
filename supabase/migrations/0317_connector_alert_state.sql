-- SCRUM-2041: Connector health alert de-duplication state (SOC 2 CC7.1).
--
-- Tracks per-connector, per-org alert state to avoid spamming Sentry
-- on every cron tick. Alert fires on state transitions (connected →
-- degraded/disconnected) and re-fires after 1h cooldown.
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS connector_alert_state_deny_anon ON public.connector_alert_state;
--   DROP POLICY IF EXISTS connector_alert_state_deny_all ON public.connector_alert_state;
--   DROP TABLE IF EXISTS public.connector_alert_state;

CREATE TABLE IF NOT EXISTS public.connector_alert_state (
  connector_id TEXT NOT NULL,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  last_state TEXT NOT NULL DEFAULT 'connected'
    CHECK (last_state IN ('connected', 'degraded', 'disconnected')),
  last_alerted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, org_id)
);

ALTER TABLE public.connector_alert_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_alert_state FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'connector_alert_state' AND policyname = 'connector_alert_state_deny_all'
  ) THEN
    CREATE POLICY connector_alert_state_deny_all
      ON public.connector_alert_state
      FOR ALL
      TO authenticated
      USING (false);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'connector_alert_state' AND policyname = 'connector_alert_state_deny_anon'
  ) THEN
    CREATE POLICY connector_alert_state_deny_anon
      ON public.connector_alert_state
      FOR ALL
      TO anon
      USING (false);
  END IF;
END $$;

COMMENT ON TABLE public.connector_alert_state IS
  'SCRUM-2041: de-duplication state for connector health alerts. Service-role only.';

NOTIFY pgrst, 'reload schema';
