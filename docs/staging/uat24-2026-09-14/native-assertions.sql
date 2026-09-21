\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION private.is_human_mfa_verified() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT COALESCE(NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'aal'='aal2',false)
$$;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_human_mfa_verified() TO authenticated;
CREATE POLICY mfa_verified_authenticated ON public.folders AS RESTRICTIVE FOR ALL TO authenticated
 USING (private.is_human_mfa_verified()) WITH CHECK (private.is_human_mfa_verified());

SELECT set_config('request.jwt.claim.role','service_role',false);
INSERT INTO public.folders(id,owner_scope,user_id,org_id,context_org_id,name,created_by) VALUES
 ('f0000000-0000-4000-8000-000000000002','USER','22222222-0000-4000-8000-000000000002',NULL,'bbbbbbbb-0000-4000-8000-000000000001','Child context','22222222-0000-4000-8000-000000000002'),
 ('f0000000-0000-4000-8000-000000000003','USER','22222222-0000-4000-8000-000000000002',NULL,NULL,'Child global','22222222-0000-4000-8000-000000000002'),
 ('f0000000-0000-4000-8000-000000000004','USER','11111111-0000-4000-8000-000000000001',NULL,'aaaaaaaa-0000-4000-8000-000000000001','Issuer org A context','11111111-0000-4000-8000-000000000001'),
 ('f0000000-0000-4000-8000-000000000005','ORG',NULL,'aaaaaaaa-0000-4000-8000-000000000001',NULL,'Org A records','11111111-0000-4000-8000-000000000001');
INSERT INTO public.anchors(id,user_id,org_id,fingerprint,filename) VALUES
 ('a0000000-0000-4000-8000-000000000002','11111111-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001',repeat('2',64),'org-a.pdf'),
 ('a0000000-0000-4000-8000-000000000003','11111111-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001',repeat('3',64),'org-b.pdf'),
 ('a0000000-0000-4000-8000-000000000005','11111111-0000-4000-8000-000000000001',NULL,repeat('5',64),'personal.pdf');
INSERT INTO public.org_integrations(id,org_id,provider,revoked_at) VALUES
 ('d0000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','google_drive',NULL),
 ('d0000000-0000-4000-8000-000000000002','aaaaaaaa-0000-4000-8000-000000000001','google_drive',now());
INSERT INTO public.member_integrations(id,user_id,org_id,provider,revoked_at) VALUES
 ('d0000000-0000-4000-8000-000000000003','22222222-0000-4000-8000-000000000002',
  'bbbbbbbb-0000-4000-8000-000000000001','docusign',NULL);
INSERT INTO public.api_keys(id,org_id,created_by,is_active) VALUES
 ('90000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001',
  '11111111-0000-4000-8000-000000000001',true);

DO $$ DECLARE n int; BEGIN
  IF (SELECT context_org_id FROM public.folders WHERE id='f0000000-0000-4000-8000-000000000001') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy folder was silently contextualized';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.anchors WHERE id='a0000000-0000-4000-8000-000000000001' AND folder_id='f0000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'legacy assignment was rewritten';
  END IF;

  SELECT count(*) INTO n FROM public.folder_api_list(
    '11111111-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','USER',
    '11111111-0000-4000-8000-000000000001',NULL,NULL);
  IF n <> 0 THEN RAISE EXCEPTION 'org key reached issuer global personal folders'; END IF;
  SELECT count(*) INTO n FROM public.folder_api_list(
    '11111111-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','USER',
    '11111111-0000-4000-8000-000000000001',NULL,'bbbbbbbb-0000-4000-8000-000000000001');
  IF n <> 0 THEN RAISE EXCEPTION 'org key reached issuer other-org personal folders'; END IF;
  SELECT count(*) INTO n FROM public.folder_api_list(
    '11111111-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','USER',
    '11111111-0000-4000-8000-000000000001',NULL,'aaaaaaaa-0000-4000-8000-000000000001');
  IF n <> 1 THEN RAISE EXCEPTION 'org key lost its exact contextual personal scope'; END IF;
  SELECT count(*) INTO n FROM public.folder_api_list(
    '11111111-0000-4000-8000-000000000001',NULL,'USER',
    '11111111-0000-4000-8000-000000000001',NULL,NULL);
  IF n <> 1 THEN RAISE EXCEPTION 'personal principal key cannot reach its global folder'; END IF;
END $$;

-- 0480 direct-RLS parity: platform and approved ancestor administrators can
-- read only explicitly contextual personal trees. The owner retains both;
-- ordinary peers and identity-less sessions retain neither.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claims','{"role":"authenticated","aal":"aal2"}',false);
SELECT set_config('request.jwt.claim.sub','99999999-0000-4000-8000-000000000009',false);
DO $$ DECLARE contextual int; global_private int; BEGIN
  SELECT count(*) FILTER (WHERE context_org_id IS NOT NULL),
         count(*) FILTER (WHERE context_org_id IS NULL)
    INTO contextual, global_private
    FROM public.folders
   WHERE user_id='22222222-0000-4000-8000-000000000002';
  IF contextual <> 1 OR global_private <> 0 THEN
    RAISE EXCEPTION 'platform direct RLS personal privacy mismatch';
  END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','22222222-0000-4000-8000-000000000002',false);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.folders
       WHERE user_id='22222222-0000-4000-8000-000000000002') <> 2 THEN
    RAISE EXCEPTION 'personal owner lost own folder tree';
  END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','11111111-0000-4000-8000-000000000001',false);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.folders
       WHERE user_id='22222222-0000-4000-8000-000000000002') <> 1 THEN
    RAISE EXCEPTION 'approved ancestor contextual visibility mismatch';
  END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','33333333-0000-4000-8000-000000000003',false);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.folders
              WHERE user_id='22222222-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'ordinary peer reached personal folder tree';
  END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','',false);
SELECT set_config('request.jwt.claims','',false);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.folders) THEN
    RAISE EXCEPTION 'identity-less authenticated session reached folders';
  END IF;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claim.role','service_role',false);

-- SCRUM-5252: platform authority is read-only and applies only to verified
-- JWT actors. Global personal folders remain private through the REST/RPC
-- contract, and an API key org remains the upper bound.
DO $$ DECLARE failed boolean:=false; BEGIN
  PERFORM set_config('request.jwt.claim.role','',true);
  BEGIN
    PERFORM public.folder_api_list(
      '99999999-0000-4000-8000-000000000009',NULL,'USER',
      '22222222-0000-4000-8000-000000000002',NULL,'bbbbbbbb-0000-4000-8000-000000000001');
  EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  IF NOT failed THEN RAISE EXCEPTION 'missing role claim reached service folder list'; END IF;
END $$;

DO $$ DECLARE n int; failed boolean:=false; created public.folders%ROWTYPE; BEGIN
  SELECT count(*) INTO n FROM public.folder_api_list(
    '99999999-0000-4000-8000-000000000009',NULL,'USER',
    '22222222-0000-4000-8000-000000000002',NULL,'bbbbbbbb-0000-4000-8000-000000000001');
  IF n <> 1 THEN RAISE EXCEPTION 'platform admin lost contextual personal folder read'; END IF;

  SELECT count(*) INTO n FROM public.folder_api_list(
    '99999999-0000-4000-8000-000000000009',NULL,'USER',
    '22222222-0000-4000-8000-000000000002',NULL,NULL);
  IF n <> 0 THEN RAISE EXCEPTION 'platform admin reached a global personal folder'; END IF;

  SELECT count(*) INTO n FROM public.folder_api_list(
    '99999999-0000-4000-8000-000000000009',NULL,'ORG',NULL,
    'aaaaaaaa-0000-4000-8000-000000000001',NULL);
  IF n <> 1 THEN RAISE EXCEPTION 'platform admin lost organization folder read'; END IF;

  SELECT count(*) INTO n FROM public.folder_api_list(
    '33333333-0000-4000-8000-000000000003',NULL,'USER',
    '22222222-0000-4000-8000-000000000002',NULL,'bbbbbbbb-0000-4000-8000-000000000001');
  IF n <> 0 THEN RAISE EXCEPTION 'ordinary member gained peer contextual folder read'; END IF;

  SELECT count(*) INTO n FROM public.folder_api_list(
    '99999999-0000-4000-8000-000000000009','aaaaaaaa-0000-4000-8000-000000000001','USER',
    '22222222-0000-4000-8000-000000000002',NULL,'bbbbbbbb-0000-4000-8000-000000000001');
  IF n <> 0 THEN RAISE EXCEPTION 'API key escaped its organization through platform authority'; END IF;

  BEGIN
    SELECT * INTO created FROM public.folder_api_create(
      '99999999-0000-4000-8000-000000000009',NULL,NULL,'ORG',NULL,
      'cccccccc-0000-4000-8000-000000000001',NULL,'Forbidden platform write',NULL);
  EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'platform read authority widened org writes'; END IF;

  SELECT * INTO created FROM public.folder_api_update(
    '99999999-0000-4000-8000-000000000009',NULL,
    'f0000000-0000-4000-8000-000000000002','Forbidden rename',true,
    NULL,false,NULL,NULL,NULL,false);
  IF created.id IS NOT NULL OR EXISTS (
    SELECT 1 FROM public.folders
     WHERE id='f0000000-0000-4000-8000-000000000002' AND name='Forbidden rename'
  ) THEN RAISE EXCEPTION 'platform read authority widened personal owner writes'; END IF;

  SELECT * INTO created FROM public.folder_api_create(
    '11111111-0000-4000-8000-000000000001',NULL,NULL,'ORG',NULL,
    'aaaaaaaa-0000-4000-8000-000000000001',NULL,'Exact admin write baseline',NULL);
  IF created.org_id IS DISTINCT FROM 'aaaaaaaa-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'exact org admin write baseline regressed';
  END IF;
  PERFORM public.folder_api_delete(
    '11111111-0000-4000-8000-000000000001',NULL,created.id);
END $$;

DO $$ DECLARE failed boolean:=false; n int; f public.folders%ROWTYPE; r jsonb; BEGIN
  SELECT count(*) INTO n FROM public.folder_api_list(
    NULL,'aaaaaaaa-0000-4000-8000-000000000001','ORG',NULL,
    'aaaaaaaa-0000-4000-8000-000000000001',NULL);
  IF n <> 1 THEN RAISE EXCEPTION 'org-only key could not list exact org folders'; END IF;
  SELECT * INTO f FROM public.folder_api_create(
    NULL,'90000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001',
    'ORG',NULL,'aaaaaaaa-0000-4000-8000-000000000001',NULL,'Org key folder',NULL);
  IF f.created_by IS NOT NULL OR f.created_by_api_key_id IS DISTINCT FROM
    '90000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'org-only key folder has incorrect creator audit';
  END IF;
  PERFORM public.folder_api_update(NULL,'aaaaaaaa-0000-4000-8000-000000000001',
    f.id,'Org key renamed',true,NULL,false,NULL,NULL,NULL,false);
  r := public.folder_api_bulk_move(NULL,'aaaaaaaa-0000-4000-8000-000000000001',
    ARRAY['a0000000-0000-4000-8000-000000000002'::uuid],f.id);
  IF jsonb_array_length(r->'moved') <> 1 THEN
    RAISE EXCEPTION 'org-only key could not move an exact-org record: %',r;
  END IF;
  BEGIN
    PERFORM public.folder_api_list(NULL,NULL,'ORG',NULL,
      'aaaaaaaa-0000-4000-8000-000000000001',NULL);
  EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'both-NULL principal reached list RPC'; END IF;
  failed:=false;
  BEGIN
    PERFORM public.folder_api_bulk_move(NULL,NULL,
      ARRAY['a0000000-0000-4000-8000-000000000002'::uuid],NULL);
  EXCEPTION WHEN invalid_parameter_value OR insufficient_privilege THEN failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'both-NULL principal reached bulk RPC'; END IF;
END $$;

DO $$ DECLARE r jsonb; BEGIN
  r := public.folder_api_bulk_move(
    '11111111-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001',
    ARRAY['a0000000-0000-4000-8000-000000000003'::uuid],NULL);
  IF jsonb_array_length(r->'moved') <> 0 OR jsonb_array_length(r->'failed') <> 1 THEN
    RAISE EXCEPTION 'org key moved an other-org issuer-owned record: %',r;
  END IF;
  r := public.folder_api_bulk_move(
    '11111111-0000-4000-8000-000000000001',NULL,
    ARRAY['a0000000-0000-4000-8000-000000000002'::uuid,'a0000000-0000-4000-8000-000000000003'::uuid],NULL);
  IF jsonb_array_length(r->'moved') <> 2 OR r->>'event_org_id' IS NOT NULL THEN
    RAISE EXCEPTION 'mixed-org personal move leaked an aggregate tenant event: %',r;
  END IF;
  r := public.folder_api_bulk_move(
    '11111111-0000-4000-8000-000000000001',NULL,
    ARRAY['a0000000-0000-4000-8000-000000000005'::uuid,'a0000000-0000-4000-8000-000000000002'::uuid],NULL);
  IF jsonb_array_length(r->'moved') <> 2 OR r->>'event_org_id' IS NOT NULL THEN
    RAISE EXCEPTION 'NULL-org plus org move leaked a single-tenant event: %',r;
  END IF;
END $$;

DO $$ DECLARE failed boolean:=false; BEGIN
  BEGIN
    PERFORM public.folder_api_update(
      '11111111-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001',
      'f0000000-0000-4000-8000-000000000005',NULL,false,NULL,false,
      'google_drive','source-revoked','d0000000-0000-4000-8000-000000000002',true);
  EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'revoked connector binding accepted'; END IF;
  PERFORM public.folder_api_update(
    '11111111-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001',
    'f0000000-0000-4000-8000-000000000005',NULL,false,NULL,false,
    'google_drive','source-active','d0000000-0000-4000-8000-000000000001',true);
END $$;

-- Authenticated direct writes cannot manufacture system connector bindings.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','22222222-0000-4000-8000-000000000002',false);
SELECT set_config('request.jwt.claims','{"role":"authenticated","aal":"aal2"}',false);
DO $$ DECLARE failed boolean:=false; BEGIN
  BEGIN
    INSERT INTO public.folders(owner_scope,user_id,context_org_id,name,created_by,
      connector_provider,connector_source_id,connector_connection_id,is_system_managed)
    VALUES ('USER','22222222-0000-4000-8000-000000000002','bbbbbbbb-0000-4000-8000-000000000001','Squat',
      '22222222-0000-4000-8000-000000000002','google_drive','squat','d0000000-0000-4000-8000-000000000001',true);
  EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'authenticated connector squat accepted'; END IF;
END $$;

-- Parent administrator sees explicit child context, never global personal.
SELECT set_config('request.jwt.claim.sub','11111111-0000-4000-8000-000000000001',false);
DO $$ DECLARE contextual int; global_private int; BEGIN
  SELECT count(*) FILTER(WHERE context_org_id IS NOT NULL),count(*) FILTER(WHERE context_org_id IS NULL)
    INTO contextual,global_private FROM public.folders WHERE user_id='22222222-0000-4000-8000-000000000002';
  IF contextual<>1 OR global_private<>0 THEN RAISE EXCEPTION 'parent admin visibility mismatch'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id='22222222-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'parent admin cannot read child member profile';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.anchors WHERE org_id='bbbbbbbb-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'parent admin cannot read child member records';
  END IF;
END $$;

-- Ordinary child member cannot read a peer's contextual personal folder.
SELECT set_config('request.jwt.claim.sub','33333333-0000-4000-8000-000000000003',false);
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.folders WHERE user_id='22222222-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'ordinary member read peer personal folders';
  END IF;
END $$;

-- AAL1 cannot read even its own rows; AAL2 can.
SELECT set_config('request.jwt.claim.sub','22222222-0000-4000-8000-000000000002',false);
SELECT set_config('request.jwt.claims','{"role":"authenticated","aal":"aal1"}',false);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.folders WHERE user_id=auth.uid()) THEN RAISE EXCEPTION 'AAL1 folder read allowed'; END IF; END $$;
SELECT set_config('request.jwt.claims','{"role":"authenticated","aal":"aal2"}',false);
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM public.folders WHERE user_id=auth.uid()) THEN RAISE EXCEPTION 'AAL2 folder read denied'; END IF; END $$;

-- Arbitrary personal context is rejected by RLS.
DO $$ DECLARE failed boolean:=false; BEGIN
  BEGIN INSERT INTO public.folders(owner_scope,user_id,context_org_id,name,created_by)
    VALUES ('USER',auth.uid(),'cccccccc-0000-4000-8000-000000000001','Foreign context',auth.uid());
  EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'arbitrary context accepted'; END IF;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claim.role','service_role',false);
-- Replay the actual 0445 atomic RPC for every creation/reuse branch. Routing
-- occurs before the owner guard on a fresh INSERT and at the artifact link for
-- reuse. An already-filed anchor is never silently moved.
INSERT INTO public.connector_artifact(id,org_id,source,integration_id,external_ref,fingerprint_sha256,metadata,status,updated_at) VALUES
 ('e0000000-0000-4000-8000-000000000010','aaaaaaaa-0000-4000-8000-000000000001','google_drive',
  'd0000000-0000-4000-8000-000000000001','reuse-explicit',repeat('a',64),
  '{"integration_id":"d0000000-0000-4000-8000-000000000001","_drive_folder_id":"drive-explicit","_drive_folder_path":"Root/Explicit"}',
  'processing',clock_timestamp()),
 ('e0000000-0000-4000-8000-000000000011','aaaaaaaa-0000-4000-8000-000000000001','google_drive',
  'd0000000-0000-4000-8000-000000000001','reuse-conflict',repeat('b',64),
  '{"integration_id":"d0000000-0000-4000-8000-000000000001","_drive_folder_id":"drive-conflict","_drive_folder_path":"Root/Conflict"}',
  'processing',clock_timestamp()),
 ('e0000000-0000-4000-8000-000000000012','aaaaaaaa-0000-4000-8000-000000000001','google_drive',
  'd0000000-0000-4000-8000-000000000001','reuse-filed',repeat('c',64),
  '{"integration_id":"d0000000-0000-4000-8000-000000000001","_drive_folder_id":"drive-filed","_drive_folder_path":"Root/Filed"}',
  'processing',clock_timestamp()),
 ('e0000000-0000-4000-8000-000000000013','bbbbbbbb-0000-4000-8000-000000000001','docusign',
  'd0000000-0000-4000-8000-000000000003','member-fresh',repeat('d',64),
  '{"integration_id":"d0000000-0000-4000-8000-000000000003","queue_scope":"member","owner_user_id":"22222222-0000-4000-8000-000000000002"}',
  'processing',clock_timestamp()),
 ('e0000000-0000-4000-8000-000000000015','bbbbbbbb-0000-4000-8000-000000000001','docusign',
  'd0000000-0000-4000-8000-000000000003','member-historical',repeat('e',64),
  '{"integration_id":"d0000000-0000-4000-8000-000000000003","queue_scope":"member","owner_user_id":"22222222-0000-4000-8000-000000000002"}',
  'processing',clock_timestamp());
INSERT INTO public.anchors(id,user_id,org_id,fingerprint,filename,metadata,folder_id,status) VALUES
 ('a0000000-0000-4000-8000-000000000010','11111111-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000001',repeat('a',64),'explicit.pdf',
  '{"source_envelope_id":"reuse-explicit"}',NULL,'PENDING'),
 ('a0000000-0000-4000-8000-000000000011','11111111-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000001',repeat('b',64),'conflict.pdf','{}',NULL,'PENDING'),
 ('a0000000-0000-4000-8000-000000000012','11111111-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000001',repeat('c',64),'filed.pdf',
  '{"source_envelope_id":"reuse-filed"}','f0000000-0000-4000-8000-000000000005','PENDING'),
 ('a0000000-0000-4000-8000-000000000015','11111111-0000-4000-8000-000000000001',
  'bbbbbbbb-0000-4000-8000-000000000001',repeat('f',64),'historical.pdf',
  '{"source_envelope_id":"member-historical"}',NULL,'PENDING');

DO $$
DECLARE artifact public.connector_artifact%ROWTYPE; payload jsonb; result jsonb;
BEGIN
  SELECT * INTO artifact FROM public.connector_artifact WHERE id='e0000000-0000-4000-8000-000000000010';
  payload := jsonb_build_object('fingerprint',artifact.fingerprint_sha256,'status','PENDING',
    'org_id',artifact.org_id,'user_id','11111111-0000-4000-8000-000000000001','filename','explicit.pdf',
    'credential_type','CONTRACT_POSTSIGNING','metadata',artifact.metadata || jsonb_build_object(
      'connector_source',artifact.source,'connector_artifact_id',artifact.id,'external_ref',artifact.external_ref),
    'fingerprint_source','document_bytes');
  result := public.materialize_connector_artifact_anchor(artifact.id,artifact.org_id,artifact.updated_at,
    artifact.fingerprint_sha256,artifact.metadata,payload,'a0000000-0000-4000-8000-000000000010');
  IF result->>'created' <> 'false' OR NOT EXISTS(SELECT 1 FROM public.anchors WHERE id=(result->>'anchor_id')::uuid AND folder_id IS NOT NULL)
  THEN RAISE EXCEPTION '0445 explicit reuse did not auto-sort: %',result; END IF;

  SELECT * INTO artifact FROM public.connector_artifact WHERE id='e0000000-0000-4000-8000-000000000011';
  payload := jsonb_build_object('fingerprint',artifact.fingerprint_sha256,'status','PENDING',
    'org_id',artifact.org_id,'user_id','11111111-0000-4000-8000-000000000001','filename','new-conflict.pdf',
    'credential_type','CONTRACT_POSTSIGNING','metadata',artifact.metadata || jsonb_build_object(
      'connector_source',artifact.source,'connector_artifact_id',artifact.id,'external_ref',artifact.external_ref),
    'fingerprint_source','document_bytes');
  result := public.materialize_connector_artifact_anchor(artifact.id,artifact.org_id,artifact.updated_at,
    artifact.fingerprint_sha256,artifact.metadata,payload,NULL);
  IF result->>'created' <> 'false' OR result->>'anchor_id' <> 'a0000000-0000-4000-8000-000000000011' OR
     NOT EXISTS(SELECT 1 FROM public.anchors WHERE id='a0000000-0000-4000-8000-000000000011' AND folder_id IS NOT NULL)
  THEN RAISE EXCEPTION '0445 unique-conflict reuse did not auto-sort: %',result; END IF;

  SELECT * INTO artifact FROM public.connector_artifact WHERE id='e0000000-0000-4000-8000-000000000012';
  payload := jsonb_build_object('fingerprint',artifact.fingerprint_sha256,'status','PENDING',
    'org_id',artifact.org_id,'user_id','11111111-0000-4000-8000-000000000001','filename','filed.pdf',
    'credential_type','CONTRACT_POSTSIGNING','metadata',artifact.metadata || jsonb_build_object(
      'connector_source',artifact.source,'connector_artifact_id',artifact.id,'external_ref',artifact.external_ref),
    'fingerprint_source','document_bytes');
  PERFORM public.materialize_connector_artifact_anchor(artifact.id,artifact.org_id,artifact.updated_at,
    artifact.fingerprint_sha256,artifact.metadata,payload,'a0000000-0000-4000-8000-000000000012');
  IF (SELECT folder_id FROM public.anchors WHERE id='a0000000-0000-4000-8000-000000000012') IS DISTINCT FROM
     'f0000000-0000-4000-8000-000000000005'::uuid
  THEN RAISE EXCEPTION '0445 reuse overwrote an existing folder'; END IF;

  SELECT * INTO artifact FROM public.connector_artifact WHERE id='e0000000-0000-4000-8000-000000000013';
  payload := jsonb_build_object('fingerprint',artifact.fingerprint_sha256,'status','PENDING',
    'org_id',artifact.org_id,'user_id','22222222-0000-4000-8000-000000000002','filename','member.pdf',
    'credential_type','CONTRACT_POSTSIGNING','metadata',artifact.metadata || jsonb_build_object(
      'connector_source',artifact.source,'connector_artifact_id',artifact.id,'external_ref',artifact.external_ref),
    'fingerprint_source','document_bytes');
  result := public.materialize_connector_artifact_anchor(artifact.id,artifact.org_id,artifact.updated_at,
    artifact.fingerprint_sha256,artifact.metadata,payload,NULL);
  IF NOT EXISTS(SELECT 1 FROM public.anchors a JOIN public.folders f ON f.id=a.folder_id
      WHERE a.id=(result->>'anchor_id')::uuid AND f.owner_scope='USER'
        AND f.user_id=a.user_id AND f.user_id='22222222-0000-4000-8000-000000000002'
        AND f.context_org_id=a.org_id)
  THEN RAISE EXCEPTION 'member connector missed its exact personal destination: %',result; END IF;

  SELECT * INTO artifact FROM public.connector_artifact WHERE id='e0000000-0000-4000-8000-000000000015';
  payload := jsonb_build_object('fingerprint',artifact.fingerprint_sha256,'status','PENDING',
    'org_id',artifact.org_id,'user_id','22222222-0000-4000-8000-000000000002','filename','historical.pdf',
    'credential_type','CONTRACT_POSTSIGNING','metadata',artifact.metadata || jsonb_build_object(
      'connector_source',artifact.source,'connector_artifact_id',artifact.id,'external_ref',artifact.external_ref),
    'fingerprint_source','document_bytes');
  result := public.materialize_connector_artifact_anchor(artifact.id,artifact.org_id,artifact.updated_at,
    artifact.fingerprint_sha256,artifact.metadata,payload,'a0000000-0000-4000-8000-000000000015');
  IF result->>'anchor_id' <> 'a0000000-0000-4000-8000-000000000015' OR
     (SELECT folder_id FROM public.anchors WHERE id='a0000000-0000-4000-8000-000000000015') IS NOT NULL THEN
    RAISE EXCEPTION 'historical cross-owner envelope reuse was stranded or misfiled: %',result;
  END IF;
END $$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','33333333-0000-4000-8000-000000000003',false);
SELECT set_config('request.jwt.claims','{"role":"authenticated","aal":"aal2"}',false);
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.folders WHERE connector_source_id='d0000000-0000-4000-8000-000000000003') THEN
    RAISE EXCEPTION 'ordinary peer read member connector destination';
  END IF;
END $$;
RESET ROLE;



-- Connector materialization uses an active same-org connection and the
-- canonical folder model, even when an ordinary folder has a similar name.
SELECT set_config('request.jwt.claim.role','service_role',false);
INSERT INTO public.folders(owner_scope,org_id,name,created_by) VALUES
 ('ORG','aaaaaaaa-0000-4000-8000-000000000001','Receipts','11111111-0000-4000-8000-000000000001');
INSERT INTO public.connector_artifact(id,org_id,source,integration_id,external_ref,fingerprint_sha256,metadata,status) VALUES
 ('e0000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','google_drive',
  'd0000000-0000-4000-8000-000000000001','drive-file',repeat('4',64),
  '{"integration_id":"d0000000-0000-4000-8000-000000000001","_drive_folder_id":"drive-folder-1","_drive_folder_path":"Root/Receipts"}','processing');
INSERT INTO public.anchors(id,user_id,org_id,fingerprint,filename,metadata) VALUES
 ('a0000000-0000-4000-8000-000000000004','11111111-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001',repeat('4',64),'drive.pdf',
  '{"connector_artifact_id":"e0000000-0000-4000-8000-000000000001"}');
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.anchors a JOIN public.folders f ON f.id=a.folder_id
    WHERE a.id='a0000000-0000-4000-8000-000000000004' AND f.connector_source_id='drive-folder-1' AND f.is_system_managed) THEN
    RAISE EXCEPTION 'connector auto-sort did not create/use its canonical destination';
  END IF;
END $$;

-- Reconnecting the same Drive source refreshes the canonical folder's active
-- connection id without creating a duplicate destination.
UPDATE public.org_integrations SET revoked_at=now()
 WHERE id='d0000000-0000-4000-8000-000000000001';
INSERT INTO public.org_integrations(id,org_id,provider,revoked_at) VALUES
 ('d0000000-0000-4000-8000-000000000004','aaaaaaaa-0000-4000-8000-000000000001','google_drive',NULL);
INSERT INTO public.connector_artifact(id,org_id,source,integration_id,external_ref,fingerprint_sha256,metadata,status,updated_at) VALUES
 ('e0000000-0000-4000-8000-000000000014','aaaaaaaa-0000-4000-8000-000000000001','google_drive',
  'd0000000-0000-4000-8000-000000000004','drive-reconnect',repeat('6',64),
  '{"integration_id":"d0000000-0000-4000-8000-000000000004","_drive_folder_id":"drive-explicit","_drive_folder_path":"Root/Explicit"}',
  'processing',clock_timestamp());
DO $$ DECLARE artifact public.connector_artifact%ROWTYPE; payload jsonb; result jsonb; BEGIN
  SELECT * INTO artifact FROM public.connector_artifact WHERE id='e0000000-0000-4000-8000-000000000014';
  payload := jsonb_build_object('fingerprint',artifact.fingerprint_sha256,'status','PENDING',
    'org_id',artifact.org_id,'user_id','11111111-0000-4000-8000-000000000001','filename','reconnect.pdf',
    'credential_type','CONTRACT_POSTSIGNING','metadata',artifact.metadata || jsonb_build_object(
      'connector_source',artifact.source,'connector_artifact_id',artifact.id,'external_ref',artifact.external_ref),
    'fingerprint_source','document_bytes');
  result := public.materialize_connector_artifact_anchor(artifact.id,artifact.org_id,artifact.updated_at,
    artifact.fingerprint_sha256,artifact.metadata,payload,NULL);
  IF NOT EXISTS(SELECT 1 FROM public.anchors a JOIN public.folders f ON f.id=a.folder_id
      WHERE a.id=(result->>'anchor_id')::uuid AND f.connector_source_id='drive-explicit'
        AND f.connector_connection_id='d0000000-0000-4000-8000-000000000004') THEN
    RAISE EXCEPTION 'connector reconnect did not refresh canonical destination: %',result;
  END IF;
END $$;

-- Concurrent cycle fixture ids consumed by run-native-check.sh.
INSERT INTO public.folders(id,owner_scope,user_id,name,created_by) VALUES
 ('f0000000-0000-4000-8000-000000000010','USER','11111111-0000-4000-8000-000000000001','Cycle A','11111111-0000-4000-8000-000000000001'),
 ('f0000000-0000-4000-8000-000000000011','USER','11111111-0000-4000-8000-000000000001','Cycle B','11111111-0000-4000-8000-000000000001');

SELECT 'uat24-native-assertions-ok' AS result;
