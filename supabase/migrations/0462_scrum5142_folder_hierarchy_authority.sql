-- 0462 / SCRUM-5142 / UAT-24 — canonical nested folders and scoped authority.
--
-- Extends public.folders from migration 0365. No second folder model is
-- introduced. Personal folders remain private unless they explicitly carry an
-- organization context; that context is also the hard record-ownership bound.
-- Approved organization ancestry grants visibility only. Mutations remain with
-- the personal owner or an administrator of the exact organization.
--
-- Existing USER folders deliberately backfill context_org_id=NULL. They are
-- therefore not exposed to any org administrator. Existing anchor assignments
-- are left untouched; the strengthened trigger applies to every future move.
--
-- ROLLBACK: drop trg_enforce_folder_hierarchy and its function; restore the
-- 0365 folder policies/indexes and enforce_anchor_folder_owner_scope body;
-- drop bulk_move_records_to_folder, folder_administers_org, the connector
-- destination indexes/checks, then parent_folder_id/context_org_id/
-- public_id/connector_provider/connector_source_id/connector_connection_id/
-- is_system_managed columns.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS parent_folder_id uuid
    REFERENCES public.folders(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS public_id text NOT NULL
    DEFAULT ('FLD-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16))),
  ADD COLUMN IF NOT EXISTS context_org_id uuid
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS connector_provider text,
  ADD COLUMN IF NOT EXISTS connector_source_id text,
  ADD COLUMN IF NOT EXISTS connector_connection_id uuid,
  ADD COLUMN IF NOT EXISTS is_system_managed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by_api_key_id uuid
    REFERENCES public.api_keys(id) ON DELETE SET NULL;

-- Organization-only keys have no human principal. Keep their creator audit as
-- the verified key id instead of attributing the write to an invented user.
ALTER TABLE public.folders ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE public.folders
  DROP CONSTRAINT IF EXISTS folders_connector_provider_valid,
  ADD CONSTRAINT folders_connector_provider_valid CHECK (
    connector_provider IS NULL OR connector_provider IN ('google_drive', 'docusign')
  ),
  DROP CONSTRAINT IF EXISTS folders_connector_pair_complete,
  ADD CONSTRAINT folders_connector_pair_complete CHECK (
    (connector_provider IS NULL AND connector_source_id IS NULL AND connector_connection_id IS NULL) OR
    (connector_provider IS NOT NULL AND
     connector_connection_id IS NOT NULL AND
     char_length(btrim(connector_source_id)) BETWEEN 1 AND 500)
  ),
  DROP CONSTRAINT IF EXISTS folders_user_context_only,
  ADD CONSTRAINT folders_user_context_only CHECK (
    owner_scope = 'USER' OR context_org_id IS NULL
  ),
  DROP CONSTRAINT IF EXISTS folders_connector_managed_consistent,
  ADD CONSTRAINT folders_connector_managed_consistent CHECK (
    is_system_managed = (connector_provider IS NOT NULL)
  ),
  DROP CONSTRAINT IF EXISTS folders_creator_present,
  ADD CONSTRAINT folders_creator_present CHECK (
    created_by IS NOT NULL OR created_by_api_key_id IS NOT NULL
  );

COMMENT ON COLUMN public.folders.context_org_id IS
  'Optional org context for a personal folder. NULL is globally personal and '
  'private; a value permits authorized org/ancestor admins to view only records '
  'owned by this user in that exact organization.';
COMMENT ON COLUMN public.folders.parent_folder_id IS
  'Same-owner parent folder. trg_enforce_folder_hierarchy serializes owner-tree '
  'changes and rejects cross-owner links and cycles.';
COMMENT ON COLUMN public.folders.connector_source_id IS
  'Opaque connector destination identity (Drive folder id or DocuSign integration id).';
COMMENT ON COLUMN public.folders.connector_connection_id IS
  'Active org_integrations/member_integrations connection validated before a source binding is accepted.';
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_public_id_unique
  ON public.folders (public_id);

-- Names are unique among siblings, not across an entire owner tree.
DROP INDEX IF EXISTS public.idx_folders_user_name_unique;
DROP INDEX IF EXISTS public.idx_folders_org_name_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_user_sibling_name_unique
  ON public.folders (
    user_id,
    coalesce(context_org_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(parent_folder_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  ) WHERE owner_scope = 'USER';
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_org_sibling_name_unique
  ON public.folders (
    org_id,
    coalesce(parent_folder_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  ) WHERE owner_scope = 'ORG';

-- A connector source has at most one canonical destination per owner/context.
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_connector_destination_unique
  ON public.folders (
    owner_scope,
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(context_org_id, '00000000-0000-0000-0000-000000000000'::uuid),
    connector_provider,
    connector_source_id
  ) WHERE connector_provider IS NOT NULL;

-- Reuse the canonical exact-org helper. Approved parent links are the only
-- edges that grant ancestor visibility; a pending/revoked affiliation grants
-- nothing. Organizations already enforce bounded acyclic parent chains.
CREATE OR REPLACE FUNCTION public.folder_administers_org_exact(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_org_admin_of(p_org_id);
$$;

CREATE OR REPLACE FUNCTION public.folder_administers_org(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE ancestors AS (
    SELECT o.id, o.parent_org_id, o.parent_approval_status, 0 AS depth
      FROM public.organizations o
     WHERE o.id = p_org_id
    UNION ALL
    SELECT parent.id, parent.parent_org_id, parent.parent_approval_status, child.depth + 1
      FROM public.organizations parent
      JOIN ancestors child ON child.parent_org_id = parent.id
     WHERE child.parent_approval_status = 'APPROVED'
       AND child.depth < 3
  )
  SELECT EXISTS (
    SELECT 1 FROM ancestors a WHERE public.is_org_admin_of(a.id)
  );
$$;

REVOKE ALL ON FUNCTION public.folder_administers_org_exact(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.folder_administers_org_exact(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.folder_administers_org(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.folder_administers_org(uuid) TO authenticated, service_role;

-- The member profile page already shows every record in the selected member's
-- org. Extend that existing read contract through approved parent ancestry so
-- an authorized parent admin can reach the profile and records before loading
-- the member's contextual folder tree. No write policy is broadened.
DROP POLICY IF EXISTS profiles_select_approved_ancestor_admin ON public.profiles;
CREATE POLICY profiles_select_approved_ancestor_admin ON public.profiles
  FOR SELECT TO authenticated USING (
    org_id IS NOT NULL AND public.folder_administers_org(org_id)
  );
DROP POLICY IF EXISTS anchors_select_approved_ancestor_admin ON public.anchors;
CREATE POLICY anchors_select_approved_ancestor_admin ON public.anchors
  FOR SELECT TO authenticated USING (
    org_id IS NOT NULL AND public.folder_administers_org(org_id)
  );

CREATE OR REPLACE FUNCTION public.enforce_folder_hierarchy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  parent_row public.folders%ROWTYPE;
  owner_lock_key text;
BEGIN
  owner_lock_key := concat_ws(':', NEW.owner_scope, NEW.user_id, NEW.org_id, NEW.context_org_id);
  -- Serializes all hierarchy mutations for one canonical owner. Without this,
  -- concurrent A->B and B->A transactions can both pass a recursive precheck.
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_lock_key, 5142));

  IF TG_OP = 'UPDATE' AND (
    NEW.owner_scope IS DISTINCT FROM OLD.owner_scope OR
    NEW.user_id IS DISTINCT FROM OLD.user_id OR
    NEW.org_id IS DISTINCT FROM OLD.org_id OR
    NEW.context_org_id IS DISTINCT FROM OLD.context_org_id OR
    NEW.created_by IS DISTINCT FROM OLD.created_by OR
    NEW.created_by_api_key_id IS DISTINCT FROM OLD.created_by_api_key_id
  ) THEN
    RAISE EXCEPTION 'folder ownership is immutable' USING ERRCODE = 'check_violation';
  END IF;

  IF auth.role() <> 'service_role' AND (
    (TG_OP = 'INSERT' AND (
      NEW.connector_provider IS NOT NULL OR NEW.connector_source_id IS NOT NULL OR
      NEW.connector_connection_id IS NOT NULL OR NEW.is_system_managed
    )) OR
    (TG_OP = 'UPDATE' AND (
      NEW.connector_provider IS DISTINCT FROM OLD.connector_provider OR
      NEW.connector_source_id IS DISTINCT FROM OLD.connector_source_id OR
      NEW.connector_connection_id IS DISTINCT FROM OLD.connector_connection_id OR
      NEW.is_system_managed IS DISTINCT FROM OLD.is_system_managed
    ))
  ) THEN
    RAISE EXCEPTION 'connector folder binding is service managed' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.parent_folder_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_folder_id = NEW.id THEN
    RAISE EXCEPTION 'folder hierarchy cycle' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO parent_row FROM public.folders WHERE id = NEW.parent_folder_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'folder parent does not exist' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF parent_row.owner_scope IS DISTINCT FROM NEW.owner_scope OR
     parent_row.user_id IS DISTINCT FROM NEW.user_id OR
     parent_row.org_id IS DISTINCT FROM NEW.org_id OR
     parent_row.context_org_id IS DISTINCT FROM NEW.context_org_id THEN
    RAISE EXCEPTION 'folder parent owner must match child owner' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT f.id, f.parent_folder_id FROM public.folders f WHERE f.id = NEW.parent_folder_id
      UNION ALL
      SELECT f.id, f.parent_folder_id
        FROM public.folders f JOIN ancestors a ON f.id = a.parent_folder_id
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'folder hierarchy cycle' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_folder_hierarchy() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_folder_hierarchy() TO service_role;
DROP TRIGGER IF EXISTS trg_enforce_folder_hierarchy ON public.folders;
CREATE TRIGGER trg_enforce_folder_hierarchy
  BEFORE INSERT OR UPDATE ON public.folders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_folder_hierarchy();

-- Replace the permissive 0365 policies. Personal owner writes and exact-org
-- admin writes are disjoint. Ancestor authority is visibility-only.
DROP POLICY IF EXISTS folders_select_own ON public.folders;
DROP POLICY IF EXISTS folders_select_org ON public.folders;
DROP POLICY IF EXISTS folders_select_platform_admin ON public.folders;
DROP POLICY IF EXISTS folders_insert_own ON public.folders;
DROP POLICY IF EXISTS folders_update_own ON public.folders;
DROP POLICY IF EXISTS folders_delete_own ON public.folders;

CREATE POLICY folders_select_user ON public.folders
  FOR SELECT TO authenticated USING (
    owner_scope = 'USER' AND (
      user_id = (SELECT auth.uid()) OR
      public.is_current_user_platform_admin() OR
      (folders.context_org_id IS NOT NULL AND public.folder_administers_org(folders.context_org_id))
    )
  );
CREATE POLICY folders_select_org ON public.folders
  FOR SELECT TO authenticated USING (
    owner_scope = 'ORG' AND (
      public.is_current_user_platform_admin() OR
      org_id = public.get_user_org_id() OR
      folders.org_id IN (SELECT public.get_user_org_ids()) OR
      public.folder_administers_org(folders.org_id)
    )
  );
CREATE POLICY folders_insert_user ON public.folders
  FOR INSERT TO authenticated WITH CHECK (
    owner_scope = 'USER' AND user_id = (SELECT auth.uid()) AND created_by = (SELECT auth.uid()) AND (
      context_org_id IS NULL OR folders.context_org_id IN (SELECT public.get_user_org_ids())
    )
  );
CREATE POLICY folders_insert_org_admin ON public.folders
  FOR INSERT TO authenticated WITH CHECK (
    owner_scope = 'ORG' AND created_by = (SELECT auth.uid()) AND public.folder_administers_org_exact(org_id)
  );
CREATE POLICY folders_update_user ON public.folders
  FOR UPDATE TO authenticated
  USING (owner_scope = 'USER' AND user_id = (SELECT auth.uid()))
  WITH CHECK (owner_scope = 'USER' AND user_id = (SELECT auth.uid()));
CREATE POLICY folders_update_org_admin ON public.folders
  FOR UPDATE TO authenticated
  USING (owner_scope = 'ORG' AND public.folder_administers_org_exact(org_id))
  WITH CHECK (owner_scope = 'ORG' AND public.folder_administers_org_exact(org_id));
CREATE POLICY folders_delete_user ON public.folders
  FOR DELETE TO authenticated USING (owner_scope = 'USER' AND user_id = (SELECT auth.uid()));
CREATE POLICY folders_delete_org_admin ON public.folders
  FOR DELETE TO authenticated USING (owner_scope = 'ORG' AND public.folder_administers_org_exact(org_id));

-- Strengthen the canonical anchor/folder owner guard. Existing assignments are
-- unchanged; every new assignment is exact on both user and org context.
CREATE OR REPLACE FUNCTION public.enforce_anchor_folder_owner_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f public.folders%ROWTYPE;
BEGIN
  IF NEW.folder_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO f FROM public.folders WHERE id = NEW.folder_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'folder does not exist' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF f.owner_scope = 'USER' THEN
    IF f.user_id IS DISTINCT FROM NEW.user_id OR
       (f.context_org_id IS NOT NULL AND f.context_org_id IS DISTINCT FROM NEW.org_id) THEN
      RAISE EXCEPTION 'record owner does not match personal folder context'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF f.org_id IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'record organization does not match folder organization'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_anchor_folder_owner_scope() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_anchor_folder_owner_scope() TO service_role;
DROP TRIGGER IF EXISTS trg_anchor_folder_owner_scope ON public.anchors;
CREATE TRIGGER trg_anchor_folder_owner_scope
  BEFORE INSERT OR UPDATE OF folder_id, user_id, org_id ON public.anchors
  FOR EACH ROW
  WHEN (NEW.folder_id IS NOT NULL)
  EXECUTE FUNCTION public.enforce_anchor_folder_owner_scope();

-- Resolve a connector's canonical destination. Member-scoped sources use a
-- personal destination only when the canonical anchor has that same owner.
-- A historical envelope anchor with a different owner can still be reused by
-- 0445 for idempotency, but remains unfiled or in its existing destination.
CREATE OR REPLACE FUNCTION public.resolve_connector_destination_folder(
  p_artifact_id uuid,
  p_anchor_user_id uuid,
  p_anchor_org_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE artifact public.connector_artifact%ROWTYPE; v_folder_id uuid;
  v_connection_id uuid; v_owner_user_id uuid; v_source_id text; v_name text;
  v_member_scope boolean; v_personal_destination boolean; v_connection_ok boolean;
BEGIN
  IF auth.role() <> 'service_role' THEN RETURN NULL; END IF;
  BEGIN
    SELECT * INTO artifact FROM public.connector_artifact
      WHERE id=p_artifact_id AND org_id=p_anchor_org_id FOR SHARE;
    v_connection_id := (artifact.metadata->>'integration_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
  END;
  IF NOT FOUND OR artifact.source NOT IN ('google_drive','docusign') OR v_connection_id IS NULL THEN
    RETURN NULL;
  END IF;
  v_member_scope := artifact.metadata->>'queue_scope' = 'member';
  IF v_member_scope THEN
    BEGIN v_owner_user_id := (artifact.metadata->>'owner_user_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RETURN NULL; END;
    SELECT EXISTS(SELECT 1 FROM public.member_integrations i
      WHERE i.id=v_connection_id AND i.user_id=v_owner_user_id AND i.org_id=artifact.org_id
        AND i.provider=artifact.source AND i.revoked_at IS NULL) INTO v_connection_ok;
  ELSE
    SELECT EXISTS(SELECT 1 FROM public.org_integrations i
      WHERE i.id=v_connection_id AND i.org_id=artifact.org_id
        AND i.provider=artifact.source AND i.revoked_at IS NULL) INTO v_connection_ok;
  END IF;
  IF NOT v_connection_ok THEN RETURN NULL; END IF;
  IF v_member_scope AND v_owner_user_id IS DISTINCT FROM p_anchor_user_id THEN
    RETURN NULL;
  END IF;
  v_personal_destination := v_member_scope;
  v_source_id := CASE WHEN artifact.source='google_drive'
    THEN coalesce(nullif(artifact.metadata->>'_drive_folder_id',''),v_connection_id::text)
    ELSE v_connection_id::text END;
  -- The short source suffix keeps a system destination from colliding with an
  -- ordinary sibling that already uses the connector's display name. The full
  -- opaque source id remains in connector_source_id and is never exposed as a
  -- public record identifier.
  v_name := left(CASE WHEN artifact.source='google_drive' THEN
    coalesce(nullif(regexp_replace(artifact.metadata->>'_drive_folder_path','^.*/',''),''),'Google Drive')
    ELSE 'DocuSign' END, 88) || ' · ' || upper(left(md5(v_source_id),8));
  IF v_personal_destination THEN
    SELECT id INTO v_folder_id FROM public.folders WHERE owner_scope='USER'
      AND user_id=v_owner_user_id AND context_org_id=artifact.org_id
      AND connector_provider=artifact.source AND connector_source_id=v_source_id;
    IF v_folder_id IS NULL THEN
      INSERT INTO public.folders(owner_scope,user_id,context_org_id,name,created_by,
        connector_provider,connector_source_id,connector_connection_id,is_system_managed)
      VALUES ('USER',v_owner_user_id,artifact.org_id,v_name,v_owner_user_id,
        artifact.source,v_source_id,v_connection_id,true)
      ON CONFLICT DO NOTHING RETURNING id INTO v_folder_id;
    END IF;
  ELSE
    SELECT id INTO v_folder_id FROM public.folders WHERE owner_scope='ORG' AND org_id=artifact.org_id
      AND connector_provider=artifact.source AND connector_source_id=v_source_id;
    IF v_folder_id IS NULL THEN
      INSERT INTO public.folders(owner_scope,org_id,name,created_by,
        connector_provider,connector_source_id,connector_connection_id,is_system_managed)
      VALUES ('ORG',artifact.org_id,v_name,p_anchor_user_id,
        artifact.source,v_source_id,v_connection_id,true)
      ON CONFLICT DO NOTHING RETURNING id INTO v_folder_id;
    END IF;
  END IF;
  IF v_folder_id IS NULL THEN
    SELECT id INTO v_folder_id FROM public.folders WHERE connector_provider=artifact.source
      AND connector_source_id=v_source_id AND (
        (v_personal_destination AND owner_scope='USER' AND user_id=v_owner_user_id AND context_org_id=artifact.org_id) OR
        (NOT v_personal_destination AND owner_scope='ORG' AND org_id=artifact.org_id));
  END IF;
  IF v_folder_id IS NOT NULL THEN
    -- A reconnect can preserve the source identity while changing the active
    -- connection row. Refresh only after the new connection passed validation.
    UPDATE public.folders SET connector_connection_id=v_connection_id
      WHERE id=v_folder_id AND connector_connection_id IS DISTINCT FROM v_connection_id;
  END IF;
  RETURN v_folder_id;
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_connector_destination_folder(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_connector_destination_folder(uuid,uuid,uuid) TO service_role;

-- Fresh INSERTs route before the alphabetical ownership guard, so the guard
-- validates the resolved destination in the same BEFORE INSERT chain.
CREATE OR REPLACE FUNCTION public.route_connector_anchor_to_folder()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.folder_id IS NOT NULL OR auth.role() <> 'service_role' OR
     NEW.metadata->>'connector_artifact_id' IS NULL THEN RETURN NEW; END IF;
  BEGIN
    NEW.folder_id := public.resolve_connector_destination_folder(
      (NEW.metadata->>'connector_artifact_id')::uuid, NEW.user_id, NEW.org_id);
  EXCEPTION WHEN invalid_text_representation THEN RETURN NEW;
  END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.route_connector_anchor_to_folder() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.route_connector_anchor_to_folder() TO service_role;
DROP TRIGGER IF EXISTS trg_route_connector_anchor_to_folder ON public.anchors;
DROP TRIGGER IF EXISTS trg_00_route_connector_anchor_to_folder ON public.anchors;
CREATE TRIGGER trg_00_route_connector_anchor_to_folder
  BEFORE INSERT ON public.anchors FOR EACH ROW
  EXECUTE FUNCTION public.route_connector_anchor_to_folder();

-- Migration 0445 can reuse an existing anchor without inserting it. Its final
-- connector_artifact UPDATE is still inside the locked atomic transaction, so
-- route an unfiled reuse there. A user's existing destination always wins.
CREATE OR REPLACE FUNCTION public.route_materialized_connector_anchor_to_folder()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user_id uuid; v_org_id uuid; v_folder_id uuid; v_destination_id uuid;
BEGIN
  IF auth.role() <> 'service_role' OR NEW.status <> 'materialized' OR
     NEW.anchor_id IS NULL THEN RETURN NEW; END IF;
  SELECT user_id,org_id,folder_id INTO v_user_id,v_org_id,v_folder_id
    FROM public.anchors WHERE id=NEW.anchor_id AND org_id=NEW.org_id FOR UPDATE;
  IF NOT FOUND OR v_folder_id IS NOT NULL THEN RETURN NEW; END IF;
  v_destination_id := public.resolve_connector_destination_folder(NEW.id,v_user_id,v_org_id);
  IF v_destination_id IS NOT NULL THEN
    UPDATE public.anchors SET folder_id=v_destination_id
      WHERE id=NEW.anchor_id AND folder_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.route_materialized_connector_anchor_to_folder() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.route_materialized_connector_anchor_to_folder() TO service_role;
DROP TRIGGER IF EXISTS trg_route_materialized_connector_anchor_to_folder ON public.connector_artifact;
CREATE TRIGGER trg_route_materialized_connector_anchor_to_folder
  AFTER UPDATE OF status,anchor_id ON public.connector_artifact
  FOR EACH ROW EXECUTE FUNCTION public.route_materialized_connector_anchor_to_folder();


-- Replace 0445's atomic materializer without splitting its artifact lock,
-- anchor publication, or guarded link. The only authority extension is DS-04:
-- a locked active member connection may publish as its exact member owner.
CREATE OR REPLACE FUNCTION public.materialize_connector_artifact_anchor(
  p_artifact_id uuid,
  p_org_id uuid,
  p_expected_updated_at timestamptz,
  p_expected_fingerprint text,
  p_expected_metadata jsonb,
  p_anchor_payload jsonb,
  p_existing_anchor_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET lock_timeout TO '5s'
SET statement_timeout TO '30s'
AS $$
DECLARE
  v_artifact public.connector_artifact%ROWTYPE;
  v_anchor public.anchors%ROWTYPE;
  v_user_id uuid;
  v_existing_id uuid;
  v_metadata jsonb;
  v_fingerprint_source text;
  v_connection_id uuid;
  v_member_owner_user_id uuid;
  v_member_scope boolean := false;
  v_created boolean := false;
BEGIN
  IF public.get_caller_role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'connector materialization requires service role' USING ERRCODE = '42501';
  END IF;

  -- A missing/wrong-tenant/newly requeued row is not this caller's lease.
  -- Return no identifiers and perform no write on rejection.
  SELECT a.* INTO v_artifact
    FROM public.connector_artifact a
   WHERE a.id = p_artifact_id AND a.org_id = p_org_id AND a.status = 'processing'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'lost_lease');
  END IF;
  IF v_artifact.updated_at IS DISTINCT FROM p_expected_updated_at
     OR v_artifact.fingerprint_sha256 IS DISTINCT FROM p_expected_fingerprint
     OR v_artifact.metadata IS DISTINCT FROM p_expected_metadata THEN
    -- Metadata equality also catches same-millisecond, equal-fingerprint
    -- provenance changes. Never requeue an unidentified newer processing lease.
    RETURN jsonb_build_object('outcome', 'superseded');
  END IF;

  IF jsonb_typeof(p_anchor_payload) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_artifact.metadata) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid connector materialization payload' USING ERRCODE = '22023';
  END IF;
  v_user_id := (p_anchor_payload->>'user_id')::uuid;
  v_member_scope := v_artifact.metadata->>'queue_scope' = 'member';
  IF v_member_scope THEN
    BEGIN
      v_member_owner_user_id := (v_artifact.metadata->>'owner_user_id')::uuid;
      v_connection_id := (v_artifact.metadata->>'integration_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'member connector ownership is invalid' USING ERRCODE = '22023';
    END;
    IF v_user_id IS DISTINCT FROM v_member_owner_user_id THEN
      RAISE EXCEPTION 'connector reuse target owner differs from member connection owner'
        USING ERRCODE = '22023';
    END IF;
    -- Lock both proofs so revocation or membership removal cannot race publication.
    PERFORM 1 FROM public.member_integrations i
     WHERE i.id=v_connection_id AND i.user_id=v_user_id AND i.org_id=p_org_id
       AND i.provider=v_artifact.source AND i.revoked_at IS NULL
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'active member connector ownership required' USING ERRCODE = '42501';
    END IF;
    PERFORM 1 FROM public.org_members m
     WHERE m.org_id=p_org_id AND m.user_id=v_user_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'member connector owner lacks exact org membership' USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Org-scoped artifacts retain the canonical owner/admin service actor.
    PERFORM 1 FROM public.org_members m
     WHERE m.org_id = p_org_id AND m.user_id = v_user_id AND m.role::text IN ('owner', 'admin')
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'connector materialization actor lacks org authority' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_metadata := v_artifact.metadata || jsonb_build_object(
    'connector_source', v_artifact.source,
    'connector_artifact_id', v_artifact.id,
    'external_ref', v_artifact.external_ref
  );
  v_fingerprint_source := CASE WHEN v_artifact.metadata->>'_direction' = 'inbound'
    THEN 'issuer_record_attestation' ELSE 'document_bytes' END;
  IF p_anchor_payload->>'fingerprint' IS DISTINCT FROM v_artifact.fingerprint_sha256
     OR p_anchor_payload->>'status' IS DISTINCT FROM 'PENDING'
     OR p_anchor_payload->>'org_id' IS DISTINCT FROM p_org_id::text
     OR p_anchor_payload->>'credential_type' IS DISTINCT FROM 'CONTRACT_POSTSIGNING'
     OR p_anchor_payload->'metadata' IS DISTINCT FROM v_metadata
     OR p_anchor_payload->>'fingerprint_source' IS DISTINCT FROM v_fingerprint_source
     OR jsonb_typeof(p_anchor_payload->'filename') IS DISTINCT FROM 'string'
     OR length(p_anchor_payload->>'filename') NOT BETWEEN 1 AND 255
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_anchor_payload) AS k(key)
        WHERE k.key NOT IN ('fingerprint','status','org_id','user_id','filename',
          'credential_type','metadata','fingerprint_source')
     ) THEN
    RAISE EXCEPTION 'connector payload does not match locked source' USING ERRCODE = '22023';
  END IF;

  -- A paid retry must retain its original anchor id, even if an envelope lookup
  -- now returns another row. No deletion or credit mutation occurs on reuse.
  v_existing_id := COALESCE(v_artifact.anchor_id, p_existing_anchor_id);
  IF v_existing_id IS NOT NULL THEN
    SELECT a.* INTO v_anchor FROM public.anchors a
     WHERE a.id = v_existing_id AND a.org_id = p_org_id
       AND a.deleted_at IS NULL AND a.status <> 'REVOKED'
       AND (
         a.id = v_artifact.anchor_id
         OR a.metadata->>'source_envelope_id' = btrim(v_artifact.external_ref)
         OR a.metadata->>'envelope_id' = btrim(v_artifact.external_ref)
         OR a.metadata->>'external_ref' = btrim(v_artifact.external_ref)
       )
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'connector reuse target is not an eligible org anchor' USING ERRCODE = '22023';
    END IF;
  ELSE
    BEGIN
      INSERT INTO public.anchors(fingerprint,status,org_id,user_id,filename,
        credential_type,metadata,fingerprint_source)
      VALUES (v_artifact.fingerprint_sha256,'PENDING',p_org_id,v_user_id,
        p_anchor_payload->>'filename','CONTRACT_POSTSIGNING',v_metadata,v_fingerprint_source)
      RETURNING * INTO v_anchor;
      v_created := true;
    EXCEPTION WHEN unique_violation THEN
      -- Preserve the existing partial (user_id,fingerprint) idempotency rule.
      -- The rejected INSERT and all its trigger effects roll back together.
      SELECT a.* INTO v_anchor FROM public.anchors a
       WHERE a.org_id = p_org_id AND a.user_id = v_user_id
         AND a.fingerprint = v_artifact.fingerprint_sha256
         AND a.deleted_at IS NULL AND a.status <> 'REVOKED'
       FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'connector materialization conflict has no eligible anchor' USING ERRCODE = '23505';
      END IF;
    END;
  END IF;

  -- Same transaction and still holding the artifact lock. A provenance heal
  -- either committed before validation or waits and then sees anchor_id set.
  UPDATE public.connector_artifact
     SET status = 'materialized', anchor_id = v_anchor.id, updated_at = now()
   WHERE id = v_artifact.id AND org_id = p_org_id;
  RETURN jsonb_build_object('outcome','linked','anchor_id',v_anchor.id,
    'public_id',v_anchor.public_id,'created',v_created);
END;
$$;
REVOKE ALL ON FUNCTION public.materialize_connector_artifact_anchor(uuid,uuid,timestamptz,text,jsonb,jsonb,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materialize_connector_artifact_anchor(uuid,uuid,timestamptz,text,jsonb,jsonb,uuid)
  TO service_role;

-- JWT/PostgREST bulk management. Each row is an independent subtransaction:
-- one stale/foreign row never rolls back successful siblings.
CREATE OR REPLACE FUNCTION public.bulk_move_records_to_folder(
  p_anchor_ids uuid[],
  p_folder_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  anchor_id uuid;
  moved_ids jsonb := '[]'::jsonb;
  failures jsonb := '[]'::jsonb;
  affected uuid;
BEGIN
  IF p_anchor_ids IS NULL OR cardinality(p_anchor_ids) = 0 THEN
    RAISE EXCEPTION 'anchor_ids_required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cardinality(p_anchor_ids) > 100 THEN
    RAISE EXCEPTION 'bulk_move_limit_exceeded' USING ERRCODE = 'program_limit_exceeded';
  END IF;

  FOR anchor_id IN SELECT DISTINCT unnest(p_anchor_ids) LOOP
    BEGIN
      affected := NULL;
      UPDATE public.anchors SET folder_id = p_folder_id
       WHERE id = anchor_id RETURNING id INTO affected;
      IF affected IS NULL THEN
        failures := failures || jsonb_build_array(jsonb_build_object(
          'anchor_id', anchor_id, 'code', 'not_authorized_or_not_found'));
      ELSE
        moved_ids := moved_ids || to_jsonb(anchor_id);
      END IF;
    EXCEPTION
      WHEN check_violation OR foreign_key_violation THEN
        failures := failures || jsonb_build_array(jsonb_build_object(
          'anchor_id', anchor_id, 'code', 'invalid_destination'));
      WHEN OTHERS THEN
        failures := failures || jsonb_build_array(jsonb_build_object(
          'anchor_id', anchor_id, 'code', 'rejected'));
    END;
  END LOOP;
  RETURN jsonb_build_object('moved', moved_ids, 'failed', failures);
END;
$$;
REVOKE ALL ON FUNCTION public.bulk_move_records_to_folder(uuid[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_move_records_to_folder(uuid[], uuid) TO authenticated, service_role;

-- The worker uses a service-role database client, so authorization and the
-- mutation must be one database statement. These RPCs accept identity only
-- from the already-authenticated worker and are therefore service_role-only.
CREATE OR REPLACE FUNCTION public.folder_api_administers_org(
  p_actor_user_id uuid,
  p_api_org_id uuid,
  p_org_id uuid,
  p_exact boolean DEFAULT false
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE ancestors AS (
    SELECT o.id, o.parent_org_id, o.parent_approval_status, 0 AS depth
      FROM public.organizations o WHERE o.id = p_org_id
    UNION ALL
    SELECT parent.id, parent.parent_org_id, parent.parent_approval_status, child.depth + 1
      FROM public.organizations parent
      JOIN ancestors child ON child.parent_org_id = parent.id
     WHERE NOT p_exact AND child.parent_approval_status = 'APPROVED' AND child.depth < 3
  )
  SELECT CASE
    WHEN p_api_org_id IS NOT NULL THEN p_api_org_id IS NOT DISTINCT FROM p_org_id
    WHEN p_actor_user_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM ancestors a
      JOIN public.org_members m ON m.org_id = a.id
      WHERE m.user_id = p_actor_user_id AND m.role::text IN ('owner', 'admin', 'ORG_ADMIN')
    )
    ELSE false
  END;
$$;
REVOKE ALL ON FUNCTION public.folder_api_administers_org(uuid,uuid,uuid,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.folder_api_administers_org(uuid,uuid,uuid,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.folder_api_is_member(p_user_id uuid, p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.org_members WHERE user_id = p_user_id AND org_id = p_org_id
  );
$$;
REVOKE ALL ON FUNCTION public.folder_api_is_member(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.folder_api_is_member(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.folder_api_list(
  p_actor_user_id uuid,
  p_api_org_id uuid,
  p_owner_scope text,
  p_owner_user_id uuid DEFAULT NULL,
  p_org_id uuid DEFAULT NULL,
  p_context_org_id uuid DEFAULT NULL
) RETURNS SETOF public.folders
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner_user_id uuid := coalesce(p_owner_user_id, p_actor_user_id);
BEGIN
  IF auth.role() <> 'service_role' OR
     (p_actor_user_id IS NULL AND p_api_org_id IS NULL) THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_owner_scope = 'USER' THEN
    IF v_owner_user_id IS NULL OR
      (p_api_org_id IS NOT NULL AND (
        v_owner_user_id IS DISTINCT FROM p_actor_user_id OR
        p_context_org_id IS DISTINCT FROM p_api_org_id
      )) OR (
      v_owner_user_id IS DISTINCT FROM p_actor_user_id AND
      (p_context_org_id IS NULL OR NOT public.folder_api_administers_org(
        p_actor_user_id, p_api_org_id, p_context_org_id, false))
    ) THEN RETURN; END IF;
    RETURN QUERY SELECT f.* FROM public.folders f
      WHERE f.owner_scope = 'USER' AND f.user_id = v_owner_user_id
        AND f.context_org_id IS NOT DISTINCT FROM p_context_org_id;
  ELSIF p_owner_scope = 'ORG' AND p_org_id IS NOT NULL AND (
    (p_api_org_id IS NOT NULL AND public.folder_api_administers_org(NULL, p_api_org_id, p_org_id, false)) OR
    (p_api_org_id IS NULL AND (public.folder_api_is_member(p_actor_user_id, p_org_id) OR
      public.folder_api_administers_org(p_actor_user_id, NULL, p_org_id, false)))
  ) THEN
    RETURN QUERY SELECT f.* FROM public.folders f
      WHERE f.owner_scope = 'ORG' AND f.org_id = p_org_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.folder_api_list(uuid,uuid,text,uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.folder_api_list(uuid,uuid,text,uuid,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.folder_api_create(
  p_actor_user_id uuid,
  p_api_key_id uuid,
  p_api_org_id uuid,
  p_owner_scope text,
  p_owner_user_id uuid,
  p_org_id uuid,
  p_context_org_id uuid,
  p_name text,
  p_parent_folder_id uuid DEFAULT NULL
) RETURNS public.folders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_created public.folders;
BEGIN
  IF auth.role() <> 'service_role' OR
     (p_actor_user_id IS NULL AND p_api_org_id IS NULL) THEN
    RAISE EXCEPTION 'folder create forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_owner_scope = 'USER' THEN
    IF p_actor_user_id IS NULL OR p_owner_user_id IS DISTINCT FROM p_actor_user_id OR
       (p_api_org_id IS NOT NULL AND p_context_org_id IS DISTINCT FROM p_api_org_id) OR
       (p_context_org_id IS NOT NULL AND (
         NOT public.folder_api_is_member(p_actor_user_id, p_context_org_id) OR
         (p_api_org_id IS NOT NULL AND p_api_org_id IS DISTINCT FROM p_context_org_id)
       )) THEN
      RAISE EXCEPTION 'folder create forbidden' USING ERRCODE = 'insufficient_privilege';
    END IF;
    INSERT INTO public.folders(owner_scope,user_id,context_org_id,name,parent_folder_id,created_by)
    VALUES ('USER',p_owner_user_id,p_context_org_id,p_name,p_parent_folder_id,p_actor_user_id)
    RETURNING * INTO v_created;
  ELSIF p_owner_scope = 'ORG' AND public.folder_api_administers_org(
    p_actor_user_id, p_api_org_id, p_org_id, true
  ) THEN
    IF p_actor_user_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.api_keys k WHERE k.id=p_api_key_id AND k.org_id=p_api_org_id
        AND k.is_active AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > now())
    ) THEN
      RAISE EXCEPTION 'verified organization api key required' USING ERRCODE = 'insufficient_privilege';
    END IF;
    INSERT INTO public.folders(owner_scope,org_id,name,parent_folder_id,created_by,created_by_api_key_id)
    VALUES ('ORG',p_org_id,p_name,p_parent_folder_id,p_actor_user_id,
      CASE WHEN p_actor_user_id IS NULL THEN p_api_key_id ELSE NULL END)
    RETURNING * INTO v_created;
  ELSE
    RAISE EXCEPTION 'folder create forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_created;
END;
$$;
REVOKE ALL ON FUNCTION public.folder_api_create(uuid,uuid,uuid,text,uuid,uuid,uuid,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.folder_api_create(uuid,uuid,uuid,text,uuid,uuid,uuid,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.folder_api_update(
  p_actor_user_id uuid,
  p_api_org_id uuid,
  p_folder_id uuid,
  p_name text,
  p_name_present boolean,
  p_parent_folder_id uuid,
  p_parent_present boolean,
  p_connector_provider text,
  p_connector_source_id text,
  p_connector_connection_id uuid,
  p_connector_present boolean
) RETURNS public.folders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE f public.folders; v_connection_ok boolean := false;
BEGIN
  IF auth.role() <> 'service_role' OR
     (p_actor_user_id IS NULL AND p_api_org_id IS NULL) THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO f FROM public.folders WHERE id = p_folder_id FOR UPDATE;
  IF NOT FOUND OR ((
    (f.owner_scope = 'USER' AND f.user_id = p_actor_user_id AND
      (p_api_org_id IS NULL OR f.context_org_id = p_api_org_id)) OR
    (f.owner_scope = 'ORG' AND public.folder_api_administers_org(
      p_actor_user_id, p_api_org_id, f.org_id, true))
  ) IS NOT TRUE) THEN RETURN NULL; END IF;

  IF p_connector_present AND p_connector_provider IS NOT NULL THEN
    IF f.owner_scope = 'ORG' THEN
      SELECT EXISTS (SELECT 1 FROM public.org_integrations i
        WHERE i.id = p_connector_connection_id AND i.org_id = f.org_id
          AND i.provider = p_connector_provider AND i.revoked_at IS NULL) INTO v_connection_ok;
    ELSE
      SELECT EXISTS (SELECT 1 FROM public.member_integrations i
        WHERE i.id = p_connector_connection_id AND i.user_id = f.user_id
          AND (f.context_org_id IS NULL OR i.org_id = f.context_org_id)
          AND i.provider = p_connector_provider AND i.revoked_at IS NULL)
      OR EXISTS (SELECT 1 FROM public.org_integrations i
        WHERE i.id = p_connector_connection_id AND i.org_id = f.context_org_id
          AND i.provider = p_connector_provider AND i.revoked_at IS NULL
          AND public.folder_api_is_member(f.user_id, i.org_id)) INTO v_connection_ok;
    END IF;
    IF NOT v_connection_ok THEN
      RAISE EXCEPTION 'active connector connection required' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  UPDATE public.folders SET
    name = CASE WHEN p_name_present THEN p_name ELSE name END,
    parent_folder_id = CASE WHEN p_parent_present THEN p_parent_folder_id ELSE parent_folder_id END,
    connector_provider = CASE WHEN p_connector_present THEN p_connector_provider ELSE connector_provider END,
    connector_source_id = CASE WHEN p_connector_present THEN p_connector_source_id ELSE connector_source_id END,
    connector_connection_id = CASE WHEN p_connector_present THEN p_connector_connection_id ELSE connector_connection_id END,
    is_system_managed = CASE WHEN p_connector_present THEN p_connector_provider IS NOT NULL ELSE is_system_managed END
  WHERE id = p_folder_id RETURNING * INTO f;
  RETURN f;
END;
$$;
REVOKE ALL ON FUNCTION public.folder_api_update(uuid,uuid,uuid,text,boolean,uuid,boolean,text,text,uuid,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.folder_api_update(uuid,uuid,uuid,text,boolean,uuid,boolean,text,text,uuid,boolean)
  TO service_role;

CREATE OR REPLACE FUNCTION public.folder_api_delete(
  p_actor_user_id uuid, p_api_org_id uuid, p_folder_id uuid
) RETURNS public.folders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE f public.folders;
BEGIN
  IF auth.role() <> 'service_role' OR
     (p_actor_user_id IS NULL AND p_api_org_id IS NULL) THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO f FROM public.folders WHERE id=p_folder_id FOR UPDATE;
  IF NOT FOUND OR ((
    (f.owner_scope='USER' AND f.user_id=p_actor_user_id AND
      (p_api_org_id IS NULL OR f.context_org_id=p_api_org_id)) OR
    (f.owner_scope='ORG' AND public.folder_api_administers_org(p_actor_user_id,p_api_org_id,f.org_id,true))
  ) IS NOT TRUE) THEN RETURN NULL; END IF;
  DELETE FROM public.folders WHERE id=p_folder_id;
  RETURN f;
END;
$$;
REVOKE ALL ON FUNCTION public.folder_api_delete(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.folder_api_delete(uuid,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.folder_api_bulk_move(
  p_actor_user_id uuid, p_api_org_id uuid, p_anchor_ids uuid[], p_folder_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a public.anchors%ROWTYPE; f public.folders%ROWTYPE; anchor_id uuid;
  moved_ids jsonb := '[]'::jsonb; failures jsonb := '[]'::jsonb; v_event_org_id uuid;
  v_event_org_mixed boolean := false; v_have_event_org boolean := false;
BEGIN
  IF auth.role() <> 'service_role' OR
     (p_actor_user_id IS NULL AND p_api_org_id IS NULL) OR
     cardinality(p_anchor_ids) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid folder bulk request' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_folder_id IS NOT NULL THEN
    SELECT * INTO f FROM public.folders WHERE id=p_folder_id;
    IF NOT FOUND OR ((
      (f.owner_scope='USER' AND f.user_id=p_actor_user_id AND
        (p_api_org_id IS NULL OR f.context_org_id=p_api_org_id)) OR
      (f.owner_scope='ORG' AND (
        (p_api_org_id IS NOT NULL AND f.org_id=p_api_org_id) OR
        (p_api_org_id IS NULL AND (public.folder_api_is_member(p_actor_user_id,f.org_id) OR
          public.folder_api_administers_org(p_actor_user_id,NULL,f.org_id,false)))
      ))
    ) IS NOT TRUE) THEN
      RETURN jsonb_build_object('moved','[]'::jsonb,'failed',(
        SELECT jsonb_agg(jsonb_build_object('anchor_id',x,'code','invalid_destination'))
        FROM unnest(p_anchor_ids) x));
    END IF;
  END IF;
  FOR anchor_id IN SELECT DISTINCT unnest(p_anchor_ids) LOOP
    SELECT * INTO a FROM public.anchors WHERE id=anchor_id FOR UPDATE;
    IF NOT FOUND OR ((
      (p_api_org_id IS NOT NULL AND a.org_id=p_api_org_id) OR
      (p_api_org_id IS NULL AND (a.user_id=p_actor_user_id OR
        public.folder_api_administers_org(p_actor_user_id,NULL,a.org_id,true)))
    ) IS NOT TRUE) THEN
      failures := failures || jsonb_build_array(jsonb_build_object('anchor_id',anchor_id,'code','not_authorized_or_not_found'));
      CONTINUE;
    END IF;
    BEGIN
      UPDATE public.anchors SET folder_id=p_folder_id WHERE id=anchor_id;
      moved_ids := moved_ids || to_jsonb(anchor_id);
      IF NOT v_have_event_org THEN v_event_org_id := a.org_id; v_have_event_org := true;
      ELSIF v_event_org_id IS DISTINCT FROM a.org_id THEN v_event_org_mixed := true; END IF;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      failures := failures || jsonb_build_array(jsonb_build_object('anchor_id',anchor_id,'code','invalid_destination'));
    END;
  END LOOP;
  RETURN jsonb_build_object('moved',moved_ids,'failed',failures,
    'event_org_id',CASE WHEN v_event_org_mixed THEN NULL ELSE v_event_org_id END,
    'folder_public_id',f.public_id);
END;
$$;
REVOKE ALL ON FUNCTION public.folder_api_bulk_move(uuid,uuid,uuid[],uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.folder_api_bulk_move(uuid,uuid,uuid[],uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
