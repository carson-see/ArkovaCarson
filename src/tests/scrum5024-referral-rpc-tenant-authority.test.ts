import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SCRUM-5024 — `record_org_referral` tenant authority and audit disclosure.
 *
 * WHY THIS RATCHET EXISTS. Migration `0455` grants EXECUTE on
 * `record_org_referral(uuid, text, text)` to `authenticated` and the function is
 * `SECURITY DEFINER`, so its body is the ONLY authority check that runs — the
 * SELECT policies on `referral_codes` / `organization_referrals` do not
 * constrain it. As `0455` first wrote it the body validated `p_source` and
 * `p_org_id IS NOT NULL` and nothing else, which meant two things any signed-in
 * user could do with nothing but a target organization's uuid:
 *
 *   1. ATTRIBUTION HIJACK. Call it with someone else's `p_org_id` and their own
 *      ACTIVE code. `organization_referrals.referred_org_id` is the PRIMARY KEY,
 *      the first write wins forever and no revoke surface ships — so a partner
 *      could permanently claim an organization they never introduced.
 *   2. CROSS-TENANT AUDIT INJECTION. A bogus code takes the `unknown_code`
 *      branch, which writes an `organization.referral_code_invalid` row with
 *      `org_id = p_org_id`, i.e. into a DIFFERENT tenant's audit stream, with
 *      caller-controlled text in `details`.
 *
 * And the success branch filed `organization.referred` with
 * `actor_id = auth.uid()`. On the signup path that actor is a member of the
 * REFERRED organization, and `audit_events_select` (baseline) is
 * `USING (actor_id = (SELECT auth.uid()))` with `GRANT SELECT ... TO
 * authenticated` — so the referred user could read back a row naming the
 * referrer's raw org uuid in both `org_id` and `target_id`. That is the exact
 * asymmetry `COMMENT ON TABLE public.organization_referrals` calls deliberate,
 * defeated through the audit table, plus a §6 raw-`org_id` exposure.
 *
 * `0456` replaces both function bodies. These assertions were run against
 * `0455` alone first and FAILED (5 of 7) — that is what makes them a ratchet
 * rather than a restatement of the current file.
 *
 * The assertions read the LAST definition of each function across the migration
 * directory in ledger order, because that is what the database ends up with. A
 * future migration that replaces either body has to keep these properties or
 * this test goes red.
 */

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');

/** Executable SQL only. The header prose legitimately describes the rejected
 *  designs, so comment lines must not satisfy any assertion below. */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** Every migration, in ledger order, comments stripped. */
const ledgerSql: string = fs
  .readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => executableSql(fs.readFileSync(path.join(migrationsDir, file), 'utf8')))
  .join('\n');

/** The LAST `CREATE OR REPLACE FUNCTION public.<name>` block in ledger order —
 *  the definition the database is actually left holding. */
function effectiveFunctionBody(name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}`;
  const start = ledgerSql.lastIndexOf(marker);
  if (start === -1) throw new Error(`Missing function ${name}`);
  const end = ledgerSql.indexOf('$function$;', start);
  if (end === -1) throw new Error(`Unterminated function ${name}`);
  return ledgerSql.slice(start, end);
}

describe('SCRUM-5024 — record_org_referral tenant authority', () => {
  const body = effectiveFunctionBody('record_org_referral');

  it('refuses a p_org_id the caller is not a member of', () => {
    // `authenticated` holds EXECUTE, so the guard has to be inside the body.
    expect(ledgerSql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.record_org_referral\(uuid, text, text\) TO authenticated;/,
    );
    expect(body).toContain('get_user_org_ids');
    expect(body).toMatch(/insufficient_privilege/);
  });

  it('exempts service_role via get_caller_role(), not via a bare bypass', () => {
    // The worker (admin provisioning) calls this with the service key and has no
    // auth.uid(); CLAUDE.md §6 bans `current_setting('request.jwt.claim.role')`.
    expect(body).toContain("public.get_caller_role() = 'service_role'");
    expect(body).not.toContain('request.jwt.claim.role');
  });

  it('treats a missing caller role as non-service instead of skipping the guard', () => {
    expect(body).toMatch(
      /coalesce\(public\.get_caller_role\(\) = 'service_role',\s*false\)/,
    );
  });

  it('does not use `NOT IN (SELECT ...)` for the membership test', () => {
    // `x NOT IN (a set containing NULL)` is NULL, and `IF NULL THEN RAISE` does
    // not fire — a fail-OPEN authority check. `NOT EXISTS` is NULL-safe.
    expect(body).not.toMatch(/NOT IN \(SELECT public\.get_user_org_ids\(\)\)/);
  });

  it('bounds the caller-supplied code it writes into audit details', () => {
    // `audit_events_details_length` CHECKs `char_length(details) <= 10000`. An
    // unbounded `p_code` therefore RAISES from a function documented as a total
    // verdict that never raises.
    expect(body).toMatch(/left\(v_code,\s*\d+\)/);
  });

  it('restricts non-service callers to p_source = signup', () => {
    // A non-service caller can only ever be recording their OWN signup — the
    // service role is what actually runs admin provisioning or the public API.
    // Without this guard, an ordinary authenticated user could call this RPC
    // asserting `p_source = 'admin_provisioning'` or `'api'`, misrepresenting
    // how the referral was recorded to anyone reading `source` off the audit
    // trail or partner analytics. This is an authority failure, not a verdict,
    // so it RAISES (with the same ERRCODE as the other authority checks in this
    // function) instead of returning a jsonb reason.
    const guardIdx = body.indexOf("IF NOT v_is_service AND p_source <> 'signup' THEN");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(body.slice(guardIdx, guardIdx + 200)).toMatch(/insufficient_privilege/);
  });
});

describe('SCRUM-5024 — audit disclosure boundary', () => {
  const body = effectiveFunctionBody('record_org_referral');
  const referredInsert = body.slice(body.indexOf("'organization.referred'"));

  it('files organization.referred with a NULL actor', () => {
    // audit_events_select is actor-scoped. A non-null actor here is a member of
    // the REFERRED org and would read back the referrer's raw org uuid.
    expect(referredInsert).toMatch(/'organization\.referred',\s*'ORG',\s*NULL,/);
    expect(referredInsert).not.toMatch(/'organization\.referred',\s*'ORG',\s*v_actor,/);
  });

  it('still files organization.referred against the referrer org', () => {
    expect(referredInsert).toContain('v_referrer_org_id');
  });
});

describe('SCRUM-5024 — get_org_referrals tenant authority', () => {
  const body = effectiveFunctionBody('get_org_referrals');

  it('uses a NULL-safe membership test', () => {
    expect(body).toContain('get_user_org_ids');
    expect(body).not.toMatch(/NOT IN \(SELECT public\.get_user_org_ids\(\)\)/);
  });

  it('treats a missing caller role as non-service instead of skipping the guard', () => {
    expect(body).toMatch(
      /coalesce\(public\.get_caller_role\(\) = 'service_role',\s*false\)/,
    );
  });
});
