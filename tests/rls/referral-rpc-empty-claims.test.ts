/** Migration 0466: referral SECURITY DEFINER RPCs fail closed without JWT role claims. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Stable seed identities, also pinned by src/tests/rls/helpers.ts. Keep this
// native-pg suite independent of Supabase HTTP environment variables.
const ADMIN_ID = '44444444-0000-4000-8000-000000000001';
const ARKOVA_ORG_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

const dbUrl = process.env.RLS_DATABASE_URL
  ?? 'postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres';
const fixtureUrl = new URL(dbUrl);
const migrationSource = process.env.REFERRAL_RPC_MIGRATION_PATH
  ?? new URL('../../supabase/migrations/0466_referral_rpc_empty_claims_fail_closed.sql', import.meta.url);
const migrationSql = readFileSync(migrationSource, 'utf8')
  .replace(/^BEGIN;$/m, '')
  .replace(/^COMMIT;$/m, '');
if (!['postgres:', 'postgresql:'].includes(fixtureUrl.protocol)
  || !['127.0.0.1', 'localhost', '[::1]'].includes(fixtureUrl.hostname)
  || !['54322', '55503', '15422', '16422', '17422', '18422', '19422'].includes(fixtureUrl.port)) {
  throw new Error('Referral RPC regression requires an owned loopback PostgreSQL fixture');
}

function sql(body: string): string {
  return execFileSync('psql', ['-X', dbUrl, '-v', 'ON_ERROR_STOP=1', '-At'], {
    // Install the candidate definitions inside the rolled-back fixture. This
    // proves the migration without mutating a developer's shared local stack.
    input: `BEGIN; ${migrationSql} ${body}; ROLLBACK;`, encoding: 'utf8', stdio: 'pipe',
  });
}

describe('0466 referral RPC caller identity (native PostgreSQL)', () => {
  it.each([
    ['record_org_referral', `PERFORM public.record_org_referral('${ARKOVA_ORG_ID}','', 'signup')`],
    ['get_org_referrals', `PERFORM * FROM public.get_org_referrals('${ARKOVA_ORG_ID}')`],
  ])('denies %s when authenticated execution has empty request claims', (_name, call) => {
    const output = sql(`SET LOCAL ROLE authenticated;
      SELECT set_config('request.jwt.claim.role','',true);
      SELECT set_config('request.jwt.claims','',true);
      DO $test$ BEGIN
        ${call};
        RAISE EXCEPTION 'authority guard did not deny empty claims';
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'empty_claims_denied';
      END $test$`);
    expect(output).toContain('ROLLBACK');
  });

  it('preserves the service-role path', () => {
    const output = sql(`SET LOCAL ROLE service_role;
      SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
      SELECT public.record_org_referral('${ARKOVA_ORG_ID}','', 'api')->>'reason'`);
    expect(output).toContain('no_code');
  });

  it('preserves the authenticated tenant-member path', () => {
    const claims = JSON.stringify({ role: 'authenticated', sub: ADMIN_ID });
    const output = sql(`SET LOCAL ROLE authenticated;
      SELECT set_config('request.jwt.claims','${claims}',true);
      SELECT public.record_org_referral('${ARKOVA_ORG_ID}','', 'signup')->>'reason'`);
    expect(output).toContain('no_code');
  });
});
