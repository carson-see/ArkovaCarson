\set ON_ERROR_STOP on
BEGIN;
DROP TRIGGER IF EXISTS trg_route_connector_anchor_to_folder ON public.anchors;
DROP TRIGGER IF EXISTS trg_00_route_connector_anchor_to_folder ON public.anchors;
DROP TRIGGER IF EXISTS trg_route_materialized_connector_anchor_to_folder ON public.connector_artifact;
DROP TRIGGER IF EXISTS trg_anchor_folder_owner_scope ON public.anchors;
DROP TRIGGER IF EXISTS trg_enforce_folder_hierarchy ON public.folders;

DROP FUNCTION IF EXISTS public.route_connector_anchor_to_folder();
DROP FUNCTION IF EXISTS public.route_materialized_connector_anchor_to_folder();
DROP FUNCTION IF EXISTS public.resolve_connector_destination_folder(uuid,uuid,uuid);
DROP FUNCTION IF EXISTS public.folder_api_bulk_move(uuid,uuid,uuid[],uuid);
DROP FUNCTION IF EXISTS public.folder_api_delete(uuid,uuid,uuid);
DROP FUNCTION IF EXISTS public.folder_api_update(uuid,uuid,uuid,text,boolean,uuid,boolean,text,text,uuid,boolean);
DROP FUNCTION IF EXISTS public.folder_api_create(uuid,uuid,uuid,text,uuid,uuid,uuid,text,uuid);
DROP FUNCTION IF EXISTS public.folder_api_list(uuid,uuid,text,uuid,uuid,uuid);
DROP FUNCTION IF EXISTS public.folder_api_is_member(uuid,uuid);
DROP FUNCTION IF EXISTS public.folder_api_administers_org(uuid,uuid,uuid,boolean);
DROP FUNCTION IF EXISTS public.bulk_move_records_to_folder(uuid[],uuid);

DROP POLICY IF EXISTS folders_select_user ON public.folders;
DROP POLICY IF EXISTS folders_select_org ON public.folders;
DROP POLICY IF EXISTS folders_insert_user ON public.folders;
DROP POLICY IF EXISTS folders_insert_org_admin ON public.folders;
DROP POLICY IF EXISTS folders_update_user ON public.folders;
DROP POLICY IF EXISTS folders_update_org_admin ON public.folders;
DROP POLICY IF EXISTS folders_delete_user ON public.folders;
DROP POLICY IF EXISTS folders_delete_org_admin ON public.folders;
DROP POLICY IF EXISTS profiles_select_approved_ancestor_admin ON public.profiles;
DROP POLICY IF EXISTS anchors_select_approved_ancestor_admin ON public.anchors;
DROP FUNCTION IF EXISTS public.folder_administers_org(uuid);
DROP FUNCTION IF EXISTS public.folder_administers_org_exact(uuid);
DROP FUNCTION IF EXISTS public.enforce_folder_hierarchy();

DROP INDEX IF EXISTS public.idx_folders_connector_destination_unique;
DROP INDEX IF EXISTS public.idx_folders_user_sibling_name_unique;
DROP INDEX IF EXISTS public.idx_folders_org_sibling_name_unique;
DROP INDEX IF EXISTS public.idx_folders_public_id_unique;
ALTER TABLE public.folders
  DROP CONSTRAINT IF EXISTS folders_connector_provider_valid,
  DROP CONSTRAINT IF EXISTS folders_connector_pair_complete,
  DROP CONSTRAINT IF EXISTS folders_user_context_only,
  DROP CONSTRAINT IF EXISTS folders_connector_managed_consistent,
  DROP CONSTRAINT IF EXISTS folders_creator_present;
UPDATE public.folders f SET created_by=k.created_by
  FROM public.api_keys k
 WHERE f.created_by IS NULL AND f.created_by_api_key_id=k.id;
ALTER TABLE public.folders
  ALTER COLUMN created_by SET NOT NULL,
  DROP COLUMN IF EXISTS parent_folder_id,
  DROP COLUMN IF EXISTS public_id,
  DROP COLUMN IF EXISTS context_org_id,
  DROP COLUMN IF EXISTS connector_provider,
  DROP COLUMN IF EXISTS connector_source_id,
  DROP COLUMN IF EXISTS connector_connection_id,
  DROP COLUMN IF EXISTS is_system_managed,
  DROP COLUMN IF EXISTS created_by_api_key_id;
COMMIT;
\ir ../../../supabase/migrations/0445_connector_artifact_materialize_link_atomic.sql
