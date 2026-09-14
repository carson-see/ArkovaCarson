\set ON_ERROR_STOP on
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='folders' AND column_name='parent_folder_id') THEN
    RAISE EXCEPTION '0462 folder columns remain after rollback';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.folders WHERE id='f0000000-0000-4000-8000-000000000001') OR
     NOT EXISTS(SELECT 1 FROM public.anchors WHERE id='a0000000-0000-4000-8000-000000000001' AND folder_id='f0000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'rollback lost baseline folder or assignment';
  END IF;
END $$;
SELECT 'uat24-native-rollback-ok' AS result;

