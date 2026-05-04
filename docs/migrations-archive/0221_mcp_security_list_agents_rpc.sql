-- Migration 0221: SECURITY DEFINER RPC for MCP `list_agents` tool
--
-- BACKGROUND: The edge MCP server's `list_agents` tool previously queried
-- `/rest/v1/agents?status=eq.active` using the service-role key, with no
-- org filter. Any authenticated API-key holder could enumerate every
-- active agent across every org in the system — a cross-org data leak
-- flagged in the 2026-04-19 MCP security audit.
--
-- This RPC scopes the agent list to the caller's org by joining through
-- `org_members`. SECURITY DEFINER bypasses RLS (the agents table has its
-- own policy set but the edge caller runs with service-role, so RLS
-- isn't enforced anyway — we need an explicit filter).
--
-- Inputs:
--   p_user_id uuid — the authenticated MCP caller's auth.users.id
--
-- Returns: agents the caller's org owns (status='active'), with only the
-- non-sensitive fields the MCP tool needs to surface.
--
-- Jira: MCP-SEC-01 follow-up (TBD)
-- Audit: 2026-04-20
--
-- ROLLBACK: DROP FUNCTION IF EXISTS get_agents_for_user(uuid);

CREATE OR REPLACE FUNCTION get_agents_for_user(p_user_id uuid)
RETURNS TABLE (
  id uuid,
  name text,
  agent_type text,
  status text,
  allowed_scopes text[],
  framework text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id, a.name, a.agent_type::text, a.status::text, a.allowed_scopes, a.framework, a.created_at
  FROM agents a
  JOIN org_members om ON om.org_id = a.org_id
  WHERE om.user_id = p_user_id
    AND a.status = 'active'
  ORDER BY a.created_at DESC
  LIMIT 100;
$$;

COMMENT ON FUNCTION get_agents_for_user IS
  'MCP security: returns agents scoped to the caller''s org membership. '
  'Used by the edge MCP `list_agents` tool to replace an unscoped '
  'service-role query that leaked cross-org data.';

REVOKE EXECUTE ON FUNCTION get_agents_for_user(uuid) FROM public;
REVOKE EXECUTE ON FUNCTION get_agents_for_user(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION get_agents_for_user(uuid) FROM authenticated;
-- service_role bypasses GRANT anyway; keep the explicit grant narrow.
-- The edge worker calls this RPC with the service role key + p_user_id
-- taken from the validated API-key / JWT auth layer.

NOTIFY pgrst, 'reload schema';
