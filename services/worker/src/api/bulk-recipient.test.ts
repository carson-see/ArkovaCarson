import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  profileLookups: [] as Array<{ data: { id: string; status?: string; activation_token?: string | null } | null; error: unknown }>,
  profileInsertError: null as null | { code?: string; message?: string },
  profileUpdateError: null as null | { message?: string },
  createUserResult: { data: { user: { id: 'new-profile' } }, error: null } as { data: unknown; error: unknown },
  createUser: vi.fn(),
  authUser: { app_metadata: {}, email_confirmed_at: null } as Record<string, unknown>,
  pepper: 'test-pepper-0123456789' as string | undefined,
  provisioningEnabled: true,
  deleteUser: vi.fn(async () => ({ error: null })),
  profileInserts: [] as Array<Record<string, unknown>>,
  profileUpdates: [] as Array<Record<string, unknown>>,
  recipientInserts: [] as Array<Record<string, unknown>>,
  anchorFilters: [] as Array<[string, unknown]>,
  activationClaimError: null as null | { code?: string },
  activationClaims: [] as Array<Record<string, unknown>>,
  activationUpdates: [] as Array<Record<string, unknown>>,
  activationPriorStatus: 'sent' as 'sending' | 'sent' | 'failed',
  sendEmail: vi.fn(),
  recoveryResult: { data: null, error: { message: 'not configured' } } as { data: unknown; error: unknown },
}));

vi.mock('../config.js', () => ({ get config() { return { recipientIdentifierPepper: state.pepper, enableBulkRecipientProvisioning: state.provisioningEnabled }; } }));
vi.mock('../utils/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('../lib/urls.js', () => ({ buildActivateUrl: (token: string) => `https://example.test/activate/${token}` }));
vi.mock('../email/index.js', () => ({
  buildActivationEmail: () => ({ subject: 'Activate', html: '<p>Activate</p>' }),
  sendEmail: state.sendEmail,
}));
vi.mock('../utils/db.js', () => ({
  db: {
    rpc: vi.fn(async () => state.recoveryResult),
    auth: { admin: {
      createUser: state.createUser,
      deleteUser: state.deleteUser,
      getUserById: vi.fn(async () => ({ data: { user: state.authUser }, error: null })),
    } },
    from: vi.fn((table: string) => {
      if (table === 'profiles') return {
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => state.profileLookups.shift() ?? { data: null, error: null }) })) })),
        insert: vi.fn(async (value: Record<string, unknown>) => {
          state.profileInserts.push(value);
          return { error: state.profileInsertError };
        }),
        update: vi.fn((value: Record<string, unknown>) => {
          state.profileUpdates.push(value);
          const terminal = Promise.resolve({ data: [{ id: 'new-profile' }], error: state.profileUpdateError });
          const chain = {
            eq: vi.fn(() => chain), is: vi.fn(() => chain), select: vi.fn(() => terminal),
            then: terminal.then.bind(terminal),
          };
          return chain;
        }),
      };
      if (table === 'anchors') {
        const terminal = Promise.resolve({ data: { id: 'anchor-1' }, error: null });
        const chain = {
          eq: vi.fn((field: string, value: unknown) => { state.anchorFilters.push([field, value]); return chain; }),
          is: vi.fn((field: string, value: unknown) => { state.anchorFilters.push([field, value]); return chain; }),
          maybeSingle: vi.fn(async () => terminal),
        };
        return { select: vi.fn(() => chain) };
      }
      if (table === 'anchor_recipients') return {
        insert: vi.fn(async (value: Record<string, unknown>) => {
          state.recipientInserts.push(value);
          return { error: null };
        }),
      };
      if (table === 'recipient_activation_deliveries') return {
        insert: vi.fn(async (value: Record<string, unknown>) => {
          state.activationClaims.push(value);
          return { error: state.activationClaimError };
        }),
        update: vi.fn((value: Record<string, unknown>) => {
          state.activationUpdates.push(value);
          const terminal = Promise.resolve({ error: null });
          const chain = { eq: vi.fn(() => chain), then: terminal.then.bind(terminal) };
          return chain;
        }),
        select: vi.fn(() => {
          const terminal = Promise.resolve({ data: { status: state.activationPriorStatus }, error: null });
          const chain = { eq: vi.fn(() => chain), maybeSingle: vi.fn(async () => terminal) };
          return chain;
        }),
      };
      if (table === 'organizations') return {
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: { display_name: 'Example Org' }, error: null })) })) })),
      };
      throw new Error(`unexpected table ${table}`);
    }),
  },
}));

import { linkBulkRecipient, resolveBulkRecipientProfile } from './bulk-recipient.js';

describe('bulk recipient profile/link semantics', () => {
  beforeEach(() => {
    state.profileLookups = [];
    state.profileInsertError = null;
    state.profileUpdateError = null;
    state.createUserResult = { data: { user: { id: 'new-profile' } }, error: null };
    state.createUser.mockImplementation(async () => state.createUserResult);
    state.createUser.mockClear();
    state.authUser = { app_metadata: {}, email_confirmed_at: null };
    state.pepper = 'test-pepper-0123456789';
    state.provisioningEnabled = true;
    state.deleteUser.mockClear();
    state.profileInserts = [];
    state.profileUpdates = [];
    state.recipientInserts = [];
    state.anchorFilters = [];
    state.activationClaimError = null;
    state.activationClaims = [];
    state.activationUpdates = [];
    state.activationPriorStatus = 'sent';
    state.sendEmail.mockReset();
    state.sendEmail.mockResolvedValue({ success: true });
    state.recoveryResult = { data: null, error: { message: 'not configured' } };
  });

  it('links an existing normalized-email profile without changing membership or identity fields', async () => {
    state.profileLookups.push({ data: { id: 'existing-profile' }, error: null });
    await linkBulkRecipient({
      anchorPublicId: 'ARK-1', actorUserId: 'actor-1', orgId: 'org-1',
      email: ' Recipient@Example.COM ', fullName: 'Recipient',
    });
    expect(state.profileInserts).toEqual([]);
    expect(state.profileUpdates).toEqual([]);
    expect(state.recipientInserts[0]).toMatchObject({
      anchor_id: 'anchor-1', recipient_user_id: 'existing-profile', claimed_at: null,
    });
    expect(state.recipientInserts[0].recipient_email_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(state.anchorFilters).toEqual(expect.arrayContaining([
      ['public_id', 'ARK-1'], ['user_id', 'actor-1'], ['org_id', 'org-1'], ['deleted_at', null],
    ]));
  });

  it('creates an unconfirmed pending profile with no org or role, never a membership', async () => {
    state.profileLookups.push({ data: null, error: null });
    const result = await resolveBulkRecipientProfile('new@example.com', 'New Recipient');
    expect(result).toMatchObject({ profileId: 'new-profile', created: true });
    expect(result.activationToken).toMatch(/^[a-f0-9]{64}$/);
    expect(state.profileInserts[0]).toMatchObject({
      id: 'new-profile', email: 'new@example.com', full_name: 'New Recipient',
      org_id: null, role: null, status: 'PENDING_ACTIVATION',
    });
    expect(state.profileInserts[0].activation_token).toMatch(/^[a-f0-9]{64}$/);
    expect(state.createUser).toHaveBeenCalledWith(expect.objectContaining({
      email_confirm: false,
      app_metadata: { arkova_bulk_recipient: true, admin_provisioned: true },
    }));
    expect(state.deleteUser).not.toHaveBeenCalled();
  });

  it('recovers a concurrent email winner without deleting or rewriting that identity', async () => {
    state.profileLookups.push(
      { data: null, error: null },
      { data: { id: 'race-winner' }, error: null },
    );
    state.createUserResult = { data: { user: null }, error: { message: 'already registered' } };
    const result = await resolveBulkRecipientProfile('race@example.com');
    expect(result).toEqual({ profileId: 'race-winner', created: false });
    expect(state.profileInserts).toEqual([]);
    expect(state.profileUpdates).toEqual([]);
    expect(state.deleteUser).not.toHaveBeenCalled();
  });

  it('recovers a marker-owned auth user when the committed create response lost its profile', async () => {
    state.profileLookups.push({ data: null, error: null }, { data: null, error: null },
      { data: null, error: null }, { data: null, error: null });
    state.createUserResult = { data: { user: null }, error: { message: 'already registered' } };
    state.recoveryResult = {
      data: [{ profile_id: 'recovered-profile', activation_token: 'e'.repeat(64) }], error: null,
    };
    await expect(resolveBulkRecipientProfile('lost@example.com', 'Lost')).resolves.toEqual({
      profileId: 'recovered-profile', created: false, activationToken: 'e'.repeat(64),
    });
    expect(state.deleteUser).not.toHaveBeenCalled();
  });

  it('recovers by exact created user id after a non-unique profile write failure', async () => {
    state.profileLookups.push({ data: null, error: null });
    state.profileInsertError = { code: 'XX000', message: 'ambiguous commit failure' };
    state.recoveryResult = {
      data: [{ profile_id: 'new-profile', activation_token: 'f'.repeat(64) }], error: null,
    };
    await expect(resolveBulkRecipientProfile('repair@example.com')).resolves.toEqual({
      profileId: 'new-profile', created: false, activationToken: 'f'.repeat(64),
    });
    const { db } = await import('../utils/db.js');
    expect(db.rpc).toHaveBeenCalledWith('recover_bulk_recipient_profile', expect.objectContaining({
      p_email: 'repair@example.com', p_expected_user_id: 'new-profile',
    }));
  });

  it('repairs a marker-owned unconfirmed ACTIVE trigger profile instead of treating it as activated', async () => {
    state.profileLookups.push({ data: { id: 'partial', status: 'ACTIVE', activation_token: null }, error: null });
    state.authUser = {
      app_metadata: { arkova_bulk_recipient: true, admin_provisioned: true }, email_confirmed_at: null,
    };
    state.recoveryResult = {
      data: [{ profile_id: 'partial', activation_token: '9'.repeat(64) }], error: null,
    };
    const result = await resolveBulkRecipientProfile('partial@example.com', 'Partial');
    expect(result).toMatchObject({ profileId: 'partial', created: false });
    expect(result.activationToken).toMatch(/^[a-f0-9]{64}$/);
    const { db } = await import('../utils/db.js');
    expect(db.rpc).toHaveBeenCalledWith('recover_bulk_recipient_profile', expect.objectContaining({
      p_expected_user_id: 'partial',
    }));
    expect(state.profileUpdates).toHaveLength(0);
  });

  it('keeps provisioning disabled even when the recipient pepper is configured', async () => {
    state.provisioningEnabled = false;
    await expect(linkBulkRecipient({
      anchorPublicId: 'ARK-1', actorUserId: 'actor-1', orgId: 'org-1',
      email: 'recipient@example.com', deliverActivationEmail: true,
    })).rejects.toThrow('recipient_provisioning_disabled');
    expect(state.createUser).not.toHaveBeenCalled();
    expect(state.profileInserts).toEqual([]);
    expect(state.recipientInserts).toEqual([]);
    expect(state.sendEmail).not.toHaveBeenCalled();
    expect(state.anchorFilters).toEqual([]);
  });

  it('fails before auth provisioning when the recipient pepper is unavailable', async () => {
    state.pepper = undefined;
    await expect(linkBulkRecipient({
      anchorPublicId: 'ARK-1', actorUserId: 'actor-1', orgId: 'org-1', email: 'recipient@example.com',
    })).rejects.toThrow('RECIPIENT_IDENTIFIER_PEPPER is unset');
    expect(state.createUser).not.toHaveBeenCalled();
    expect(state.profileInserts).toEqual([]);
  });

  it('uses a durable claim and a token-digest provider key so replay sends no second email', async () => {
    const { deliverBulkActivationOnce } = await import('./bulk-recipient.js');
    const token = 'a'.repeat(64);
    await deliverBulkActivationOnce({
      profileId: 'profile-1', activationToken: token, email: 'recipient@example.com',
      actorUserId: 'actor-1', orgId: 'org-1',
    });
    expect(state.sendEmail).toHaveBeenCalledTimes(1);
    const options = state.sendEmail.mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(options.idempotencyKey).not.toContain(token);
    expect(options.idempotencyKey).toMatch(/^bulk-activation\/profile-1\/[a-f0-9]{64}$/);
    expect(state.activationUpdates[0]).toMatchObject({ status: 'sent', failure_code: null });

    state.activationClaimError = { code: '23505' };
    await deliverBulkActivationOnce({
      profileId: 'profile-1', activationToken: token, email: 'recipient@example.com',
      actorUserId: 'actor-1', orgId: 'org-1',
    });
    expect(state.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('surfaces an in-flight duplicate claim without re-sending', async () => {
    const { deliverBulkActivationOnce } = await import('./bulk-recipient.js');
    state.activationClaimError = { code: '23505' };
    state.activationPriorStatus = 'sending';
    await expect(deliverBulkActivationOnce({
      profileId: 'profile-1', activationToken: 'b'.repeat(64), email: 'recipient@example.com',
      actorUserId: 'actor-1', orgId: null,
    })).rejects.toThrow('recipient_activation_delivery_pending');
    expect(state.sendEmail).not.toHaveBeenCalled();
  });

  it('leaves an ambiguous provider throw claimed as sending so replay cannot duplicate it', async () => {
    const { deliverBulkActivationOnce } = await import('./bulk-recipient.js');
    state.sendEmail.mockRejectedValueOnce(new Error('ambiguous provider timeout'));
    await expect(deliverBulkActivationOnce({
      profileId: 'profile-1', activationToken: 'c'.repeat(64), email: 'recipient@example.com',
      actorUserId: 'actor-1', orgId: null,
    })).rejects.toThrow('ambiguous provider timeout');
    expect(state.activationClaims).toHaveLength(1);
    expect(state.activationUpdates).toEqual([]);
  });

  it('records a provider rejection as failed and surfaces failed replay without re-sending', async () => {
    const { deliverBulkActivationOnce } = await import('./bulk-recipient.js');
    const input = {
      profileId: 'profile-1', activationToken: 'd'.repeat(64), email: 'recipient@example.com',
      actorUserId: 'actor-1', orgId: null,
    };
    state.sendEmail.mockResolvedValueOnce({ success: false });
    await expect(deliverBulkActivationOnce(input)).rejects.toThrow('recipient_activation_email_failed');
    expect(state.activationUpdates[0]).toMatchObject({
      status: 'failed', failure_code: 'provider_rejected',
    });

    state.activationClaimError = { code: '23505' };
    state.activationPriorStatus = 'failed';
    await expect(deliverBulkActivationOnce(input)).rejects.toThrow('recipient_activation_email_failed');
    expect(state.sendEmail).toHaveBeenCalledTimes(1);
  });
});
