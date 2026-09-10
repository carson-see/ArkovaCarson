-- =============================================================================
-- 0429 — Sub-org tenancy foundations (SCRUM-3864, epic SCRUM-3863)
--
-- Closes pre-mortem findings F1 (a parent's sub-org roster is published to
-- anonymous callers with no opt-in) and F2 (credit enforcement is a single
-- GLOBAL flag, so making one partner's sub-org budgets real would 402 every
-- other zero-balance org in prod, including the Login Defense partner org and
-- the UAT demo org).
--
-- WHAT THIS ADDS
--   1. organizations.sub_org_listing_parent_optin  (default FALSE)
--      organizations.sub_org_listing_child_optin   (default FALSE)
--      Two-party consent for publishing a parent->child affiliation. BOTH must
--      be true before the edge appears on any anonymous surface.
--   2. organizations.credit_enforcement_enabled    (default FALSE)
--      Per-org opt-in to anchor-credit enforcement, so a single org tree can be
--      enforced WITHOUT flipping the global switchboard flag for every tenant.
--   3. protect_org_tenancy_fields() — BEFORE UPDATE trigger giving each of the
--      three columns its own write authority. `organizations_update_admin`
--      grants an org admin UPDATE on EVERY column of their own row, so without
--      this trigger an org could switch off its own billing enforcement, and
--      the two-party consent below would be one party clicking twice.
--   4. get_public_org_profile()  — children filtered on both consents.
--   5. get_org_subtree()         — descent pruned on both consents.
--
-- WHY TWO SURFACES, NOT ONE
--   `get_public_org_profile` is the obvious leak, but `get_org_subtree` is
--   ALSO granted to `anon` (verified against prod this session) and walks the
--   affiliation tree to depth 3, returning display_name / domain / description
--   / logo / banner for every descendant. Fixing only the first would leave
--   the roster readable through the second. Both are replaced here.
--
-- WHY THE CHILD CONSENT EXCLUDES PARENT ADMINS
--   The affiliate creation flow (orgSubOrgs.ts buildAffiliateMembershipRows)
--   writes the creating parent admin into the child's `org_members` as `owner`.
--   So `is_org_admin_of(child_id)` is TRUE for the parent admin, and a naive
--   "child admin may set the child flag" rule would let the parent supply both
--   halves of the consent. The child-side guard therefore requires an admin of
--   the child who is NOT an admin of the parent — i.e. the invited sub-org
--   admin. That is the only shape in which the second signature means anything.
--
-- WHY RE-PARENTING RESETS BOTH FLAGS
--   Consent is to a SPECIFIC affiliation. If parent_org_id is repointed, a
--   previously-published edge would silently republish the child under a parent
--   neither party consented to. The trigger clears both flags on any
--   parent_org_id change; the reset runs LAST so it wins over a same-statement
--   attempt to set them.
--
-- FUNCTION BODIES
--   Both function bodies below were captured from the LIVE PROD definition via
--   `pg_get_functiondef` on `vzwyaatejekddvltxyye` this session, NOT copied
--   from an older migration file — the 0376/0385 clobber is exactly what that
--   distinction prevents. The ONLY edits are the added consent predicates,
--   marked `-- 0429:` inline.
--
-- SECURITY (§1.4)
--   - Both functions keep SECURITY DEFINER + `SET search_path = public` and
--     their existing statement_timeout settings. No grant is widened; this
--     migration only ever REMOVES rows from an anonymous projection.
--   - The trigger is SECURITY DEFINER + `SET search_path = public` so its
--     `org_members` reads are not subject to the caller's RLS.
--   - `credit_enforcement_enabled` is writable ONLY by service_role or a
--     platform admin. An org admin changing it raises insufficient_privilege.
--
-- §1.2 HOT TABLE
--   `organizations` is a named hot table, so this file opens with
--   `SET LOCAL lock_timeout = '5s'`. All three columns are NOT NULL with a
--   constant DEFAULT, which is metadata-only on PG11+ (no table rewrite).
--
-- ROLLBACK:
--   ORDER MATTERS. Both functions read the new columns, so the function bodies
--   must be reverted BEFORE the columns are dropped. Dropping the columns first
--   leaves get_public_org_profile() and get_org_subtree() raising
--   "column ... does not exist" on every call -- and both are granted to `anon`,
--   so that is an outage on the public verification surface, not a degradation.
--   Rehearsed in that wrong order during this PR's proof run and it failed
--   exactly that way, which is why the bodies are inlined below rather than
--   left as "restore them from the baseline file".
--
--   Executable as written, top to bottom:
--
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--
--   -- 1. revert the two projections to their pre-0429 bodies
--   CREATE OR REPLACE FUNCTION public.get_public_org_profile(p_org_id uuid)
--    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
--    SET search_path TO 'public' SET statement_timeout TO '10s'
--   AS $rb$
--   DECLARE
--     result jsonb; org_row record; total_count bigint; secured_count bigint;
--     breakdown jsonb; members jsonb; sub_orgs jsonb;
--   BEGIN
--     SELECT id, public_id, display_name, domain, description, org_type,
--            website_url, linkedin_url, twitter_url, logo_url,
--            location, founded_date, industry_tag, verification_status, created_at
--     INTO org_row FROM organizations WHERE id = p_org_id;
--     IF org_row IS NULL THEN RETURN jsonb_build_object('error', 'Organization not found'); END IF;
--     SELECT count(*), count(*) FILTER (WHERE status = 'SECURED')
--     INTO total_count, secured_count FROM anchors
--     WHERE org_id = p_org_id AND deleted_at IS NULL AND (metadata->>'pipeline_source') IS NULL;
--     SELECT coalesce(jsonb_agg(jsonb_build_object('type', credential_type, 'count', cnt) ORDER BY cnt DESC), '[]'::jsonb)
--     INTO breakdown FROM (
--       SELECT credential_type, count(*) AS cnt FROM anchors
--       WHERE org_id = p_org_id AND deleted_at IS NULL AND (metadata->>'pipeline_source') IS NULL
--       GROUP BY credential_type) sub;
--     SELECT coalesce(jsonb_agg(jsonb_build_object(
--       'profile_public_id', CASE WHEN coalesce(p.is_public_profile, false) THEN p.public_id ELSE NULL END,
--       'display_name', CASE WHEN coalesce(p.is_public_profile, false) THEN coalesce(nullif(p.full_name, ''), 'Public member') ELSE 'Anonymous member' END,
--       'avatar_url', CASE WHEN coalesce(p.is_public_profile, false) THEN p.avatar_url ELSE NULL END,
--       'role', om.role, 'is_public_profile', coalesce(p.is_public_profile, false)
--     ) ORDER BY CASE om.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,
--       CASE WHEN coalesce(p.is_public_profile, false) THEN coalesce(p.full_name, p.public_id) ELSE p.public_id END
--     ), '[]'::jsonb) INTO members
--     FROM org_members om JOIN profiles p ON p.id = om.user_id WHERE om.org_id = p_org_id;
--     SELECT coalesce(jsonb_agg(jsonb_build_object(
--       'org_id', child.id, 'public_id', child.public_id, 'display_name', child.display_name,
--       'domain', child.domain, 'description', child.description, 'logo_url', child.logo_url,
--       'org_type', child.org_type, 'website_url', child.website_url,
--       'verification_status', child.verification_status
--     ) ORDER BY child.display_name), '[]'::jsonb) INTO sub_orgs
--     FROM organizations child
--     WHERE child.parent_org_id = p_org_id AND child.parent_approval_status = 'APPROVED';
--     result := jsonb_build_object(
--       'org_id', org_row.id, 'public_id', org_row.public_id, 'display_name', org_row.display_name,
--       'domain', org_row.domain, 'description', org_row.description, 'org_type', org_row.org_type,
--       'website_url', org_row.website_url, 'linkedin_url', org_row.linkedin_url,
--       'twitter_url', org_row.twitter_url, 'logo_url', org_row.logo_url,
--       'location', org_row.location, 'founded_date', org_row.founded_date,
--       'industry_tag', org_row.industry_tag, 'verification_status', org_row.verification_status,
--       'created_at', org_row.created_at, 'total_credentials', total_count,
--       'secured_credentials', secured_count, 'credential_breakdown', breakdown,
--       'public_members', members, 'sub_organizations', sub_orgs);
--     RETURN result;
--   END; $rb$;
--
--   CREATE OR REPLACE FUNCTION public.get_org_subtree(p_root_id uuid, p_max_depth integer DEFAULT 3)
--    RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
--    SET search_path TO 'public' SET statement_timeout TO '5s'
--   AS $rb$
--   DECLARE effective_depth integer := greatest(1, least(coalesce(p_max_depth, 3), 3)); result jsonb;
--   BEGIN
--     IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = p_root_id) THEN
--       RETURN jsonb_build_object('error', 'Organization not found'); END IF;
--     WITH RECURSIVE tree AS (
--       SELECT o.id, o.public_id, o.parent_org_id, o.parent_approval_status,
--         o.display_name, o.domain, o.description, o.logo_url, o.banner_url,
--         o.org_type, o.website_url, o.verification_status,
--         o.verified_badge_granted_at, 1 AS depth
--       FROM organizations o WHERE o.id = p_root_id
--       UNION ALL
--       SELECT o.id, o.public_id, o.parent_org_id, o.parent_approval_status,
--         o.display_name, o.domain, o.description, o.logo_url, o.banner_url,
--         o.org_type, o.website_url, o.verification_status,
--         o.verified_badge_granted_at, t.depth + 1
--       FROM organizations o JOIN tree t ON t.id = o.parent_org_id
--       WHERE t.depth < effective_depth
--         AND coalesce(o.parent_approval_status, 'APPROVED') = 'APPROVED')
--     SELECT jsonb_build_object('root_id', p_root_id, 'max_depth', effective_depth,
--       'nodes', coalesce(jsonb_agg(jsonb_build_object(
--         'org_id', t.id, 'display_name', t.display_name, 'depth', t.depth
--       ) ORDER BY t.depth, t.display_name), '[]'::jsonb)) INTO result FROM tree t;
--     RETURN result;
--   END; $rb$;
--
--   -- 2. only now remove the trigger and the columns it guards
--   DROP TRIGGER IF EXISTS trg_protect_org_tenancy_fields ON public.organizations;
--   DROP FUNCTION IF EXISTS public.protect_org_tenancy_fields();
--   ALTER TABLE public.organizations
--     DROP COLUMN IF EXISTS sub_org_listing_parent_optin,
--     DROP COLUMN IF EXISTS sub_org_listing_child_optin,
--     DROP COLUMN IF EXISTS credit_enforcement_enabled;
--   COMMIT;
--
--   NOTE: rolling back re-opens F1 -- every APPROVED affiliation becomes
--   publicly listed again. Roll back only for a functional defect, and tell the
--   affected partner orgs before you do.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ─── 1. Columns ──────────────────────────────────────────────────────────────

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS sub_org_listing_parent_optin boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sub_org_listing_child_optin  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS credit_enforcement_enabled   boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.organizations.sub_org_listing_parent_optin IS
  'SCRUM-3864: the PARENT org has consented to publishing this affiliation. Writable only by an admin of organizations.parent_org_id (or service_role / platform admin). Reset to false whenever parent_org_id changes.';

COMMENT ON COLUMN public.organizations.sub_org_listing_child_optin IS
  'SCRUM-3864: THIS org has consented to being published as a sub-org of its parent. Writable only by an admin of this org who is NOT also an admin of the parent (the parent admin is an org_members owner of every affiliate it creates). Reset to false whenever parent_org_id changes.';

COMMENT ON COLUMN public.organizations.credit_enforcement_enabled IS
  'SCRUM-3864: per-org opt-in to anchor-credit enforcement. The worker enforces when the global ENABLE_ORG_CREDIT_ENFORCEMENT flag is on OR this column is true, so one org tree can be enforced without 402-ing every other zero-balance tenant. Writable only by service_role or a platform admin.';

-- ─── 2. Column write-authority trigger ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.protect_org_tenancy_fields()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  caller_role text;
BEGIN
  caller_role := get_caller_role();

  -- Column guards apply to ordinary callers only. Trusted callers (the
  -- worker's service_role client, platform operators) skip them -- but they do
  -- NOT skip the re-parent reset below, which is an invariant rather than an
  -- authorization rule and so is written once, after this block, for both
  -- caller classes.
  -- NULL-SAFE, and load-bearing. `get_caller_role()` returns NULL for an
  -- ordinary authenticated caller (no `request.jwt.claim.role` GUC), so a bare
  -- `NOT (caller_role = 'service_role' OR ...)` evaluates to NULL, the branch
  -- does not execute, and EVERY column guard below silently becomes a no-op.
  -- Caught by this PR's behaviour proof, which went 20/20 -> 15/20 on exactly
  -- the negative-authority cases. Same three-valued-logic class as the
  -- identity-guard fixes in 0380/0391/0392.
  IF NOT (
    coalesce(caller_role = 'service_role', false)
    OR coalesce(is_current_user_platform_admin(), false)
  ) THEN

    -- Billing enforcement is never self-service: an org must not be able to
    -- switch off the gate that bills it.
    IF OLD.credit_enforcement_enabled IS DISTINCT FROM NEW.credit_enforcement_enabled THEN
      RAISE EXCEPTION 'Cannot modify credit_enforcement_enabled directly'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Parent half of the consent: only an admin of the CURRENT parent org.
    IF OLD.sub_org_listing_parent_optin IS DISTINCT FROM NEW.sub_org_listing_parent_optin THEN
      IF OLD.parent_org_id IS NULL OR NOT is_org_admin_of(OLD.parent_org_id) THEN
        RAISE EXCEPTION 'Only an admin of the parent organization may change sub_org_listing_parent_optin'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;

    -- Child half of the consent: an admin of THIS org who is not also an admin
    -- of the parent. See the header note -- the parent admin is an org_members
    -- owner of every affiliate it creates, so without the second clause one
    -- party could sign both halves.
    IF OLD.sub_org_listing_child_optin IS DISTINCT FROM NEW.sub_org_listing_child_optin THEN
      IF NOT is_org_admin_of(OLD.id) THEN
        RAISE EXCEPTION 'Only an admin of this organization may change sub_org_listing_child_optin'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF OLD.parent_org_id IS NOT NULL AND is_org_admin_of(OLD.parent_org_id) THEN
        RAISE EXCEPTION 'A parent-org admin may not supply the sub-organization''s own listing consent'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;

  END IF;

  -- Consent is to a specific affiliation. Repointing the parent revokes both
  -- halves, for EVERY caller. Runs after the guards above so an unrelated
  -- re-parent by a trusted caller cannot trip the parent-consent check, and
  -- last overall so it wins over any same-statement assignment.
  IF OLD.parent_org_id IS DISTINCT FROM NEW.parent_org_id THEN
    NEW.sub_org_listing_parent_optin := false;
    NEW.sub_org_listing_child_optin  := false;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.protect_org_tenancy_fields() OWNER TO postgres;

COMMENT ON FUNCTION public.protect_org_tenancy_fields() IS
  'SCRUM-3864: per-column write authority for the sub-org tenancy columns on organizations. organizations_update_admin grants an org admin UPDATE on every column of their own row, so these three need their own guard.';

REVOKE ALL ON FUNCTION public.protect_org_tenancy_fields() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_protect_org_tenancy_fields ON public.organizations;
CREATE TRIGGER trg_protect_org_tenancy_fields
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_org_tenancy_fields();

-- ─── 3. get_public_org_profile — children require both consents ──────────────
-- Body captured from live prod via pg_get_functiondef. Only the two lines
-- marked `-- 0429:` differ from the deployed definition.

CREATE OR REPLACE FUNCTION public.get_public_org_profile(p_org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '10s'
AS $function$
DECLARE
  result jsonb;
  org_row record;
  total_count bigint;
  secured_count bigint;
  breakdown jsonb;
  members jsonb;
  sub_orgs jsonb;
BEGIN
  SELECT id, public_id, display_name, domain, description, org_type,
         website_url, linkedin_url, twitter_url, logo_url,
         location, founded_date, industry_tag, verification_status, created_at
  INTO org_row
  FROM organizations
  WHERE id = p_org_id;

  IF org_row IS NULL THEN
    RETURN jsonb_build_object('error', 'Organization not found');
  END IF;

  SELECT count(*), count(*) FILTER (WHERE status = 'SECURED')
  INTO total_count, secured_count
  FROM anchors
  WHERE org_id = p_org_id
    AND deleted_at IS NULL
    AND (metadata->>'pipeline_source') IS NULL;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'type', credential_type,
    'count', cnt
  ) ORDER BY cnt DESC), '[]'::jsonb)
  INTO breakdown
  FROM (
    SELECT credential_type, count(*) AS cnt
    FROM anchors
    WHERE org_id = p_org_id
      AND deleted_at IS NULL
      AND (metadata->>'pipeline_source') IS NULL
    GROUP BY credential_type
  ) sub;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'profile_public_id', CASE WHEN coalesce(p.is_public_profile, false) THEN p.public_id ELSE NULL END,
    'display_name', CASE
      WHEN coalesce(p.is_public_profile, false) THEN coalesce(nullif(p.full_name, ''), 'Public member')
      ELSE 'Anonymous member'
    END,
    'avatar_url', CASE WHEN coalesce(p.is_public_profile, false) THEN p.avatar_url ELSE NULL END,
    'role', om.role,
    'is_public_profile', coalesce(p.is_public_profile, false)
  ) ORDER BY
    CASE om.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,
    CASE WHEN coalesce(p.is_public_profile, false) THEN coalesce(p.full_name, p.public_id) ELSE p.public_id END
  ), '[]'::jsonb)
  INTO members
  FROM org_members om
  JOIN profiles p ON p.id = om.user_id
  WHERE om.org_id = p_org_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'org_id', child.id,
    'public_id', child.public_id,
    'display_name', child.display_name,
    'domain', child.domain,
    'description', child.description,
    'logo_url', child.logo_url,
    'org_type', child.org_type,
    'website_url', child.website_url,
    'verification_status', child.verification_status
  ) ORDER BY child.display_name), '[]'::jsonb)
  INTO sub_orgs
  FROM organizations child
  WHERE child.parent_org_id = p_org_id
    AND child.parent_approval_status = 'APPROVED'
    -- 0429: two-party consent. Absent either signature the affiliation is
    -- 0429: confidential and the child is omitted entirely.
    AND child.sub_org_listing_parent_optin
    AND child.sub_org_listing_child_optin;

  result := jsonb_build_object(
    'org_id', org_row.id,
    'public_id', org_row.public_id,
    'display_name', org_row.display_name,
    'domain', org_row.domain,
    'description', org_row.description,
    'org_type', org_row.org_type,
    'website_url', org_row.website_url,
    'linkedin_url', org_row.linkedin_url,
    'twitter_url', org_row.twitter_url,
    'logo_url', org_row.logo_url,
    'location', org_row.location,
    'founded_date', org_row.founded_date,
    'industry_tag', org_row.industry_tag,
    'verification_status', org_row.verification_status,
    'created_at', org_row.created_at,
    'total_credentials', total_count,
    'secured_credentials', secured_count,
    'credential_breakdown', breakdown,
    'public_members', members,
    'sub_organizations', sub_orgs
  );

  RETURN result;
END;
$function$;

ALTER FUNCTION public.get_public_org_profile(uuid) OWNER TO postgres;

-- ─── 4. get_org_subtree — descent pruned on both consents ────────────────────
-- Body captured from the deployed definition. Only the two lines marked
-- `-- 0429:` differ. Pruning at the recursive term (rather than filtering the
-- final aggregate) means a non-consenting node hides its whole branch: a
-- grandchild must not be reachable through a child that stayed confidential.

CREATE OR REPLACE FUNCTION public.get_org_subtree(p_root_id uuid, p_max_depth integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '5s'
AS $function$
DECLARE
  effective_depth integer := greatest(1, least(coalesce(p_max_depth, 3), 3));
  result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = p_root_id) THEN
    RETURN jsonb_build_object('error', 'Organization not found');
  END IF;
  WITH RECURSIVE tree AS (
    SELECT
      o.id, o.public_id, o.parent_org_id, o.parent_approval_status,
      o.display_name, o.domain, o.description, o.logo_url, o.banner_url,
      o.org_type, o.website_url, o.verification_status,
      o.verified_badge_granted_at,
      o.sub_org_listing_parent_optin, o.sub_org_listing_child_optin,
      1 AS depth
    FROM organizations o WHERE o.id = p_root_id
    UNION ALL
    SELECT
      o.id, o.public_id, o.parent_org_id, o.parent_approval_status,
      o.display_name, o.domain, o.description, o.logo_url, o.banner_url,
      o.org_type, o.website_url, o.verification_status,
      o.verified_badge_granted_at,
      o.sub_org_listing_parent_optin, o.sub_org_listing_child_optin,
      t.depth + 1
    FROM organizations o JOIN tree t ON t.id = o.parent_org_id
    WHERE t.depth < effective_depth
      AND coalesce(o.parent_approval_status, 'APPROVED') = 'APPROVED'
      -- 0429: two-party consent, applied at the recursive term so a
      -- 0429: confidential child also hides everything beneath it.
      AND o.sub_org_listing_parent_optin
      AND o.sub_org_listing_child_optin
  )
  SELECT jsonb_build_object(
    'root_id', p_root_id,
    'max_depth', effective_depth,
    'nodes', coalesce(jsonb_agg(jsonb_build_object(
      'org_id', t.id, 'public_id', t.public_id,
      -- 0429: the ROOT node is returned unconditionally (you already named it),
      -- 0429: so emitting its parent_org_id would disclose the very affiliation
      -- 0429: the consents protect -- readable by anyone holding the child's id,
      -- 0429: which get_public_org_profiles hands out. Gate the edge on the
      -- 0429: node's OWN consents; descendants are already filtered, so theirs
      -- 0429: are true by construction.
      'parent_org_id', CASE
        WHEN t.sub_org_listing_parent_optin AND t.sub_org_listing_child_optin
        THEN t.parent_org_id ELSE NULL END,
      'display_name', t.display_name, 'domain', t.domain,
      'description', t.description, 'logo_url', t.logo_url,
      'banner_url', t.banner_url, 'org_type', t.org_type,
      'website_url', t.website_url,
      'verification_status', t.verification_status,
      'verified_badge_granted_at', t.verified_badge_granted_at,
      'depth', t.depth
    ) ORDER BY t.depth, t.display_name), '[]'::jsonb)
  ) INTO result FROM tree t;
  RETURN result;
END;
$function$;

ALTER FUNCTION public.get_org_subtree(uuid, integer) OWNER TO postgres;

COMMIT;
