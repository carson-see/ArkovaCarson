-- SCRUM-1581: Align DB CHECK constraints with the canonical API key scope vocabulary.
-- ROLLBACK:
-- ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_scopes_known_values;
-- ALTER TABLE public.api_keys ADD CONSTRAINT api_keys_scopes_known_values
--   CHECK (
--     array_length(scopes, 1) >= 1
--     AND scopes <@ ARRAY[
--       'read:records', 'read:orgs', 'read:search', 'write:anchors',
--       'admin:rules', 'verify', 'verify:batch', 'usage:read', 'keys:manage'
--     ]::text[]
--   );
-- ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_allowed_scopes_known_values;

UPDATE public.api_keys
SET scopes = array_replace(
  array_replace(
    array_replace(
      array_replace(scopes, 'batch', 'verify:batch'),
      'usage',
      'usage:read'
    ),
    'oracle',
    'oracle:read'
  ),
  'attest',
  'attestations:write'
)
WHERE scopes && ARRAY['batch', 'usage', 'oracle', 'attest']::text[];

ALTER TABLE public.api_keys
  DROP CONSTRAINT IF EXISTS api_keys_scopes_known_values;

ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_scopes_known_values
  CHECK (
    array_length(scopes, 1) >= 1
    AND scopes <@ ARRAY[
      'read:records',
      'read:orgs',
      'read:search',
      'write:anchors',
      'admin:rules',
      'verify',
      'verify:batch',
      'usage:read',
      'keys:manage',
      'compliance:read',
      'compliance:write',
      'oracle:read',
      'oracle:write',
      'anchor:write',
      'anchor:read',
      'attestations:write',
      'attestations:read',
      'webhooks:manage',
      'agents:manage',
      'keys:read'
    ]::text[]
  );

COMMENT ON COLUMN public.api_keys.scopes IS
  'Canonical API key scope vocabulary: read:records, read:orgs, read:search, write:anchors, admin:rules, verify, verify:batch, usage:read, keys:manage, compliance:read, compliance:write, oracle:read, oracle:write, anchor:write, anchor:read, attestations:write, attestations:read, webhooks:manage, agents:manage, keys:read.';

UPDATE public.agents
SET allowed_scopes = array_replace(
  array_replace(
    array_replace(
      array_replace(allowed_scopes, 'batch', 'verify:batch'),
      'usage',
      'usage:read'
    ),
    'oracle',
    'oracle:read'
  ),
  'attest',
  'attestations:write'
)
WHERE allowed_scopes && ARRAY['batch', 'usage', 'oracle', 'attest']::text[];

ALTER TABLE public.agents
  DROP CONSTRAINT IF EXISTS agents_allowed_scopes_known_values;

ALTER TABLE public.agents
  ADD CONSTRAINT agents_allowed_scopes_known_values
  CHECK (
    array_length(allowed_scopes, 1) >= 1
    AND allowed_scopes <@ ARRAY[
      'read:records',
      'read:orgs',
      'read:search',
      'write:anchors',
      'admin:rules',
      'verify',
      'verify:batch',
      'usage:read',
      'keys:manage',
      'compliance:read',
      'compliance:write',
      'oracle:read',
      'oracle:write',
      'anchor:write',
      'anchor:read',
      'attestations:write',
      'attestations:read',
      'webhooks:manage',
      'agents:manage',
      'keys:read'
    ]::text[]
  );

COMMENT ON COLUMN public.agents.allowed_scopes IS
  'Canonical API key scopes an agent may receive when generating delegated keys.';

NOTIFY pgrst, 'reload schema';
