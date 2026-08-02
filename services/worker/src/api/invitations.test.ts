/**
 * Invitation accept/preview tests (SCRUM-3012)
 *
 * TDD for the previously-nonexistent accept step: the invite email link used
 * to drop `invitations.token` entirely (routes/anchor.ts built
 * `/login?invite=true&org=...`), so nothing could ever validate or provision
 * an accept. These tests cover the full decision tree in invitations.ts:
 * preview, new-account provisioning + rollback-on-failure, existing-account
 * join, idempotency, expiry, and the email-mismatch / already-exists guards.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSendEmail } = vi.hoisted(() => ({ mockSendEmail: vi.fn() }));

vi.mock('../email/sender.js', () => ({ sendEmail: mockSendEmail }));
vi.mock('../lib/urls.js', () => ({ buildLoginUrl: () => 'https://app.arkova.test/login' }));

import {
  getInvitationPreview,
  acceptInvitation,
  InvitationError,
  type InvitationDeps,
} from './invitations.js';

// ---- Generic Supabase-chain mock ----
// Every chain method returns the same object (so any sequence of
// .select().eq().eq()... compiles); the object is ALSO directly thenable so
// both `await chain.maybeSingle()` and `await chain` (bare insert/update)
// resolve to the configured result.
function chain(result: { data?: unknown; error?: unknown }) {
  const obj: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'order', 'limit', 'update', 'insert', 'delete']) {
    obj[method] = vi.fn(() => obj);
  }
  obj.maybeSingle = vi.fn(async () => result);
  obj.single = vi.fn(async () => result);
  (obj as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return obj;
}

interface TableQueues {
  [table: string]: ReturnType<typeof chain>[];
}

function makeDb(queues: TableQueues, admin: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  const from = vi.fn((table: string) => {
    const q = queues[table];
    if (!q || q.length === 0) {
      throw new Error(`Unconfigured db.from('${table}') call (mock queue exhausted)`);
    }
    return q.shift();
  });
  return {
    from,
    auth: {
      admin: {
        createUser: vi.fn(async () => ({ data: { user: { id: 'new-user-id' } }, error: null })),
        getUserById: vi.fn(async () => ({
          data: { user: { email_confirmed_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' } },
          error: null,
        })),
        deleteUser: vi.fn(async () => ({ error: null })),
        generateLink: vi.fn(async () => ({
          data: { properties: { action_link: 'https://app.arkova.test/verify-link' } },
          error: null,
        })),
        ...admin,
      },
    },
  };
}

function makeDeps(queues: TableQueues, admin?: Partial<Record<string, ReturnType<typeof vi.fn>>>): InvitationDeps {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: makeDb(queues, admin) as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

const INVITATION_ROW = {
  id: 'invite-id-1',
  email: 'invitee@example.com',
  role: 'INDIVIDUAL' as const,
  org_id: 'org-1',
  invited_by: 'admin-user-1',
  status: 'pending',
  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
};

const ORG_ROW = { display_name: 'Example Org' };

/** `invitations.token` is a uuid column — a non-uuid literal makes Postgres
 *  raise 22P02, so tokens in these tests must be well-formed. */
const TOKEN = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-1' });
});

describe('getInvitationPreview', () => {
  it('rejects an empty token without a DB call', async () => {
    const deps = makeDeps({});
    await expect(getInvitationPreview(deps, '')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('returns not_found for an unknown token', async () => {
    const deps = makeDeps({ invitations: [chain({ data: null, error: null })] });
    await expect(getInvitationPreview(deps, TOKEN)).rejects.toMatchObject({ code: 'not_found' });
  });

  // `.eq('token', <non-uuid>)` makes Postgres raise 22P02 (invalid input syntax
  // for type uuid), which supabase-js surfaces as an `error` -> internal_error
  // -> HTTP 500 + an error-level log, for input as ordinary as a link mangled
  // by an email client. The 404 branch was unreachable for malformed links.
  it('returns not_found for a malformed token without querying the DB', async () => {
    const deps = makeDeps({});
    await expect(getInvitationPreview(deps, 'not-a-uuid')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(deps.db.from).not.toHaveBeenCalled();
  });

  it('returns org name + validity for a pending, unexpired invitation', async () => {
    const deps = makeDeps({
      invitations: [chain({ data: INVITATION_ROW, error: null })],
      organizations: [chain({ data: ORG_ROW, error: null })],
    });

    const preview = await getInvitationPreview(deps, TOKEN);
    expect(preview).toEqual({
      orgName: 'Example Org',
      email: 'invitee@example.com',
      role: 'INDIVIDUAL',
      expired: false,
      alreadyUsed: false,
    });
  });

  it('flags an expired pending invitation', async () => {
    const expired = { ...INVITATION_ROW, expires_at: new Date(Date.now() - 1000).toISOString() };
    const deps = makeDeps({
      invitations: [chain({ data: expired, error: null })],
      organizations: [chain({ data: ORG_ROW, error: null })],
    });

    const preview = await getInvitationPreview(deps, TOKEN);
    expect(preview.expired).toBe(true);
    expect(preview.alreadyUsed).toBe(false);
  });

  it('flags an already-accepted invitation', async () => {
    const accepted = { ...INVITATION_ROW, status: 'accepted' };
    const deps = makeDeps({
      invitations: [chain({ data: accepted, error: null })],
      organizations: [chain({ data: ORG_ROW, error: null })],
    });

    const preview = await getInvitationPreview(deps, TOKEN);
    expect(preview.alreadyUsed).toBe(true);
  });
});

describe('acceptInvitation — validation + lifecycle guards', () => {
  it('rejects a missing token', async () => {
    const deps = makeDeps({});
    await expect(acceptInvitation(deps, { token: '', callerId: null })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('returns not_found for an unknown token', async () => {
    const deps = makeDeps({ invitations: [chain({ data: null, error: null })] });
    await expect(acceptInvitation(deps, { token: TOKEN, callerId: null })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('returns not_found for a malformed token without querying the DB', async () => {
    const deps = makeDeps({});
    await expect(
      acceptInvitation(deps, { token: 'not-a-uuid', callerId: null }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(deps.db.from).not.toHaveBeenCalled();
  });

  it('rejects an expired invitation', async () => {
    const expired = { ...INVITATION_ROW, expires_at: new Date(Date.now() - 1000).toISOString() };
    const deps = makeDeps({
      invitations: [chain({ data: expired, error: null })],
      organizations: [chain({ data: ORG_ROW, error: null })],
    });
    await expect(acceptInvitation(deps, { token: TOKEN, callerId: null })).rejects.toMatchObject({
      code: 'expired',
    });
  });

  it('rejects an already-used invitation when the caller is not a member', async () => {
    const accepted = { ...INVITATION_ROW, status: 'accepted' };
    const deps = makeDeps({
      invitations: [chain({ data: accepted, error: null })],
      organizations: [chain({ data: ORG_ROW, error: null })],
      org_members: [chain({ data: null, error: null })],
    });
    await expect(acceptInvitation(deps, { token: TOKEN, callerId: 'user-1' })).rejects.toMatchObject({
      code: 'already_used',
    });
  });

  it('is idempotent: an already-used invitation succeeds when the caller IS already a member', async () => {
    const accepted = { ...INVITATION_ROW, status: 'accepted' };
    const deps = makeDeps({
      invitations: [chain({ data: accepted, error: null })],
      organizations: [chain({ data: ORG_ROW, error: null })],
      org_members: [chain({ data: { id: 'membership-1' }, error: null })],
    });
    const result = await acceptInvitation(deps, { token: TOKEN, callerId: 'user-1' });
    expect(result).toEqual({
      orgId: 'org-1',
      orgName: 'Example Org',
      verificationRequired: false,
      verificationEmailSent: false,
    });
  });
});

describe('acceptInvitation — existing-user join path', () => {
  it('rejects when the authenticated caller email does not match the invitation', async () => {
    const deps = makeDeps({
      invitations: [chain({ data: INVITATION_ROW, error: null })],
      organizations: [chain({ data: ORG_ROW, error: null })],
      profiles: [chain({ data: { email: 'someone-else@example.com' }, error: null })],
    });
    await expect(
      acceptInvitation(deps, { token: TOKEN, callerId: 'user-1' }),
    ).rejects.toMatchObject({ code: 'email_mismatch' });
  });

  it('provisions membership directly for a matching authenticated caller (no account creation)', async () => {
    const admin = {
      createUser: vi.fn(),
    };
    const deps = makeDeps(
      {
        invitations: [
          chain({ data: INVITATION_ROW, error: null }), // load
          chain({ error: null }), // status -> accepted
        ],
        organizations: [chain({ data: ORG_ROW, error: null })],
        profiles: [
          chain({ data: { email: 'invitee@example.com' }, error: null }), // caller email check
          chain({ error: null }), // org_id backfill
        ],
        org_members: [
          chain({ data: null, error: null }), // no existing membership
          chain({ error: null }), // insert
        ],
        audit_events: [chain({ error: null })],
      },
      admin,
    );

    const result = await acceptInvitation(deps, { token: TOKEN, callerId: 'user-1' });

    expect(admin.createUser).not.toHaveBeenCalled();
    expect(result).toEqual({
      orgId: 'org-1',
      orgName: 'Example Org',
      verificationRequired: false,
      verificationEmailSent: false,
    });
  });
});

describe('acceptInvitation — new-account path', () => {
  it('requires a password of at least 8 characters', async () => {
    const deps = makeDeps({
      invitations: [chain({ data: INVITATION_ROW, error: null })],
      organizations: [chain({ data: ORG_ROW, error: null })],
      profiles: [chain({ data: null, error: null })], // no existing account
    });
    await expect(
      acceptInvitation(deps, { token: TOKEN, password: 'short', callerId: null }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('returns account_exists when an account with the invited email already exists', async () => {
    const deps = makeDeps({
      invitations: [chain({ data: INVITATION_ROW, error: null })],
      organizations: [chain({ data: ORG_ROW, error: null })],
      profiles: [chain({ data: { id: 'existing-profile' }, error: null })],
    });
    await expect(
      acceptInvitation(deps, { token: TOKEN, password: 'longenough', callerId: null }),
    ).rejects.toMatchObject({ code: 'account_exists' });
  });

  it('creates the account worker-side, provisions membership, and sends a verification email', async () => {
    const deps = makeDeps({
      invitations: [
        chain({ data: INVITATION_ROW, error: null }), // load
        chain({ error: null }), // status -> accepted
      ],
      organizations: [chain({ data: ORG_ROW, error: null })],
      profiles: [
        chain({ data: null, error: null }), // no existing account
        chain({ error: null }), // profile insert
        chain({ error: null }), // org_id backfill
      ],
      org_members: [
        chain({ data: null, error: null }), // no existing membership
        chain({ error: null }), // insert
      ],
      audit_events: [chain({ error: null })],
    });

    const result = await acceptInvitation(deps, {
      token: TOKEN,
      password: 'longenough',
      fullName: 'Jamie Doe',
      callerId: null,
    });

    expect(deps.db.auth.admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'invitee@example.com', password: 'longenough', email_confirm: false }),
    );
    expect(deps.db.auth.admin.generateLink).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'signup', email: 'invitee@example.com', password: 'longenough' }),
    );
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'invitee@example.com', emailType: 'account_verification' }),
    );
    expect(result).toEqual({
      orgId: 'org-1',
      orgName: 'Example Org',
      verificationRequired: true,
      verificationEmailSent: true,
    });
  });

  it('treats a duplicate profile row (23505, likely a DB trigger race) as success, not a failure', async () => {
    const deps = makeDeps({
      invitations: [
        chain({ data: INVITATION_ROW, error: null }),
        chain({ error: null }),
      ],
      organizations: [chain({ data: ORG_ROW, error: null })],
      profiles: [
        chain({ data: null, error: null }),
        chain({ error: { code: '23505', message: 'duplicate key' } }), // profile insert races a trigger
        chain({ error: null }),
      ],
      org_members: [chain({ data: null, error: null }), chain({ error: null })],
      audit_events: [chain({ error: null })],
    });

    const result = await acceptInvitation(deps, { token: TOKEN, password: 'longenough', callerId: null });
    expect(result.verificationRequired).toBe(true);
  });

  it('rolls back (deletes) the newly created auth user when provisioning fails after account creation', async () => {
    const deps = makeDeps({
      invitations: [chain({ data: INVITATION_ROW, error: null })],
      organizations: [chain({ data: ORG_ROW, error: null })],
      profiles: [
        chain({ data: null, error: null }), // no existing account
        chain({ error: { code: '23503', message: 'insert failed' } }), // profile insert hard-fails
      ],
    });

    await expect(
      acceptInvitation(deps, { token: TOKEN, password: 'longenough', callerId: null }),
    ).rejects.toMatchObject({ code: 'internal_error' });

    expect(deps.db.auth.admin.deleteUser).toHaveBeenCalledWith('new-user-id');
  });

  it('still returns success when the verification email fails to send (account already provisioned)', async () => {
    const admin = {
      generateLink: vi.fn(async () => ({ data: null, error: { message: 'link generation failed' } })),
    };
    const deps = makeDeps(
      {
        invitations: [chain({ data: INVITATION_ROW, error: null }), chain({ error: null })],
        organizations: [chain({ data: ORG_ROW, error: null })],
        profiles: [chain({ data: null, error: null }), chain({ error: null }), chain({ error: null })],
        org_members: [chain({ data: null, error: null }), chain({ error: null })],
        audit_events: [chain({ error: null })],
      },
      admin,
    );

    const result = await acceptInvitation(deps, { token: TOKEN, password: 'longenough', callerId: null });
    expect(result.verificationRequired).toBe(true);
    expect(result.verificationEmailSent).toBe(false);
  });
});

describe('InvitationError', () => {
  it('carries a stable machine-readable code alongside the message', () => {
    const err = new InvitationError('boom', 'not_found');
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('boom');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('acceptInvitation — unconfirmed-squatter reclaim', () => {
  const UNCONFIRMED_AFTER_INVITE = {
    data: {
      user: {
        email_confirmed_at: null,
        created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // after the invite
      },
    },
    error: null,
  };

  it('releases an unconfirmed account that squatted the invited address, and provisions the real recipient', async () => {
    const admin = {
      getUserById: vi.fn(async () => UNCONFIRMED_AFTER_INVITE),
      deleteUser: vi.fn(async () => ({ error: null })),
      createUser: vi.fn(async () => ({ data: { user: { id: 'real-recipient-id' } }, error: null })),
      generateLink: vi.fn(async () => ({
        data: { properties: { action_link: 'https://app.arkova.test/verify-link' } },
        error: null,
      })),
    };
    const deps = makeDeps(
      {
        invitations: [
          chain({ data: INVITATION_ROW, error: null }), // load
          chain({ error: null }), // status -> accepted
        ],
        organizations: [chain({ data: ORG_ROW, error: null })],
        profiles: [
          chain({ data: { id: 'squatter-id' }, error: null }), // squatter occupies the address
          chain({ error: null }), // real recipient profile insert
          chain({ error: null }), // org_id backfill
        ],
        org_members: [
          chain({ data: null, error: null }), // squatter holds no membership
          chain({ data: null, error: null }), // no existing membership
          chain({ error: null }), // insert
        ],
        audit_events: [chain({ error: null })],
      },
      admin,
    );

    const result = await acceptInvitation(deps, { token: TOKEN, password: 'longenough', callerId: null });

    expect(admin.deleteUser).toHaveBeenCalledWith('squatter-id');
    expect(admin.createUser).toHaveBeenCalled();
    expect(result.orgId).toBe('org-1');
    expect(result.verificationRequired).toBe(true);
  });

  it('does NOT reclaim a confirmed account — a real user keeps their address', async () => {
    const admin = {
      getUserById: vi.fn(async () => ({
        data: { user: { email_confirmed_at: '2026-02-01T00:00:00Z', created_at: new Date().toISOString() } },
        error: null,
      })),
      deleteUser: vi.fn(async () => ({ error: null })),
    };
    const deps = makeDeps(
      {
        invitations: [chain({ data: INVITATION_ROW, error: null })],
        organizations: [chain({ data: ORG_ROW, error: null })],
        profiles: [chain({ data: { id: 'real-user' }, error: null })],
      },
      admin,
    );

    await expect(
      acceptInvitation(deps, { token: TOKEN, password: 'longenough', callerId: null }),
    ).rejects.toMatchObject({ code: 'account_exists' });
    expect(admin.deleteUser).not.toHaveBeenCalled();
  });

  it('does NOT reclaim an unconfirmed account that already belongs to another org', async () => {
    // Two orgs can hold a pending invite for the same address (the unique
    // constraint is per-org), and multi-org membership is supported. Bob
    // accepts org B's invite -> unconfirmed account + org B membership, then
    // clicks org A's older invite from the same inbox. He is unconfirmed and
    // was created after invitation A, so the reclaim conditions look identical
    // to a squatter's — but deleting him silently drops his org B membership,
    // and invitation B is already 'accepted' so it cannot be replayed.
    const admin = {
      getUserById: vi.fn(async () => UNCONFIRMED_AFTER_INVITE),
      deleteUser: vi.fn(async () => ({ error: null })),
    };
    const deps = makeDeps(
      {
        invitations: [chain({ data: INVITATION_ROW, error: null })],
        organizations: [chain({ data: ORG_ROW, error: null })],
        profiles: [chain({ data: { id: 'bob-id' }, error: null })],
        org_members: [chain({ data: { id: 'org-b-membership' }, error: null })],
      },
      admin,
    );

    await expect(
      acceptInvitation(deps, { token: TOKEN, password: 'longenough', callerId: null }),
    ).rejects.toMatchObject({ code: 'account_exists' });
    expect(admin.deleteUser).not.toHaveBeenCalled();
  });

  it('does NOT reclaim an unconfirmed account that PREDATES the invitation', async () => {
    const admin = {
      getUserById: vi.fn(async () => ({
        data: {
          user: {
            email_confirmed_at: null,
            created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // before the invite
          },
        },
        error: null,
      })),
      deleteUser: vi.fn(async () => ({ error: null })),
    };
    const deps = makeDeps(
      {
        invitations: [chain({ data: INVITATION_ROW, error: null })],
        organizations: [chain({ data: ORG_ROW, error: null })],
        profiles: [chain({ data: { id: 'early-signup' }, error: null })],
      },
      admin,
    );

    await expect(
      acceptInvitation(deps, { token: TOKEN, password: 'longenough', callerId: null }),
    ).rejects.toMatchObject({ code: 'account_exists' });
    expect(admin.deleteUser).not.toHaveBeenCalled();
  });
});
