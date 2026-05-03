-- SCRUM-1581: Align DB CHECK constraints with the canonical API key scope vocabulary.
-- ROLLBACK:
-- ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_scopes_known_values;
-- Restore the previous api_keys_scopes_known_values CHECK from migration 0239_api_key_scopes.sql.
-- ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_allowed_scopes_known_values;

CREATE TEMP TABLE scope_aliases (
  old_scope text PRIMARY KEY,
  new_scope text NOT NULL
) ON COMMIT DROP;

INSERT INTO scope_aliases (old_scope, new_scope)
VALUES
  ('batch', 'verify:batch'),
  ('usage', 'usage:read'),
  ('oracle', 'oracle:read'),
  ('attest', 'attestations:write');

UPDATE public.api_keys AS api_keys
SET scopes = (
  SELECT array_agg(COALESCE(scope_aliases.new_scope, scope_item.scope) ORDER BY scope_item.ordinality)
  FROM unnest(api_keys.scopes) WITH ORDINALITY AS scope_item(scope, ordinality)
  LEFT JOIN scope_aliases ON scope_aliases.old_scope = scope_item.scope
)
WHERE api_keys.scopes && ARRAY(SELECT old_scope FROM scope_aliases);

ALTER TABLE public.api_keys
  DROP CONSTRAINT IF EXISTS api_keys_scopes_known_values;

ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_scopes_known_values
  CHECK (
    cardinality(scopes) >= 1
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
  'Canonical API key scope vocabulary enforced by api_keys_scopes_known_values; source-of-truth list lives in services/worker/src/api/apiScopes.ts.';

UPDATE public.agents AS agents
SET allowed_scopes = (
  SELECT array_agg(COALESCE(scope_aliases.new_scope, scope_item.scope) ORDER BY scope_item.ordinality)
  FROM unnest(agents.allowed_scopes) WITH ORDINALITY AS scope_item(scope, ordinality)
  LEFT JOIN scope_aliases ON scope_aliases.old_scope = scope_item.scope
)
WHERE agents.allowed_scopes && ARRAY(SELECT old_scope FROM scope_aliases);

ALTER TABLE public.agents
  DROP CONSTRAINT IF EXISTS agents_allowed_scopes_known_values;

ALTER TABLE public.agents
  ADD CONSTRAINT agents_allowed_scopes_known_values
  CHECK (
    cardinality(allowed_scopes) >= 1
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
