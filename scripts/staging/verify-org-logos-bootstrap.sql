-- Classify the Path-C-external org-logos Storage bootstrap.
-- Exactly one row is returned so provision-isolated-rig.sh can fail closed.
WITH expected_policies(policyname, cmd, qual_hash, check_hash) AS (
  VALUES
    ('org_logos_public_read', 'SELECT', '78ea9c4a2317d55be036eec29ed39abe', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('org_logos_admin_insert', 'INSERT', 'd41d8cd98f00b204e9800998ecf8427e', 'd6c00fd6f4ccfb3c53a3ee0056f85c7d'),
    ('org_logos_admin_update', 'UPDATE', 'd6c00fd6f4ccfb3c53a3ee0056f85c7d', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('org_logos_admin_delete', 'DELETE', 'd6c00fd6f4ccfb3c53a3ee0056f85c7d', 'd41d8cd98f00b204e9800998ecf8427e')
), actual_policies AS (
  SELECT policyname, cmd,
         md5(regexp_replace(coalesce(qual, ''), '\s', '', 'g')) AS qual_hash,
         md5(regexp_replace(coalesce(with_check, ''), '\s', '', 'g')) AS check_hash,
         permissive, roles
  FROM pg_policies
  WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname IN (SELECT policyname FROM expected_policies)
), observed AS (
  SELECT
    (SELECT count(*) FROM storage.buckets WHERE id = 'org-logos') AS bucket_count,
    (SELECT count(*) FROM actual_policies) AS policy_count,
    (SELECT count(*) FROM storage.buckets
      WHERE id = 'org-logos' AND name = 'org-logos' AND public
        AND file_size_limit = 2097152
        AND allowed_mime_types = ARRAY['image/png','image/jpeg','image/webp']::text[]) AS exact_bucket_count,
    (SELECT count(*) FROM actual_policies a JOIN expected_policies e USING (policyname,cmd,qual_hash,check_hash)
      WHERE a.permissive = 'PERMISSIVE' AND a.roles = ARRAY['public']::name[]) AS exact_policy_count
)
SELECT CASE
  WHEN bucket_count = 0 AND policy_count = 0 THEN 'ORG_LOGOS_BOOTSTRAP_STATE=absent'
  WHEN bucket_count = 1 AND policy_count = 4 AND exact_bucket_count = 1 AND exact_policy_count = 4
    THEN 'ORG_LOGOS_BOOTSTRAP_STATE=complete'
  ELSE 'ORG_LOGOS_BOOTSTRAP_STATE=unexpected'
END AS org_logos_bootstrap_state
FROM observed;
