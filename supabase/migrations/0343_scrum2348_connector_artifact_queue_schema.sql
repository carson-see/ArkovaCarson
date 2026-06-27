-- QUEUE-02 / SCRUM-2348: Connector-artifact queue schema.
-- Tier: T3 (new table + RLS + SECURITY DEFINER RPC; migration-class change).
--
-- WHAT
-- ----
-- Creates `connector_artifact`, the queue table that Lane 3's connector
-- materializers (Google Drive / DocuSign / Microsoft 365 / manual + batch
-- upload) write into, plus an idempotent `enqueue_connector_artifact` RPC.
--
-- WHY
-- ---
-- Connectors redeliver. The same external file+revision can arrive many times
-- (webhook retries, page-token replays, manual re-runs). A row must be created
-- exactly once per (org, source, external_ref, external_revision). The RPC is
-- the single enqueue entry point; it is INSERT ... ON CONFLICT DO NOTHING and
-- returns the existing row id on conflict so a redelivery is a no-op that still
-- hands the caller a stable id.
--
-- §1.6A — NO RAW BYTES SERVER-SIDE. This table stores only the server-computed
-- fingerprint (`fingerprint_sha256`) + bounded, PII-scrubbed `metadata`. There
-- is deliberately NO bytea / blob / content column. Raw connector bytes are
-- fetched → SHA-256'd → discarded in the worker and never persist here.
--
-- §-credit: enqueue does NOT debit credits. The credit debit happens later, at
-- SECURING, via the already-live `debit_and_enqueue_anchor` RPC (mig 0341).
-- `credit_deduction_id` is a nullable backlink the worker sets once that debit
-- has occurred; it is never written by this enqueue path.
--
-- Precedent: `external_document_versions` (mig 0323) — same org-scoped
-- connector-dedup shape, RLS + FORCE, service-role writes, org-member SELECT.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.enqueue_connector_artifact(uuid, text, text, text, text, bigint, timestamptz, jsonb);
--   DROP TABLE IF EXISTS public.connector_artifact;

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ══════════════════════════════════════════════════════════════════════════════
-- Table: connector_artifact
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.connector_artifact (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- RLS tenant key.
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  -- Originating connector. Locked set; widen via a forward migration only.
  source text NOT NULL,
  -- Nullable FK to the per-org connection that produced this artifact.
  -- ON DELETE SET NULL: removing a connection must not orphan-delete history.
  -- (mirrors integration_events.integration_id in the baseline schema).
  integration_id uuid REFERENCES public.org_integrations(id) ON DELETE SET NULL,
  -- Connector-native identifier (Drive fileId, DocuSign envelopeId, etc.).
  external_ref text NOT NULL,
  -- Connector-native revision/version handle. Nullable: not every source has one.
  external_revision text,
  -- Server-computed SHA-256 of the fetched bytes (§1.6A). 64 lowercase-hex chars.
  fingerprint_sha256 text NOT NULL,
  -- Byte length of the fetched document (metadata only — NOT the bytes).
  byte_length bigint,
  -- Connector-reported source modification time, if any.
  source_timestamp timestamptz,
  -- Queue lifecycle.
  status text NOT NULL DEFAULT 'pending',
  -- Backlink to the credit-debit ledger row, set by the worker at SECURING.
  -- NEVER written by enqueue_connector_artifact (no debit at enqueue).
  credit_deduction_id uuid REFERENCES public.org_credit_deductions(id),
  -- Backlink to the resulting anchor once materialized + anchored.
  anchor_id uuid REFERENCES public.anchors(id),
  -- Bounded, PII-scrubbed structured metadata only.
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connector_artifact_source_check
    CHECK (source IN ('google_drive', 'docusign', 'microsoft_365', 'manual_upload', 'batch_upload')),
  CONSTRAINT connector_artifact_status_check
    CHECK (status IN ('pending', 'queued', 'processing', 'materialized', 'anchored', 'failed', 'skipped')),
  -- Server-side fingerprint must be a canonical lowercase 64-hex SHA-256.
  CONSTRAINT connector_artifact_fingerprint_format_check
    CHECK (fingerprint_sha256 ~ '^[a-f0-9]{64}$')
);

ALTER TABLE public.connector_artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_artifact FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.connector_artifact IS
  'SCRUM-2348 QUEUE-02: connector-sourced document queue. Stores only the '
  'server-computed fingerprint + PII-scrubbed metadata (§1.6A) — never raw bytes. '
  'Dedup/idempotency key: (org_id, source, external_ref, COALESCE(external_revision,'''')). '
  'Enqueue does not debit credits; the credit debit happens at SECURING via debit_and_enqueue_anchor.';
COMMENT ON COLUMN public.connector_artifact.fingerprint_sha256 IS
  'SHA-256 (64 lowercase-hex) computed server-side from the fetched bytes, which are then discarded (§1.6A).';
COMMENT ON COLUMN public.connector_artifact.credit_deduction_id IS
  'Backlink to org_credit_deductions, set by the worker at SECURING. Never written by enqueue.';
COMMENT ON COLUMN public.connector_artifact.integration_id IS
  'Nullable FK to org_integrations (the per-org connection). NULL for manual/batch uploads with no connection row.';

-- ══════════════════════════════════════════════════════════════════════════════
-- Indexes
-- ══════════════════════════════════════════════════════════════════════════════

-- Dedupe / idempotency key. external_revision is nullable, so we COALESCE it to
-- '' inside a UNIQUE INDEX. A plain UNIQUE (…, external_revision) constraint
-- would treat NULL revisions as always-distinct (SQL NULL semantics) and let a
-- redelivered no-revision artifact insert twice — the COALESCE sentinel closes
-- that hole so NULL revisions dedupe as a single logical value.
CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_artifact_dedupe
  ON public.connector_artifact (org_id, source, external_ref, COALESCE(external_revision, ''));

-- Org dashboard / status sweeps.
CREATE INDEX IF NOT EXISTS idx_connector_artifact_org_status
  ON public.connector_artifact (org_id, status);

-- Fingerprint cross-reference (dedupe across sources, anchor lookup).
CREATE INDEX IF NOT EXISTS idx_connector_artifact_fingerprint
  ON public.connector_artifact (fingerprint_sha256);

-- ══════════════════════════════════════════════════════════════════════════════
-- RLS Policies
-- ══════════════════════════════════════════════════════════════════════════════

-- Service role: full access (worker writes + advances queue rows).
DROP POLICY IF EXISTS connector_artifact_service_all ON public.connector_artifact;
CREATE POLICY connector_artifact_service_all ON public.connector_artifact
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Org members: SELECT their own org's artifacts only (mirrors edv_org_select).
DROP POLICY IF EXISTS connector_artifact_org_select ON public.connector_artifact;
CREATE POLICY connector_artifact_org_select ON public.connector_artifact
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.user_id = (SELECT auth.uid())
        AND om.org_id = connector_artifact.org_id
    )
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- RPC: enqueue_connector_artifact
-- ══════════════════════════════════════════════════════════════════════════════
--
-- Single idempotent enqueue entry point. Call-site is Zod-validated in the
-- worker. INSERT ... ON CONFLICT DO NOTHING on the dedupe key; on conflict the
-- INSERT ... RETURNING yields no row, so we resolve and return the existing id.
-- Performs NO credit debit (debit is at SECURING via debit_and_enqueue_anchor).
CREATE OR REPLACE FUNCTION public.enqueue_connector_artifact(
  p_org_id uuid,
  p_source text,
  p_external_ref text,
  p_external_revision text DEFAULT NULL,
  p_fingerprint_sha256 text DEFAULT NULL,
  p_byte_length bigint DEFAULT NULL,
  p_source_timestamp timestamptz DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Idempotent insert. The table CHECK constraints validate source / status /
  -- fingerprint format; the call-site Zod schema is the first line of defence.
  INSERT INTO public.connector_artifact (
    org_id, source, external_ref, external_revision,
    fingerprint_sha256, byte_length, source_timestamp, metadata
  )
  VALUES (
    p_org_id, p_source, p_external_ref, p_external_revision,
    p_fingerprint_sha256, p_byte_length, p_source_timestamp,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (org_id, source, external_ref, COALESCE(external_revision, ''))
  DO NOTHING
  RETURNING id INTO v_id;

  -- Conflict path: row already existed, INSERT returned nothing. Resolve the
  -- existing id so a redelivery still hands the caller a stable identifier.
  IF v_id IS NULL THEN
    SELECT id INTO v_id
    FROM public.connector_artifact
    WHERE org_id = p_org_id
      AND source = p_source
      AND external_ref = p_external_ref
      AND COALESCE(external_revision, '') = COALESCE(p_external_revision, '');
  END IF;

  RETURN v_id;
END;
$$;

-- ══════════════════════════════════════════════════════════════════════════════
-- Grants
-- ══════════════════════════════════════════════════════════════════════════════

REVOKE ALL ON TABLE public.connector_artifact FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.connector_artifact TO service_role;
-- Org members read their own rows (RLS-scoped). No write grant to authenticated.
GRANT SELECT ON TABLE public.connector_artifact TO authenticated;

REVOKE ALL ON FUNCTION public.enqueue_connector_artifact(uuid, text, text, text, text, bigint, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_connector_artifact(uuid, text, text, text, text, bigint, timestamptz, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
