-- SCRUM-2042 — DocuSign retry exhaustion reconciliation (SOC 2 CC7.2)
--
-- Purpose: Track envelopes that DocuSign completed but never delivered via
-- Connect webhook (retry exhaustion after 45 attempts over 7 days). The
-- reconciliation cron polls the Envelopes API, diffs against received
-- nonces, and inserts gap rows here for alerting + manual recovery.
--
-- This table is semantically distinct from:
--   - webhook_dead_letter_queue (outbound delivery failures)
--   - webhook_dlq (inbound intake failures)
-- It captures events the vendor never delivered at all.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.docusign_reconciliation_gaps;

BEGIN;

CREATE TABLE IF NOT EXISTS public.docusign_reconciliation_gaps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  integration_id uuid NOT NULL,
  account_id    text NOT NULL,
  envelope_id   text NOT NULL,
  envelope_status text NOT NULL DEFAULT 'completed',
  completed_at  timestamptz NOT NULL,
  detected_at   timestamptz NOT NULL DEFAULT now(),
  resolution    text NOT NULL DEFAULT 'pending'
                CONSTRAINT docusign_reconciliation_gaps_resolution_valid
                CHECK (resolution IN ('pending', 'requeued', 'stale', 'manual')),
  resolved_at   timestamptz,
  sentry_event_id text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT docusign_reconciliation_gaps_envelope_unique
    UNIQUE (integration_id, envelope_id)
);

COMMENT ON TABLE public.docusign_reconciliation_gaps IS
  'SCRUM-2042: Envelopes completed on DocuSign but never delivered via Connect webhook (retry exhaustion). Service-role only.';

-- RLS: deny all for anon/authenticated — service_role only (same pattern as connector_alert_state)
ALTER TABLE public.docusign_reconciliation_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.docusign_reconciliation_gaps FORCE ROW LEVEL SECURITY;

CREATE POLICY "Deny anon all access on docusign_reconciliation_gaps"
  ON public.docusign_reconciliation_gaps
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Deny authenticated all access on docusign_reconciliation_gaps"
  ON public.docusign_reconciliation_gaps
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

-- Index for the reconciliation cron's primary query pattern
CREATE INDEX IF NOT EXISTS idx_docusign_reconciliation_gaps_pending
  ON public.docusign_reconciliation_gaps (resolution)
  WHERE resolution = 'pending';

CREATE INDEX IF NOT EXISTS idx_docusign_reconciliation_gaps_org
  ON public.docusign_reconciliation_gaps (org_id, detected_at DESC);

-- Notify PostgREST to pick up the new table
NOTIFY pgrst, 'reload schema';

COMMIT;
