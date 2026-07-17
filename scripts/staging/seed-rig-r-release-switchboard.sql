-- RIG-R-only release-path switchboard seed.
-- The live app reads these DB rows before JWT auth; env flags do not override
-- a missing/false ENABLE_VERIFICATION_API result. Keep this isolated from the
-- shared baseline seed so no other rig or environment is enabled implicitly.

BEGIN;

INSERT INTO public.switchboard_flags (flag_key, enabled, description)
VALUES
  ('ENABLE_VERIFICATION_API', true, 'RIG-R isolated release auth-boundary verification'),
  ('ENABLE_AI_EXTRACTION', true, 'RIG-R isolated release AI-path verification')
ON CONFLICT (flag_key) DO UPDATE
SET enabled = EXCLUDED.enabled,
    description = EXCLUDED.description,
    updated_at = NOW();

COMMIT;

-- Independent post-commit readback. Any missing/false row aborts provisioning.
DO $$
DECLARE
  exact_enabled_count integer;
BEGIN
  SELECT count(*)
    INTO exact_enabled_count
  FROM public.switchboard_flags
  WHERE flag_key IN ('ENABLE_VERIFICATION_API', 'ENABLE_AI_EXTRACTION')
    AND enabled IS TRUE;

  IF exact_enabled_count <> 2 THEN
    RAISE EXCEPTION 'RIG-R release switchboard readback is not exact true/true';
  END IF;
END
$$;

SELECT jsonb_object_agg(flag_key, enabled ORDER BY flag_key) AS exact_rig_r_switchboard_readback
FROM public.switchboard_flags
WHERE flag_key IN ('ENABLE_VERIFICATION_API', 'ENABLE_AI_EXTRACTION');
