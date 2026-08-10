/**
 * Unit tests for createPendingRecipient (BETA-04)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----

const {
  mockLogger,
  mockSendEmail,
  mockBuildActivationEmail,
  mockDbFrom,
  mockCreateUser,
  mockDeleteUser,
  mockConfig,
} = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockSendEmail = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-1' });
  const mockBuildActivationEmail = vi.fn().mockReturnValue({
    subject: 'Test Subject',
    html: '<p>Test</p>',
  });
  const mockDbFrom = vi.fn();
  const mockCreateUser = vi.fn();
  const mockDeleteUser = vi.fn();
  const mockConfig = {
    frontendUrl: 'https://app.arkova.ai',
    resendApiKey: 'test-key',
    emailFrom: 'noreply@arkova.ai',
  };

  return {
    mockLogger,
    mockSendEmail,
    mockBuildActivationEmail,
    mockDbFrom,
    mockCreateUser,
    mockDeleteUser,
    mockConfig,
  };
});

// ---- Module mocks ----

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('../config.js', () => ({
  config: mockConfig,
}));

vi.mock('../utils/db.js', () => ({
  db: {
    from: mockDbFrom,
    auth: { admin: { createUser: mockCreateUser, deleteUser: mockDeleteUser } },
  },
}));

vi.mock('../email/index.js', () => ({
  sendEmail: mockSendEmail,
  buildActivationEmail: mockBuildActivationEmail,
}));

// ---- Import after mocks ----
import { createPendingRecipient } from './recipients.js';

// ---- Helpers ----

/** The id GoTrue assigns to the auth user created for a brand-new recipient. */
const NEW_AUTH_USER_ID = '11111111-2222-3333-4444-555555555555';

/**
 * A db chain that records every operation it performs into `log` (as
 * `<table>.<op>`) and captures insert/update payloads. Used by the FK-ordering
 * contract tests below, which assert on the ORDER of operations, not just the
 * final result.
 */
function recordingChain(
  table: string,
  result: { data?: unknown; error?: unknown },
  log: string[],
  captured: { inserts: Record<string, unknown>[]; updates: Record<string, unknown>[] },
) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of ['eq', 'is', 'maybeSingle', 'single']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.select = vi.fn(() => {
    log.push(`${table}.select`);
    return chain;
  });
  chain.insert = vi.fn((payload: Record<string, unknown>) => {
    log.push(`${table}.insert`);
    captured.inserts.push(payload);
    return chain;
  });
  chain.update = vi.fn((payload: Record<string, unknown>) => {
    log.push(`${table}.update`);
    captured.updates.push(payload);
    return chain;
  });
  Object.defineProperty(chain, 'then', {
    value: (resolve: (v: unknown) => void) => resolve(result),
    enumerable: false,
  });
  return chain;
}

function mockDbChain(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const methods = ['select', 'eq', 'is', 'maybeSingle', 'single', 'insert', 'update'];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  // Make the chain thenable so it can be awaited (SonarQube S7739: use defineProperty)
  Object.defineProperty(chain, 'then', {
    value: (resolve: (v: unknown) => void) => resolve(result),
    enumerable: false,
  });
  return chain;
}

describe('createPendingRecipient', () => {
  const baseRequest = {
    email: 'student@example.com',
    orgId: 'org-uuid-1',
    fullName: 'Jane Doe',
    credentialLabel: 'Bachelor of Science',
    actorId: 'admin-uuid-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-1' });
    mockCreateUser.mockResolvedValue({ data: { user: { id: NEW_AUTH_USER_ID } }, error: null });
    mockDeleteUser.mockResolvedValue({ error: null });
  });

  it('returns existing profile ID when recipient already exists', async () => {
    let callCount = 0;
    mockDbFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // profiles.select — existing profile found
        return mockDbChain({ data: { id: 'existing-uuid', status: 'ACTIVE' }, error: null });
      }
      return mockDbChain({ data: null, error: null });
    });

    const result = await createPendingRecipient(baseRequest);

    expect(result.profileId).toBe('existing-uuid');
    expect(result.isNew).toBe(false);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('creates new pending profile when recipient does not exist', async () => {
    let callCount = 0;
    mockDbFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // profiles.select — no existing
        return mockDbChain({ data: null, error: null });
      }
      if (callCount === 2) {
        // profiles.insert
        return mockDbChain({ error: null });
      }
      if (callCount === 3) {
        // audit_events.insert
        return mockDbChain({ error: null });
      }
      if (callCount === 4) {
        // organizations.select
        return mockDbChain({ data: { display_name: 'University of Michigan' }, error: null });
      }
      return mockDbChain({ data: null, error: null });
    });

    const result = await createPendingRecipient(baseRequest);

    expect(result.isNew).toBe(true);
    expect(result.profileId).toBeDefined();
    expect(result.activationEmailSent).toBe(true);
  });

  it('sends activation email with correct data', async () => {
    let callCount = 0;
    mockDbFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain({ data: null, error: null });
      if (callCount === 4) return mockDbChain({ data: { display_name: 'Acme Corp' }, error: null });
      return mockDbChain({ data: null, error: null });
    });

    await createPendingRecipient(baseRequest);

    expect(mockBuildActivationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientEmail: 'student@example.com',
        organizationName: 'Acme Corp',
        credentialLabel: 'Bachelor of Science',
      }),
    );
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'student@example.com',
        emailType: 'activation',
      }),
    );
  });

  it('normalizes email to lowercase', async () => {
    let callCount = 0;
    mockDbFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain({ data: null, error: null });
      return mockDbChain({ data: null, error: null });
    });

    const result = await createPendingRecipient({
      ...baseRequest,
      email: '  Student@Example.COM  ',
    });

    expect(result.isNew).toBe(true);
    // The email should be normalized
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'student@example.com',
      }),
    );
  });

  it('throws when profile insert fails', async () => {
    let callCount = 0;
    mockDbFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain({ data: null, error: null });
      if (callCount === 2) return mockDbChain({ error: { message: 'unique constraint' } });
      return mockDbChain({ data: null, error: null });
    });

    await expect(createPendingRecipient(baseRequest)).rejects.toThrow('Failed to create pending recipient');
  });

  it('still succeeds when activation email fails to send', async () => {
    let callCount = 0;
    mockDbFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain({ data: null, error: null });
      return mockDbChain({ data: null, error: null });
    });
    mockSendEmail.mockResolvedValue({ success: false, error: 'SMTP timeout' });

    const result = await createPendingRecipient(baseRequest);

    expect(result.isNew).toBe(true);
    expect(result.activationEmailSent).toBe(false);
  });

  it('uses default org name when org lookup fails', async () => {
    let callCount = 0;
    mockDbFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain({ data: null, error: null });
      if (callCount === 4) return mockDbChain({ data: null, error: { message: 'not found' } });
      return mockDbChain({ data: null, error: null });
    });

    await createPendingRecipient(baseRequest);

    expect(mockBuildActivationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationName: 'Your organization',
      }),
    );
  });

  /**
   * FK ORDERING CONTRACT — `profiles.id` is FOREIGN KEY -> `auth.users(id)`
   * ON DELETE CASCADE (constraint `profiles_id_fkey`, convalidated in prod).
   *
   * Inserting a `profiles` row keyed by a freshly minted `crypto.randomUUID()`
   * therefore ALWAYS violates that FK, because no `auth.users` row exists for
   * it — the endpoint 500s for every genuinely new recipient. Prod bears this
   * out: zero `PENDING_ACTIVATION` profiles and zero activation tokens have
   * ever existed, and `auth.users` count == `profiles` count.
   *
   * These tests pin the ORDER of operations (auth user created BEFORE the
   * profile insert, profile keyed by that user's id) and the rollback
   * semantics, mirroring `invitations.ts`. The rest of this file mocks `db`
   * wholesale, which is exactly why CI never caught the FK violation — an
   * ordering assertion is the part of the constraint that CAN be pinned
   * without a live database.
   */
  describe('auth-user provisioning (FK profiles.id -> auth.users.id)', () => {
    function wireDb(
      opts: {
        existingProfile?: { id: string; status: string } | null;
        profileInsertResult?: { error?: unknown };
        orgName?: string;
      } = {},
    ) {
      const log: string[] = [];
      const captured = {
        inserts: [] as Record<string, unknown>[],
        updates: [] as Record<string, unknown>[],
      };
      let profilesCall = 0;

      mockDbFrom.mockImplementation((table: string) => {
        if (table === 'profiles') {
          profilesCall++;
          if (profilesCall === 1) {
            return recordingChain(
              'profiles',
              { data: opts.existingProfile ?? null, error: null },
              log,
              captured,
            );
          }
          if (profilesCall === 2) {
            return recordingChain('profiles', opts.profileInsertResult ?? { error: null }, log, captured);
          }
          return recordingChain('profiles', { error: null }, log, captured);
        }
        if (table === 'organizations') {
          return recordingChain(
            'organizations',
            { data: { display_name: opts.orgName ?? 'Acme Corp' }, error: null },
            log,
            captured,
          );
        }
        return recordingChain(table, { data: null, error: null }, log, captured);
      });

      // Record the auth-user creation into the same ordered log.
      mockCreateUser.mockImplementation(() => {
        log.push('auth.createUser');
        return Promise.resolve({ data: { user: { id: NEW_AUTH_USER_ID } }, error: null });
      });

      return { log, captured };
    }

    it('creates the auth user BEFORE inserting the profile row', async () => {
      const { log } = wireDb();

      await createPendingRecipient(baseRequest);

      const createIdx = log.indexOf('auth.createUser');
      const insertIdx = log.indexOf('profiles.insert');

      expect(createIdx).toBeGreaterThanOrEqual(0);
      expect(insertIdx).toBeGreaterThanOrEqual(0);
      expect(createIdx).toBeLessThan(insertIdx);
    });

    it('keys the profile row with the auth user id, never a standalone random UUID', async () => {
      const { captured } = wireDb();

      const result = await createPendingRecipient(baseRequest);

      const profileInsert = captured.inserts.find((p) => 'activation_token' in p);
      expect(profileInsert).toBeDefined();
      expect(profileInsert?.id).toBe(NEW_AUTH_USER_ID);
      expect(result.profileId).toBe(NEW_AUTH_USER_ID);
    });

    it('creates the auth user with the recipient email and does not pre-confirm it', async () => {
      wireDb();

      await createPendingRecipient({ ...baseRequest, email: '  Student@Example.COM  ' });

      expect(mockCreateUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'student@example.com', email_confirm: false }),
      );
    });

    it('rolls back the auth user when the profile insert fails', async () => {
      wireDb({ profileInsertResult: { error: { code: '23503', message: 'fk violation' } } });

      await expect(createPendingRecipient(baseRequest)).rejects.toThrow(
        'Failed to create pending recipient',
      );

      expect(mockDeleteUser).toHaveBeenCalledWith(NEW_AUTH_USER_ID);
    });

    it('never inserts a profile — and never rolls back — when auth user creation fails', async () => {
      const { log } = wireDb();
      mockCreateUser.mockResolvedValue({ data: null, error: { message: 'email exists' } });

      await expect(createPendingRecipient(baseRequest)).rejects.toThrow(
        'Failed to create pending recipient',
      );

      expect(log).not.toContain('profiles.insert');
      expect(mockDeleteUser).not.toHaveBeenCalled();
    });

    it('applies the activation fields by update when a trigger already created the profile row', async () => {
      // 23505 = unique_violation: the `create_profile_for_new_user` trigger on
      // auth.users may already have inserted a bare profile row. That row has
      // NO org, NO PENDING_ACTIVATION status and NO activation token, so
      // swallowing the 23505 as success would leave a recipient who can never
      // be activated. The fields must be applied by update instead.
      const { captured } = wireDb({
        profileInsertResult: { error: { code: '23505', message: 'duplicate key' } },
      });

      const result = await createPendingRecipient(baseRequest);

      expect(mockDeleteUser).not.toHaveBeenCalled();
      expect(captured.updates).toHaveLength(1);
      expect(captured.updates[0]).toEqual(
        expect.objectContaining({
          org_id: baseRequest.orgId,
          status: 'PENDING_ACTIVATION',
          activation_token: expect.any(String),
        }),
      );
      expect(result.profileId).toBe(NEW_AUTH_USER_ID);
      expect(result.isNew).toBe(true);
    });

    it('does not create an auth user when the recipient already exists', async () => {
      wireDb({ existingProfile: { id: 'existing-uuid', status: 'ACTIVE' } });

      const result = await createPendingRecipient(baseRequest);

      expect(result).toEqual({ profileId: 'existing-uuid', isNew: false });
      expect(mockCreateUser).not.toHaveBeenCalled();
    });
  });
});
