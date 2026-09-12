/**
 * SEC — migration 0453 (SCRUM-3971): an API key administering sub-organizations.
 *
 * Migration: supabase/migrations/0453_scrum3971_orgs_manage_scope_api_key_suborg_authority.sql
 *
 * 0453 adds three SECURITY DEFINER RPCs that move credits and suspend
 * organizations on the authority of an API KEY rather than a logged-in user.
 * That is a new class of principal on a money-moving path, so the properties
 * below are ratchets, not descriptions:
 *
 *   - The authority predicate is `_suborg_api_key_authorized` and NOTHING ELSE.
 *     A body that re-implements the check inline is how 0430 and 0450 drifted
 *     apart in the first place.
 *   - The predicate requires ALL FOUR of: the key belongs to the organization
 *     being administered, is active, is not revoked, and is not expired — plus
 *     the `orgs:manage` grant. Dropping any one is a live authorization hole,
 *     and three of the four are invisible in a green integration test run
 *     against a fresh key.
 *   - `audit_events.actor_id` is NULL on every key-driven write.
 *     `audit_events_actor_id_fkey` REFERENCES `public.profiles(id)`, so an
 *     api_key id there is an FK violation and a user id there is a false
 *     statement about who acted.
 *   - The child row is locked FOR UPDATE before authority is decided, so a
 *     reparent committed mid-flight cannot be authorized against the old
 *     parent (the SCRUM-4470 property 0444 exists to hold).
 *   - anon and authenticated are REVOKEd explicitly. `REVOKE FROM PUBLIC` alone
 *     does not undo the baseline's `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
 *     FUNCTIONS TO anon, authenticated`, which grants the two browser roles
 *     DIRECTLY at CREATE time.
 *
 * TWO LAYERS (repo convention — see sec-0396 / sec-0405):
 *   (1) CONTENT GUARD (always runs, no DB) — asserts on the migration SQL.
 *   (2) LIVE INTEGRATION (opt-in, RUN_LIVE_RLS=1, throwaway/isolated DB with
 *       0453 applied). Never runs in default CI. NEVER against production —
 *       the cases below deliberately attempt cross-tenant writes.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0453_scrum3971_orgs_manage_scope_api_key_suborg_authority.sql',
);

let migrationCache: string | null = null;
function migration(): string {
  if (migrationCache === null) migrationCache = fs.readFileSync(MIGRATION_PATH, 'utf8');
  return migrationCache;
}

/**
 * Strip SQL comment lines. Load-bearing: this migration's header describes the
 * authority model at length, and a header sentence must never be what satisfies
 * an assertion about the executable body.
 */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** Extract one `CREATE OR REPLACE FUNCTION public.<name>(...) ... $function$;` block. */
function extractFunctionBlock(sql: string, fnName: string): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${fnName}(`;
  const start = sql.indexOf(marker);
  if (start === -1) return '';
  const end = sql.indexOf('$function$;', start);
  if (end === -1) return '';
  return sql.slice(start, end + '$function$;'.length);
}

const AUTHORIZED_FN = '_suborg_api_key_authorized';
const WRITE_FNS = [
  'allocate_credits_to_sub_org_as_api_key',
  'suspend_suborg_as_api_key',
] as const;
const ALL_KEY_FNS = [...WRITE_FNS, 'get_parent_credit_rollup_as_api_key'] as const;

describe('0453 content guard — the authority predicate', () => {
  it('defines exactly one authority helper', () => {
    const body = extractFunctionBlock(executableSql(migration()), AUTHORIZED_FN);
    expect(body, `${AUTHORIZED_FN} is missing from 0453`).not.toBe('');
  });

  it.each([
    ['belongs to the organization being administered', 'k.org_id = p_org_id'],
    ['is active', 'k.is_active = true'],
    ['is not revoked', 'k.revoked_at IS NULL'],
    ['is not expired', 'k.expires_at IS NULL OR k.expires_at > now()'],
    ['holds orgs:manage', "'orgs:manage' = ANY (k.scopes)"],
  ])('requires that the key %s', (_label, clause) => {
    const body = extractFunctionBlock(executableSql(migration()), AUTHORIZED_FN);
    expect(body).toContain(clause);
  });

  it('matches on the key id, so a NULL caller id can never satisfy it', () => {
    const body = extractFunctionBlock(executableSql(migration()), AUTHORIZED_FN);
    expect(body).toContain('k.id = p_api_key_id');
    // EXISTS over a predicate containing `= NULL` yields no rows, so the guard
    // fails closed without a special case. Pinned because "add a NULL check"
    // is a tempting simplification that would change that.
    expect(body).toContain('SELECT EXISTS');
  });
});

describe('0453 content guard — every key-driven RPC delegates to the helper', () => {
  it.each(ALL_KEY_FNS)('%s calls _suborg_api_key_authorized', (fnName) => {
    const body = extractFunctionBlock(executableSql(migration()), fnName);
    expect(body, `${fnName} is missing from 0453`).not.toBe('');
    expect(body).toContain(`public.${AUTHORIZED_FN}(p_parent_org_id, p_caller_api_key_id)`);
  });

  it.each(ALL_KEY_FNS)('%s never re-implements membership authority inline', (fnName) => {
    const body = extractFunctionBlock(executableSql(migration()), fnName);
    // The org_members / profiles pair is the USER authority model. A key is not
    // a user; finding that pair in a key RPC means the two models were merged.
    expect(body).not.toContain('FROM org_members');
    expect(body).not.toContain('FROM profiles');
    expect(body).not.toContain('auth.uid()');
  });

  it.each(ALL_KEY_FNS)('%s refuses a NULL caller key id before doing anything else', (fnName) => {
    const body = extractFunctionBlock(executableSql(migration()), fnName);
    expect(body).toContain('IF p_caller_api_key_id IS NULL THEN');
  });

  it.each(ALL_KEY_FNS)('%s is SECURITY DEFINER with a pinned search_path', (fnName) => {
    const body = extractFunctionBlock(executableSql(migration()), fnName);
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path TO 'public'");
  });

  it.each(WRITE_FNS)('%s bounds its lock waits', (fnName) => {
    const body = extractFunctionBlock(executableSql(migration()), fnName);
    // Bounded on the ROUTINE, not by a file-level SET LOCAL: a function body is
    // stored at apply time and executed later, in some other session, where the
    // migration's SET LOCAL no longer exists (BUG-019).
    expect(body).toContain("SET lock_timeout TO '5s'");
  });
});

describe('0453 content guard — the audit actor', () => {
  it.each(WRITE_FNS)('%s writes a NULL audit actor_id', (fnName) => {
    const body = extractFunctionBlock(executableSql(migration()), fnName);
    expect(body).toContain('event_type, event_category, actor_id, target_type, target_id, org_id, details');
    // The positional NULL in the VALUES list. `audit_events.actor_id`
    // REFERENCES profiles(id): an api_key id is an FK violation and a user id
    // is a false claim about who acted.
    expect(body).toMatch(/'ORG',\s*NULL,\s*'organization'/);
  });

  it.each(WRITE_FNS)('%s records the acting key in details instead', (fnName) => {
    const body = extractFunctionBlock(executableSql(migration()), fnName);
    expect(body).toContain("'actor_kind', 'api_key'");
    expect(body).toContain("'actor_api_key_id', p_caller_api_key_id");
    expect(body).toContain("'actor_key_prefix', v_key_prefix");
  });

  it('stamps the FK-bound provenance columns with the key authorizing principal, never an invented value', () => {
    const allocate = extractFunctionBlock(executableSql(migration()), 'allocate_credits_to_sub_org_as_api_key');
    const suspend = extractFunctionBlock(executableSql(migration()), 'suspend_suborg_as_api_key');
    // org_credit_allocations.granted_by is NOT NULL FK -> auth.users, and
    // organizations.suspended_by is FK -> auth.users. api_keys.created_by is
    // the only real user identity a key carries.
    expect(allocate).toContain('SELECT created_by, key_prefix INTO v_principal, v_key_prefix');
    expect(allocate).toContain('amount, granted_by, note)');
    expect(allocate).toContain('p_amount, v_principal, p_note');
    expect(suspend).toContain('suspended_by     = v_principal');
    // And it refuses rather than proceeding when that lookup yields nothing.
    for (const body of [allocate, suspend]) {
      expect(body).toContain("'api_key_principal_unresolved'");
    }
  });
});

describe('0453 content guard — the SCRUM-4470 reparent property survives', () => {
  it.each(WRITE_FNS)('%s locks the child row FOR UPDATE before authorizing', (fnName) => {
    const body = extractFunctionBlock(executableSql(migration()), fnName);
    expect(body).toContain('FOR UPDATE');
  });

  it('allocate keeps the LEAST/GREATEST credit-row lock order', () => {
    const body = extractFunctionBlock(executableSql(migration()), 'allocate_credits_to_sub_org_as_api_key');
    expect(body).toContain('LEAST(p_parent_org_id, p_child_org_id) FOR UPDATE');
    expect(body).toContain('GREATEST(p_parent_org_id, p_child_org_id) FOR UPDATE');
  });

  it('allocate still refuses a child of another parent', () => {
    const body = extractFunctionBlock(executableSql(migration()), 'allocate_credits_to_sub_org_as_api_key');
    expect(body).toContain('IF v_actual_parent IS NULL OR v_actual_parent <> p_parent_org_id THEN');
    expect(body).toContain("'not_a_sub_org'");
  });

  it('suspend still refuses a child of another parent', () => {
    const body = extractFunctionBlock(executableSql(migration()), 'suspend_suborg_as_api_key');
    expect(body).toContain("'not_a_child_of_parent'");
  });
});

describe('0453 content guard — grants', () => {
  it.each([...ALL_KEY_FNS, AUTHORIZED_FN, 'generate_unique_org_public_id'])('%s revokes anon and authenticated by name', (fnName) => {
    const sql = executableSql(migration());
    const revoke = new RegExp(
      `REVOKE ALL ON FUNCTION public\\.${fnName}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`,
    );
    expect(sql).toMatch(revoke);
  });

  it.each([...ALL_KEY_FNS, AUTHORIZED_FN, 'generate_unique_org_public_id'])('%s grants EXECUTE to service_role only', (fnName) => {
    const sql = executableSql(migration());
    const grant = new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fnName}\\([^)]*\\) TO service_role;`);
    expect(sql).toMatch(grant);
    expect(sql).not.toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fnName}\\([^)]*\\) TO (anon|authenticated)`),
    );
  });
});

describe('0453 content guard — vocabulary and column changes', () => {
  const sql = () => executableSql(migration());

  it.each(['api_keys_scopes_known_values', 'agents_allowed_scopes_known_values'])(
    'adds %s NOT VALID and then validates it',
    (constraintName) => {
      expect(sql()).toContain(`ALTER TABLE public.${constraintName.startsWith('api_keys') ? 'api_keys' : 'agents'} ADD CONSTRAINT ${constraintName}`);
      expect(sql()).toContain(`VALIDATE CONSTRAINT ${constraintName}`);
    },
  );

  it('adds orgs:manage to both CHECK constraints and drops nothing else', () => {
    const body = sql();
    const arrays = body.match(/ARRAY\[[^\]]*\]/g) ?? [];
    const scopeArrays = arrays.filter((a) => a.includes("'read:records'"));
    expect(scopeArrays.length).toBe(2);
    for (const array of scopeArrays) {
      expect(array).toContain("'orgs:manage'::text");
      // The 20 pre-existing values must all survive — a re-add is the easiest
      // place in this schema to silently delete a scope from the vocabulary.
      for (const scope of [
        'read:records', 'read:orgs', 'read:search', 'write:anchors', 'admin:rules',
        'verify', 'verify:batch', 'usage:read', 'keys:manage', 'compliance:read',
        'compliance:write', 'oracle:read', 'oracle:write', 'anchor:write', 'anchor:read',
        'attestations:write', 'attestations:read', 'webhooks:manage', 'agents:manage', 'keys:read',
      ]) {
        expect(array, `${scope} vanished from a scope CHECK`).toContain(`'${scope}'::text`);
      }
    }
  });

  /**
   * U3. Postgres holds every lock until COMMIT, so an ACCESS EXCLUSIVE taken on
   * `organizations` early in a transaction is held across everything that
   * follows — including two full-table VALIDATE scans. That is the 2026-08-11
   * P0 mechanism, and `SET LOCAL lock_timeout` does nothing about it: it bounds
   * ACQUISITION, not hold time. The ordering below is the mitigation, so it is
   * pinned rather than left to the next person editing the file.
   */
  it('takes the organizations ACCESS EXCLUSIVE last — after both VALIDATE scans', () => {
    const body = sql();
    const orgAlter = body.indexOf('ALTER TABLE public.organizations ALTER COLUMN public_id SET DEFAULT');
    expect(orgAlter).toBeGreaterThan(-1);
    for (const constraint of ['api_keys_scopes_known_values', 'agents_allowed_scopes_known_values']) {
      const validate = body.indexOf(`VALIDATE CONSTRAINT ${constraint}`);
      expect(validate, `VALIDATE ${constraint} is missing`).toBeGreaterThan(-1);
      expect(
        validate,
        `VALIDATE ${constraint} runs INSIDE the organizations exclusive window`,
      ).toBeLessThan(orgAlter);
    }
    // Nothing but the second ALTER, its COMMENT, the NOTIFY and the COMMIT may
    // follow the first one — no function creation, no row write, no scan.
    const tail = body.slice(orgAlter);
    expect(tail).not.toContain('CREATE OR REPLACE FUNCTION');
    expect(tail).not.toContain('VALIDATE CONSTRAINT');
    expect(tail).not.toMatch(/^UPDATE /m);
    expect(tail).not.toMatch(/^GRANT /m);
  });

  it('backfills NULL public_id with one statement, not a per-row PL/pgSQL loop', () => {
    const body = sql();
    expect(body).toContain('UPDATE public.organizations');
    expect(body).toContain('WHERE public_id IS NULL');
    // The loop issued an UPDATE and a function call per row inside the same
    // transaction, for a set that is empty in prod.
    expect(body).not.toContain('$backfill$');
    expect(body).not.toContain('FOR v_row IN SELECT id FROM public.organizations');
    // And it must precede the NOT NULL, or the NOT NULL can fail on a row the
    // backfill was meant to repair.
    expect(body.indexOf('WHERE public_id IS NULL'))
      .toBeLessThan(body.indexOf('ALTER COLUMN public_id SET NOT NULL'));
  });

  it('bounds the hot-table DDL and reloads the PostgREST schema cache', () => {
    const body = sql();
    // `organizations` is a hot table; an unbounded ALTER on it is the
    // 2026-08-11 P0 mechanism.
    expect(body.indexOf("SET LOCAL lock_timeout = '5s'"))
      .toBeLessThan(body.indexOf('ALTER TABLE public.organizations ALTER COLUMN public_id'));
    expect(body).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('gives organizations.public_id a DEFAULT alongside the NOT NULL', () => {
    const body = sql();
    // Without the default, generated Insert types make public_id mandatory and
    // browser-side organization creation stops typechecking. Measured, not
    // predicted — see the migration header.
    expect(body).toContain('ALTER COLUMN public_id SET DEFAULT public.generate_unique_org_public_id()');
    expect(body).toContain('ALTER COLUMN public_id SET NOT NULL');
    expect(body.indexOf('SET DEFAULT public.generate_unique_org_public_id()'))
      .toBeLessThan(body.indexOf('ALTER COLUMN public_id SET NOT NULL'));
  });

  it('keeps the re-draw-on-collision loop the trigger provided', () => {
    const generator = extractFunctionBlock(executableSql(migration()), 'generate_unique_org_public_id');
    expect(generator).not.toBe('');
    expect(generator).toContain('EXIT WHEN NOT EXISTS (SELECT 1 FROM organizations WHERE public_id = v_candidate)');
    // Bounded: a broken generator must raise, not spin inside a migration
    // holding locks on a hot table.
    expect(generator).toContain('IF v_attempts >= 100 THEN');
  });

  it('carries a runnable ROLLBACK that undoes all three changes', () => {
    // Up to the first EXECUTABLE `BEGIN;` — the ROLLBACK block itself contains
    // a commented `BEGIN;`, so a naive split truncates the thing under test.
    const lines = migration().split('\n');
    const header = lines.slice(0, lines.findIndex((line) => line.trim() === 'BEGIN;')).join('\n');
    expect(header).toContain('-- ROLLBACK:');
    for (const fn of ALL_KEY_FNS) {
      expect(header).toContain(`DROP FUNCTION IF EXISTS public.${fn}(`);
    }
    expect(header).toContain(`DROP FUNCTION IF EXISTS public.${AUTHORIZED_FN}(`);
    expect(header).toContain('ALTER COLUMN public_id DROP NOT NULL');
    expect(header).toContain('ALTER COLUMN public_id DROP DEFAULT');
    expect(header).toContain('api_keys_scopes_known_values');
    expect(header).toContain('agents_allowed_scopes_known_values');
  });
});

// ---------------------------------------------------------------------------
// LIVE INTEGRATION — opt-in.
//
// Requires 0453 applied to a THROWAWAY / ISOLATED database, RUN_LIVE_RLS=1, and
// the RLS helper env vars. NEVER run against production: the cases below
// deliberately attempt cross-tenant writes. Never runs in default CI.
//
// NOT EXECUTED IN THE SESSION THAT WROTE IT — no staging rig, no prod, no local
// stack was available. Treat these as the specification for the T3 soak, not as
// evidence that they pass.
// ---------------------------------------------------------------------------
const RUN_LIVE = process.env.RUN_LIVE_RLS === '1';

describe.skipIf(!RUN_LIVE)('SEC-0453: live behaviour (throwaway/isolated DB, 0453 applied)', () => {
  const helpers = () => import('./rls/helpers');

  type Rpc = { data: Record<string, unknown> | null; error: { code?: string; message?: string } | null };

  async function serviceRpc(fn: string, args: Record<string, unknown>): Promise<Rpc> {
    const { serviceClient } = (await helpers()) as unknown as {
      serviceClient: () => { rpc: (fn: string, args: Record<string, unknown>) => Promise<Rpc> };
    };
    return serviceClient().rpc(fn, args);
  }

  /** Seeded by the rig fixture: see docs/staging for the provisioning script. */
  const fixture = {
    parentOrgId: process.env.SEC0453_PARENT_ORG_ID ?? '',
    otherParentOrgId: process.env.SEC0453_OTHER_PARENT_ORG_ID ?? '',
    childOrgId: process.env.SEC0453_CHILD_ORG_ID ?? '',
    otherChildOrgId: process.env.SEC0453_OTHER_CHILD_ORG_ID ?? '',
    liveKeyId: process.env.SEC0453_LIVE_KEY_ID ?? '',
    revokedKeyId: process.env.SEC0453_REVOKED_KEY_ID ?? '',
    expiredKeyId: process.env.SEC0453_EXPIRED_KEY_ID ?? '',
    noScopeKeyId: process.env.SEC0453_NO_SCOPE_KEY_ID ?? '',
  };

  it('admits a live orgs:manage key of the parent', async () => {
    const res = await serviceRpc('get_parent_credit_rollup_as_api_key', {
      p_parent_org_id: fixture.parentOrgId,
      p_caller_api_key_id: fixture.liveKeyId,
    });
    expect(res.error).toBeNull();
    expect(res.data?.error).toBeUndefined();
  });

  it.each([
    ['a revoked key', () => fixture.revokedKeyId],
    ['an expired key', () => fixture.expiredKeyId],
    ['a key without orgs:manage', () => fixture.noScopeKeyId],
  ])('refuses %s with parent_admin_required', async (_label, keyId) => {
    const res = await serviceRpc('allocate_credits_to_sub_org_as_api_key', {
      p_parent_org_id: fixture.parentOrgId,
      p_child_org_id: fixture.childOrgId,
      p_amount: 1,
      p_note: null,
      p_caller_api_key_id: keyId(),
    });
    expect(res.error).toBeNull();
    expect(res.data?.error).toBe('parent_admin_required');
  });

  it("refuses org A's key against org B's child with not_a_sub_org", async () => {
    const res = await serviceRpc('allocate_credits_to_sub_org_as_api_key', {
      p_parent_org_id: fixture.parentOrgId,
      p_child_org_id: fixture.otherChildOrgId,
      p_amount: 1,
      p_note: null,
      p_caller_api_key_id: fixture.liveKeyId,
    });
    expect(res.error).toBeNull();
    expect(res.data?.error).toBe('not_a_sub_org');
  });

  it("refuses org A's key claiming to administer org B", async () => {
    const res = await serviceRpc('allocate_credits_to_sub_org_as_api_key', {
      p_parent_org_id: fixture.otherParentOrgId,
      p_child_org_id: fixture.otherChildOrgId,
      p_amount: 1,
      p_note: null,
      p_caller_api_key_id: fixture.liveKeyId,
    });
    expect(res.error).toBeNull();
    expect(res.data?.error).toBe('parent_admin_required');
  });

  it('refuses a NULL caller key id on every function', async () => {
    for (const [fn, args] of [
      ['allocate_credits_to_sub_org_as_api_key', {
        p_parent_org_id: fixture.parentOrgId, p_child_org_id: fixture.childOrgId,
        p_amount: 1, p_note: null, p_caller_api_key_id: null,
      }],
      ['suspend_suborg_as_api_key', {
        p_parent_org_id: fixture.parentOrgId, p_sub_org_id: fixture.childOrgId,
        p_reason: null, p_caller_api_key_id: null,
      }],
      ['get_parent_credit_rollup_as_api_key', {
        p_parent_org_id: fixture.parentOrgId, p_caller_api_key_id: null,
      }],
    ] as [string, Record<string, unknown>][]) {
      const res = await serviceRpc(fn, args);
      expect(res.data?.error, fn).toBeTruthy();
    }
  });
});
