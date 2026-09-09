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
vi.mock('../lib/urls.js', () => ({ buildSetPasswordUrl: () => 'https://app.arkova.test/set-password' }));

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
  function rpcDeps(data: unknown, error: unknown = null) {
    const deps = makeDeps({});
    vi.mocked(deps.db.rpc).mockResolvedValue({ data, error } as never);
    return deps;
  }
  const organization = { org_id: ORG_ROW.id, public_id: ORG_ROW.public_id,
    org_prefix: ORG_ROW.org_prefix, display_name: 'PlanBook', anchor_quota: 31,
    credits_balance: 18, is_test: true };

  it('returns the persisted balance, including credits added after the original request', async () => {
    const deps = rpcDeps({ success: true, organization });
    const result = await createOrganization(deps, ACTOR, orgInput({ credits: 7 }));
    expect(result.credits_balance).toBe(18);
    expect(deps.db.from).not.toHaveBeenCalled();
  });

  it('passes explicit uncapped quota and the actor to the atomic operation', async () => {
    const deps = rpcDeps({ success: true, organization });
    await createOrganization(deps, ACTOR, orgInput({ anchor_quota: null, is_test: false }));
    expect(deps.db.rpc).toHaveBeenCalledWith('admin_provision_organization', expect.objectContaining({
      p_actor: ACTOR, p_anchor_quota: null, p_is_test: false,
      p_idempotency_key: '99999999-9999-4999-8999-999999999999',
    }));
  });

  it('reports a changed-payload or incomplete legacy replay as a conflict', async () => {
    const deps = rpcDeps({ success: false, error: 'idempotency_key_conflict' });
    await expect(createOrganization(deps, ACTOR, orgInput())).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
  });

  it('preserves the explicit duplicate-name override workflow', async () => {
    const deps = rpcDeps({ success: false, error: 'org_exists', existing_org_id: ORG_ROW.id });
    await expect(createOrganization(deps, ACTOR, orgInput())).rejects.toMatchObject({ code: 'org_exists', existingOrgId: ORG_ROW.id });
  });

  it.each([null, { success: false }, { success: true }])('fails closed on an incomplete database result %j', async (data) => {
    await expect(createOrganization(rpcDeps(data), ACTOR, orgInput())).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('does not report a rolled-back operation as a successful creation', async () => {
    const deps = rpcDeps(null, { code: 'P0001', message: 'transaction failed' });
    await expect(createOrganization(deps, ACTOR, orgInput())).rejects.toMatchObject({ code: 'internal_error' });
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

  it('uses protected app metadata to preserve the explicit account placement', async () => {
    const deps = makeDeps(userQueues());
    await createUserAccount(deps, ACTOR, userInput({ send_invite_email: false }));
    expect(deps.db.auth.admin.createUser).toHaveBeenCalledWith(expect.objectContaining({
      app_metadata: { admin_provisioned: true },
    }));
  });

  it.each([false, true])('returns a usable link after confirmation when email is attempted=%s', async (attemptEmail) => {
    // GoTrue confirmation clears auth.one_time_tokens, including previously
    // generated recovery links. A stale action_link must never be returned.
    const usableLinks = new Set<string>();
    let sequence = 0;
    mockSendEmail.mockResolvedValue({ success: false });
    const deps = makeDeps(userQueues(), {
      updateUserById: vi.fn(async () => {
        usableLinks.clear();
        return { data: { user: { id: 'new-user-id' } }, error: null };
      }),
      generateLink: vi.fn(async () => {
        const link = `https://app.arkova.test/set-password?fixture=${++sequence}`;
        usableLinks.add(link);
        return { data: { properties: { action_link: link } }, error: null };
      }),
    });
    const result = await createUserAccount(deps, ACTOR, userInput({ send_invite_email: attemptEmail }));
    expect(result.invite_email_sent).toBe(false);
    expect(usableLinks.has(result.activation_link ?? '')).toBe(true);
  });

  it('rolls back when no activation link can be delivered', async () => {
    const deps = makeDeps(userQueues(), {
      generateLink: vi.fn(async () => ({ data: null, error: { code: 'unexpected_failure', message: 'secret-person@example.com' } })),
    });
    await expect(createUserAccount(deps, ACTOR, userInput({ send_invite_email: false }))).rejects.toMatchObject({ code: 'internal_error' });
    expect(deps.db.auth.admin.deleteUser).toHaveBeenCalledWith('new-user-id');
    expect(JSON.stringify(vi.mocked(deps.logger.error).mock.calls)).not.toContain('secret-person@example.com');
  });

  it('rolls back when manual-delivery email confirmation fails', async () => {
    const deps = makeDeps(userQueues(), {
      updateUserById: vi.fn(async () => ({ data: null, error: { code: 'unexpected_failure' } })),
    });
    await expect(createUserAccount(deps, ACTOR, userInput({ send_invite_email: false }))).rejects.toMatchObject({ code: 'internal_error' });
    expect(deps.db.auth.admin.deleteUser).toHaveBeenCalledWith('new-user-id');
  });

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
    expect(deps.db.auth.admin.updateUserById).not.toHaveBeenCalled();
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

// Duplicate-name concurrency and multiple existing names are exercised against
// the real database in the provisioning qualification driver.
