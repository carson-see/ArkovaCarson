import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0488_atomic_admin_agent_revoke.sql'),
  'utf8',
);

describe('0488 atomic admin agent revoke', () => {
  it('locks the tenant-owned parent before moving agent, keys, and audit atomically', () => {
    const actorCheck = migration.indexOf('FROM public.profiles');
    const lock = migration.indexOf('\n  FOR UPDATE;');
    const agentUpdate = migration.indexOf('UPDATE public.agents');
    const keyUpdate = migration.indexOf('UPDATE public.api_keys');
    const auditInsert = migration.indexOf('INSERT INTO public.audit_events');

    expect(actorCheck).toBeGreaterThan(0);
    expect(actorCheck).toBeLessThan(lock);
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(agentUpdate);
    expect(agentUpdate).toBeLessThan(keyUpdate);
    expect(keyUpdate).toBeLessThan(auditInsert);
    expect(migration).toMatch(/WHERE id = p_agent_id AND org_id = p_org_id\s+FOR UPDATE/i);
    expect(migration).toMatch(/IF v_status_changed OR v_keys_revoked > 0 THEN\s+INSERT INTO public\.audit_events/i);
  });

  it('permanently revokes active and admin-suspended keys without overwriting unrelated inactive reasons', () => {
    expect(migration).toMatch(/revocation_reason = 'admin:agent\.revoked'/i);
    expect(migration).toMatch(/is_active\s+OR revocation_reason = 'admin:agent\.suspended'/i);
    expect(migration).toMatch(/SET is_active = false/i);
  });

  it('is service-only and validates caller-controlled arguments', () => {
    expect(migration).toMatch(/SECURITY DEFINER/i);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.revoke_agent_and_keys\(uuid,uuid,uuid\)\s+FROM PUBLIC, anon, authenticated/i);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.revoke_agent_and_keys\(uuid,uuid,uuid\)\s+TO service_role/i);
    expect(migration).toMatch(/p_org_id IS NULL OR p_agent_id IS NULL OR p_actor_id IS NULL/i);
    expect(migration).toMatch(/WHERE id = p_actor_id AND org_id = p_org_id/i);
    expect(migration).toMatch(/v_actor_role <> 'ORG_ADMIN'::public\.user_role/i);
  });
});
