-- SCRUM-5139 / UAT-12: reconcile the mandatory-MFA policy on tables created
-- after 0451 enumerated the then-current RLS surface.
--
-- 0461 is immutable because it has already been applied to the owned UAT-17
-- staging candidate. Its private-tags policy has the correct predicate but a
-- non-canonical name, while the two service-only tables have no restrictive
-- authenticated policy. The UAT-04 ratchet intentionally requires the exact
-- canonical policy on every public RLS table, including service-only tables,
-- so future grants cannot silently bypass MFA.
--
-- Rollback:
--   DROP POLICY IF EXISTS mfa_verified_authenticated ON public.anchor_private_tags;
--   DROP POLICY IF EXISTS mfa_verified_authenticated ON public.anchor_instant_intents;
--   DROP POLICY IF EXISTS mfa_verified_authenticated ON public.anchor_credit_purchases;
--   CREATE POLICY anchor_private_tags_mfa ON public.anchor_private_tags
--     AS RESTRICTIVE FOR ALL TO authenticated
--     USING (private.is_human_mfa_verified())
--     WITH CHECK (private.is_human_mfa_verified());

BEGIN;

DROP POLICY IF EXISTS anchor_private_tags_mfa ON public.anchor_private_tags;

CREATE POLICY mfa_verified_authenticated ON public.anchor_private_tags
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (private.is_human_mfa_verified())
  WITH CHECK (private.is_human_mfa_verified());

CREATE POLICY mfa_verified_authenticated ON public.anchor_instant_intents
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (private.is_human_mfa_verified())
  WITH CHECK (private.is_human_mfa_verified());

CREATE POLICY mfa_verified_authenticated ON public.anchor_credit_purchases
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (private.is_human_mfa_verified())
  WITH CHECK (private.is_human_mfa_verified());

COMMIT;

