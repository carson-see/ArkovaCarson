-- Staging-rig lease table. Lives on the arkova-staging Supabase branch.
-- DO NOT apply this to prod — there is no `staging_lease` concept in prod.
--
-- Used by scripts/staging/claim.sh to prevent two engineers (or two
-- agents) from soaking conflicting changes simultaneously.

CREATE TABLE IF NOT EXISTS public.staging_lease (
  pr_number     bigint PRIMARY KEY,
  reason        text NOT NULL,
  acquired_by   text NOT NULL,
  acquired_at   timestamptz NOT NULL DEFAULT now()
);

-- Service-role-only access. claim.sh authenticates with the service role key.
ALTER TABLE public.staging_lease ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staging_lease FORCE ROW LEVEL SECURITY;

-- No anon / authenticated policies — service role bypasses RLS.

CREATE INDEX IF NOT EXISTS idx_staging_lease_acquired_at
  ON public.staging_lease (acquired_at DESC);

-- ROLLBACK:
-- DROP TABLE IF EXISTS public.staging_lease;
