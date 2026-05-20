-- SCRUM-1871 / SCRUM-1881: legally binding attestation foundation.
-- ROLLBACK: DROP TABLE IF EXISTS public.legally_binding_attestations CASCADE;
--           DROP FUNCTION IF EXISTS public.enforce_legally_binding_attestation_state();
--           DROP FUNCTION IF EXISTS public.enforce_legally_binding_attestation_org_gate();

CREATE TABLE IF NOT EXISTS public.legally_binding_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attestation_id text NOT NULL UNIQUE,
  attestation_type text NOT NULL,
  attesting_org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  attesting_org_name text NOT NULL,
  subject_name text NOT NULL,
  subject_credential_id uuid REFERENCES public.anchors(id) ON DELETE SET NULL,
  attestation_statement text NOT NULL,
  notary_name text,
  notary_commission_state text,
  notary_commission_number text,
  docusign_envelope_id text,
  docusign_completed_at timestamptz,
  notarization_completed_at timestamptz,
  anchor_id uuid REFERENCES public.anchors(id) ON DELETE SET NULL,
  anchor_timestamp timestamptz,
  public_verification_url text,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legally_binding_attestations_public_id_prefix
    CHECK (attestation_id LIKE 'ARK-ATT-%'),
  CONSTRAINT legally_binding_attestations_type_check
    CHECK (attestation_type IN ('notarized', 'witnessed', 'standard')),
  CONSTRAINT legally_binding_attestations_status_check
    CHECK (status IN ('draft', 'pending_notarization', 'notarized', 'anchored', 'requires_review')),
  CONSTRAINT legally_binding_attestations_statement_nonempty
    CHECK (length(btrim(attestation_statement)) > 0),
  CONSTRAINT legally_binding_attestations_subject_nonempty
    CHECK (length(btrim(subject_name)) > 0),
  CONSTRAINT legally_binding_attestations_org_name_nonempty
    CHECK (length(btrim(attesting_org_name)) > 0)
);

ALTER TABLE public.legally_binding_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legally_binding_attestations FORCE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS idx_legally_binding_attestations_docusign_envelope_id_unique
  ON public.legally_binding_attestations (docusign_envelope_id)
  WHERE docusign_envelope_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_legally_binding_attestations_attesting_org_id
  ON public.legally_binding_attestations (attesting_org_id);

CREATE INDEX IF NOT EXISTS idx_legally_binding_attestations_status
  ON public.legally_binding_attestations (status);

CREATE INDEX IF NOT EXISTS idx_legally_binding_attestations_anchor_id
  ON public.legally_binding_attestations (anchor_id)
  WHERE anchor_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_legally_binding_attestation_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'legally_binding_attestations must be inserted at draft status'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD.status = 'anchored' AND NEW.status <> 'anchored' THEN
    RAISE EXCEPTION 'anchored legally_binding_attestations cannot transition to %', NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'anchored' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'anchored legally_binding_attestations are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'requires_review' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'pending_notarization' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending_notarization' AND NEW.status = 'notarized' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'notarized' AND NEW.status = 'anchored' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid legally_binding_attestations status transition: % -> %', OLD.status, NEW.status
    USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_legally_binding_attestation_org_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.attestation_type = 'notarized'
     AND NEW.status <> 'requires_review'
     AND NOT EXISTS (
       SELECT 1
       FROM public.organizations o
       WHERE o.id = NEW.attesting_org_id
         AND o.verification_status = 'VERIFIED'
     ) THEN
    RAISE EXCEPTION 'notarized attestations require a VERIFIED organization'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_legally_binding_attestations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER legally_binding_attestations_org_gate
  BEFORE INSERT OR UPDATE ON public.legally_binding_attestations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_legally_binding_attestation_org_gate();

CREATE OR REPLACE TRIGGER legally_binding_attestations_state_machine
  BEFORE INSERT OR UPDATE ON public.legally_binding_attestations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_legally_binding_attestation_state();

CREATE OR REPLACE TRIGGER legally_binding_attestations_updated_at
  BEFORE UPDATE ON public.legally_binding_attestations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_legally_binding_attestations_updated_at();

CREATE POLICY legally_binding_attestations_select_org
  ON public.legally_binding_attestations
  FOR SELECT
  TO authenticated
  USING (attesting_org_id = public.get_user_org_id());

CREATE POLICY legally_binding_attestations_insert_org
  ON public.legally_binding_attestations
  FOR INSERT
  TO authenticated
  WITH CHECK (attesting_org_id = public.get_user_org_id());

CREATE POLICY legally_binding_attestations_update_org
  ON public.legally_binding_attestations
  FOR UPDATE
  TO authenticated
  USING (attesting_org_id = public.get_user_org_id())
  WITH CHECK (attesting_org_id = public.get_user_org_id());

GRANT SELECT, INSERT, UPDATE ON public.legally_binding_attestations TO authenticated;
GRANT ALL ON public.legally_binding_attestations TO service_role;

COMMENT ON TABLE public.legally_binding_attestations IS
  'SCRUM-1871: legal attestation chain metadata only. No notarized document content or raw webhook bodies are stored here. Public verification must be API-mediated and redacted.';

COMMENT ON COLUMN public.legally_binding_attestations.attestation_statement IS
  'Legal attestation statement. Do not copy into audit_events details or public verification payloads.';

COMMENT ON COLUMN public.legally_binding_attestations.docusign_envelope_id IS
  'Nullable DocuSign idempotency key for notarized attestation webhook handling.';

NOTIFY pgrst, 'reload schema';
