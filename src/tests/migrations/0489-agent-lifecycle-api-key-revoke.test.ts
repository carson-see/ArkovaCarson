import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/0489_scrum3980_agent_lifecycle_api_key_revoke.sql'), 'utf8');

describe('0489 machine-authorized atomic agent revoke', () => {
  it('uses a distinct service-only RPC and locks target agent before caller key', () => {
    const agentLock = sql.indexOf('FROM public.agents');
    const keyLock = sql.indexOf('FROM public.api_keys');
    const sweep = sql.indexOf('UPDATE public.api_keys');
    expect(agentLock).toBeGreaterThan(0);
    expect(agentLock).toBeLessThan(keyLock);
    expect(keyLock).toBeLessThan(sweep);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.revoke_agent_and_keys_as_api_key\(uuid,uuid,uuid\)\s+FROM PUBLIC, anon, authenticated/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.revoke_agent_and_keys_as_api_key\(uuid,uuid,uuid\)\s+TO service_role/i);
  });

  it('validates same-org live unexpired agents:manage authority before writes', () => {
    const validation = sql.indexOf("OR NOT ('agents:manage'");
    expect(sql).toMatch(/WHERE id = p_actor_api_key_id AND org_id = p_org_id\s+FOR UPDATE/i);
    expect(sql).toMatch(/NOT v_actor\.is_active/i);
    expect(sql).toMatch(/v_actor\.revoked_at IS NOT NULL/i);
    expect(sql).toMatch(/v_actor\.expires_at <= v_now/i);
    expect(validation).toBeGreaterThan(0);
    expect(validation).toBeLessThan(sql.indexOf('UPDATE public.agents'));
  });

  it('attributes machine audit without human impersonation', () => {
    expect(sql).toMatch(/NULL, p_org_id, 'AGENT_REVOKED'/i);
    expect(sql).toContain("'actor_kind', 'api_key'");
    expect(sql).toContain("'actor_api_key_id', v_actor.id");
    expect(sql).toContain("'actor_key_prefix', v_actor.key_prefix");
  });
  it('enforces durable provider suspension and current parent scope at the database boundary', () => {
    expect(sql).toContain('computeid_provider_suspension_active');
    expect(sql).toMatch(/UPDATE public\.agents[\s\S]*last_event}' = 'passport\.suspended'/i);
    expect(sql).toContain('UPDATE OF is_active, agent_id, org_id, scopes');
    expect(sql).toMatch(/NEW\.metadata #>> '\{computeid,provider_suspended\}' = 'true'/i);
    expect(sql).toMatch(/COALESCE\(NEW\.scopes, ARRAY\[\]::text\[\]\) <@ COALESCE\(v_allowed_scopes, ARRAY\[\]::text\[\]\)/i);
    expect(sql).toMatch(/FROM public\.agents WHERE id = NEW\.agent_id FOR SHARE/i);
  });

});
