CREATE OR REPLACE FUNCTION get_agents_for_user(p_user_id uuid)
RETURNS TABLE (
  id uuid, name text, agent_type text, status text,
  allowed_scopes text[], framework text, created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT a.id, a.name, a.agent_type::text, a.status::text, a.allowed_scopes, a.framework, a.created_at
  FROM agents a
  JOIN org_members om ON om.org_id = a.org_id
  WHERE om.user_id = p_user_id AND a.status = 'active'
  ORDER BY a.created_at DESC
  LIMIT 100;
$$;

COMMENT ON FUNCTION get_agents_for_user IS 'MCP security: org-scoped agent list for the edge list_agents tool';
REVOKE EXECUTE ON FUNCTION get_agents_for_user(uuid) FROM public, anon, authenticated;
NOTIFY pgrst, 'reload schema';;
