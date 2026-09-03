/**
 * Unit tests for scripts/ops/mfa-break-glass.ts (SCRUM-3584).
 *
 * All Supabase interaction is through a hand-rolled fake client
 * (`makeFakeClient`) implementing the minimal `SupabaseAdminLike` surface
 * the script actually calls — no real network, no real Supabase project.
 * This exercises the BINDING safety sequence from the CTO plan
 * (Amendment A4 ruling 5): resolve -> list -> validate selection ->
 * INTENT audit -> delete -> COMPLETION audit, with dry-run as the default
 * and every abort path writing nothing.
 *
 * By default the fake's `profiles` email lookup returns "no row", so
 * every test exercises the `auth.admin.listUsers` pagination-scan
 * fallback path unless it opts into the `profileEmailRow` fast path.
 */
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  runBreakGlass,
  parseCliArgs,
  findDuplicateFlags,
  isProdHost,
  isDirectEntrypoint,
  normalizeEmail,
  formatFactorTable,
  boundedDetailsJson,
  EXIT_SUCCESS,
  EXIT_VALIDATION,
  EXIT_INTENT_AUDIT_FAILED,
  EXIT_COMPLETION_AUDIT_FAILED,
  EXIT_PARTIAL_FAILURE,
  type SupabaseAdminLike,
  type MfaFactorRow,
  type BreakGlassArgs,
  type BreakGlassDeps,
} from './mfa-break-glass.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const USER_EMAIL = 'user@example.com';

const FACTOR_A: MfaFactorRow = {
  id: 'factor-aaaa',
  factor_type: 'totp',
  friendly_name: 'Phone',
  status: 'verified',
  created_at: '2026-01-01T00:00:00Z',
};
const FACTOR_B: MfaFactorRow = {
  id: 'factor-bbbb',
  factor_type: 'totp',
  friendly_name: 'Backup',
  status: 'verified',
  created_at: '2026-02-01T00:00:00Z',
};

interface FakeListUsersPage {
  users: Array<{ id: string; email: string }>;
  nextPage?: number | null;
}

interface FakeClientOptions {
  /** Convenience: a single implicit page for the scan fallback (nextPage=null). */
  users?: Array<{ id: string; email: string }>;
  /** Explicit multi-page scan fixture — takes precedence over `users`. */
  listUsersPages?: FakeListUsersPage[];
  listUsersError?: { message: string } | null;
  listUsersThrows?: Error;

  factors?: MfaFactorRow[];
  listFactorsThrows?: Error;
  onDeleteFactor?: (id: string) => { error: { message: string } | null };

  /** profiles-fast-path candidate row. Default: no row (forces the scan). */
  profileEmailRow?: { id: string; email: string } | null;
  profileEmailLookupError?: { message: string } | null;
  profileEmailLookupThrows?: Error;
  /** Override the default auto-confirm-from-profileEmailRow behaviour. */
  getUserById?: (id: string) => Promise<{
    data: { user: { id: string; email: string | null } | null };
    error: { message: string } | null;
  }>;

  profileOrgId?: string | null;
  profileOrgIdError?: { message: string } | null;
  profileOrgIdThrows?: Error;

  onInsert?: (
    table: string,
    row: Record<string, unknown>,
    callIndex: number,
  ) => { error: { message: string } | null };
}

interface FakeClientHandle {
  client: SupabaseAdminLike;
  inserts: Array<{ table: string; row: Record<string, unknown> }>;
  selectCalls: Array<{ table: string; columns: string }>;
  /** Every `.eq(column, value)` call recorded (currently only the org_id lookup uses `.eq`). */
  eqCalls: Array<{ table: string; column: string; value: string }>;
  /** Every `.in(column, values)` call recorded (currently only the profiles email fast path uses `.in`). */
  inCalls: Array<{ table: string; column: string; values: string[] }>;
  deletedFactorIds: string[];
  listUsersCalls: number;
}

function makeFakeClient(opts: FakeClientOptions = {}): FakeClientHandle {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const selectCalls: Array<{ table: string; columns: string }> = [];
  const eqCalls: Array<{ table: string; column: string; value: string }> = [];
  const inCalls: Array<{ table: string; column: string; values: string[] }> = [];
  const deletedFactorIds: string[] = [];
  let listUsersCalls = 0;
  let insertCallIndex = 0;

  const pages: FakeListUsersPage[] =
    opts.listUsersPages ?? [{ users: opts.users ?? [{ id: USER_ID, email: USER_EMAIL }], nextPage: null }];

  const client: SupabaseAdminLike = {
    auth: {
      admin: {
        listUsers: vi.fn(async ({ page }: { page: number; perPage: number }) => {
          listUsersCalls += 1;
          if (opts.listUsersThrows) throw opts.listUsersThrows;
          if (opts.listUsersError) return { data: { users: [] }, error: opts.listUsersError };
          const found = pages[page - 1] ?? { users: [], nextPage: null };
          return { data: { users: found.users, nextPage: found.nextPage ?? null }, error: null };
        }),
        getUserById: vi.fn(async (id: string) => {
          if (opts.getUserById) return opts.getUserById(id);
          if (opts.profileEmailRow && opts.profileEmailRow.id === id) {
            return { data: { user: { id, email: opts.profileEmailRow.email } }, error: null };
          }
          return { data: { user: null }, error: { message: 'user not found' } };
        }),
        mfa: {
          listFactors: vi.fn(async () => {
            if (opts.listFactorsThrows) throw opts.listFactorsThrows;
            return { data: { factors: opts.factors ?? [FACTOR_A, FACTOR_B] }, error: null };
          }),
          deleteFactor: vi.fn(async ({ id }: { id: string; userId: string }) => {
            deletedFactorIds.push(id);
            const result = opts.onDeleteFactor ? opts.onDeleteFactor(id) : { error: null };
            return { data: result.error ? null : {}, error: result.error };
          }),
        },
      },
    },
    from: vi.fn((table: string) => ({
      select: (columns: string) => {
        selectCalls.push({ table, columns });
        return {
          // Real callers only ever reach `.eq()` for the org_id lookup
          // (`select('org_id').eq('id', userId)`) — the profiles email
          // fast path uses `.in()` below. Recorded so tests can assert on
          // the actual column/value a query used, per review finding #2:
          // a fake that ignores its own arguments can't fail when
          // production code queries the wrong key.
          eq: (column: string, value: string) => {
            eqCalls.push({ table, column, value });
            return {
              maybeSingle: async () => {
                if (opts.profileOrgIdThrows) throw opts.profileOrgIdThrows;
                if (opts.profileOrgIdError) return { data: null, error: opts.profileOrgIdError };
                return { data: { org_id: opts.profileOrgId ?? null }, error: null };
              },
            };
          },
          // profiles email fast-path lookup (`select('id,email').in('email', candidates)`).
          // Returns the fixture row ONLY when `column` is 'email' AND at
          // least one candidate value matches the fixture's email exactly
          // — a fake that returned the fixture regardless of the query key
          // would never catch a fast path querying the wrong column or the
          // wrong normalized form (review finding #2).
          in: (column: string, values: string[]) => {
            inCalls.push({ table, column, values });
            return {
              maybeSingle: async () => {
                if (opts.profileEmailLookupThrows) throw opts.profileEmailLookupThrows;
                if (opts.profileEmailLookupError) return { data: null, error: opts.profileEmailLookupError };
                const row = opts.profileEmailRow;
                if (!row || column !== 'email') return { data: null, error: null };
                const matches = values.some((v) => v === row.email);
                return { data: matches ? row : null, error: null };
              },
            };
          },
        };
      },
      insert: async (row: Record<string, unknown>) => {
        const idx = insertCallIndex;
        insertCallIndex += 1;
        inserts.push({ table, row });
        return opts.onInsert ? opts.onInsert(table, row, idx) : { error: null };
      },
    })),
  };

  return {
    client,
    inserts,
    selectCalls,
    eqCalls,
    inCalls,
    deletedFactorIds,
    get listUsersCalls() {
      return listUsersCalls;
    },
  };
}

function baseArgs(overrides: Partial<BreakGlassArgs> = {}): BreakGlassArgs {
  return {
    email: USER_EMAIL,
    factorId: undefined,
    all: false,
    reason: 'lost phone, no backup codes',
    ticket: 'SCRUM-3584',
    operator: 'carson@arkova.io',
    apply: false,
    ...overrides,
  };
}

function baseDeps(handle: FakeClientHandle, overrides: Partial<BreakGlassDeps> = {}): BreakGlassDeps {
  return {
    client: handle.client,
    supabaseUrl: 'https://abcdefghijklmnop.supabase.co',
    confirmEnv: undefined,
    confirmAllEnv: undefined,
    allowProdBreakGlass: undefined,
    log: () => {},
    warn: () => {},
    ...overrides,
  };
}

/** apply-mode deps shorthand: CONFIRM_MFA_BREAK_GLASS pre-set to the resolved email. */
function applyDeps(handle: FakeClientHandle, overrides: Partial<BreakGlassDeps> = {}): BreakGlassDeps {
  return baseDeps(handle, { confirmEnv: USER_EMAIL, ...overrides });
}

describe('SCRUM-3584 — mfa-break-glass', () => {
  describe('dry run (default)', () => {
    it('makes no writes and no deletes even with --factor-id selected', async () => {
      const handle = makeFakeClient();
      const outcome = await runBreakGlass(
        baseDeps(handle),
        baseArgs({ factorId: FACTOR_A.id, apply: false }),
      );

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(handle.inserts).toHaveLength(0);
      expect(handle.deletedFactorIds).toHaveLength(0);
      expect(outcome.summary?.mode).toBe('dry-run');
      expect(outcome.summary?.factors_selected).toEqual([FACTOR_A.id]);
    });

    it('resolves + lists factors with no selection at all and still writes nothing', async () => {
      const handle = makeFakeClient();
      const outcome = await runBreakGlass(baseDeps(handle), baseArgs({ apply: false }));

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(handle.inserts).toHaveLength(0);
      expect(handle.deletedFactorIds).toHaveLength(0);
      expect(outcome.summary?.factors_found).toBe(2);
      expect(outcome.summary?.factors_selected).toEqual([]);
    });

    it('--all --apply on a user with zero factors fails safely (not a "logic bug" — a real reachable path)', async () => {
      const handle = makeFakeClient({ factors: [] });
      const outcome = await runBreakGlass(
        applyDeps(handle, { confirmAllEnv: USER_EMAIL }),
        baseArgs({ all: true, apply: true }),
      );

      expect(outcome.exitCode).toBe(EXIT_VALIDATION);
      expect(handle.inserts).toHaveLength(0);
      expect(handle.deletedFactorIds).toHaveLength(0);
    });
  });

  describe('apply-mode preconditions', () => {
    it('aborts when CONFIRM_MFA_BREAK_GLASS is missing', async () => {
      const handle = makeFakeClient();
      const outcome = await runBreakGlass(
        baseDeps(handle, { confirmEnv: undefined }),
        baseArgs({ factorId: FACTOR_A.id, apply: true }),
      );

      expect(outcome.exitCode).toBe(EXIT_VALIDATION);
      expect(handle.inserts).toHaveLength(0);
      expect(handle.deletedFactorIds).toHaveLength(0);
    });

    it('aborts when CONFIRM_MFA_BREAK_GLASS does not match the resolved email', async () => {
      const handle = makeFakeClient();
      const outcome = await runBreakGlass(
        baseDeps(handle, { confirmEnv: 'someone-else@example.com' }),
        baseArgs({ factorId: FACTOR_A.id, apply: true }),
      );

      expect(outcome.exitCode).toBe(EXIT_VALIDATION);
      expect(handle.inserts).toHaveLength(0);
      expect(handle.deletedFactorIds).toHaveLength(0);
    });

    it('accepts CONFIRM_MFA_BREAK_GLASS case-insensitively', async () => {
      const handle = makeFakeClient();
      const outcome = await runBreakGlass(
        applyDeps(handle, { confirmEnv: USER_EMAIL.toUpperCase() }),
        baseArgs({ factorId: FACTOR_A.id, apply: true }),
      );

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(handle.deletedFactorIds).toEqual([FACTOR_A.id]);
    });

    it('denies a prod SUPABASE_URL host without ALLOW_PROD_BREAK_GLASS=1, before touching the client', async () => {
      const handle = makeFakeClient();
      const outcome = await runBreakGlass(
        baseDeps(handle, {
          supabaseUrl: 'https://vzwyaatejekddvltxyye.supabase.co',
          confirmEnv: USER_EMAIL,
          allowProdBreakGlass: undefined,
        }),
        baseArgs({ factorId: FACTOR_A.id, apply: true }),
      );

      expect(outcome.exitCode).toBe(EXIT_VALIDATION);
      expect(handle.listUsersCalls).toBe(0);
      expect(handle.inserts).toHaveLength(0);
      expect(handle.deletedFactorIds).toHaveLength(0);
    });

    it('denies a prod SUPABASE_URL host on a DRY RUN too — the deny is not apply-only', async () => {
      const handle = makeFakeClient();
      const outcome = await runBreakGlass(
        baseDeps(handle, {
          supabaseUrl: 'https://vzwyaatejekddvltxyye.supabase.co',
          allowProdBreakGlass: undefined,
        }),
        baseArgs({ factorId: FACTOR_A.id, apply: false }),
      );

      expect(outcome.exitCode).toBe(EXIT_VALIDATION);
      expect(handle.listUsersCalls).toBe(0);
    });

    it('allows a prod SUPABASE_URL host when ALLOW_PROD_BREAK_GLASS=1 is also set', async () => {
      const handle = makeFakeClient();
      const warnings: string[] = [];
      const outcome = await runBreakGlass(
        applyDeps(handle, {
          supabaseUrl: 'https://vzwyaatejekddvltxyye.supabase.co',
          allowProdBreakGlass: '1',
          warn: (line) => warnings.push(line),
        }),
        baseArgs({ factorId: FACTOR_A.id, apply: true }),
      );

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(warnings.some((w) => w.includes('PRODUCTION'))).toBe(true);
    });

    it('aborts when --factor-id does not belong to the resolved user', async () => {
      const handle = makeFakeClient();
      const outcome = await runBreakGlass(
        applyDeps(handle),
        baseArgs({ factorId: 'not-a-real-factor', apply: true }),
      );

      expect(outcome.exitCode).toBe(EXIT_VALIDATION);
      expect(handle.inserts).toHaveLength(0);
      expect(handle.deletedFactorIds).toHaveLength(0);
    });

    it('aborts when no user is found for the email', async () => {
      const handle = makeFakeClient({ users: [] });
      const outcome = await runBreakGlass(
        applyDeps(handle),
        baseArgs({ factorId: FACTOR_A.id, apply: true }),
      );

      expect(outcome.exitCode).toBe(EXIT_VALIDATION);
      expect(handle.inserts).toHaveLength(0);
    });

    describe('--all requires the second CONFIRM_MFA_BREAK_GLASS_ALL gate (AL3)', () => {
      it('aborts when CONFIRM_MFA_BREAK_GLASS_ALL is missing (even with CONFIRM_MFA_BREAK_GLASS present)', async () => {
        const handle = makeFakeClient({ factors: [FACTOR_A, FACTOR_B] });
        const outcome = await runBreakGlass(applyDeps(handle), baseArgs({ all: true, apply: true }));

        expect(outcome.exitCode).toBe(EXIT_VALIDATION);
        expect(handle.deletedFactorIds).toHaveLength(0);
        expect(handle.inserts).toHaveLength(0);
      });

      it('aborts when CONFIRM_MFA_BREAK_GLASS_ALL does not match the resolved email', async () => {
        const handle = makeFakeClient({ factors: [FACTOR_A, FACTOR_B] });
        const outcome = await runBreakGlass(
          applyDeps(handle, { confirmAllEnv: 'wrong@example.com' }),
          baseArgs({ all: true, apply: true }),
        );

        expect(outcome.exitCode).toBe(EXIT_VALIDATION);
        expect(handle.deletedFactorIds).toHaveLength(0);
      });

      it('proceeds when both CONFIRM_MFA_BREAK_GLASS and CONFIRM_MFA_BREAK_GLASS_ALL match', async () => {
        const handle = makeFakeClient({ factors: [FACTOR_A, FACTOR_B] });
        const outcome = await runBreakGlass(
          applyDeps(handle, { confirmAllEnv: USER_EMAIL }),
          baseArgs({ all: true, apply: true }),
        );

        expect(outcome.exitCode).toBe(EXIT_SUCCESS);
        expect(handle.deletedFactorIds.sort()).toEqual([FACTOR_A.id, FACTOR_B.id].sort());
      });

      it('does not require CONFIRM_MFA_BREAK_GLASS_ALL for a single --factor-id', async () => {
        const handle = makeFakeClient();
        const outcome = await runBreakGlass(applyDeps(handle), baseArgs({ factorId: FACTOR_A.id, apply: true }));

        expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      });
    });
  });

  describe('resolveUserByEmail — profiles fast path (E1/D7)', () => {
    it('resolves via profiles + getUserById without ever calling listUsers', async () => {
      const handle = makeFakeClient({ profileEmailRow: { id: USER_ID, email: USER_EMAIL } });
      const outcome = await runBreakGlass(baseDeps(handle), baseArgs({ apply: false }));

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(outcome.summary?.user_id).toBe(USER_ID);
      expect(handle.listUsersCalls).toBe(0);
      expect(handle.selectCalls.some((c) => c.table === 'profiles' && c.columns.includes('email'))).toBe(true);
      // The actual query key/value matter — a fake (or an implementation)
      // that queried the wrong column or a mangled value would still pass
      // without this (review finding #2). USER_EMAIL is plain ASCII, so
      // the fast path's trim+lowercase and NFKC+lowercase forms coincide:
      // exactly one deduped candidate.
      expect(handle.inCalls).toHaveLength(1);
      expect(handle.inCalls[0]).toEqual({ table: 'profiles', column: 'email', values: [USER_EMAIL] });
    });

    it('falls back to the listUsers scan when profiles has no row', async () => {
      const handle = makeFakeClient({ profileEmailRow: null, users: [{ id: USER_ID, email: USER_EMAIL }] });
      const outcome = await runBreakGlass(baseDeps(handle), baseArgs({ apply: false }));

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(outcome.summary?.user_id).toBe(USER_ID);
      expect(handle.listUsersCalls).toBeGreaterThan(0);
    });

    it('queries BOTH the trim+lowercase and NFKC+lowercase candidate forms via .in(), and hits the fast path even when profiles.email only matches the non-NFKC form (review finding #1, SCRUM-3584 PR #2635)', async () => {
      // profiles.email is populated by a DB trigger that ONLY lowercases
      // (never NFKC-normalizes). A fullwidth Latin capital U (U+FF35)
      // lowercases in place under plain `.toLowerCase()` to a fullwidth
      // lowercase u (U+FF55, still non-ASCII) — but NFKC-then-lowercase
      // collapses the whole thing down to plain ASCII "user@example.com".
      // Before this fix, the fast path queried ONLY the NFKC form and
      // would never match a profiles row stored in the non-NFKC shape,
      // silently falling through to the slow full-scan path every time.
      const rawEmailAsTyped = 'Ｕser@example.com';
      const storedProfileEmail = rawEmailAsTyped.trim().toLowerCase();
      const nfkcForm = normalizeEmail(rawEmailAsTyped);
      expect(storedProfileEmail).not.toBe(nfkcForm); // sanity: the two forms really do diverge here
      expect(nfkcForm).toBe(USER_EMAIL);

      const handle = makeFakeClient({ profileEmailRow: { id: USER_ID, email: storedProfileEmail } });
      const outcome = await runBreakGlass(baseDeps(handle), baseArgs({ email: rawEmailAsTyped, apply: false }));

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(outcome.summary?.user_id).toBe(USER_ID);
      expect(handle.listUsersCalls).toBe(0); // fast path was hit — no fallback scan needed
      expect(handle.inCalls).toHaveLength(1);
      expect(handle.inCalls[0].table).toBe('profiles');
      expect(handle.inCalls[0].column).toBe('email');
      expect(handle.inCalls[0].values.sort()).toEqual([storedProfileEmail, nfkcForm].sort());
    });

    it('falls back to the scan when the profiles row is orphaned (getUserById finds no auth user)', async () => {
      const handle = makeFakeClient({
        profileEmailRow: { id: USER_ID, email: USER_EMAIL },
        getUserById: async () => ({ data: { user: null }, error: { message: 'not found' } }),
        users: [{ id: USER_ID, email: USER_EMAIL }],
      });
      const outcome = await runBreakGlass(baseDeps(handle), baseArgs({ apply: false }));

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(outcome.summary?.user_id).toBe(USER_ID);
      expect(handle.listUsersCalls).toBeGreaterThan(0);
    });

    it('falls back to the scan when the profiles lookup itself errors', async () => {
      const handle = makeFakeClient({
        profileEmailLookupError: { message: 'db down' },
        users: [{ id: USER_ID, email: USER_EMAIL }],
      });
      const outcome = await runBreakGlass(baseDeps(handle), baseArgs({ apply: false }));

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(handle.listUsersCalls).toBeGreaterThan(0);
    });

    it('falls back to the scan when the profiles lookup throws', async () => {
      const handle = makeFakeClient({
        profileEmailLookupThrows: new Error('network blip'),
        users: [{ id: USER_ID, email: USER_EMAIL }],
      });
      const outcome = await runBreakGlass(baseDeps(handle), baseArgs({ apply: false }));

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(handle.listUsersCalls).toBeGreaterThan(0);
    });
  });

  describe('resolveUserByEmail — stale profiles.email vs the live auth email (review finding #3, SCRUM-3584 PR #2635)', () => {
    // A profiles row can lag the auth-side email (the auth email changed
    // and the profiles-table copy hasn't caught up, or never gets
    // updated). The profiles row is only used to FIND the user id — the
    // resolved `user.email` returned to the rest of the tool must always be
    // the CURRENT auth email from `getUserById()`, and every downstream
    // check (most importantly the CONFIRM_MFA_BREAK_GLASS gate) must
    // compare against that resolved email, never the stale profiles value.
    const STALE_PROFILE_EMAIL = 'old-address@example.com';
    const CURRENT_AUTH_EMAIL = 'new-address@example.com';

    function staleHandle(): FakeClientHandle {
      return makeFakeClient({
        profileEmailRow: { id: USER_ID, email: STALE_PROFILE_EMAIL },
        getUserById: async (id) => ({ data: { user: { id, email: CURRENT_AUTH_EMAIL } }, error: null }),
      });
    }

    it('resolves user.email to the live auth email, not the stale profiles.email used to find the user', async () => {
      const handle = staleHandle();
      const outcome = await runBreakGlass(baseDeps(handle), baseArgs({ email: STALE_PROFILE_EMAIL, apply: false }));

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(outcome.summary?.user_id).toBe(USER_ID);
      expect(outcome.summary?.email).toBe(CURRENT_AUTH_EMAIL);
      expect(handle.listUsersCalls).toBe(0);
    });

    it('rejects a CONFIRM_MFA_BREAK_GLASS equal to the STALE profiles email — the gate compares against the resolved auth email, not the lookup key', async () => {
      const handle = staleHandle();
      const outcome = await runBreakGlass(
        baseDeps(handle, { confirmEnv: STALE_PROFILE_EMAIL }),
        baseArgs({ email: STALE_PROFILE_EMAIL, factorId: FACTOR_A.id, apply: true }),
      );

      expect(outcome.exitCode).toBe(EXIT_VALIDATION);
      expect(handle.inserts).toHaveLength(0);
      expect(handle.deletedFactorIds).toHaveLength(0);
    });

    it('accepts a CONFIRM_MFA_BREAK_GLASS equal to the resolved (current) auth email even though the operator looked the user up by their old address', async () => {
      const handle = staleHandle();
      const outcome = await runBreakGlass(
        baseDeps(handle, { confirmEnv: CURRENT_AUTH_EMAIL }),
        baseArgs({ email: STALE_PROFILE_EMAIL, factorId: FACTOR_A.id, apply: true }),
      );

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(handle.deletedFactorIds).toEqual([FACTOR_A.id]);
    });
  });

  describe('resolveUserByEmail — listUsers pagination (A2: nextPage, not short-page heuristic)', () => {
    it('paginates via nextPage until it finds the matching email, even when an earlier page is SHORT', async () => {
      // A page shorter than perPage does NOT mean "last page" — only a null
      // nextPage does. This page 1 has just 1 user but explicitly declares
      // nextPage: 2, so the resolver must keep going.
      const page1: FakeListUsersPage = { users: [{ id: 'other-1', email: 'other1@example.com' }], nextPage: 2 };
      const page2: FakeListUsersPage = { users: [{ id: USER_ID, email: USER_EMAIL }], nextPage: null };
      const handle = makeFakeClient({ listUsersPages: [page1, page2] });

      const outcome = await runBreakGlass(baseDeps(handle), baseArgs({ apply: false }));

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(outcome.summary?.user_id).toBe(USER_ID);
    });

    it('stops and reports not-found once nextPage is null, without over-scanning', async () => {
      const page1: FakeListUsersPage = { users: [{ id: 'other-1', email: 'other1@example.com' }], nextPage: null };
      const handle = makeFakeClient({ listUsersPages: [page1] });

      const outcome = await runBreakGlass(baseDeps(handle), baseArgs({ apply: false }));

      expect(outcome.exitCode).toBe(EXIT_VALIDATION);
      expect(handle.listUsersCalls).toBe(1);
    });

    it('propagates a listUsers {error} during the scan as a validation failure', async () => {
      const handle = makeFakeClient({ listUsersError: { message: 'gotrue 500' } });
      const outcome = await runBreakGlass(baseDeps(handle), baseArgs({ apply: false }));

      expect(outcome.exitCode).toBe(EXIT_VALIDATION);
      expect(outcome.message).toContain('gotrue 500');
    });

    it('propagates a THROWN listUsers rejection (network failure) as a validation failure', async () => {
      const handle = makeFakeClient({ listUsersThrows: new Error('ECONNRESET') });
      const outcome = await runBreakGlass(baseDeps(handle), baseArgs({ apply: false }));

      expect(outcome.exitCode).toBe(EXIT_VALIDATION);
      expect(outcome.message).toContain('ECONNRESET');
    });
  });

  describe('listFactorsForUser / lookupOrgId resilience', () => {
    it('propagates a THROWN listFactors rejection as a validation failure', async () => {
      const handle = makeFakeClient({ listFactorsThrows: new Error('mfa service down') });
      const outcome = await runBreakGlass(baseDeps(handle), baseArgs({ apply: false }));

      expect(outcome.exitCode).toBe(EXIT_VALIDATION);
      expect(outcome.message).toContain('mfa service down');
    });

    it('continues with org_id=null when the profiles org lookup returns an error', async () => {
      const handle = makeFakeClient({ profileOrgIdError: { message: 'rls denied' } });
      const warnings: string[] = [];
      const outcome = await runBreakGlass(baseDeps(handle, { warn: (l) => warnings.push(l) }), baseArgs({ apply: false }));

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(outcome.summary?.org_id).toBeNull();
      expect(warnings.some((w) => w.includes('rls denied'))).toBe(true);
    });

    it('continues with org_id=null when the profiles org lookup throws', async () => {
      const handle = makeFakeClient({ profileOrgIdThrows: new Error('timeout') });
      const warnings: string[] = [];
      const outcome = await runBreakGlass(baseDeps(handle, { warn: (l) => warnings.push(l) }), baseArgs({ apply: false }));

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(outcome.summary?.org_id).toBeNull();
      expect(warnings.some((w) => w.includes('timeout'))).toBe(true);
    });
  });

  describe('apply-mode audit sequencing (CTO plan Amendment A4 ruling 5)', () => {
    it('aborts BEFORE any delete when the INTENT audit insert fails', async () => {
      const handle = makeFakeClient({
        onInsert: (_table, row) => {
          if (row.event_type === 'MFA_BREAK_GLASS_REQUESTED') {
            return { error: { message: 'insert rejected' } };
          }
          return { error: null };
        },
      });

      const outcome = await runBreakGlass(applyDeps(handle), baseArgs({ factorId: FACTOR_A.id, apply: true }));

      expect(outcome.exitCode).toBe(EXIT_INTENT_AUDIT_FAILED);
      expect(handle.deletedFactorIds).toHaveLength(0);
      expect(handle.inserts).toHaveLength(1);
      expect(handle.inserts[0].table).toBe('audit_events');
      expect(handle.inserts[0].row.event_type).toBe('MFA_BREAK_GLASS_REQUESTED');
      expect(handle.inserts[0].row.event_category).toBe('SECURITY');
    });

    it('writes the INTENT row to audit_events with the documented shape, identifying fields first, before deleting', async () => {
      const handle = makeFakeClient({ profileOrgId: 'org-123' });
      await runBreakGlass(
        applyDeps(handle),
        baseArgs({ factorId: FACTOR_A.id, apply: true, reason: 'lost device', ticket: 'SCRUM-9999', operator: 'ops@arkova.io' }),
      );

      expect(handle.inserts[0].table).toBe('audit_events');
      const intentRow = handle.inserts[0].row;
      expect(intentRow.event_type).toBe('MFA_BREAK_GLASS_REQUESTED');
      expect(intentRow.event_category).toBe('SECURITY');
      expect(intentRow.actor_id).toBeNull();
      expect(intentRow.target_type).toBe('mfa_factor');
      expect(intentRow.target_id).toBe(FACTOR_A.id);
      expect(intentRow.org_id).toBe('org-123');

      const details = JSON.parse(intentRow.details as string);
      // Identifying fields come first in the serialized JSON, ahead of the
      // free-text `reason` (B2: so truncation can never cut them).
      const keys = Object.keys(details);
      expect(keys.indexOf('user_id')).toBeLessThan(keys.indexOf('reason'));
      expect(keys.indexOf('factor_ids')).toBeLessThan(keys.indexOf('reason'));
      expect(details.operator).toBe('ops@arkova.io');
      expect(details.reason).toBe('lost device');
      expect(details.ticket).toBe('SCRUM-9999');
      expect(details.user_id).toBe(USER_ID);
      expect(details.factor_ids).toEqual([FACTOR_A.id]);
    });

    it('deletes the factor and writes a COMPLETION row to audit_events on success', async () => {
      const handle = makeFakeClient();
      const outcome = await runBreakGlass(applyDeps(handle), baseArgs({ factorId: FACTOR_A.id, apply: true }));

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(handle.deletedFactorIds).toEqual([FACTOR_A.id]);
      expect(handle.inserts).toHaveLength(2);
      expect(handle.inserts[1].table).toBe('audit_events');
      expect(handle.inserts[1].row.event_type).toBe('MFA_BREAK_GLASS_COMPLETED');
      const details = JSON.parse(handle.inserts[1].row.details as string);
      expect(details.results).toEqual([{ id: FACTOR_A.id, friendly_name: FACTOR_A.friendly_name, status: 'deleted' }]);
    });

    it('--all deletes every factor and joins ids in the audit target_id', async () => {
      const handle = makeFakeClient({ factors: [FACTOR_A, FACTOR_B] });
      const outcome = await runBreakGlass(
        applyDeps(handle, { confirmAllEnv: USER_EMAIL }),
        baseArgs({ all: true, apply: true }),
      );

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(handle.deletedFactorIds.sort()).toEqual([FACTOR_A.id, FACTOR_B.id].sort());
      expect(handle.inserts[0].row.target_id).toBe([FACTOR_A.id, FACTOR_B.id].join(','));
      expect(handle.inserts[1].row.target_id).toBe([FACTOR_A.id, FACTOR_B.id].join(','));
    });

    it('records a per-factor failure in the COMPLETION row when a delete fails, exit code reflects partial failure', async () => {
      const handle = makeFakeClient({
        onDeleteFactor: (id) => (id === FACTOR_A.id ? { error: { message: 'gotrue 500' } } : { error: null }),
      });

      const outcome = await runBreakGlass(applyDeps(handle), baseArgs({ factorId: FACTOR_A.id, apply: true }));

      expect(outcome.exitCode).toBe(EXIT_PARTIAL_FAILURE);
      expect(handle.inserts).toHaveLength(2);
      const details = JSON.parse(handle.inserts[1].row.details as string);
      expect(details.results).toEqual([
        { id: FACTOR_A.id, friendly_name: FACTOR_A.friendly_name, status: 'failed', error: 'gotrue 500' },
      ]);
      expect(outcome.summary?.results?.[0].status).toBe('failed');
    });

    it('exits EXIT_COMPLETION_AUDIT_FAILED and surfaces the row to insert manually when the COMPLETION insert fails', async () => {
      const handle = makeFakeClient({
        onInsert: (_table, row) => {
          if (row.event_type === 'MFA_BREAK_GLASS_COMPLETED') {
            return { error: { message: 'insert rejected' } };
          }
          return { error: null };
        },
      });
      const warnings: string[] = [];

      const outcome = await runBreakGlass(
        applyDeps(handle, { warn: (line) => warnings.push(line) }),
        baseArgs({ factorId: FACTOR_A.id, apply: true }),
      );

      expect(outcome.exitCode).toBe(EXIT_COMPLETION_AUDIT_FAILED);
      // The delete already happened — that's what makes this the loud path.
      expect(handle.deletedFactorIds).toEqual([FACTOR_A.id]);
      expect(warnings.some((w) => w.includes('MFA_BREAK_GLASS_COMPLETED'))).toBe(true);
      expect(warnings.some((w) => w.includes(FACTOR_A.id))).toBe(true);
    });

    it('handles a non-Error thrown value from deleteFactor without producing "[object Object]"', async () => {
      const handle = makeFakeClient();
      // Force a throw instead of the normal {error} return shape.
      (handle.client.auth.admin.mfa.deleteFactor as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async () => {
          throw { message: 'weird non-Error rejection' };
        },
      );

      const outcome = await runBreakGlass(applyDeps(handle), baseArgs({ factorId: FACTOR_A.id, apply: true }));

      expect(outcome.exitCode).toBe(EXIT_PARTIAL_FAILURE);
      expect(outcome.summary?.results?.[0].error).toBe('weird non-Error rejection');
    });
  });

  describe('boundedDetailsJson / audit-details hardening (D2, C1, B2)', () => {
    // The Zod caps (reason<=2000, operator<=200, ticket<=300) mean a details
    // object built from real CLI args essentially never reaches the 10000-char
    // audit_events.details CHECK — so these test boundedDetailsJson directly
    // with a SYNTHETIC oversized object (server-supplied fields like
    // friendly_name and factor ids are not CLI-capped) to actually exercise
    // the truncation mechanism end to end, not just prove the normal path is
    // under the limit (which any implementation would satisfy trivially).
    const baseDetails = {
      user_id: USER_ID,
      factor_ids: [FACTOR_A.id],
      statuses: ['verified'],
      ticket: 'SCRUM-3584',
      operator: 'carson@arkova.io',
      host: 'abcdefghijklmnop.supabase.co',
      friendly_names: ['Phone'],
    };

    it('returns valid, parseable JSON unmodified when under the 10000-char limit', () => {
      const json = boundedDetailsJson({ ...baseDetails, reason: 'lost phone' });
      expect(json.length).toBeLessThanOrEqual(10000);
      expect(() => JSON.parse(json)).not.toThrow();
      expect(JSON.parse(json).reason).toBe('lost phone');
      expect(JSON.parse(json)._truncated).toBeUndefined();
    });

    it('truncates a huge ASCII reason structurally, staying valid JSON and keeping identifying fields intact', () => {
      const json = boundedDetailsJson({ ...baseDetails, reason: 'x'.repeat(50000) });
      expect(json.length).toBeLessThanOrEqual(10000);
      const parsed = JSON.parse(json);
      expect(parsed.user_id).toBe(USER_ID);
      expect(parsed.factor_ids).toEqual([FACTOR_A.id]);
      expect(parsed._truncated).toBe(true);
      expect(parsed.reason.length).toBeLessThan(50000);
    });

    it('truncates a huge emoji (surrogate-pair) reason without ever producing a lone surrogate', () => {
      // Repeated surrogate-pair emoji at a length whose natural truncation
      // point is not neatly aligned to a 2-unit boundary — the exact shape
      // that a bare `.slice(0, N)` can cut mid-pair.
      const reason = '😀'.repeat(6000) + '!'; // 12001 UTF-16 units, odd total
      const json = boundedDetailsJson({ ...baseDetails, reason });
      expect(json.length).toBeLessThanOrEqual(10000);

      let parsed: { reason: string };
      expect(() => {
        parsed = JSON.parse(json);
      }).not.toThrow();
      // encodeURIComponent throws URIError on a lone surrogate — the
      // concrete, checkable manifestation of the 2026-08-17 incident class
      // this fix prevents (PostgREST rejects the same shape as invalid JSON
      // once UTF-8 encoded).
      expect(() => encodeURIComponent(parsed!.reason)).not.toThrow();
    });

    it('falls back past reason+friendly_names when even those cannot make it fit, still producing valid JSON with the identifying fields', () => {
      // An oversized FACTOR_IDS array (not Zod-capped — factor ids/friendly
      // names come from GoTrue, not CLI args) that alone busts the limit
      // even with an empty reason.
      const hugeFactorIds = Array.from({ length: 2000 }, (_, i) => `factor-${i}-${'a'.repeat(40)}`);
      const json = boundedDetailsJson({
        ...baseDetails,
        factor_ids: hugeFactorIds,
        friendly_names: hugeFactorIds.map(() => 'x'.repeat(100)),
        reason: 'irrelevant',
      });

      expect(json.length).toBeLessThanOrEqual(10000);
      const parsed = JSON.parse(json);
      expect(parsed._truncated).toBe(true);
      expect(parsed._truncated_hard).toBe(true);
      expect(parsed.user_id).toBe(USER_ID);
      expect(parsed.ticket).toBe('SCRUM-3584');
      // factor_ids degrades to a capped, joined string in the hard fallback
      // — still identifies which factors were touched, just not as an array.
      expect(typeof parsed.factor_ids).toBe('string');
      expect(parsed.factor_ids.startsWith('factor-0-')).toBe(true);
    });
  });

  describe('parseCliArgs', () => {
    const argv = (extra: string[]): string[] => [
      'node',
      'mfa-break-glass.ts',
      '--email',
      USER_EMAIL,
      '--reason',
      'lost phone',
      '--ticket',
      'SCRUM-1234',
      '--operator',
      'carson@arkova.io',
      ...extra,
    ];

    it('parses a valid dry-run invocation with --factor-id', () => {
      const args = parseCliArgs(argv(['--factor-id', 'factor-aaaa']));
      expect(args.email).toBe(USER_EMAIL);
      expect(args.factorId).toBe('factor-aaaa');
      expect(args.apply).toBe(false);
    });

    it('parses --all', () => {
      const args = parseCliArgs(argv(['--all']));
      expect(args.all).toBe(true);
    });

    it('rejects both --factor-id and --all', () => {
      expect(() => parseCliArgs(argv(['--factor-id', 'x', '--all']))).toThrow();
    });

    it('rejects --apply with neither --factor-id nor --all', () => {
      expect(() => parseCliArgs(argv(['--apply']))).toThrow();
    });

    it('accepts --apply with --factor-id', () => {
      const args = parseCliArgs(argv(['--factor-id', 'factor-aaaa', '--apply']));
      expect(args.apply).toBe(true);
    });

    it('rejects an invalid email', () => {
      expect(() =>
        parseCliArgs([
          'node',
          'mfa-break-glass.ts',
          '--email',
          'not-an-email',
          '--reason',
          'x',
          '--ticket',
          'SCRUM-1',
          '--operator',
          'carson@arkova.io',
        ]),
      ).toThrow();
    });

    it('rejects a ticket that is neither a SCRUM- id nor the Jira browse URL', () => {
      expect(() =>
        parseCliArgs([
          'node',
          'mfa-break-glass.ts',
          '--email',
          USER_EMAIL,
          '--reason',
          'x',
          '--ticket',
          'not-a-ticket',
          '--operator',
          'carson@arkova.io',
        ]),
      ).toThrow();
    });

    it('rejects an arbitrary https URL as the ticket (B3 — only SCRUM-id or the Jira browse URL)', () => {
      expect(() =>
        parseCliArgs([
          'node',
          'mfa-break-glass.ts',
          '--email',
          USER_EMAIL,
          '--reason',
          'x',
          '--ticket',
          'https://docs.google.com/document/d/abc123',
          '--operator',
          'carson@arkova.io',
        ]),
      ).toThrow();
    });

    it('accepts the exact Jira browse URL as the ticket', () => {
      const args = parseCliArgs(
        argv(['--factor-id', 'factor-aaaa']).map((a) =>
          a === 'SCRUM-1234' ? 'https://arkova.atlassian.net/browse/SCRUM-1234' : a,
        ),
      );
      expect(args.ticket).toBe('https://arkova.atlassian.net/browse/SCRUM-1234');
    });

    it('requires --reason, --ticket, --operator', () => {
      expect(() =>
        parseCliArgs(['node', 'mfa-break-glass.ts', '--email', USER_EMAIL, '--factor-id', 'x']),
      ).toThrow();
    });

    it('rejects a --reason over 2000 characters', () => {
      expect(() => parseCliArgs(argv(['--factor-id', 'x']).map((a) => (a === 'lost phone' ? 'x'.repeat(2001) : a)))).toThrow();
    });

    it('rejects an --operator over 200 characters', () => {
      expect(() =>
        parseCliArgs(argv(['--factor-id', 'x']).map((a) => (a === 'carson@arkova.io' ? 'x'.repeat(201) : a))),
      ).toThrow();
    });

    describe('duplicate-flag detection (D4)', () => {
      it('rejects a repeated --email', () => {
        expect(() =>
          parseCliArgs([
            'node',
            'mfa-break-glass.ts',
            '--email',
            'a@example.com',
            '--email',
            'b@example.com',
            '--reason',
            'x',
            '--ticket',
            'SCRUM-1',
            '--operator',
            'carson@arkova.io',
            '--factor-id',
            'x',
          ]),
        ).toThrow(/repeated.*--email/);
      });

      it('rejects a repeated --factor-id', () => {
        expect(() =>
          parseCliArgs([
            ...argv([]),
            '--factor-id',
            'X',
            '--factor-id',
            'Y',
          ]),
        ).toThrow(/repeated.*--factor-id/);
      });

      it('findDuplicateFlags reports every duplicated flag, ignoring unknown/non-flag tokens', () => {
        expect(findDuplicateFlags(['--email', 'a', '--email=b', '--reason', 'x', '--bogus', '--bogus'])).toEqual([
          'email',
        ]);
      });

      it('findDuplicateFlags returns [] for a clean argv', () => {
        expect(findDuplicateFlags(argv(['--factor-id', 'x']))).toEqual([]);
      });

      it('runs parseArgs before the duplicate-flag scan, so a value swallowed by a flag-shaped token is diagnosed correctly instead of misreported as a repeated LATER flag (review finding #4, SCRUM-3584 PR #2635)', () => {
        // --reason has no real value here: its value token is the
        // flag-shaped `--ticket` that follows, which Node's parseArgs
        // itself rejects as ambiguous. A duplicate-scan-first
        // implementation instead counts the two (unrelated) --ticket
        // tokens and reports "repeated: --ticket" — not the operator's
        // actual mistake.
        const argvWithSwallowedValue = [
          'node',
          'mfa-break-glass.ts',
          '--email',
          'a@b.com',
          '--reason',
          '--ticket',
          '--ticket',
          'SCRUM-1234',
          '--operator',
          'carson@arkova.io',
          '--factor-id',
          'x',
        ];

        let thrown: unknown;
        try {
          parseCliArgs(argvWithSwallowedValue);
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toMatch(/--reason/);
        expect(message).not.toMatch(/repeated/i);
      });
    });
  });

  describe('isProdHost', () => {
    it('flags the prod Supabase ref', () => {
      expect(isProdHost('https://vzwyaatejekddvltxyye.supabase.co')).toBe(true);
    });

    it('does not flag an unrelated project ref', () => {
      expect(isProdHost('https://abcdefghijklmnop.supabase.co')).toBe(false);
    });
  });

  describe('normalizeEmail (D6)', () => {
    it('trims and lowercases', () => {
      expect(normalizeEmail('  User@Example.com  ')).toBe('user@example.com');
    });

    it('is idempotent for a non-ASCII (Turkish dotted İ) local part', () => {
      const raw = 'İstanbul@example.com';
      const once = normalizeEmail(raw);
      const twice = normalizeEmail(once);
      expect(twice).toBe(once);
    });

    it('normalizes the same non-ASCII input the same way regardless of surrounding whitespace', () => {
      const raw = 'İstanbul@example.com';
      expect(normalizeEmail(`  ${raw}  `)).toBe(normalizeEmail(raw));
    });
  });

  describe('formatFactorTable', () => {
    it('prints a header + row per factor', () => {
      const table = formatFactorTable([FACTOR_A]);
      expect(table).toContain('id');
      expect(table).toContain(FACTOR_A.id);
      expect(table).toContain('Phone');
    });

    it('handles a factor with no friendly_name (undefined, matching auth-js)', () => {
      const noName: MfaFactorRow = { ...FACTOR_A, friendly_name: undefined };
      expect(() => formatFactorTable([noName])).not.toThrow();
    });

    it('reports "no factors" for an empty list', () => {
      expect(formatFactorTable([])).toMatch(/no mfa factors/i);
    });
  });

  describe('isDirectEntrypoint (D1)', () => {
    it('returns false when argv1 is undefined', () => {
      expect(isDirectEntrypoint(undefined, import.meta.url)).toBe(false);
    });

    it('returns false when argv1 points at an unrelated file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'mfa-bg-entrypoint-'));
      const real = join(dir, 'real.mjs');
      const other = join(dir, 'other.mjs');
      writeFileSync(real, '// real');
      writeFileSync(other, '// other');

      expect(isDirectEntrypoint(other, pathToFileURL(real).href)).toBe(false);
    });

    it('returns true when argv1 IS the module, resolved through a symlink (macOS /tmp -> /private/tmp shape)', () => {
      const realDir = mkdtempSync(join(tmpdir(), 'mfa-bg-entrypoint-real-'));
      const linkDir = mkdtempSync(join(tmpdir(), 'mfa-bg-entrypoint-link-'));
      const realFile = join(realDir, 'script.mjs');
      writeFileSync(realFile, '// script');
      const symlinkedFile = join(linkDir, 'script-via-symlink.mjs');
      symlinkSync(realFile, symlinkedFile);

      // Simulate: the module's own import.meta.url resolves to the REAL
      // path, but argv[1] is how the user invoked it — through the symlink.
      expect(isDirectEntrypoint(symlinkedFile, pathToFileURL(realFile).href)).toBe(true);
    });

    it('returns true for a relative argv1 that resolves to the same file (npx tsx <relative path>)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'mfa-bg-entrypoint-rel-'));
      const file = join(dir, 'script.mjs');
      writeFileSync(file, '// script');

      const originalCwd = process.cwd();
      try {
        process.chdir(dir);
        expect(isDirectEntrypoint('./script.mjs', pathToFileURL(file).href)).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('returns false (not throws) when argv1 does not exist on disk', () => {
      expect(isDirectEntrypoint('/nonexistent/path/does-not-exist.mjs', import.meta.url)).toBe(
        false,
      );
    });

    describe('realpath failure falls back to unresolved-path string comparison instead of silently returning false (review finding #5, SCRUM-3584 PR #2635)', () => {
      it('returns true and warns once when realpath throws but the unresolved path strings match', () => {
        const samePath = '/some/fake/path/script.mjs';
        const warnings: string[] = [];

        const result = isDirectEntrypoint(samePath, pathToFileURL(samePath).href, {
          realpath: () => {
            throw new Error('EACCES: permission denied');
          },
          warn: (line) => warnings.push(line),
        });

        expect(result).toBe(true);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/fall(?:s|ing|en)? back|fallback/i);
        expect(warnings[0]).toMatch(/EACCES/);
      });

      it('returns false when realpath throws and the unresolved path strings do NOT match', () => {
        const warnings: string[] = [];

        const result = isDirectEntrypoint(
          '/some/fake/path/other.mjs',
          pathToFileURL('/some/fake/path/script.mjs').href,
          {
            realpath: () => {
              throw new Error('EACCES: permission denied');
            },
            warn: (line) => warnings.push(line),
          },
        );

        expect(result).toBe(false);
        expect(warnings).toHaveLength(1);
      });
    });
  });
});
