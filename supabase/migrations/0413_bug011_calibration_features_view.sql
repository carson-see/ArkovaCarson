-- BUG-011 (P2, 2026-08 soak) — `POST /jobs/calibration-refit` returns 500 on
-- every run: `PGRST205 Could not find the table 'public.calibration_features'`.
--
-- The view does not exist in production either — `information_schema.tables`
-- count = 0. `runCalibrationRefit()` queries it by name and its own comment
-- cites "Migration 0222", which is real but archived
-- (`docs/migrations-archive/0222_calibration_features_view.sql`): the Path C
-- cutover (SCRUM-1668) replaced the 0000..0289 chain with a `pg_dump` of prod,
-- and the view was not in prod to be dumped. The archive README's "the runtime
-- schema came from these migrations being applied to prod" does not hold for
-- 0222.
--
-- WHY CREATE IT RATHER THAN MAKE THE ROUTE FAIL LOUDLY
--
-- "Unimplemented" would be false, and shipping a `501` would say so. The job IS
-- implemented and complete — it samples 7 days of extraction results, re-derives
-- per-type calibration knots, and reports ΔPearson-r against the production
-- knots. It is registered in cron (`0 3 * * 1`) and wrapped in
-- `withCronMonitoring`. What is missing is one schema object it was written
-- against, and only because a squash dropped it. The repo still carries the
-- evidence that this view is expected to exist: it is named in
-- `scripts/ci/snapshots/views-security-invoker-baseline.json` (grandfathered as
-- a pre-existing definer view under SCRUM-1276) and 0281's header lists it among
-- the views a follow-up should convert.
--
-- The job is also read-only and advisory — `derivePerTypeCalibrationKnots`
-- returns PROPOSED knots and nothing auto-applies them, so restoring it cannot
-- move production calibration on its own. Turning the route into a loud 501
-- would permanently retire the only feedback loop measuring whether reported
-- extraction confidence tracks actual accuracy, to avoid recreating five
-- columns.
--
-- WHAT CHANGES vs THE ARCHIVED 0222
--
--   1. `WITH (security_invoker = true)`. Postgres views default to the OWNER's
--      privileges, so a definer view over `anchors` would evaluate no RLS for
--      the caller — a cross-tenant read surface waiting for someone to widen a
--      grant. 0222 predates the SCRUM-1276 rule; this does not. The sole caller
--      is the worker's service_role client, which bypasses RLS anyway, so the
--      invoker semantics cost nothing and close the hazard. This is also why
--      `calibration_features` comes OUT of
--      `scripts/ci/snapshots/views-security-invoker-baseline.json` in the same
--      PR: the grandfather entry existed for a view that no longer needs it.
--
--   2. Explicit `REVOKE ALL ... FROM PUBLIC, anon, authenticated` before the
--      grant. The baseline carries `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
--      TABLES TO anon, authenticated` (baseline:15104), which auto-grants every
--      newly created relation — views included. 0222's
--      `REVOKE ALL ... FROM anon, authenticated` was written before that trap
--      was understood; `PUBLIC` is now named explicitly per the 0364 no-op catch.
--
-- The projection itself is unchanged from 0222 so the job's existing select list
-- (`id, credential_type, confidence, extraction_accuracy, created_at`) works
-- untouched. `id` is `anchors.id`: it never leaves the worker — the job maps it
-- to an internal `entryId` and `CalibrationRefitResult` returns only knots and a
-- correlation delta — and the view is service_role-only, so CLAUDE.md §6 is not
-- engaged. No fingerprint is projected; the join uses one but does not select it.
--
-- `database.types.ts` is NOT regenerated here. The shared local Supabase stack
-- is concurrently mutated by other worktree sessions and this PR applies nothing
-- anywhere (2026-08 soak freeze until 2026-08-19T15:51:30Z), so a canonical
-- regeneration is not available. `calibration-refit.ts` reaches the view through
-- an explicit cast and compiles either way. Whoever applies this should run
-- `npm run gen:types` once afterwards, per the 0400 / 0405 precedent.
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS public.calibration_features;
--   NOTIFY pgrst, 'reload schema';
--   (and re-add "calibration_features" to the `grandfathered` array in
--   scripts/ci/snapshots/views-security-invoker-baseline.json only if a bare
--   definer version is ever restored — it should not be.)

-- CREATE VIEW takes only AccessShareLock on the referenced relations, so it is
-- not barrier-forming. The bound is here anyway: `anchors` is a hot table and
-- CLAUDE.md §1.2 costs one line.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE VIEW public.calibration_features
WITH (security_invoker = true) AS
SELECT
  a.id,
  a.credential_type,
  a.created_at,
  (em.confidence_scores->>'overall')::numeric AS confidence,
  aue.confidence AS extraction_accuracy
FROM anchors a
LEFT JOIN extraction_manifests em ON em.anchor_id = a.id
LEFT JOIN ai_usage_events aue
  ON aue.fingerprint = a.fingerprint
  AND aue.event_type = 'extraction'
WHERE em.confidence_scores IS NOT NULL
   OR aue.confidence IS NOT NULL;

ALTER VIEW public.calibration_features OWNER TO postgres;

-- Supabase default privileges auto-grant every new relation to anon +
-- authenticated. Strip that first, then grant only the caller that exists.
REVOKE ALL ON public.calibration_features FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.calibration_features TO service_role;

COMMENT ON VIEW public.calibration_features IS
  'BUG-011 / SCRUM-917: flattened feed for the weekly calibration-refit cron (GME7.3). Joins anchors -> extraction_manifests (confidence_scores.overall) and ai_usage_events (confidence) so the job never queries columns that do not exist on anchors. security_invoker=true (SCRUM-1276): RLS is evaluated against the caller, not the view owner. service_role only — REVOKEd from PUBLIC/anon/authenticated. Originally shipped as archived migration 0222 and lost in the Path C baseline cutover, which is why the route 500d with PGRST205.';

NOTIFY pgrst, 'reload schema';
