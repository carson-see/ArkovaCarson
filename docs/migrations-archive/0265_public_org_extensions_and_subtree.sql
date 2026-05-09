-- Migration: 0265_public_org_extensions_and_subtree.sql
-- SCRUM-1084 PUBLIC-ORG-01 — organizations extensions + depth-3 hierarchy guard.
-- SCRUM-1087 PUBLIC-ORG-04 — server-side recursive subtree resolver (capped depth 3).
--
-- Adds:
--   1. organizations.banner_url — text, NULL OK. Marketing hero banner for the
--      public org page; rendered above the existing logo on /issuer/:id.
--   2. organizations.verified_badge_granted_at — timestamptz, NULL OK. The
--      moment Arkova ops flipped verification_status to 'VERIFIED' is what
--      the verified-issuer badge rolls up against. Backfill is left NULL —
--      historical orgs were verified before this column existed and have
--      no authoritative grant time.
--   3. enforce_org_parent_depth() trigger — rejects an INSERT/UPDATE if the
--      new parent_org_id would put the org at hierarchy depth > 3 from a
--      root. Depth-1 = root org (parent_org_id IS NULL); depth-3 = great-
--      grandchild. The check is recursive but safety-guarded with a 10-step
--      visited-cycle bound in case bad data has a parent loop.
--   4. get_org_subtree(p_root_id, p_max_depth) — recursive CTE that returns
--      the org tree rooted at p_root_id. Caps at p_max_depth (default + max
--      3) to mirror the data-model invariant.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS get_org_subtree(uuid, integer);
--   DROP TRIGGER IF EXISTS enforce_org_parent_depth_trg ON organizations;
--   DROP FUNCTION IF EXISTS enforce_org_parent_depth();
--   ALTER TABLE organizations DROP COLUMN IF EXISTS verified_badge_granted_at;
--   ALTER TABLE organizations DROP COLUMN IF EXISTS banner_url;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS banner_url text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS verified_badge_granted_at timestamptz;

CREATE OR REPLACE FUNCTION enforce_org_parent_depth()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  depth integer := 1;
  cursor_id uuid := NEW.parent_org_id;
  visited uuid[] := ARRAY[]::uuid[];
  step_limit integer := 10;
BEGIN
  -- Root orgs (no parent) are always depth 1 and pass.
  IF NEW.parent_org_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Self-parenting is never allowed.
  IF NEW.parent_org_id = NEW.id THEN
    RAISE EXCEPTION 'org_self_parent_forbidden' USING ERRCODE = 'check_violation';
  END IF;
  -- Walk up to the root. Increment depth for each level above NEW.
  WHILE cursor_id IS NOT NULL LOOP
    depth := depth + 1;
    IF depth > 3 THEN
      RAISE EXCEPTION 'org_depth_exceeded_3'
        USING ERRCODE = 'check_violation',
              DETAIL = 'organizations.parent_org_id chain depth must be <= 3';
    END IF;
    IF cursor_id = ANY (visited) THEN
      RAISE EXCEPTION 'org_parent_cycle_detected'
        USING ERRCODE = 'check_violation';
    END IF;
    visited := array_append(visited, cursor_id);
    -- Bounded steps so a hostile chain can't burn statement_timeout.
    step_limit := step_limit - 1;
    EXIT WHEN step_limit <= 0;
    SELECT parent_org_id INTO cursor_id
    FROM organizations WHERE id = cursor_id;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_org_parent_depth_trg ON organizations;
CREATE TRIGGER enforce_org_parent_depth_trg
BEFORE INSERT OR UPDATE OF parent_org_id ON organizations
FOR EACH ROW EXECUTE FUNCTION enforce_org_parent_depth();

CREATE OR REPLACE FUNCTION get_org_subtree(
  p_root_id uuid,
  p_max_depth integer DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '5s'
STABLE
AS $$
DECLARE
  -- The schema-side invariant guarantees real data is depth ≤ 3, but we
  -- accept and clamp the input so a hostile/buggy caller cannot ask for
  -- depth=999 and trigger a long recursive scan.
  effective_depth integer := greatest(1, least(coalesce(p_max_depth, 3), 3));
  result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = p_root_id) THEN
    RETURN jsonb_build_object('error', 'Organization not found');
  END IF;

  WITH RECURSIVE tree AS (
    SELECT
      o.id,
      o.public_id,
      o.parent_org_id,
      o.parent_approval_status,
      o.display_name,
      o.domain,
      o.description,
      o.logo_url,
      o.banner_url,
      o.org_type,
      o.website_url,
      o.verification_status,
      o.verified_badge_granted_at,
      1 AS depth
    FROM organizations o
    WHERE o.id = p_root_id
    UNION ALL
    SELECT
      o.id,
      o.public_id,
      o.parent_org_id,
      o.parent_approval_status,
      o.display_name,
      o.domain,
      o.description,
      o.logo_url,
      o.banner_url,
      o.org_type,
      o.website_url,
      o.verification_status,
      o.verified_badge_granted_at,
      t.depth + 1 AS depth
    FROM organizations o
    JOIN tree t ON t.id = o.parent_org_id
    WHERE
      t.depth < effective_depth
      AND coalesce(o.parent_approval_status, 'APPROVED') = 'APPROVED'
  )
  SELECT jsonb_build_object(
    'root_id', p_root_id,
    'max_depth', effective_depth,
    'nodes', coalesce(jsonb_agg(jsonb_build_object(
      'org_id', t.id,
      'public_id', t.public_id,
      'parent_org_id', t.parent_org_id,
      'display_name', t.display_name,
      'domain', t.domain,
      'description', t.description,
      'logo_url', t.logo_url,
      'banner_url', t.banner_url,
      'org_type', t.org_type,
      'website_url', t.website_url,
      'verification_status', t.verification_status,
      'verified_badge_granted_at', t.verified_badge_granted_at,
      'depth', t.depth
    ) ORDER BY t.depth, t.display_name), '[]'::jsonb)
  )
  INTO result
  FROM tree t;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION get_org_subtree(uuid, integer) TO anon;
GRANT EXECUTE ON FUNCTION get_org_subtree(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION get_org_subtree(uuid, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
