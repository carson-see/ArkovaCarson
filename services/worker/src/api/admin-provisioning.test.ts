/**
 * Platform-admin provisioning tests (SCRUM-3873).
 *
 * TDD for the gap found while provisioning PlanBook by hand: the admin console
 * can set quota/credits on an EXISTING org but cannot create a net-new
 * organization or a net-new account. Cases here are driven by
 * docs/staging/premortem-platform-admin-provisioning-2026-09-01.md — every
 * numbered failure mode in that document has a test below.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSendEmail } = vi.hoisted(() => ({ mockSendEmail: vi.fn() }));
vi.mock('../email/sender.js', () => ({ sendEmail: mockSendEmail }));
vi.mock('../lib/urls.js', () => ({ buildLoginUrl: () => 'https://app.arkova.test/login' }));

import {
  createOrganization,
  createUserAccount,
  ProvisioningError,
  validateCreateOrganizationInput,
  validateCreateUserAccountInput,
  type AdminProvisioningDeps,
} from './admin-provisioning.js';

// Generic Supabase-chain mock (mirrors invitations.test.ts).
function chain(result: { data?: unknown; error?: unknown }) {
  const obj: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'order', 'limit', 'update', 'insert', 'delete', 'upsert']) {
    obj[m] = vi.fn(() => obj);
  }
  obj.maybeSingle = vi.fn(async () => result);
  obj.single = vi.fn(async () => result);
  (obj as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return obj;
}

interface TableQueues { [table: string]: ReturnType<typeof chain>[] }

function makeDb(queues: TableQueues, admin: Record<string, unknown> = {}) {
  return {
    rpc: vi.fn(async () => ({ data: null, error: null })),
    from: vi.fn((table: string) => {
      const q = queues[table];
      if (!q || q.length === 0) throw new Error(`Unconfigured db.from('${table}') (queue exhausted)`);
      return q.shift();
    }),
    auth: {
      admin: {
        createUser: vi.fn(async () => ({ data: { user: { id: 'new-user-id' } }, error: null })),
        updateUserById: vi.fn(async () => ({ data: { user: { id: 'new-user-id' } }, error: null })),
        deleteUser: vi.fn(async () => ({ error: null })),
        generateLink: vi.fn(async () => ({
          data: { properties: { action_link: 'https://app.arkova.test/set-password' } },
          error: null,
        })),
        ...admin,
      },
    },
  };
}

function makeDeps(queues: TableQueues, admin?: Record<string, unknown>): AdminProvisioningDeps {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: makeDb(queues, admin) as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function orgInput(over: Record<string, unknown> = {}) {
  const r = validateCreateOrganizationInput({
    display_name: 'PlanBook',
    idempotency_key: '99999999-9999-4999-8999-999999999999',
    ...over,
  });
  if (!r.ok) throw new Error(`bad test fixture: ${r.error}`);
  return r.value;
}

function userInput(over: Record<string, unknown> = {}) {
  const r = validateCreateUserAccountInput({ email: 'x@example.com', role: 'INDIVIDUAL', ...over });
  if (!r.ok) throw new Error(`bad test fixture: ${r.error}`);
  return r.value;
}

const ACTOR = '11111111-1111-4111-8111-111111111111';
const ORG_ROW = { id: '22222222-2222-4222-8222-222222222222', public_id: 'abc123xyz789', org_prefix: 'PLA', display_name: 'PlanBook' };

beforeEach(() => {
  vi.clearAllMocks();
  mockSendEmail.mockResolvedValue({ success: true });
});

// ─────────────────────────── input validation ───────────────────────────

describe('validateCreateOrganizationInput', () => {
  it('requires an idempotency_key — an optional atomicity guarantee is not one', () => {
    const r = validateCreateOrganizationInput({ display_name: 'A' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/idempotency_key/);
  });

  it('rejects a non-uuid idempotency_key', () => {
    expect(validateCreateOrganizationInput({ display_name: 'A', idempotency_key: 'nope' }).ok).toBe(false);
  });

  it('requires a non-empty display_name', () => {
    expect(validateCreateOrganizationInput({}).ok).toBe(false);
    expect(validateCreateOrganizationInput({ display_name: '   ' }).ok).toBe(false);
  });

  it('rejects a display_name longer than 200 characters', () => {
    expect(validateCreateOrganizationInput({ display_name: 'x'.repeat(201) }).ok).toBe(false);
  });

  it('rejects a negative or non-integer anchor_quota but allows null (uncapped)', () => {
    expect(validateCreateOrganizationInput({ display_name: 'A', anchor_quota: -1 }).ok).toBe(false);
    expect(validateCreateOrganizationInput({ display_name: 'A', anchor_quota: 1.5 }).ok).toBe(false);
    expect(validateCreateOrganizationInput({ idempotency_key: '99999999-9999-4999-8999-999999999999', display_name: 'A', anchor_quota: null }).ok).toBe(true);
  });

  it('rejects negative credits', () => {
    expect(validateCreateOrganizationInput({ display_name: 'A', credits: -5 }).ok).toBe(false);
  });

  it('defaults legal_name to display_name and credits to 0', () => {
    const r = validateCreateOrganizationInput({ idempotency_key: '99999999-9999-4999-8999-999999999999', display_name: 'PlanBook' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.legal_name).toBe('PlanBook');
      expect(r.value.credits).toBe(0);
    }
  });
});

describe('validateCreateUserAccountInput', () => {
  it('rejects a malformed email', () => {
    expect(validateCreateUserAccountInput({ email: 'nope', role: 'INDIVIDUAL' }).ok).toBe(false);
  });

  it('rejects an unknown role', () => {
    expect(validateCreateUserAccountInput({ email: 'a@b.com', role: 'SUPERUSER' }).ok).toBe(false);
  });

  it('F1: ignores an is_platform_admin field rather than honouring it', () => {
    const r = validateCreateUserAccountInput({
      email: 'a@b.com', role: 'ORG_ADMIN', org_id: '22222222-2222-4222-8222-222222222222', is_platform_admin: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).not.toHaveProperty('is_platform_admin');
  });

  it('requires org_id for org-scoped roles and forbids it for INDIVIDUAL', () => {
    expect(validateCreateUserAccountInput({ email: 'a@b.com', role: 'ORG_ADMIN' }).ok).toBe(false);
    expect(validateCreateUserAccountInput({ email: 'a@b.com', role: 'INDIVIDUAL', org_id: '22222222-2222-4222-8222-222222222222' }).ok).toBe(false);
  });

  it('F6: defaults send_invite_email to true', () => {
    const r = validateCreateUserAccountInput({ email: 'a@b.com', role: 'INDIVIDUAL' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.send_invite_email).toBe(true);
  });

  it('normalises the email to lowercase', () => {
    const r = validateCreateUserAccountInput({ email: 'MiXeD@Example.COM', role: 'INDIVIDUAL' });
    if (r.ok) expect(r.value.email).toBe('mixed@example.com');
  });
});

// ─────────────────────────── createOrganization ───────────────────────────

describe('createOrganization', () => {
  it('creates the org and explicitly writes the resolved credit state (F8)', async () => {
    const creditsChain = chain({ data: null, error: null });
    const deps = makeDeps({
      organizations: [chain({ data: [], error: null }), chain({ data: ORG_ROW, error: null })],
      org_credits: [creditsChain],
      audit_events: [chain({ data: null, error: null })],
    });

    const result = await createOrganization(deps, ACTOR, orgInput({
      display_name: 'PlanBook', legal_name: 'PlanBook', anchor_quota: 10, credits: 2, is_test: true,
    }));

    expect(result.org_id).toBe('22222222-2222-4222-8222-222222222222');
    expect(result.anchor_quota).toBe(10);
    expect(result.credits_balance).toBe(2);
    expect(creditsChain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ anchor_quota: 10, is_test: true }),
      expect.objectContaining({ onConflict: 'org_id' }),
    );
    // Starting credits go through the audited ledger RPC, never straight onto
    // the balance — booking a grant as `purchased` would call it revenue.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((deps.db as any).rpc).toHaveBeenCalledWith(
      'admin_adjust_org_credit',
      expect.objectContaining({ p_amount: 2, p_actor: ACTOR }),
    );
  });

  it('is idempotent: a replayed submission returns the first org, not a second one', async () => {
    // The unique index on creation_idempotency_key (0422) is what makes the
    // guard atomic — the display_name pre-check cannot be.
    const prior = { id: 'org-first', public_id: 'pub1', org_prefix: 'PLA', display_name: 'PlanBook' };
    const deps = makeDeps({
      organizations: [
        chain({ data: [], error: null }),                                   // dup-name probe: clear
        chain({ data: null, error: { code: '23505', message: 'duplicate key' } }), // insert: replay
        chain({ data: [prior], error: null }),                              // fetch the original
      ],
      org_credits: [chain({ data: null, error: null })],
      audit_events: [chain({ data: null, error: null })],
    });

    const r = await createOrganization(deps, ACTOR, orgInput());
    expect(r.org_id).toBe('org-first');
  });

  it('surfaces internal_error when the replay lookup finds nothing', async () => {
    const deps = makeDeps({
      organizations: [
        chain({ data: [], error: null }),
        chain({ data: null, error: { code: '23505', message: 'duplicate key' } }),
        chain({ data: [], error: null }),
      ],
    });
    await expect(createOrganization(deps, ACTOR, orgInput())).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('F3: rejects a duplicate display_name with org_exists and surfaces the existing id', async () => {
    // .limit(1) resolves to an ARRAY (see the maybeSingle finding below).
    const deps = makeDeps({
      organizations: [chain({ data: [{ id: 'org-existing' }], error: null })],
    });

    await expect(
      createOrganization(deps, ACTOR, orgInput({ display_name: 'PlanBook', credits: 0 })),
    ).rejects.toMatchObject({ code: 'org_exists', existingOrgId: 'org-existing' });
  });

  it('F8: an uncapped org writes anchor_quota null and is_test false, overriding the seed trigger', async () => {
    const creditsChain = chain({ data: null, error: null });
    const deps = makeDeps({
      organizations: [chain({ data: [], error: null }), chain({ data: ORG_ROW, error: null })],
      org_credits: [creditsChain],
      audit_events: [chain({ data: null, error: null })],
    });

    await createOrganization(deps, ACTOR, orgInput({ display_name: 'BigCo', anchor_quota: null, is_test: false, credits: 0 }));

    expect(creditsChain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ anchor_quota: null, is_test: false }),
      expect.objectContaining({ onConflict: 'org_id' }),
    );
  });

  it('upserts org_credits so a sub-org with no seeded row is not a silent success', async () => {
    // trg_seed_free_tier_org_credits skips orgs with a parent, and PostgREST
    // reports a zero-row UPDATE as success.
    const creditsChain = chain({ data: null, error: null });
    const deps = makeDeps({
      organizations: [chain({ data: [], error: null }), chain({ data: ORG_ROW, error: null })],
      org_credits: [creditsChain],
      audit_events: [chain({ data: null, error: null })],
    });

    await createOrganization(deps, ACTOR, orgInput({ display_name: 'SubCo', credits: 0 }));

    expect(creditsChain.upsert).toHaveBeenCalled();
    expect(creditsChain.update).not.toHaveBeenCalled();
  });

  it('writes an audit event naming the actor', async () => {
    const audit = chain({ data: null, error: null });
    const deps = makeDeps({
      organizations: [chain({ data: [], error: null }), chain({ data: ORG_ROW, error: null })],
      org_credits: [chain({ data: null, error: null })],
      audit_events: [audit],
    });

    await createOrganization(deps, ACTOR, orgInput({ display_name: 'PlanBook', credits: 0 }));

    expect(audit.insert).toHaveBeenCalledWith(
      expect.objectContaining({ actor_id: ACTOR, org_id: '22222222-2222-4222-8222-222222222222' }),
    );
  });

  it('surfaces internal_error when the org insert fails', async () => {
    const deps = makeDeps({
      organizations: [chain({ data: null, error: null }), chain({ data: null, error: { message: 'boom' } })],
    });
    await expect(
      createOrganization(deps, ACTOR, orgInput({ display_name: 'PlanBook', credits: 0 })),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });
});

// ─────────────────────────── createUserAccount ───────────────────────────

describe('createUserAccount', () => {
  function userQueues(over: Partial<TableQueues> = {}): TableQueues {
    return {
      profiles: [
        chain({ data: null, error: null }),                      // pre-existing lookup by email
        chain({ data: null, error: null }),                      // insert (may 23505)
        chain({ data: { id: 'new-user-id', role: null }, error: null }), // read back before role write
        chain({ data: null, error: null }),                      // update role/org
      ],
      org_members: [chain({ data: null, error: null })],
      audit_events: [chain({ data: null, error: null })],
      organizations: [chain({ data: { display_name: 'PlanBook' }, error: null })],
      ...over,
    };
  }

  it('F2: always creates the auth user with email_confirm false so auto-association cannot pre-set the role', async () => {
    const deps = makeDeps(userQueues());
    await createUserAccount(deps, ACTOR, userInput({
      email: 'ogechi@example.com', full_name: 'Ogechi Welechi',
      role: 'ORG_ADMIN', org_id: '22222222-2222-4222-8222-222222222222', org_role: 'owner', send_invite_email: true,
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((deps.db as any).auth.admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ogechi@example.com', email_confirm: false }),
    );
  });

  it('F2: fails loudly with role_conflict when the profile already carries a different, frozen role', async () => {
    const deps = makeDeps(userQueues({
      profiles: [
        chain({ data: null, error: null }),
        chain({ data: null, error: null }),
        chain({ data: { id: 'new-user-id', role: 'ORG_MEMBER' }, error: null }), // auto-associated first
        chain({ data: null, error: null }),
      ],
    }));

    await expect(
      createUserAccount(deps, ACTOR, userInput({
        email: 'ops@acme.com', role: 'ORG_ADMIN', org_id: '22222222-2222-4222-8222-222222222222', send_invite_email: true,
      })),
    ).rejects.toMatchObject({ code: 'role_conflict' });
  });

  it('F4: rolls the auth user back when a downstream write fails', async () => {
    const deps = makeDeps(userQueues({
      profiles: [
        chain({ data: null, error: null }),
        chain({ data: null, error: { code: 'XXXXX', message: 'profile insert exploded' } }),
      ],
    }));

    await expect(
      createUserAccount(deps, ACTOR, userInput({ email: 'x@example.com', role: 'INDIVIDUAL', send_invite_email: true })),
    ).rejects.toMatchObject({ code: 'internal_error' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((deps.db as any).auth.admin.deleteUser).toHaveBeenCalledWith('new-user-id');
  });

  it('F4: tolerates 23505 on the profile insert (the on_auth_user_created trigger won the race)', async () => {
    const deps = makeDeps(userQueues({
      profiles: [
        chain({ data: null, error: null }),
        chain({ data: null, error: { code: '23505', message: 'duplicate key' } }),
        chain({ data: { id: 'new-user-id', role: null }, error: null }),
        chain({ data: null, error: null }),
      ],
    }));

    const r = await createUserAccount(deps, ACTOR, userInput({
      email: 'x@example.com', role: 'INDIVIDUAL', send_invite_email: true,
    }));

    expect(r.user_id).toBe('new-user-id');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((deps.db as any).auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it('rejects an address that already has an account', async () => {
    const deps = makeDeps(userQueues({
      profiles: [chain({ data: { id: 'existing-user' }, error: null })],
    }));

    await expect(
      createUserAccount(deps, ACTOR, userInput({ email: 'taken@example.com', role: 'INDIVIDUAL', send_invite_email: true })),
    ).rejects.toMatchObject({ code: 'account_exists' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((deps.db as any).auth.admin.createUser).not.toHaveBeenCalled();
  });

  it('F6: sends the invite email and reports it, without returning the link', async () => {
    const deps = makeDeps(userQueues());
    const r = await createUserAccount(deps, ACTOR, userInput({
      email: 'ogechi@example.com', role: 'ORG_ADMIN', org_id: '22222222-2222-4222-8222-222222222222', send_invite_email: true,
    }));

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(r.invite_email_sent).toBe(true);
    expect(r.activation_link).toBeNull();
  });

  it('F6: opting out sends nothing, confirms the email, and returns the link for manual delivery', async () => {
    const deps = makeDeps(userQueues());
    const r = await createUserAccount(deps, ACTOR, userInput({
      email: 'ogechi@example.com', role: 'ORG_ADMIN', org_id: '22222222-2222-4222-8222-222222222222', send_invite_email: false,
    }));

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(r.invite_email_sent).toBe(false);
    expect(r.activation_link).toBe('https://app.arkova.test/set-password');
    // Confirmed only AFTER role/org are written, so auto-association is a no-op.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((deps.db as any).auth.admin.updateUserById).toHaveBeenCalledWith(
      'new-user-id', expect.objectContaining({ email_confirm: true }),
    );
  });

  it('F7: never logs the email address', async () => {
    const deps = makeDeps(userQueues({
      profiles: [
        chain({ data: null, error: null }),
        chain({ data: null, error: { code: 'XXXXX', message: 'kaboom' } }),
      ],
    }));

    await expect(
      createUserAccount(deps, ACTOR, userInput({ email: 'secret@example.com', role: 'INDIVIDUAL', send_invite_email: true })),
    ).rejects.toBeInstanceOf(ProvisioningError);

    const logged = JSON.stringify((deps.logger.error as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain('secret@example.com');
  });

  it('creates the org_members row for an org-scoped account', async () => {
    const members = chain({ data: null, error: null });
    const deps = makeDeps(userQueues({ org_members: [members] }));

    await createUserAccount(deps, ACTOR, userInput({
      email: 'ogechi@example.com', role: 'ORG_ADMIN', org_id: '22222222-2222-4222-8222-222222222222', org_role: 'owner',
      send_invite_email: true,
    }));

    expect(members.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'new-user-id', org_id: '22222222-2222-4222-8222-222222222222', role: 'owner' }),
    );
  });

  it('does not touch org_members for an INDIVIDUAL account', async () => {
    const members = chain({ data: null, error: null });
    const deps = makeDeps(userQueues({ org_members: [members] }));

    await createUserAccount(deps, ACTOR, userInput({
      email: 'solo@example.com', role: 'INDIVIDUAL', send_invite_email: true,
    }));

    expect(members.insert).not.toHaveBeenCalled();
  });
});

// ── Code-review findings (2026-09-01) ──────────────────────────────────────

describe('createUserAccount — send-failure and orphan handling', () => {
  function baseQueues(): TableQueues {
    return {
      profiles: [
        chain({ data: null, error: null }),
        chain({ data: null, error: null }),
        chain({ data: { id: 'new-user-id', role: null }, error: null }),
        chain({ data: null, error: null }),
      ],
      org_members: [chain({ data: null, error: null })],
      audit_events: [chain({ data: null, error: null })],
      organizations: [chain({ data: { display_name: 'PlanBook' }, error: null })],
    };
  }

  it('falls back to the manual-delivery path when the invite email fails to send', async () => {
    mockSendEmail.mockResolvedValue({ success: false });
    const deps = makeDeps(baseQueues());

    const r = await createUserAccount(deps, ACTOR, userInput({ send_invite_email: true }));

    // Asked for an email, send failed -> report it honestly AND surface the link.
    expect(r.invite_email_sent).toBe(false);
    expect(r.activation_link).toBe('https://app.arkova.test/set-password');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((deps.db as any).auth.admin.updateUserById).toHaveBeenCalledWith(
      'new-user-id', expect.objectContaining({ email_confirm: true }),
    );
  });

  it('maps an orphaned auth user to account_exists rather than a generic failure', async () => {
    const deps = makeDeps(
      { profiles: [chain({ data: null, error: null })] },
      {
        createUser: vi.fn(async () => ({
          data: null,
          error: { message: 'A user with this email address has already been registered' },
        })),
      },
    );

    await expect(
      createUserAccount(deps, ACTOR, userInput({ email: 'orphan@example.com' })),
    ).rejects.toMatchObject({ code: 'account_exists' });
  });

  it('never passes a raw driver error (which can carry the email) to the logger', async () => {
    const deps = makeDeps({
      profiles: [
        chain({ data: null, error: null }),
        chain({
          data: null,
          error: {
            code: '23505',
            message: 'duplicate key value violates unique constraint',
            details: 'Key (email)=(secret@example.com) already exists.',
          },
        }),
      ],
    });

    await expect(
      createUserAccount(deps, ACTOR, userInput({ email: 'secret@example.com' })),
    ).rejects.toBeInstanceOf(ProvisioningError);

    const logged = JSON.stringify((deps.logger.error as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain('secret@example.com');
    expect(logged).not.toContain('Key (email)');
  });
});

describe('createOrganization — duplicate lookup', () => {
  it('returns org_exists (not a 500) when two orgs already share the name', async () => {
    // limit(1) returns an array; maybeSingle() would have raised PGRST116 here.
    const deps = makeDeps({
      organizations: [chain({ data: [{ id: 'org-a' }], error: null })],
    });

    await expect(
      createOrganization(deps, ACTOR, orgInput({ display_name: 'Acme Corp' })),
    ).rejects.toMatchObject({ code: 'org_exists', existingOrgId: 'org-a' });
  });
});
