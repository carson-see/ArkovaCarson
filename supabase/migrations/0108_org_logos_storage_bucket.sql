-- =============================================================================
-- Migration 0108: Create storage bucket for organization logos
-- Story: MVP-13 (partial) — Organization logo upload
-- Date: 2026-03-24
--
-- PURPOSE
-- -------
-- Creates a public storage bucket for org logos with RLS policies:
-- - Anyone can read (logos are public on org profile pages)
-- - Only org admins can upload/update/delete their org's logos
--
-- Files are stored as: {org_id}/logo.{ext}
-- =============================================================================

-- 1. Create the bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'org-logos',
  'org-logos',
  true,
  2097152, -- 2 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- 2. Public read policy (logos are public)
CREATE POLICY "org_logos_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'org-logos');

-- 3. Org admins can upload logos for their org
CREATE POLICY "org_logos_admin_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'org-logos'
    AND EXISTS (
      SELECT 1 FROM org_members om
      JOIN profiles p ON p.id = om.user_id
      WHERE om.user_id = auth.uid()
        AND om.org_id::text = (storage.foldername(name))[1]
        AND (p.role = 'ORG_ADMIN' OR om.role IN ('owner', 'admin'))
    )
  );

-- 4. Org admins can update logos for their org
CREATE POLICY "org_logos_admin_update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'org-logos'
    AND EXISTS (
      SELECT 1 FROM org_members om
      JOIN profiles p ON p.id = om.user_id
      WHERE om.user_id = auth.uid()
        AND om.org_id::text = (storage.foldername(name))[1]
        AND (p.role = 'ORG_ADMIN' OR om.role IN ('owner', 'admin'))
    )
  );

-- 5. Org admins can delete logos for their org
CREATE POLICY "org_logos_admin_delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'org-logos'
    AND EXISTS (
      SELECT 1 FROM org_members om
      JOIN profiles p ON p.id = om.user_id
      WHERE om.user_id = auth.uid()
        AND om.org_id::text = (storage.foldername(name))[1]
        AND (p.role = 'ORG_ADMIN' OR om.role IN ('owner', 'admin'))
    )
  );


-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- DROP POLICY IF EXISTS "org_logos_public_read" ON storage.objects;
-- DROP POLICY IF EXISTS "org_logos_admin_insert" ON storage.objects;
-- DROP POLICY IF EXISTS "org_logos_admin_update" ON storage.objects;
-- DROP POLICY IF EXISTS "org_logos_admin_delete" ON storage.objects;
-- DELETE FROM storage.objects WHERE bucket_id = 'org-logos';
-- DELETE FROM storage.buckets WHERE id = 'org-logos';
