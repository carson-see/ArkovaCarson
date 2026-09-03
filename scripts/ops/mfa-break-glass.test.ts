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
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runBreakGlass,
  parseCliArgs,
  isProdHost,
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

interface FakeClientOptions {
  listUsersPages?: Array<Array<{ id: string; email: string }>>;
  factors?: MfaFactorRow[];
  profileOrgId?: string | null;
  onInsert?: (
    table: string,
    row: Record<string, unknown>,
    callIndex: number,
  ) => { error: { message: string } | null };
  onDeleteFactor?: (id: string) => { error: { message: string } | null };
}

interface FakeClientHandle {
  client: SupabaseAdminLike;
  inserts: Array<{ table: string; row: Record<string, unknown> }>;
  deletedFactorIds: string[];
  listUsersCalls: number;
}

function makeFakeClient(opts: FakeClientOptions = {}): FakeClientHandle {
  const pages = opts.listUsersPages ?? [[{ id: USER_ID, email: USER_EMAIL }]];
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const deletedFactorIds: string[] = [];
  let listUsersCalls = 0;
  let insertCallIndex = 0;

  const client: SupabaseAdminLike = {
    auth: {
      admin: {
        listUsers: vi.fn(async ({ page }: { page: number; perPage: number }) => {
          listUsersCalls += 1;
          const users = pages[page - 1] ?? [];
          return { data: { users }, error: null };
        }),
        mfa: {
          listFactors: vi.fn(async () => ({
            data: { factors: opts.factors ?? [FACTOR_A, FACTOR_B] },
            error: null,
          })),
          deleteFactor: vi.fn(async ({ id }: { id: string; userId: string }) => {
            deletedFactorIds.push(id);
            const result = opts.onDeleteFactor ? opts.onDeleteFactor(id) : { error: null };
            return { data: result.error ? null : {}, error: result.error };
          }),
        },
      },
    },
    from: vi.fn((table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { org_id: opts.profileOrgId ?? null },
            error: null,
          }),
        }),
      }),
      insert: async (row: Record<string, unknown>) => {
        const idx = insertCallIndex;
        insertCallIndex += 1;
        inserts.push({ table, row });
        return opts.onInsert ? opts.onInsert(table, row, idx) : { error: null };
      },
    })),
  };

  return { client, inserts, deletedFactorIds, get listUsersCalls() { return listUsersCalls; } };
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
    allowProdBreakGlass: undefined,
    log: () => {},
    warn: () => {},
    ...overrides,
  };
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
        baseDeps(handle, { confirmEnv: USER_EMAIL.toUpperCase() }),
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

    it('allows a prod SUPABASE_URL host when ALLOW_PROD_BREAK_GLASS=1 is also set', async () => {
      const handle = makeFakeClient();
      const warnings: string[] = [];
      const outcome = await runBreakGlass(
        baseDeps(handle, {
          supabaseUrl: 'https://vzwyaatejekddvltxyye.supabase.co',
          confirmEnv: USER_EMAIL,
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
        baseDeps(handle, { confirmEnv: USER_EMAIL }),
        baseArgs({ factorId: 'not-a-real-factor', apply: true }),
      );

      expect(outcome.exitCode).toBe(EXIT_VALIDATION);
      expect(handle.inserts).toHaveLength(0);
      expect(handle.deletedFactorIds).toHaveLength(0);
    });

    it('aborts when no user is found for the email', async () => {
      const handle = makeFakeClient({ listUsersPages: [[]] });
      const outcome = await runBreakGlass(
        baseDeps(handle, { confirmEnv: USER_EMAIL }),
        baseArgs({ factorId: FACTOR_A.id, apply: true }),
      );

      expect(outcome.exitCode).toBe(EXIT_VALIDATION);
      expect(handle.inserts).toHaveLength(0);
    });

    it('paginates listUsers until it finds the matching email', async () => {
      // A full page (200 = LIST_USERS_PAGE_SIZE) signals "there may be more" —
      // matching real listUsers pagination, where a short page means last page.
      const page1 = Array.from({ length: 200 }, (_, i) => ({ id: `other-${i}`, email: `other${i}@example.com` }));
      const page2 = [{ id: USER_ID, email: USER_EMAIL }];
      const handle = makeFakeClient({ listUsersPages: [page1, page2] });
      const outcome = await runBreakGlass(baseDeps(handle), baseArgs({ apply: false }));

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(outcome.summary?.user_id).toBe(USER_ID);
    });
  });

  describe('apply-mode audit sequencing (CTO plan Amendment A4 ruling 5)', () => {
    it('aborts BEFORE any delete when the INTENT audit insert fails', async () => {
      const handle = makeFakeClient({
        onInsert: (_table, row) => {
          if (row.event_type === 'mfa_break_glass_requested') {
            return { error: { message: 'insert rejected' } };
          }
          return { error: null };
        },
      });

      const outcome = await runBreakGlass(
        baseDeps(handle, { confirmEnv: USER_EMAIL }),
        baseArgs({ factorId: FACTOR_A.id, apply: true }),
      );

      expect(outcome.exitCode).toBe(EXIT_INTENT_AUDIT_FAILED);
      expect(handle.deletedFactorIds).toHaveLength(0);
      expect(handle.inserts).toHaveLength(1);
      expect(handle.inserts[0].row.event_type).toBe('mfa_break_glass_requested');
      expect(handle.inserts[0].row.event_category).toBe('SECURITY');
    });

    it('writes the INTENT row with the documented shape before deleting', async () => {
      const handle = makeFakeClient({ profileOrgId: 'org-123' });
      await runBreakGlass(
        baseDeps(handle, { confirmEnv: USER_EMAIL }),
        baseArgs({ factorId: FACTOR_A.id, apply: true, reason: 'lost device', ticket: 'SCRUM-9999', operator: 'ops@arkova.io' }),
      );

      const intentRow = handle.inserts[0].row;
      expect(intentRow.event_type).toBe('mfa_break_glass_requested');
      expect(intentRow.event_category).toBe('SECURITY');
      expect(intentRow.actor_id).toBeNull();
      expect(intentRow.target_type).toBe('mfa_factor');
      expect(intentRow.target_id).toBe(FACTOR_A.id);
      expect(intentRow.org_id).toBe('org-123');
      const details = JSON.parse(intentRow.details as string);
      expect(details.operator).toBe('ops@arkova.io');
      expect(details.reason).toBe('lost device');
      expect(details.ticket).toBe('SCRUM-9999');
      expect(details.user_id).toBe(USER_ID);
      expect(details.factor_ids).toEqual([FACTOR_A.id]);
    });

    it('deletes the factor and writes a COMPLETION row on success', async () => {
      const handle = makeFakeClient();
      const outcome = await runBreakGlass(
        baseDeps(handle, { confirmEnv: USER_EMAIL }),
        baseArgs({ factorId: FACTOR_A.id, apply: true }),
      );

      expect(outcome.exitCode).toBe(EXIT_SUCCESS);
      expect(handle.deletedFactorIds).toEqual([FACTOR_A.id]);
      expect(handle.inserts).toHaveLength(2);
      expect(handle.inserts[1].row.event_type).toBe('mfa_break_glass_completed');
      const details = JSON.parse(handle.inserts[1].row.details as string);
      expect(details.results).toEqual([{ id: FACTOR_A.id, friendly_name: FACTOR_A.friendly_name, status: 'deleted' }]);
    });

    it('--all deletes every factor and joins ids in the audit target_id', async () => {
      const handle = makeFakeClient({ factors: [FACTOR_A, FACTOR_B] });
      const outcome = await runBreakGlass(
        baseDeps(handle, { confirmEnv: USER_EMAIL }),
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

      const outcome = await runBreakGlass(
        baseDeps(handle, { confirmEnv: USER_EMAIL }),
        baseArgs({ factorId: FACTOR_A.id, apply: true }),
      );

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
          if (row.event_type === 'mfa_break_glass_completed') {
            return { error: { message: 'insert rejected' } };
          }
          return { error: null };
        },
      });
      const warnings: string[] = [];

      const outcome = await runBreakGlass(
        baseDeps(handle, { confirmEnv: USER_EMAIL, warn: (line) => warnings.push(line) }),
        baseArgs({ factorId: FACTOR_A.id, apply: true }),
      );

      expect(outcome.exitCode).toBe(EXIT_COMPLETION_AUDIT_FAILED);
      // The delete already happened — that's what makes this the loud path.
      expect(handle.deletedFactorIds).toEqual([FACTOR_A.id]);
      expect(warnings.some((w) => w.includes('mfa_break_glass_completed'))).toBe(true);
      expect(warnings.some((w) => w.includes(FACTOR_A.id))).toBe(true);
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

    it('rejects a ticket that is neither a SCRUM- id nor a URL', () => {
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

    it('accepts a Jira URL as the ticket', () => {
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
  });

  describe('isProdHost', () => {
    it('flags the prod Supabase ref', () => {
      expect(isProdHost('https://vzwyaatejekddvltxyye.supabase.co')).toBe(true);
    });

    it('does not flag an unrelated project ref', () => {
      expect(isProdHost('https://abcdefghijklmnop.supabase.co')).toBe(false);
    });
  });
});
