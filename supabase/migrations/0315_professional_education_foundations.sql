-- ROLLBACK:
--   DROP TABLE IF EXISTS public.cle_provider_registry;
--   DROP TABLE IF EXISTS public.cpe_provider_registry;
--   ALTER TABLE public.anchors DROP CONSTRAINT IF EXISTS anchors_cle_metadata_is_object;
--   ALTER TABLE public.anchors DROP CONSTRAINT IF EXISTS anchors_cpe_metadata_is_object;
--   ALTER TABLE public.anchors DROP COLUMN IF EXISTS cle_metadata;
--   ALTER TABLE public.anchors DROP COLUMN IF EXISTS cpe_metadata;

BEGIN;

ALTER TYPE public.credential_type ADD VALUE IF NOT EXISTS 'CPE';

COMMENT ON TYPE public.credential_type IS
  'Classification of anchored credential documents. CPE = Continuing Professional Education; CLE = Continuing Legal Education credit.';

ALTER TABLE public.anchors
  ADD COLUMN IF NOT EXISTS cpe_metadata jsonb,
  ADD COLUMN IF NOT EXISTS cle_metadata jsonb;

ALTER TABLE public.anchors
  DROP CONSTRAINT IF EXISTS anchors_cpe_metadata_is_object,
  ADD CONSTRAINT anchors_cpe_metadata_is_object
    CHECK (cpe_metadata IS NULL OR jsonb_typeof(cpe_metadata) = 'object'),
  DROP CONSTRAINT IF EXISTS anchors_cle_metadata_is_object,
  ADD CONSTRAINT anchors_cle_metadata_is_object
    CHECK (cle_metadata IS NULL OR jsonb_typeof(cle_metadata) = 'object');

COMMENT ON COLUMN public.anchors.cpe_metadata IS
  'R-CPE-01 structured CPE compliance metadata. Same row-level visibility as anchors.metadata; write via worker typed accessors.';

COMMENT ON COLUMN public.anchors.cle_metadata IS
  'R-LEGAL-01 structured CLE compliance metadata. Same row-level visibility as anchors.metadata; write via worker typed accessors.';

CREATE TABLE IF NOT EXISTS public.cpe_provider_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name text NOT NULL,
  provider_domain text,
  nasba_sponsor_id text,
  delivery_methods text[] NOT NULL DEFAULT '{}',
  nasba_status text NOT NULL,
  last_verified_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cpe_provider_registry_provider_name_nonempty CHECK (length(btrim(provider_name)) > 0),
  CONSTRAINT cpe_provider_registry_provider_domain_lower CHECK (provider_domain IS NULL OR provider_domain = lower(provider_domain)),
  CONSTRAINT cpe_provider_registry_nasba_status_check CHECK (nasba_status IN ('confirmed', 'not_found', 'unknown'))
);

CREATE UNIQUE INDEX IF NOT EXISTS cpe_provider_registry_provider_domain_key
  ON public.cpe_provider_registry (provider_domain)
  WHERE provider_domain IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cpe_provider_registry_provider_name_key
  ON public.cpe_provider_registry (lower(provider_name));

ALTER TABLE public.cpe_provider_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cpe_provider_registry FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cpe_provider_registry_service_role_all" ON public.cpe_provider_registry;
CREATE POLICY "cpe_provider_registry_service_role_all" ON public.cpe_provider_registry
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.cpe_provider_registry IS
  'Internal CPE provider registry for NASBA status lookup. Operator/service-role managed only; no anon/authenticated writes.';

GRANT ALL ON public.cpe_provider_registry TO service_role;

INSERT INTO public.cpe_provider_registry (
  provider_name,
  provider_domain,
  nasba_sponsor_id,
  delivery_methods,
  nasba_status,
  last_verified_date,
  notes
)
VALUES
  ('Udemy', 'udemy.com', NULL, ARRAY['QAS Self-Study'], 'confirmed', DATE '2026-05-14', 'Confirmed NASBA sponsor for NASBA-designated courses; sponsor ID is certificate/course-specific.'),
  ('Accredible', 'accredible.com', NULL, ARRAY[]::text[], 'not_found', DATE '2026-05-14', 'Credential host, not itself a NASBA sponsor. Lookup underlying issuer.'),
  ('Credly', 'credly.com', NULL, ARRAY[]::text[], 'not_found', DATE '2026-05-14', 'Badge host, not itself a NASBA sponsor. Lookup underlying issuer.'),
  ('Coursera for Business', 'coursera.org', NULL, ARRAY['QAS Self-Study', 'Group Internet Based'], 'unknown', NULL, 'Requires manual confirmation before treating as NASBA-confirmed.'),
  ('LinkedIn Learning', 'linkedin.com', NULL, ARRAY['QAS Self-Study'], 'unknown', NULL, 'Requires manual confirmation before treating as NASBA-confirmed.'),
  ('CPAacademy', 'cpaacademy.org', NULL, ARRAY['Group Internet Based'], 'unknown', NULL, 'Requires manual confirmation before treating as NASBA-confirmed.')
ON CONFLICT (lower(provider_name)) DO UPDATE
SET provider_domain = EXCLUDED.provider_domain,
    nasba_sponsor_id = EXCLUDED.nasba_sponsor_id,
    delivery_methods = EXCLUDED.delivery_methods,
    nasba_status = EXCLUDED.nasba_status,
    last_verified_date = EXCLUDED.last_verified_date,
    notes = EXCLUDED.notes,
    updated_at = now();

CREATE TABLE IF NOT EXISTS public.cle_provider_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name text NOT NULL,
  provider_domain text,
  approved_jurisdictions text[] NOT NULL DEFAULT '{}',
  approval_status text NOT NULL,
  last_verified_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cle_provider_registry_provider_name_nonempty CHECK (length(btrim(provider_name)) > 0),
  CONSTRAINT cle_provider_registry_provider_domain_lower CHECK (provider_domain IS NULL OR provider_domain = lower(provider_domain)),
  CONSTRAINT cle_provider_registry_approval_status_check CHECK (approval_status IN ('approved', 'not_approved', 'unknown'))
);

CREATE UNIQUE INDEX IF NOT EXISTS cle_provider_registry_provider_domain_key
  ON public.cle_provider_registry (provider_domain)
  WHERE provider_domain IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cle_provider_registry_provider_name_key
  ON public.cle_provider_registry (lower(provider_name));

ALTER TABLE public.cle_provider_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cle_provider_registry FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cle_provider_registry_service_role_all" ON public.cle_provider_registry;
CREATE POLICY "cle_provider_registry_service_role_all" ON public.cle_provider_registry
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.cle_provider_registry IS
  'Internal CLE provider registry for state-bar approval lookup. Operator/service-role managed only; no anon/authenticated writes.';

GRANT ALL ON public.cle_provider_registry TO service_role;

INSERT INTO public.cle_provider_registry (
  provider_name,
  provider_domain,
  approved_jurisdictions,
  approval_status,
  last_verified_date,
  notes
)
VALUES
  ('Practising Law Institute', 'pli.edu', ARRAY['MULTI_STATE'], 'approved', DATE '2026-05-15', 'National CLE provider; jurisdiction-specific approval still controls credit acceptance.'),
  ('Westlaw CLE', 'legal.thomsonreuters.com', ARRAY['MULTI_STATE'], 'approved', DATE '2026-05-15', 'Multi-state CLE provider; jurisdiction-specific approval still controls credit acceptance.'),
  ('American Bar Association', 'americanbar.org', ARRAY['MULTI_STATE'], 'approved', DATE '2026-05-15', 'National legal association CLE provider; verify jurisdiction-specific approvals per course.'),
  ('Coursera Legal', 'coursera.org', ARRAY[]::text[], 'unknown', NULL, 'Requires manual confirmation before treating as state-bar approved.'),
  ('Alabama State Bar', NULL, ARRAY['AL'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Alaska Bar Association', NULL, ARRAY['AK'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('State Bar of Arizona', NULL, ARRAY['AZ'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Arkansas Bar Association', NULL, ARRAY['AR'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('State Bar of California', NULL, ARRAY['CA'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Colorado Supreme Court Office of Attorney Regulation Counsel', NULL, ARRAY['CO'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Connecticut Bar Association', NULL, ARRAY['CT'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Delaware State Bar Association', NULL, ARRAY['DE'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('The Florida Bar', NULL, ARRAY['FL'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('State Bar of Georgia', NULL, ARRAY['GA'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Hawaii State Bar Association', NULL, ARRAY['HI'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Idaho State Bar', NULL, ARRAY['ID'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Illinois State Bar Association', NULL, ARRAY['IL'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Indiana State Bar Association', NULL, ARRAY['IN'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Iowa State Bar Association', NULL, ARRAY['IA'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Kansas Bar Association', NULL, ARRAY['KS'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Kentucky Bar Association', NULL, ARRAY['KY'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Louisiana State Bar Association', NULL, ARRAY['LA'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Maine State Bar Association', NULL, ARRAY['ME'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Maryland State Bar Association', NULL, ARRAY['MD'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Massachusetts Board of Bar Overseers', NULL, ARRAY['MA'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('State Bar of Michigan', NULL, ARRAY['MI'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Minnesota State Bar Association', NULL, ARRAY['MN'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('The Mississippi Bar', NULL, ARRAY['MS'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('The Missouri Bar', NULL, ARRAY['MO'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('State Bar of Montana', NULL, ARRAY['MT'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Nebraska State Bar Association', NULL, ARRAY['NE'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('State Bar of Nevada', NULL, ARRAY['NV'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('New Hampshire Bar Association', NULL, ARRAY['NH'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('New Jersey State Bar Association', NULL, ARRAY['NJ'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('State Bar of New Mexico', NULL, ARRAY['NM'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('New York State CLE Board', NULL, ARRAY['NY'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('North Carolina State Bar', NULL, ARRAY['NC'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('State Bar Association of North Dakota', NULL, ARRAY['ND'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Ohio State Bar Association', NULL, ARRAY['OH'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Oklahoma Bar Association', NULL, ARRAY['OK'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Oregon State Bar', NULL, ARRAY['OR'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Pennsylvania Bar Association', NULL, ARRAY['PA'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Rhode Island Bar Association', NULL, ARRAY['RI'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('South Carolina Bar', NULL, ARRAY['SC'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('State Bar of South Dakota', NULL, ARRAY['SD'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Tennessee Bar Association', NULL, ARRAY['TN'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('State Bar of Texas', NULL, ARRAY['TX'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Utah State Bar', NULL, ARRAY['UT'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Vermont Bar Association', NULL, ARRAY['VT'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Virginia State Bar', NULL, ARRAY['VA'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Washington State Bar Association', NULL, ARRAY['WA'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('West Virginia State Bar', NULL, ARRAY['WV'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('State Bar of Wisconsin', NULL, ARRAY['WI'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.'),
  ('Wyoming State Bar', NULL, ARRAY['WY'], 'approved', DATE '2026-05-15', 'State bar seed entry; domain intentionally unset until operator verification.')
ON CONFLICT (lower(provider_name)) DO UPDATE
SET provider_domain = EXCLUDED.provider_domain,
    approved_jurisdictions = EXCLUDED.approved_jurisdictions,
    approval_status = EXCLUDED.approval_status,
    last_verified_date = EXCLUDED.last_verified_date,
    notes = EXCLUDED.notes,
    updated_at = now();

CREATE OR REPLACE FUNCTION public.prevent_metadata_edit_after_secured() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'public'
AS $$
BEGIN
  IF get_caller_role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF (OLD.metadata IS NOT DISTINCT FROM NEW.metadata)
     AND (OLD.description IS NOT DISTINCT FROM NEW.description)
     AND (OLD.cpe_metadata IS NOT DISTINCT FROM NEW.cpe_metadata)
     AND (OLD.cle_metadata IS NOT DISTINCT FROM NEW.cle_metadata)
  THEN
    RETURN NEW;
  END IF;

  IF OLD.status != 'PENDING' THEN
    IF OLD.description IS NULL AND NEW.description IS NOT NULL
       AND (OLD.metadata IS NOT DISTINCT FROM NEW.metadata)
       AND (OLD.cpe_metadata IS NOT DISTINCT FROM NEW.cpe_metadata)
       AND (OLD.cle_metadata IS NOT DISTINCT FROM NEW.cle_metadata)
    THEN
      RETURN NEW;
    END IF;

    IF OLD.metadata IS DISTINCT FROM NEW.metadata THEN
      RAISE EXCEPTION 'Cannot modify metadata after anchor has been secured. Current status: %', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.cpe_metadata IS DISTINCT FROM NEW.cpe_metadata THEN
      RAISE EXCEPTION 'Cannot modify cpe_metadata after anchor has been secured. Current status: %', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.cle_metadata IS DISTINCT FROM NEW.cle_metadata THEN
      RAISE EXCEPTION 'Cannot modify cle_metadata after anchor has been secured. Current status: %', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.description IS DISTINCT FROM NEW.description THEN
      RAISE EXCEPTION 'Cannot modify description after anchor has been secured. Current status: %', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.prevent_metadata_edit_after_secured() IS
  'Prevents metadata, CPE/CLE metadata, and description edits on non-PENDING anchors for regular users. Service role (pipeline) is exempt.';

NOTIFY pgrst, 'reload schema';

COMMIT;
