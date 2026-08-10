/**
 * Unit tests for the recipient account-activation API.
 *
 * Covers the launch blocker: a recipient issued a credential could not claim
 * it and could not log in, because
 *   (a) the frontend called a non-existent `activate_user(p_token, p_claim_key)`
 *       overload (PGRST202), and
 *   (b) the deployed `activate_user(p_token, p_password)` IGNORED p_password,
 *       so no password was ever set on the `auth.users` row.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  ActivationError,
  getActivationPreview,
  completeActivation,
  type ActivationDeps,
} from './activation.js';

// ---- Fixtures ----

const VALID_TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = 'b'.repeat(64);
const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function pendingProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: PROFILE_ID,
    email: 'recipient@example.com',
    full_name: 'Rec Ipient',
    org_id: ORG_ID,
    status: 'PENDING_ACTIVATION',
    activation_token: VALID_TOKEN,
    activation_token_expires_at: FUTURE,
    ...overrides,
  };
}

// ---- Supabase client double ----

interface HarnessOptions {
  profile?: Record<string, unknown> | null;
  profileError?: unknown;
  /** Rows returned by the compare-and-swap UPDATE. [] means the race was lost. */
  casRows?: unknown[];
  casError?: unknown;
  updateUserError?: unknown;
}

function makeDeps(options: HarnessOptions = {}) {
  const {
    profile = pendingProfile(),
    profileError = null,
    casRows = [{ id: PROFILE_ID }],
    casError = null,
    updateUserError = null,
  } = options;

  const updates: Record<string, unknown>[] = [];
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const updateUserById = vi.fn().mockResolvedValue(
    updateUserError ? { data: null, error: updateUserError } : { data: { user: { id: PROFILE_ID } }, error: null },
  );

  // Each `.update()` call gets its own terminal result: the first is the CAS
  // claim, any later one is the best-effort rollback.
  let updateCount = 0;

  function chain(terminal: { data?: unknown; error?: unknown }) {
    const node: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'limit', 'maybeSingle', 'single']) {
      node[m] = vi.fn().mockReturnValue(node);
    }
    Object.defineProperty(node, 'then', {
      value: (resolve: (v: unknown) => void) => resolve(terminal),
      enumerable: false,
    });
    return node;
  }

  const from = vi.fn((table: string) => {
    if (table === 'organizations') {
      return {
        ...chain({ data: { display_name: 'Example University' }, error: null }),
      };
    }
    if (table === 'audit_events') {
      return {
        insert: vi.fn((row: Record<string, unknown>) => {
          inserts.push({ table, row });
          return chain({ data: null, error: null });
        }),
      };
    }
    // profiles
    return {
      ...chain({ data: profile, error: profileError }),
      update: vi.fn((row: Record<string, unknown>) => {
        updates.push(row);
        updateCount += 1;
        // First update = the CAS claim. Subsequent = rollback (always "ok").
        return updateCount === 1
          ? chain({ data: casError ? null : casRows, error: casError })
          : chain({ data: [{ id: PROFILE_ID }], error: null });
      }),
    };
  });

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const deps = {
    db: { from, auth: { admin: { updateUserById } } },
    logger,
  } as unknown as ActivationDeps;

  return { deps, logger, from, updates, inserts, updateUserById };
}

/** Every string a logger/error ever saw, flattened for token-leak assertions. */
function allLoggedText(logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }) {
  return [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]
    .map((call) => JSON.stringify(call))
    .join('|');
}

const GOOD_PASSWORD = 'correct horse battery';

describe('completeActivation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a token that does not exist, without setting any password', async () => {
    const { deps, updateUserById } = makeDeps({ profile: null });

    await expect(
      completeActivation(deps, { token: OTHER_TOKEN, password: GOOD_PASSWORD }),
    ).rejects.toMatchObject({ code: 'not_found' });

    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('rejects a malformed token before it ever reaches the database', async () => {
    const { deps, from, updateUserById } = makeDeps();

    await expect(
      completeActivation(deps, { token: 'not-a-hex-token', password: GOOD_PASSWORD }),
    ).rejects.toMatchObject({ code: 'not_found' });

    expect(from).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('rejects an expired token and does not set a password', async () => {
    const { deps, updateUserById, updates } = makeDeps({
      profile: pendingProfile({ activation_token_expires_at: PAST }),
    });

    await expect(
      completeActivation(deps, { token: VALID_TOKEN, password: GOOD_PASSWORD }),
    ).rejects.toMatchObject({ code: 'expired' });

    expect(updateUserById).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('treats a token whose claim was already won by a concurrent request as used', async () => {
    // CAS returns zero rows => somebody else consumed this single-use token.
    const { deps, updateUserById } = makeDeps({ casRows: [] });

    await expect(
      completeActivation(deps, { token: VALID_TOKEN, password: GOOD_PASSWORD }),
    ).rejects.toMatchObject({ code: 'already_used' });

    // The critical single-use property: a replay must NOT reset the password.
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('rejects a password shorter than 8 characters', async () => {
    const { deps, updateUserById } = makeDeps();

    await expect(
      completeActivation(deps, { token: VALID_TOKEN, password: 'short' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('sets a real password on the auth user and confirms the email so the recipient can sign in', async () => {
    const { deps, updateUserById, updates } = makeDeps();

    const result = await completeActivation(deps, {
      token: VALID_TOKEN,
      password: GOOD_PASSWORD,
    });

    // Defect B: the password must actually reach GoTrue.
    expect(updateUserById).toHaveBeenCalledWith(
      PROFILE_ID,
      expect.objectContaining({ password: GOOD_PASSWORD }),
    );

    // createPendingRecipient mints the auth user with `email_confirm: false`,
    // and prod runs `mailer_autoconfirm=false` — without confirming here the
    // recipient still cannot sign in, i.e. the blocker would not be fixed.
    expect(updateUserById).toHaveBeenCalledWith(
      PROFILE_ID,
      expect.objectContaining({ email_confirm: true }),
    );

    // The token is consumed and the profile activated.
    expect(updates[0]).toMatchObject({
      status: 'ACTIVE',
      activation_token: null,
      activation_token_expires_at: null,
    });

    expect(result).toMatchObject({ email: 'recipient@example.com', orgId: ORG_ID });
  });

  it('claims the token BEFORE setting the password, and rolls the claim back if the password write fails', async () => {
    const { deps, updates } = makeDeps({ updateUserError: { message: 'gotrue exploded' } });

    await expect(
      completeActivation(deps, { token: VALID_TOKEN, password: GOOD_PASSWORD }),
    ).rejects.toMatchObject({ code: 'internal_error' });

    // updates[0] = CAS claim, updates[1] = rollback restoring the pending state
    // so the recipient's link keeps working instead of stranding them ACTIVE
    // with no password.
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      status: 'PENDING_ACTIVATION',
      activation_token: VALID_TOKEN,
    });
  });

  it('never writes the activation token into logs', async () => {
    const { deps, logger } = makeDeps();

    await completeActivation(deps, { token: VALID_TOKEN, password: GOOD_PASSWORD });

    expect(allLoggedText(logger)).not.toContain(VALID_TOKEN);
  });

  it('never leaks the activation token or the password in a thrown error', async () => {
    const { deps, logger } = makeDeps({ updateUserError: { message: 'gotrue exploded' } });

    const err = await completeActivation(deps, {
      token: VALID_TOKEN,
      password: GOOD_PASSWORD,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ActivationError);
    expect((err as Error).message).not.toContain(VALID_TOKEN);
    expect((err as Error).message).not.toContain(GOOD_PASSWORD);
    expect(allLoggedText(logger)).not.toContain(GOOD_PASSWORD);
  });

  it('records a USER_ACTIVATED audit event without the token', async () => {
    const { deps, inserts } = makeDeps();

    await completeActivation(deps, { token: VALID_TOKEN, password: GOOD_PASSWORD });

    const audit = inserts.find((i) => i.table === 'audit_events');
    expect(audit?.row).toMatchObject({ event_type: 'USER_ACTIVATED' });
    expect(JSON.stringify(audit?.row)).not.toContain(VALID_TOKEN);
  });
});

describe('getActivationPreview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the invited email and organization for a valid token', async () => {
    const { deps } = makeDeps();

    await expect(getActivationPreview(deps, VALID_TOKEN)).resolves.toMatchObject({
      email: 'recipient@example.com',
      orgName: 'Example University',
      expired: false,
    });
  });

  it('reports an expired token as expired rather than valid', async () => {
    const { deps } = makeDeps({
      profile: pendingProfile({ activation_token_expires_at: PAST }),
    });

    await expect(getActivationPreview(deps, VALID_TOKEN)).resolves.toMatchObject({
      expired: true,
    });
  });

  it('rejects an unknown token', async () => {
    const { deps } = makeDeps({ profile: null });

    await expect(getActivationPreview(deps, OTHER_TOKEN)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rejects a malformed token without querying the database', async () => {
    const { deps, from } = makeDeps();

    await expect(getActivationPreview(deps, 'nope')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(from).not.toHaveBeenCalled();
  });
});
