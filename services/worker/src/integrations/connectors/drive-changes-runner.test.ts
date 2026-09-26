/**
 * SCRUM-1661 [Verify] code-path tests for the Drive changes-feed runner.
 *
 * Pins the behaviors the runner is responsible for:
 *   1. Returns access_token from cache when stored tokens are still fresh.
 *   2. Refreshes + re-encrypts + persists when stored tokens are expired.
 *   3. loadWatchedFolderIds unions legacy folder_id + drive_folders[].
 *   4. createProcessorDbAdapter maps unique-violation to conflict=true.
 *   5. runDriveChanges orchestrator: skip on no_page_token, skip on
 *      no_watched_folders, happy-path handoff to processDriveChanges with
 *      resolved access token + watched folder ids.
 *
 * Drive HTTP, KMS, DB, and the processor are all dependency-injected /
 * mocked — no real network or Postgres traffic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// SCRUM-2903/3661 follow-up (single-flight lease): runDriveChanges now
// imports `jobs/run-lease.ts`, which reads the Zod-validated `config` export
// at MODULE LOAD time — this suite never sets the Supabase/Stripe env vars
// that full validation requires. Mirrors the same mock
// `drive-subscription-renewal-deps.test.ts` already uses for the identical
// reason; only `kRevision` (read by `runLeaseHolder()`) matters here.
vi.mock('../../config.js', () => ({ config: { kRevision: 'test-revision' } }));
// Fix-round item 2 (gap visibility): createProcessorDbAdapter's
// recordCursorGap now imports utils/auditEvent.js, which imports
// utils/db.js -> config.ts's real Zod boot validation. Mock it the same way
// jobQueue.js is mocked below — this suite injects its own `deps.db` and
// never wants the real Supabase client instantiated.
const recordAuditEventMock = vi.fn();
vi.mock('../../utils/auditEvent.js', () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEventMock(...args),
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock processDriveChanges so the happy-path runDriveChanges test can
// assert the handoff arguments without exercising the real Drive
// changes.list HTTP fetch or revision-ledger writes. The other suites
// don't touch this import.
const processDriveChangesMock = vi.fn();
vi.mock('./drive-changes-processor.js', async () => {
  const actual = await vi.importActual<typeof import('./drive-changes-processor.js')>(
    './drive-changes-processor.js',
  );
  return {
    ...actual,
    processDriveChanges: (...args: unknown[]) => processDriveChangesMock(...args),
  };
});
// SCRUM-2903 (GD-PROD): enqueueFileChangedJob calls the real submitJob (like
// docusign.ts's enqueueFetchJob does) rather than the injected `db` — submitJob
// owns the global db import from utils/db.js. Mock it the same way
// docusign.test.ts does so the adapter tests never touch a real Supabase client.
const submitJobMock = vi.fn();
vi.mock('../../utils/jobQueue.js', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
}));
import {
  loadDriveAccessToken,
  loadWatchedFolderIds,
  createProcessorDbAdapter,
  createFolderPathCache,
  runDriveChanges,
  runDriveReconciliationSweep,
  driveChangesRunLeaseSpec,
  type DriveIntegrationRow,
} from './drive-changes-runner.js';
import { createRunLeaseStore } from '../../jobs/__tests__/__testHelpers.js';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1';

const FRESH_TOKENS = {
  access_token: 'access-fresh',
  refresh_token: 'refresh-token',
  expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
};

const EXPIRED_TOKENS = {
  access_token: 'access-stale',
  refresh_token: 'refresh-token',
  expires_at: new Date(Date.now() - 60_000).toISOString(),
};

function fakeKms() {
  return {
    encrypt: vi.fn(async ({ plaintext }: { keyName: string; plaintext: Buffer }) =>
      Buffer.from(`ct:${plaintext.toString('utf8')}`, 'utf8'),
    ),
    decrypt: vi.fn(async ({ ciphertext }: { keyName: string; ciphertext: Buffer }) => {
      const text = ciphertext.toString('utf8');
      // Strip the `ct:` prefix our fakeEncrypt added; otherwise return the
      // raw text (used when test pre-seeds plaintext directly).
      const stripped = text.startsWith('ct:') ? text.slice(3) : text;
      return Buffer.from(stripped, 'utf8');
    }),
  };
}

function makeFakeDb() {
  // CodeRabbit ASSERTIVE on PR #696: previously the fake recorded only the
  // first `.eq()` filter, so a refactor that drops the `encrypted_tokens`
  // CAS predicate from loadDriveAccessToken would still pass these tests
  // (re-opening the double-refresh race the predicate prevents). Capture
  // the FULL chain in `eqs` and re-record on every chain advance so a
  // single update emits one row per terminal observation.
  const updates: Array<{ table: string; patch: Record<string, unknown>; eqs: Array<[string, unknown]> }> = [];
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const deletes: Array<{ table: string; eqs: Array<[string, unknown]> }> = [];
  let conflictKey: { file_id: string; revision_id: string } | null = null;
  let deleteErrorNext: { code?: string; message?: string } | null = null;

  return {
    updates,
    inserts,
    deletes,
    setConflictOnNext(key: { file_id: string; revision_id: string }) {
      conflictKey = key;
    },
    setDeleteErrorOnNext(err: { code?: string; message?: string }) {
      deleteErrorNext = err;
    },
    db: {
      from: (table: string) => ({
        update: (patch: Record<string, unknown>) => {
          // Two callers exercise this path:
          //   (a) advancePageToken: .update(patch).eq('id', X) → awaited as Promise
          //   (b) loadDriveAccessToken CAS: .update(patch).eq('id', X).eq('encrypted_tokens', $prev).select('id').maybeSingle()
          // The fake builds a thenable that captures EVERY `.eq()` filter so
          // tests can assert the CAS predicate is present.
          const eqs: Array<[string, unknown]> = [];
          let recordedIndex = -1;
          const recordOrUpdate = () => {
            if (recordedIndex === -1) {
              recordedIndex = updates.length;
              updates.push({ table, patch, eqs: [...eqs] });
            } else {
              updates[recordedIndex] = { table, patch, eqs: [...eqs] };
            }
          };
          const makeThenable = (): Promise<{ error: null }> & { eq: (col: string, val: unknown) => unknown; is: (col: string, val: unknown) => unknown; select: (cols: string) => unknown } => {
            const p = Promise.resolve({ error: null }) as Promise<{ error: null }> & { eq?: unknown; is?: unknown; select?: unknown };
            (p as { eq: (col: string, val: unknown) => unknown }).eq = (col: string, val: unknown) => {
              eqs.push([col, val]);
              recordOrUpdate();
              return makeThenable();
            };
            // `.is()` is the Postgrest-idiomatic null-equality filter (used
            // for the account_label CAS guard below, since `.eq('col',
            // null)` doesn't translate the way `.eq('col', 'string')`
            // does) — recorded into the SAME `eqs` array as `.eq()` so
            // existing assertions against `eqColumns` still see it.
            (p as { is: (col: string, val: unknown) => unknown }).is = (col: string, val: unknown) => {
              eqs.push([col, val]);
              recordOrUpdate();
              return makeThenable();
            };
            (p as { select: (cols: string) => unknown }).select = (_cols: string) => ({
              maybeSingle: () => Promise.resolve({ data: { id: 'updated' }, error: null }),
            });
            return p as Promise<{ error: null }> & { eq: (col: string, val: unknown) => unknown; is: (col: string, val: unknown) => unknown; select: (cols: string) => unknown };
          };
          return makeThenable();
        },
        insert: (row: Record<string, unknown>) => {
          if (
            conflictKey &&
            row.file_id === conflictKey.file_id &&
            row.revision_id === conflictKey.revision_id
          ) {
            return Promise.resolve({ error: { code: '23505' } });
          }
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
        delete: () => {
          const eqs: Array<[string, unknown]> = [];
          const chain = {
            eq: (col: string, val: unknown) => {
              eqs.push([col, val]);
              if (eqs.length === 3) {
                deletes.push({ table, eqs: [...eqs] });
                if (deleteErrorNext) {
                  const err = deleteErrorNext;
                  deleteErrorNext = null;
                  return Promise.resolve({ error: err });
                }
                return Promise.resolve({ error: null });
              }
              return chain;
            },
          };
          return chain;
        },
        select: (cols: string) => {
          // SCRUM-5287 follow-up: loadDriveAccessToken now reads
          // `account_label` (single `.eq().maybeSingle()`, client-identity
          // resolution) BEFORE a refresh. Distinct shape from the 3x `.eq()`
          // array-returning chain `loadWatchedFolderIds` uses — dispatch on
          // `cols` since both go through this same fake `select`.
          if (cols === 'account_label') {
            return {
              eq: (_c: string, _v: unknown) => ({
                maybeSingle: () => Promise.resolve({ data: { account_label: null }, error: null }),
              }),
            };
          }
          return {
            eq: (_c: string, _v: unknown) => ({
              eq: (_c2: string, _v2: unknown) => ({
                eq: (_c3: string, _v3: unknown) => Promise.resolve({ data: [], error: null }),
              }),
            }),
          };
        },
      }),
      rpc: vi.fn(async (_name: string, _args: unknown) => ({ data: 'evt-1', error: null })),
    },
  };
}

// CodeRabbit ASSERTIVE on PR #696: prevent cross-test env pollution by
// snapshotting then restoring each mutated process.env entry.
let prevKmsKey: string | undefined;
let prevClientId: string | undefined;
let prevClientSecret: string | undefined;

beforeEach(() => {
  prevKmsKey = process.env.GCP_KMS_INTEGRATION_TOKEN_KEY;
  prevClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  prevClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  process.env.GCP_KMS_INTEGRATION_TOKEN_KEY = KEY;
  submitJobMock.mockReset();
  submitJobMock.mockResolvedValue('job-default');
  recordAuditEventMock.mockReset();
  recordAuditEventMock.mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (prevKmsKey === undefined) delete process.env.GCP_KMS_INTEGRATION_TOKEN_KEY;
  else process.env.GCP_KMS_INTEGRATION_TOKEN_KEY = prevKmsKey;
  if (prevClientId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  else process.env.GOOGLE_OAUTH_CLIENT_ID = prevClientId;
  if (prevClientSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  else process.env.GOOGLE_OAUTH_CLIENT_SECRET = prevClientSecret;
});

describe('loadDriveAccessToken', () => {
  it('returns cached access token when stored tokens are still fresh', async () => {
    const kms = fakeKms();
    const fakeFetch = vi.fn();
    const fake = makeFakeDb();
    const integration: DriveIntegrationRow = {
      id: INT,
      org_id: ORG,
      encrypted_tokens: Buffer.from(`ct:${JSON.stringify(FRESH_TOKENS)}`, 'utf8'),
      token_kms_key_id: KEY,
      last_page_token: 'pt-1',
    };
    const result = await loadDriveAccessToken(integration, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fake.db as any,
      kms,
      drive: { fetchImpl: fakeFetch as unknown as typeof fetch },
    });
    expect(result).toEqual({ accessToken: 'access-fresh', refreshed: false });
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(fake.updates).toHaveLength(0);
  });

  it('refreshes via Drive OAuth + re-encrypts + persists when stored tokens are expired', async () => {
    const kms = fakeKms();
    const fakeFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'access-new',
        refresh_token: 'refresh-rotated',
        expires_in: 3599,
        token_type: 'Bearer',
        scope: 'https://www.googleapis.com/auth/drive.file',
      }),
    });
    const fake = makeFakeDb();
    const integration: DriveIntegrationRow = {
      id: INT,
      org_id: ORG,
      encrypted_tokens: Buffer.from(`ct:${JSON.stringify(EXPIRED_TOKENS)}`, 'utf8'),
      token_kms_key_id: KEY,
      last_page_token: 'pt-1',
    };
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret';
    const result = await loadDriveAccessToken(integration, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fake.db as any,
      kms,
      drive: { fetchImpl: fakeFetch as unknown as typeof fetch },
    });
    expect(result.accessToken).toBe('access-new');
    expect(result.refreshed).toBe(true);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0].table).toBe('org_integrations');
    expect(fake.updates[0].patch).toMatchObject({
      token_kms_key_id: KEY,
    });
    // Encrypted tokens are written as `\x...` hex bytea string
    expect(typeof fake.updates[0].patch.encrypted_tokens).toBe('string');
    expect((fake.updates[0].patch.encrypted_tokens as string).startsWith('\\x')).toBe(true);
    // CodeRabbit ASSERTIVE on PR #696: assert the FULL CAS predicate chain.
    // The refresh path MUST condition on (id == integration.id) AND
    // (encrypted_tokens == previous ciphertext) so a concurrent refresher
    // cannot clobber rotated refresh_tokens. Pin both filters here so a
    // refactor that drops the encrypted_tokens predicate fails this test
    // instead of silently re-opening the double-refresh race.
    const eqColumns = fake.updates[0].eqs.map(([col]) => col);
    expect(eqColumns).toContain('id');
    expect(eqColumns).toContain('encrypted_tokens');
    const idFilter = fake.updates[0].eqs.find(([col]) => col === 'id');
    const encTokFilter = fake.updates[0].eqs.find(([col]) => col === 'encrypted_tokens');
    expect(idFilter?.[1]).toBe(INT);
    // The CAS guard value is the pre-refresh ciphertext rendered as `\x...` hex.
    expect(typeof encTokFilter?.[1]).toBe('string');
    expect((encTokFilter?.[1] as string).startsWith('\\x')).toBe(true);
  });

  it('throws no_encrypted_tokens when integration has never completed OAuth', async () => {
    const kms = fakeKms();
    const fake = makeFakeDb();
    const integration: DriveIntegrationRow = {
      id: INT,
      org_id: ORG,
      encrypted_tokens: null,
      token_kms_key_id: null,
      last_page_token: 'pt-1',
    };
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      loadDriveAccessToken(integration, { db: fake.db as any, kms }),
    ).rejects.toThrow(/no encrypted OAuth tokens/);
  });
});

// SCRUM-5287 follow-up (2026-09-22 fix-round, CRITICAL finding): client
// identity is resolved AUTHORITATIVELY from `account_label.oauth_client_id`
// when present, with the scope-string heuristic (isDriveLegacyGrant) only as
// a fallback for rows connected before that field existed. Plus the
// defense-in-depth retry + self-heal + oauth_client_mismatch surfacing.
describe('loadDriveAccessToken — OAuth client identity resolution (SCRUM-5287 follow-up)', () => {
  // Per-test-customizable fake: `accountLabel` seeds the SELECT response,
  // `refreshResponses` is consumed in order by successive fetch calls
  // (supports the retry-once scenario — two responses).
  function makeIdentityFakeDb(args: {
    accountLabel: Record<string, unknown> | null;
    updates: Array<Record<string, unknown>>;
  }) {
    const { accountLabel, updates } = args;
    return {
      from: (_table: string) => ({
        update: (patch: Record<string, unknown>) => {
          const chain = {
            eq: (_c: string, _v: unknown) => chain,
            is: (_c: string, _v: unknown) => chain,
            select: (_c: string) => ({
              maybeSingle: () => {
                updates.push(patch);
                return Promise.resolve({ data: { id: 'updated' }, error: null });
              },
            }),
            // A plain `.update(patch).eq(...)` awaited directly (the
            // oauth_client_mismatch last_renewal_error write has no
            // `.select().maybeSingle()` tail).
            then: (resolve: (v: { error: null }) => void) => {
              updates.push(patch);
              resolve({ error: null });
            },
          };
          return chain;
        },
        select: (cols: string) => ({
          eq: (_c: string, _v: unknown) => ({
            maybeSingle: () => {
              if (cols === 'account_label') {
                return Promise.resolve({
                  data: { account_label: accountLabel ? JSON.stringify(accountLabel) : null },
                  error: null,
                });
              }
              return Promise.resolve({ data: null, error: null });
            },
          }),
        }),
      }),
      rpc: vi.fn(),
    };
  }

  function fetchImplSequence(responses: Array<{ ok: boolean; json: () => Promise<unknown> }>) {
    let call = 0;
    return vi.fn(async (_url: string, _init?: RequestInit) => {
      const res = responses[Math.min(call, responses.length - 1)];
      call++;
      return res;
    });
  }

  const integrationBase = (): DriveIntegrationRow => ({
    id: INT,
    org_id: ORG,
    encrypted_tokens: Buffer.from(`ct:${JSON.stringify({ ...EXPIRED_TOKENS, scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email' })}`, 'utf8'),
    token_kms_key_id: KEY,
    last_page_token: 'pt-1',
  });

  it('a stored oauth_client_id matching the NEW pair resolves "current" authoritatively — regardless of scope', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'legacy-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'legacy-secret';
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID = 'new-id';
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET = 'new-secret';
    try {
      const updates: Array<Record<string, unknown>> = [];
      const db = makeIdentityFakeDb({ accountLabel: { email: null, channel_token: null, resource_id: null, oauth_client_id: 'new-id' }, updates });
      const fakeFetch = fetchImplSequence([{
        ok: true,
        json: async () => ({ access_token: 'at-new', expires_in: 3599, token_type: 'Bearer' }),
      }]);
      const result = await loadDriveAccessToken(integrationBase(), {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
        kms: fakeKms(),
        drive: { fetchImpl: fakeFetch as unknown as typeof fetch },
      });
      expect(result.accessToken).toBe('at-new');
      const sentBody = new URLSearchParams((fakeFetch.mock.calls[0]?.[1] as RequestInit)?.body as string);
      expect(sentBody.get('client_id')).toBe('new-id');
      // Already authoritative — no self-heal write needed (account_label
      // omitted from the patch, or unchanged if present).
      const patch = updates[0] as { account_label?: string };
      if (patch.account_label) {
        expect(JSON.parse(patch.account_label).oauth_client_id).toBe('new-id');
      }
    } finally {
      delete process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID;
      delete process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET;
    }
  });

  it('a stored oauth_client_id matching the LEGACY pair resolves "legacy" authoritatively — even though the scope LOOKS current (the R-hybrid trap)', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'legacy-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'legacy-secret';
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID = 'new-id';
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET = 'new-secret';
    try {
      const updates: Array<Record<string, unknown>> = [];
      // R-hybrid: scope is the CURRENT set (drive.readonly), but the token
      // was actually issued by the OLD client before the new pair existed.
      const db = makeIdentityFakeDb({ accountLabel: { email: null, channel_token: null, resource_id: null, oauth_client_id: 'legacy-id' }, updates });
      const fakeFetch = fetchImplSequence([{
        ok: true,
        json: async () => ({ access_token: 'at-legacy', expires_in: 3599, token_type: 'Bearer' }),
      }]);
      const result = await loadDriveAccessToken(integrationBase(), {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
        kms: fakeKms(),
        drive: { fetchImpl: fakeFetch as unknown as typeof fetch },
      });
      expect(result.accessToken).toBe('at-legacy');
      const sentBody = new URLSearchParams((fakeFetch.mock.calls[0]?.[1] as RequestInit)?.body as string);
      // Without the stored id, the scope heuristic would have picked
      // 'current' -> 'new-id' here, and Google would reject it. The stored
      // id makes this deterministic instead.
      expect(sentBody.get('client_id')).toBe('legacy-id');
    } finally {
      delete process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID;
      delete process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET;
    }
  });

  it('no stored oauth_client_id (pre-cutover row) falls back to the scope heuristic and self-heals on success', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'legacy-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'legacy-secret';
    const updates: Array<Record<string, unknown>> = [];
    const db = makeIdentityFakeDb({ accountLabel: null, updates });
    const fakeFetch = fetchImplSequence([{
      ok: true,
      json: async () => ({ access_token: 'at-fallback', expires_in: 3599, token_type: 'Bearer' }),
    }]);
    const result = await loadDriveAccessToken(integrationBase(), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      kms: fakeKms(),
      drive: { fetchImpl: fakeFetch as unknown as typeof fetch },
    });
    expect(result.accessToken).toBe('at-fallback');
    // Self-heal: the successful client is now known and persisted.
    const patch = updates[0] as { account_label: string };
    expect(JSON.parse(patch.account_label).oauth_client_id).toBe('legacy-id');
  });

  it('retries ONCE with "legacy" when a "current" refresh fails with an OAuth client-mismatch code, and self-heals', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'legacy-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'legacy-secret';
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID = 'new-id';
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET = 'new-secret';
    try {
      const updates: Array<Record<string, unknown>> = [];
      // No stored id -> heuristic picks 'current' (scope looks current) ->
      // resolves to the NEW pair -> Google rejects (token was really
      // issued by the old client) -> retry with 'legacy' succeeds.
      const db = makeIdentityFakeDb({ accountLabel: null, updates });
      const fakeFetch = fetchImplSequence([
        { ok: false, json: async () => ({ error: 'invalid_grant', error_description: 'Bad Request' }) },
        { ok: true, json: async () => ({ access_token: 'at-retried', expires_in: 3599, token_type: 'Bearer' }) },
      ]);
      const result = await loadDriveAccessToken(integrationBase(), {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
        kms: fakeKms(),
        drive: { fetchImpl: fakeFetch as unknown as typeof fetch },
      });
      expect(result.accessToken).toBe('at-retried');
      expect(fakeFetch).toHaveBeenCalledTimes(2);
      const firstBody = new URLSearchParams((fakeFetch.mock.calls[0]?.[1] as RequestInit)?.body as string);
      const secondBody = new URLSearchParams((fakeFetch.mock.calls[1]?.[1] as RequestInit)?.body as string);
      expect(firstBody.get('client_id')).toBe('new-id');
      expect(secondBody.get('client_id')).toBe('legacy-id');
      // Self-heal: the row now durably knows it belongs to the legacy client.
      const patch = updates[0] as { account_label: string };
      expect(JSON.parse(patch.account_label).oauth_client_id).toBe('legacy-id');
    } finally {
      delete process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID;
      delete process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET;
    }
  });

  it('does NOT retry when a non-mismatch error occurs (e.g. a 5xx) — rethrows immediately', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'legacy-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'legacy-secret';
    const updates: Array<Record<string, unknown>> = [];
    const db = makeIdentityFakeDb({ accountLabel: null, updates });
    const fakeFetch = fetchImplSequence([
      { ok: false, json: async () => ({ error: 'server_error' }) },
    ]);
    await expect(
      loadDriveAccessToken(integrationBase(), {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
        kms: fakeKms(),
        drive: { fetchImpl: fakeFetch as unknown as typeof fetch },
      }),
    ).rejects.toMatchObject({ name: 'DriveApiError' });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry when the starting generation is already "legacy" — nothing to retry toward', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'legacy-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'legacy-secret';
    const updates: Array<Record<string, unknown>> = [];
    // Stored id matches the legacy pair -> authoritative 'legacy' start.
    const db = makeIdentityFakeDb({ accountLabel: { email: null, channel_token: null, resource_id: null, oauth_client_id: 'legacy-id' }, updates });
    const fakeFetch = fetchImplSequence([
      { ok: false, json: async () => ({ error: 'invalid_grant' }) },
    ]);
    await expect(
      loadDriveAccessToken(integrationBase(), {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
        kms: fakeKms(),
        drive: { fetchImpl: fakeFetch as unknown as typeof fetch },
      }),
    ).rejects.toMatchObject({ name: 'DriveApiError' });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('when BOTH generations fail with a mismatch code, throws DriveRunnerError("oauth_client_mismatch") and persists a distinct last_renewal_error', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'legacy-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'legacy-secret';
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID = 'new-id';
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET = 'new-secret';
    try {
      const updates: Array<Record<string, unknown>> = [];
      const db = makeIdentityFakeDb({ accountLabel: null, updates });
      const fakeFetch = fetchImplSequence([
        { ok: false, json: async () => ({ error: 'invalid_grant' }) },
        { ok: false, json: async () => ({ error: 'unauthorized_client' }) },
      ]);
      await expect(
        loadDriveAccessToken(integrationBase(), {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          db: db as any,
          kms: fakeKms(),
          drive: { fetchImpl: fakeFetch as unknown as typeof fetch },
        }),
      ).rejects.toMatchObject({ name: 'DriveRunnerError', code: 'oauth_client_mismatch' });
      expect(fakeFetch).toHaveBeenCalledTimes(2);
      const mismatchWrite = updates.find((u) => typeof u.last_renewal_error === 'string');
      expect(mismatchWrite).toBeDefined();
      expect(mismatchWrite?.last_renewal_error as string).toContain('Drive OAuth client mismatch');
    } finally {
      delete process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID;
      delete process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET;
    }
  });

  it('a stored oauth_client_id matching NEITHER configured pair falls back to the scope heuristic (rotation edge case)', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'legacy-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'legacy-secret';
    const updates: Array<Record<string, unknown>> = [];
    const db = makeIdentityFakeDb({ accountLabel: { email: null, channel_token: null, resource_id: null, oauth_client_id: 'some-rotated-away-id' }, updates });
    const fakeFetch = fetchImplSequence([
      { ok: true, json: async () => ({ access_token: 'at-rotated-fallback', expires_in: 3599, token_type: 'Bearer' }) },
    ]);
    const result = await loadDriveAccessToken(integrationBase(), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      kms: fakeKms(),
      drive: { fetchImpl: fakeFetch as unknown as typeof fetch },
    });
    expect(result.accessToken).toBe('at-rotated-fallback');
    const sentBody = new URLSearchParams((fakeFetch.mock.calls[0]?.[1] as RequestInit)?.body as string);
    expect(sentBody.get('client_id')).toBe('legacy-id');
  });
});

// Independently-reviewed P1 + P2 on PR #3069 (feat/drive-readonly-scope),
// reproduced against head 13e44db0d before the fix landed:
//   P1 — `loadDriveAccessToken`'s `account_label` SELECT discarded its
//        `error`, so a transient read failure was indistinguishable from a
//        legitimately unlabeled (pre-cutover) row. If the subsequent token
//        refresh then succeeded, the self-heal write overwrote the row's
//        `email` / `channel_token` / `resource_id` with null — even though
//        the read merely failed, not the row being absent. The webhook
//        receiver (`api/v1/webhooks/drive.ts`) rejects a null
//        `channel_token` with 401 `integration_missing_channel_token`, so a
//        transient SELECT error became a PERMANENT notification failure.
//   P2 — the CAS write that persists the refreshed tokens also serializes
//        the self-healed `account_label`, but was conditioned only on
//        `encrypted_tokens` — a concurrent watch-renewal write (which
//        independently rewrites the WHOLE `account_label` blob) landing
//        between this function's account_label SELECT and its UPDATE could
//        have its fresh channel credential clobbered by this call's stale
//        copy.
describe('loadDriveAccessToken — account_label read-error handling (P1) and label CAS race (P2)', () => {
  function makeAccountLabelFakeDb(args: {
    labelSelectResult: { data: { account_label: string | null } | null; error: { message?: string } | null };
    updates: Array<{ patch: Record<string, unknown>; predicates: Array<[string, unknown]> }>;
    updateResult?: { data: { id: string } | null; error: { message?: string } | null };
  }) {
    const { labelSelectResult, updates, updateResult = { data: { id: 'updated' }, error: null } } = args;
    return {
      from: (_table: string) => ({
        update: (patch: Record<string, unknown>) => {
          const predicates: Array<[string, unknown]> = [];
          const chain = {
            eq: (c: string, v: unknown) => {
              predicates.push([c, v]);
              return chain;
            },
            is: (c: string, v: unknown) => {
              predicates.push([c, v]);
              return chain;
            },
            select: (_c: string) => ({
              maybeSingle: () => {
                updates.push({ patch, predicates: [...predicates] });
                return Promise.resolve(updateResult);
              },
            }),
          };
          return chain;
        },
        select: (cols: string) => ({
          eq: (_c: string, _v: unknown) => ({
            maybeSingle: () => {
              if (cols === 'account_label') {
                return Promise.resolve(labelSelectResult);
              }
              return Promise.resolve({ data: null, error: null });
            },
          }),
        }),
      }),
      rpc: vi.fn(),
    };
  }

  const integrationBase = (): DriveIntegrationRow => ({
    id: INT,
    org_id: ORG,
    encrypted_tokens: Buffer.from(`ct:${JSON.stringify(EXPIRED_TOKENS)}`, 'utf8'),
    token_kms_key_id: KEY,
    last_page_token: 'pt-1',
  });

  it('P1: a failed account_label SELECT aborts BEFORE refresh/write — reproduced against PR #3069 head 13e44db0d', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret';
    const updates: Array<{ patch: Record<string, unknown>; predicates: Array<[string, unknown]> }> = [];
    const db = makeAccountLabelFakeDb({
      labelSelectResult: { data: null, error: { message: 'read timeout' } },
      updates,
    });
    const fakeFetch = vi.fn();
    await expect(
      loadDriveAccessToken(integrationBase(), {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
        kms: fakeKms(),
        drive: { fetchImpl: fakeFetch as unknown as typeof fetch },
      }),
    ).rejects.toMatchObject({ name: 'DriveRunnerError', code: 'account_label_read_failed' });
    // The bug: a failed read used to fall through and behave exactly like
    // "no label" — refreshing, then self-healing with a null-filled label.
    // The fix must abort before either happens: no Google refresh call, no
    // DB write at all.
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('P2: the self-heal write guards account_label on the value actually read, so a concurrent renewal write causes a CAS miss instead of being silently clobbered', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret';
    const existingLabel = { email: 'org@example.com', channel_token: 'tok-precious', resource_id: 'res-1', oauth_client_id: null };
    const rawLabel = JSON.stringify(existingLabel);
    const winnerTokens = {
      access_token: 'access-winner',
      refresh_token: 'refresh-winner',
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
    const winnerCiphertext = `\\x${Buffer.from(`ct:${JSON.stringify(winnerTokens)}`, 'utf8').toString('hex')}`;
    const updates: Array<{ patch: Record<string, unknown>; predicates: Array<[string, unknown]> }> = [];
    let casReadCalls = 0;
    // Self-contained fake (mirrors the CAS-lost regression test's shape
    // below): the account_label SELECT returns the existing label; the
    // UPDATE always reports a CAS miss (`data: null`) — simulating a
    // concurrent watch-renewal write that already changed `account_label`
    // since this call's SELECT, so the guard predicate this UPDATE adds no
    // longer matches any row; the post-miss re-read returns the "winner"'s
    // ciphertext.
    const db = {
      from: (_table: string) => ({
        update: (patch: Record<string, unknown>) => {
          const predicates: Array<[string, unknown]> = [];
          const chain = {
            eq: (c: string, v: unknown) => {
              predicates.push([c, v]);
              return chain;
            },
            is: (c: string, v: unknown) => {
              predicates.push([c, v]);
              return chain;
            },
            select: (_c: string) => ({
              maybeSingle: () => {
                updates.push({ patch, predicates: [...predicates] });
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
          return chain;
        },
        select: (cols: string) => ({
          eq: (_c: string, _v: unknown) => ({
            maybeSingle: () => {
              if (cols === 'account_label') {
                return Promise.resolve({ data: { account_label: rawLabel }, error: null });
              }
              casReadCalls++;
              return Promise.resolve({
                data: { encrypted_tokens: winnerCiphertext, token_kms_key_id: KEY },
                error: null,
              });
            },
          }),
        }),
      }),
      rpc: vi.fn(),
    };
    const fakeFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'at-loser', expires_in: 3599, token_type: 'Bearer' }),
    });
    const result = await loadDriveAccessToken(integrationBase(), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      kms: fakeKms(),
      drive: { fetchImpl: fakeFetch as unknown as typeof fetch },
    });
    // CAS lost -> trust the winner; no throw, no second refresh burned
    // against Google, and — the actual regression — no silent overwrite of
    // the label the winner (or a renewal) just wrote.
    expect(result.accessToken).toBe('access-winner');
    expect(result.refreshed).toBe(true);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(casReadCalls).toBe(1);
    expect(updates).toHaveLength(1);
    // The write DID preserve the label fields it read (self-heal is
    // additive, not destructive) ...
    const patch = updates[0].patch as { account_label: string };
    expect(JSON.parse(patch.account_label)).toMatchObject({
      email: 'org@example.com',
      channel_token: 'tok-precious',
      resource_id: 'res-1',
    });
    // ... but the fix REQUIRES the write to also condition on account_label
    // being byte-identical to what was read, at the exact value read —
    // that predicate is what turned the concurrent write into a safe CAS
    // miss instead of a silent overwrite.
    const predicateColumns = updates[0].predicates.map(([c]) => c);
    expect(predicateColumns).toContain('account_label');
    const labelPredicate = updates[0].predicates.find(([c]) => c === 'account_label');
    expect(labelPredicate?.[1]).toBe(rawLabel);
  });
});

describe('loadWatchedFolderIds', () => {
  it('unions legacy folder_id + drive_folders[] across all enabled WORKSPACE_FILE_MODIFIED rules', async () => {
    const fakeData = [
      { trigger_config: { folder_id: 'folder-A' } },
      { trigger_config: { drive_folders: [{ folder_id: 'folder-B' }, { folder_id: 'folder-C' }] } },
      { trigger_config: { folder_id: 'folder-A' /* duplicate */ } },
      { trigger_config: { /* no folder binding */ filename_contains: 'invoice' } },
    ];
    const db = {
      from: (_table: string) => ({
        select: (_c: string) => ({
          eq: (_c1: string, _v1: unknown) => ({
            eq: (_c2: string, _v2: unknown) => ({
              eq: (_c3: string, _v3: unknown) => Promise.resolve({ data: fakeData, error: null }),
            }),
          }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rpc: () => Promise.resolve({ data: null, error: null }) as any,
    };
    const ids = await loadWatchedFolderIds(ORG, { db });
    expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual(['folder-A', 'folder-B', 'folder-C']);
  });

  it('throws (not returns []) on rule-lookup error so transient DB failures do not silently skip processing', async () => {
    // Regression for CodeRabbit ASSERTIVE on PR #696: the previous behavior
    // collapsed `error: { message: 'boom' }` into `[]`, which the runDriveChanges
    // caller then read as "no watched folders" and skipped — pending Drive
    // changes stranded until the next webhook. Now we propagate; the webhook
    // handler in drive.ts wraps in try/catch + 200-ack + Sentry log.
    const db = {
      from: (_t: string) => ({
        select: (_c: string) => ({
          eq: (_c1: string, _v1: unknown) => ({
            eq: (_c2: string, _v2: unknown) => ({
              eq: (_c3: string, _v3: unknown) =>
                Promise.resolve({ data: null, error: { message: 'boom' } }),
            }),
          }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rpc: () => Promise.resolve({ data: null, error: null }) as any,
    };
    const errorLog = vi.fn();
    await expect(
      loadWatchedFolderIds(ORG, {
        db,
        logger: { info: () => undefined, warn: () => undefined, error: errorLog },
      }),
    ).rejects.toThrow(/organization_rules query failed.*boom/);
    expect(errorLog).toHaveBeenCalled();
  });
});

describe('loadDriveAccessToken — CAS-lost regression', () => {
  // Regression for CodeRabbit ASSERTIVE on PR #696 review at 17:32:01Z:
  // the CAS-lost fallback path (lines 188-218 of drive-changes-runner.ts)
  // was not exercised. This pins the "another concurrent refresh wrote
  // first, we re-read and trust the winner" behavior so a future refactor
  // cannot collapse it into an error path.
  it('returns the winners access token when the CAS write loses to a concurrent refresher', async () => {
    const kms = fakeKms();
    // The "winner" wrote `access-winner` ciphertext; we simulate that by
    // having the post-CAS read return its KMS-encrypted bytes.
    const winnerTokens = {
      access_token: 'access-winner',
      refresh_token: 'refresh-winner',
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
    const winnerCiphertext = `\\x${Buffer.from(`ct:${JSON.stringify(winnerTokens)}`, 'utf8').toString('hex')}`;

    const fakeFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'access-loser',
        refresh_token: 'refresh-loser',
        expires_in: 3599,
        token_type: 'Bearer',
        scope: 'https://www.googleapis.com/auth/drive.file',
      }),
    });

    let casUpdateCalls = 0;
    let casReadCalls = 0;
    const db = {
      from: (_table: string) => ({
        update: (_patch: Record<string, unknown>) => {
          // CAS path: .update(patch).eq('id', X).eq('encrypted_tokens', $prev).select('id').maybeSingle()
          // Return data:null, error:null to simulate "row matched the .eq('id') filter
          // but not the .eq('encrypted_tokens') filter — another writer mutated it first".
          const chain = {
            eq: (_c: string, _v: unknown) => chain,
            is: (_c: string, _v: unknown) => chain,
            select: (_c: string) => ({
              maybeSingle: () => {
                casUpdateCalls++;
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
          return chain;
        },
        select: (cols: string) => ({
          eq: (_c: string, _v: unknown) => ({
            maybeSingle: () => {
              // SCRUM-5287 follow-up: loadDriveAccessToken now ALSO reads
              // `account_label` (client-identity resolution) BEFORE
              // attempting a refresh — distinct from the CAS-lost re-read
              // this test pins, which selects encrypted_tokens/token_kms_key_id
              // AFTER a lost CAS write. Only the latter counts as a
              // "CAS read" for this test's assertion.
              if (cols === 'account_label') {
                return Promise.resolve({ data: { account_label: null }, error: null });
              }
              casReadCalls++;
              return Promise.resolve({
                data: { encrypted_tokens: winnerCiphertext, token_kms_key_id: KEY },
                error: null,
              });
            },
          }),
        }),
      }),
      rpc: vi.fn(),
    };

    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret';
    const integration: DriveIntegrationRow = {
      id: INT,
      org_id: ORG,
      encrypted_tokens: Buffer.from(`ct:${JSON.stringify(EXPIRED_TOKENS)}`, 'utf8'),
      token_kms_key_id: KEY,
      last_page_token: 'pt-1',
    };
    const result = await loadDriveAccessToken(integration, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      kms,
      drive: { fetchImpl: fakeFetch as unknown as typeof fetch },
    });
    // Winner's token returned, NOT loser's "access-loser" — and no second
    // refresh burnt against Google.
    expect(result.accessToken).toBe('access-winner');
    expect(result.refreshed).toBe(true);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(casUpdateCalls).toBe(1);
    expect(casReadCalls).toBe(1);
  });
});

describe('createProcessorDbAdapter', () => {
  it('maps unique-violation 23505 from drive_revision_ledger insert to conflict=true', async () => {
    const fake = makeFakeDb();
    fake.setConflictOnNext({ file_id: 'f1', revision_id: 'r1' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createProcessorDbAdapter({ db: fake.db as any });
    const result = await adapter.insertRevisionLedger({
      integration_id: INT,
      org_id: ORG,
      file_id: 'f1',
      revision_id: 'r1',
      parent_ids: ['folder-A'],
      modified_time: null,
      actor_email: null,
      outcome: 'queued',
      rule_event_id: null,
    });
    expect(result).toEqual({ inserted: false, conflict: true });
  });

  it('inserts cleanly on first call', async () => {
    const fake = makeFakeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createProcessorDbAdapter({ db: fake.db as any });
    const result = await adapter.insertRevisionLedger({
      integration_id: INT,
      org_id: ORG,
      file_id: 'f2',
      revision_id: 'r2',
      parent_ids: ['folder-A'],
      modified_time: null,
      actor_email: 'alice@example.com',
      outcome: 'queued',
      rule_event_id: null,
    });
    expect(result).toEqual({ inserted: true, conflict: false });
    expect(fake.inserts).toHaveLength(1);
  });

  it('advancePageToken updates org_integrations.last_page_token + last_token_advanced_at, CAS-scoped to expected_page_token', async () => {
    const fake = makeFakeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createProcessorDbAdapter({ db: fake.db as any });
    const result = await adapter.advancePageToken({ integration_id: INT, new_page_token: 'pt-2', expected_page_token: 'pt-1' });
    expect(result).toEqual({ advanced: true });
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0].patch).toMatchObject({ last_page_token: 'pt-2' });
    expect(typeof fake.updates[0].patch.last_token_advanced_at).toBe('string');
    // Fix-round item 4A: the CAS predicate — both the target row AND the
    // expected pre-write value must be present as filters.
    expect(fake.updates[0].eqs).toContainEqual(['id', INT]);
    expect(fake.updates[0].eqs).toContainEqual(['last_page_token', 'pt-1']);
  });

  it('advancePageToken reports advanced:false (CAS miss) without throwing when last_page_token no longer matches expected_page_token', async () => {
    // Standalone double simulating PostgREST's zero-row CAS-miss response
    // (a `WHERE last_page_token = expected` that matches nothing returns
    // `data: null, error: null`, not an error) — deliberately not the
    // generic top-of-file fake, which always resolves a successful match.
    const casMissDb = {
      from: (_table: string) => {
        const chain: Record<string, unknown> = {};
        chain.update = () => chain;
        chain.eq = () => chain;
        chain.select = () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) });
        return chain;
      },
      rpc: vi.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createProcessorDbAdapter({ db: casMissDb as any });
    const result = await adapter.advancePageToken({ integration_id: INT, new_page_token: 'pt-2', expected_page_token: 'stale-expectation' });
    expect(result).toEqual({ advanced: false });
  });

  it('enqueueRuleEvent calls the enqueue_rule_event RPC with WORKSPACE_FILE_MODIFIED + google_drive vendor', async () => {
    const fake = makeFakeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createProcessorDbAdapter({ db: fake.db as any });
    const id = await adapter.enqueueRuleEvent({
      org_id: ORG,
      file_id: 'f3',
      parent_ids: ['folder-A'],
      actor_email: 'mercy@example.com',
      revision_id: 'r3',
      integration_id: INT,
      filename: 'msa.pdf',
      folder_path: null,
    });
    expect(id).toBe('evt-1');
    expect(fake.db.rpc).toHaveBeenCalledWith(
      'enqueue_rule_event',
      expect.objectContaining({
        p_org_id: ORG,
        p_trigger_type: 'WORKSPACE_FILE_MODIFIED',
        p_vendor: 'google_drive',
        p_external_file_id: 'f3',
        p_filename: 'msa.pdf',
      }),
    );
  });

  // SCRUM-1837 (GH #1837): folder_path was hardcoded p_folder_path: null in
  // the RPC call. Pin that the adapter now threads the processor's resolved
  // value through untouched.
  it('enqueueRuleEvent threads a resolved folder_path through to p_folder_path', async () => {
    const fake = makeFakeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createProcessorDbAdapter({ db: fake.db as any });
    await adapter.enqueueRuleEvent({
      org_id: ORG,
      file_id: 'f3',
      parent_ids: ['folder-A'],
      actor_email: 'mercy@example.com',
      revision_id: 'r3',
      integration_id: INT,
      filename: 'msa.pdf',
      folder_path: '/HR/2026-Q2/msa.pdf',
    });
    expect(fake.db.rpc).toHaveBeenCalledWith(
      'enqueue_rule_event',
      expect.objectContaining({ p_folder_path: '/HR/2026-Q2/msa.pdf' }),
    );
  });

  // A caller that omits folder_path entirely (undefined, not null — e.g. an
  // older test double) must still normalize to `null`, never `''`. An empty
  // string would make every folder_path_starts_with rule match.
  it('enqueueRuleEvent normalizes a missing folder_path to null, never empty string', async () => {
    const fake = makeFakeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createProcessorDbAdapter({ db: fake.db as any });
    await adapter.enqueueRuleEvent({
      org_id: ORG,
      file_id: 'f3',
      parent_ids: ['folder-A'],
      actor_email: null,
      revision_id: 'r3',
      integration_id: INT,
      filename: 'msa.pdf',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(fake.db.rpc).toHaveBeenCalledWith(
      'enqueue_rule_event',
      expect.objectContaining({ p_folder_path: null }),
    );
  });

  // CodeRabbit ASSERTIVE on PR #696: deleteRevisionLedgerEntry must throw on
  // DB error so the processor's compensating-rollback contract holds. A
  // silent-log fallback would leak the (integration, file, revision) ledger
  // row past the failure window, and the next changes.list pass would skip
  // the change as "already processed" via UNIQUE conflict — losing the
  // revision permanently.
  it('deleteRevisionLedgerEntry throws DriveRunnerError when the compensating delete fails', async () => {
    const fake = makeFakeDb();
    fake.setDeleteErrorOnNext({ code: 'XX000', message: 'connection lost' });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createProcessorDbAdapter({ db: fake.db as any, logger: log });
    await expect(
      adapter.deleteRevisionLedgerEntry({
        integration_id: INT,
        file_id: 'f1',
        revision_id: 'r1',
      }),
    ).rejects.toThrow(/revision_ledger_rollback_failed|deleteRevisionLedgerEntry failed/);
    expect(log.error).toHaveBeenCalled();
  });

  // CodeRabbit ASSERTIVE on PR #696: Zod validation at adapter boundary.
  // Malformed payloads must not reach Postgres / enqueue_rule_event RPC.
  it('insertRevisionLedger rejects malformed rows via Zod (non-UUID integration_id)', async () => {
    const fake = makeFakeDb();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createProcessorDbAdapter({ db: fake.db as any, logger: log });
    await expect(
      adapter.insertRevisionLedger({
        integration_id: 'not-a-uuid',
        org_id: ORG,
        file_id: 'f1',
        revision_id: 'r1',
        parent_ids: ['folder-A'],
        modified_time: null,
        actor_email: 'leaked@example.com',
        outcome: 'queued',
        rule_event_id: null,
      }),
    ).rejects.toThrow(/invalid_revision_ledger_row|integration_id/);
    // PII scrub: actor_email must NOT appear in any logger arg.
    const allLogArgs = JSON.stringify(log.error.mock.calls);
    expect(allLogArgs).not.toContain('leaked@example.com');
    // No Supabase write happened.
    expect(fake.inserts).toHaveLength(0);
  });

  it('advancePageToken rejects malformed args via Zod (empty new_page_token)', async () => {
    const fake = makeFakeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createProcessorDbAdapter({ db: fake.db as any });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately malformed to exercise Zod rejection
      adapter.advancePageToken({ integration_id: INT, new_page_token: '', expected_page_token: 'pt-1' } as any),
    ).rejects.toThrow(/invalid_advance_page_token_args|new_page_token/);
    expect(fake.updates).toHaveLength(0);
  });

  it('advancePageToken rejects malformed args via Zod (missing expected_page_token)', async () => {
    const fake = makeFakeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createProcessorDbAdapter({ db: fake.db as any });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately malformed to exercise Zod rejection
      adapter.advancePageToken({ integration_id: INT, new_page_token: 'pt-2' } as any),
    ).rejects.toThrow(/invalid_advance_page_token_args|expected_page_token/);
    expect(fake.updates).toHaveLength(0);
  });

  it('enqueueRuleEvent returns null on Zod failure so the processor compensates via ledger rollback', async () => {
    const fake = makeFakeDb();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createProcessorDbAdapter({ db: fake.db as any, logger: log });
    const id = await adapter.enqueueRuleEvent({
      org_id: 'not-a-uuid',
      file_id: 'f1',
      parent_ids: ['folder-A'],
      actor_email: 'leaked@example.com',
      revision_id: 'r1',
      integration_id: INT,
      filename: 'invoice.pdf',
      folder_path: null,
    });
    expect(id).toBeNull();
    // Zod failure logs a scrubbed payload.
    const allLogArgs = JSON.stringify(log.error.mock.calls);
    expect(allLogArgs).not.toContain('leaked@example.com');
    // No RPC was attempted.
    expect(fake.db.rpc).not.toHaveBeenCalled();
  });

  // SCRUM-2903 (GD-PROD): the file-changed job enqueue — Drive twin of
  // docusign.ts's enqueueFetchJob, called right after enqueueRuleEvent.
  describe('enqueueFileChangedJob', () => {
    it('submits a google_drive.file_changed job carrying only connector-native ids + mime/timestamp hint', async () => {
      const fake = makeFakeDb();
      submitJobMock.mockResolvedValueOnce('job-1');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter = createProcessorDbAdapter({ db: fake.db as any });
      const jobId = await adapter.enqueueFileChangedJob({
        org_id: ORG,
        integration_id: INT,
        file_id: 'f3',
        revision_id: 'rev-3',
        mime_type: 'application/pdf',
        modified_time: '2026-05-04T01:00:00Z',
        rule_event_id: 'evt-3',
        // SCRUM-4507 link-back fields.
        shared_drive_id: 'shared-drive-legal',
        folder_id: 'folder-legal',
        folder_path: '/Legal/Contracts',
        revision_kind: 'head_revision',
      });

      expect(jobId).toBe('job-1');
      expect(submitJobMock).toHaveBeenCalledWith({
        type: 'google_drive.file_changed',
        max_attempts: 5,
        priority: 10,
        payload: {
          org_id: ORG,
          integration_id: INT,
          file_id: 'f3',
          revision_id: 'rev-3',
          mime_type: 'application/pdf',
          modified_time: '2026-05-04T01:00:00Z',
          rule_event_id: 'evt-3',
          shared_drive_id: 'shared-drive-legal',
          folder_id: 'folder-legal',
          folder_path: '/Legal/Contracts',
          revision_kind: 'head_revision',
        },
      });
    });

    it('converts null revision_id/mime_type/modified_time to undefined so the shared Zod schema (which requires .optional(), not null) accepts the payload', async () => {
      const fake = makeFakeDb();
      submitJobMock.mockResolvedValueOnce('job-2');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter = createProcessorDbAdapter({ db: fake.db as any });
      const jobId = await adapter.enqueueFileChangedJob({
        org_id: ORG,
        integration_id: INT,
        file_id: 'doc-1',
        revision_id: null,
        mime_type: null,
        modified_time: null,
        rule_event_id: 'evt-doc-1',
        shared_drive_id: null,
        folder_id: null,
        folder_path: null,
        revision_kind: 'modified_time',
      });

      expect(jobId).toBe('job-2');
      const submittedPayload = submitJobMock.mock.calls[0][0].payload;
      expect(submittedPayload.revision_id).toBeUndefined();
      expect(submittedPayload.mime_type).toBeUndefined();
      expect(submittedPayload.modified_time).toBeUndefined();
      expect(submittedPayload.file_id).toBe('doc-1');
      // SCRUM-4507: the same null -> undefined convention at this one adapter
      // boundary. `revision_kind` is never null (the processor always resolves
      // one) so it is asserted as a value, not as undefined.
      expect(submittedPayload.shared_drive_id).toBeUndefined();
      expect(submittedPayload.folder_id).toBeUndefined();
      expect(submittedPayload.folder_path).toBeUndefined();
      expect(submittedPayload.revision_kind).toBe('modified_time');
    });

    it('returns null (does not submit) on Zod failure — e.g. non-UUID org_id', async () => {
      const fake = makeFakeDb();
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter = createProcessorDbAdapter({ db: fake.db as any, logger: log });
      const jobId = await adapter.enqueueFileChangedJob({
        org_id: 'not-a-uuid',
        integration_id: INT,
        file_id: 'f4',
        revision_id: null,
        mime_type: null,
        modified_time: null,
        rule_event_id: 'evt-4',
        shared_drive_id: null,
        folder_id: null,
        folder_path: null,
        revision_kind: 'head_revision',
      });

      expect(jobId).toBeNull();
      expect(submitJobMock).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalled();
    });

    it('returns null and logs when submitJob resolves null (DB insert failure)', async () => {
      const fake = makeFakeDb();
      submitJobMock.mockResolvedValueOnce(null);
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter = createProcessorDbAdapter({ db: fake.db as any, logger: log });
      const jobId = await adapter.enqueueFileChangedJob({
        org_id: ORG,
        integration_id: INT,
        file_id: 'f5',
        revision_id: null,
        mime_type: null,
        modified_time: null,
        rule_event_id: 'evt-5',
        shared_drive_id: null,
        folder_id: null,
        folder_path: null,
        revision_kind: 'head_revision',
      });

      expect(jobId).toBeNull();
      expect(log.error).toHaveBeenCalled();
    });
  });
});

// SCRUM-1837 (GH #1837): Postgres-backed FolderPathCacheStore over
// drive_folder_path_cache. Kept intentionally thin (read/upsert only — TTL
// logic lives in resolveDriveFolderPath).
describe('createFolderPathCache', () => {
  it('get() reads folder_path + cached_at scoped by (org_id, file_id)', async () => {
    const eqCalls: Array<[string, unknown]> = [];
    const db = {
      from: (table: string) => {
        expect(table).toBe('drive_folder_path_cache');
        return {
          select: (_cols: string) => ({
            eq: (c1: string, v1: unknown) => {
              eqCalls.push([c1, v1]);
              return {
                eq: (c2: string, v2: unknown) => {
                  eqCalls.push([c2, v2]);
                  return {
                    maybeSingle: () => Promise.resolve({
                      data: { folder_path: '/HR/notes.pdf', cached_at: '2026-08-01T00:00:00Z' },
                      error: null,
                    }),
                  };
                },
              };
            },
          }),
        };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cache = createFolderPathCache({ db: db as any });
    const result = await cache.get({ orgId: ORG, fileId: 'file-1' });
    expect(result).toEqual({ folder_path: '/HR/notes.pdf', cached_at: '2026-08-01T00:00:00Z' });
    expect(eqCalls).toEqual([['org_id', ORG], ['file_id', 'file-1']]);
  });

  it('get() returns null on a cache miss or DB error (never throws)', async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        }),
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cache = createFolderPathCache({ db: db as any });
    expect(await cache.get({ orgId: ORG, fileId: 'missing' })).toBeNull();
  });

  it('put() upserts on (org_id, file_id) and swallows a write failure (best-effort)', async () => {
    let upsertRow: Record<string, unknown> | undefined;
    let upsertOpts: unknown;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const db = {
      from: (table: string) => {
        expect(table).toBe('drive_folder_path_cache');
        return {
          upsert: (row: Record<string, unknown>, opts: unknown) => {
            upsertRow = row;
            upsertOpts = opts;
            return Promise.resolve({ error: { message: 'connection reset' } });
          },
        };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cache = createFolderPathCache({ db: db as any, logger: log });
    await expect(
      cache.put({ orgId: ORG, fileId: 'file-1', folderPath: '/HR/notes.pdf' }),
    ).resolves.toBeUndefined();
    expect(upsertRow).toMatchObject({ org_id: ORG, file_id: 'file-1', folder_path: '/HR/notes.pdf' });
    expect(upsertOpts).toEqual({ onConflict: 'org_id,file_id' });
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('runDriveChanges (orchestrator) — direct tests for skip + happy paths', () => {
  // CodeRabbit ASSERTIVE on PR #696 (review at 19:42:06Z): the helper-only
  // test suite left runDriveChanges itself unpinned. Add direct tests so a
  // refactor of the orchestrator (skip ordering, handoff shape, page-token
  // advance contract) can't regress while the helper tests stay green.
  beforeEach(() => {
    processDriveChangesMock.mockReset();
  });

  it('returns { skipped: "no_page_token" } when integration.last_page_token is null without touching DB or KMS', async () => {
    const kms = fakeKms();
    const fake = makeFakeDb();
    const integration: DriveIntegrationRow = {
      id: INT,
      org_id: ORG,
      encrypted_tokens: Buffer.from(`ct:${JSON.stringify(FRESH_TOKENS)}`, 'utf8'),
      token_kms_key_id: KEY,
      last_page_token: null,
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await runDriveChanges(integration, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fake.db as any,
      kms,
      logger: log,
    });
    expect(result).toEqual({ skipped: 'no_page_token' });
    // Bootstrap-guard short-circuit: no DB query, no KMS decrypt, no Drive
    // fetch, no processor call.
    expect(processDriveChangesMock).not.toHaveBeenCalled();
    expect(kms.decrypt).not.toHaveBeenCalled();
    expect(fake.updates).toHaveLength(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it('returns { skipped: "no_watched_folders" } when org has zero enabled WORKSPACE_FILE_MODIFIED rules; never refreshes the access token', async () => {
    const kms = fakeKms();
    const fakeFetch = vi.fn();
    const db = {
      from: (_t: string) => ({
        select: (_c: string) => ({
          eq: (_c1: string, _v1: unknown) => ({
            eq: (_c2: string, _v2: unknown) => ({
              eq: (_c3: string, _v3: unknown) => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
      }),

      rpc: vi.fn(),
    };
    const integration: DriveIntegrationRow = {
      id: INT,
      org_id: ORG,
      encrypted_tokens: Buffer.from(`ct:${JSON.stringify(FRESH_TOKENS)}`, 'utf8'),
      token_kms_key_id: KEY,
      last_page_token: 'pt-1',
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await runDriveChanges(integration, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      kms,
      drive: { fetchImpl: fakeFetch as unknown as typeof fetch },
      logger: log,
    });
    expect(result).toEqual({ skipped: 'no_watched_folders' });
    // Critical: the access-token refresh path MUST NOT run when there are
    // no folders to scan — burning a Google refresh on a no-op is wasteful
    // and rotates the refresh_token unnecessarily.
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(processDriveChangesMock).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalled();
  });

  it('happy path: hands off to processDriveChanges with resolved accessToken + watched_folder_ids and returns the processor result', async () => {
    const kms = fakeKms();
    const fakeFetch = vi.fn();
    // Org has one rule with a folder binding so loadWatchedFolderIds resolves
    // a non-empty set.
    const leaseStore = createRunLeaseStore(driveChangesRunLeaseSpec(INT), 'free');
    const db = {
      from: (t: string) => {
        if (t === 'job_queue') return leaseStore.from(t);
        return {
          select: (_c: string) => ({
            eq: (_c1: string, _v1: unknown) => ({
              eq: (_c2: string, _v2: unknown) => ({
                eq: (_c3: string, _v3: unknown) =>
                  Promise.resolve({
                    data: [{ trigger_config: { folder_id: 'folder-Z' } }],
                    error: null,
                  }),
              }),
            }),
          }),
        };
      },
      rpc: vi.fn(),
    };
    const integration: DriveIntegrationRow = {
      id: INT,
      org_id: ORG,
      encrypted_tokens: Buffer.from(`ct:${JSON.stringify(FRESH_TOKENS)}`, 'utf8'),
      token_kms_key_id: KEY,
      last_page_token: 'pt-1',
    };
    const expectedProcessorResult = {
      pages_processed: 1,
      ledger_inserted: 0,
      ledger_conflicts: 0,
      enqueued: 0,
      parent_mismatch: 0,
      unrelated_change: 0,
      next_page_token: 'pt-2',
    };
    processDriveChangesMock.mockResolvedValueOnce(expectedProcessorResult);
    const result = await runDriveChanges(integration, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      kms,
      drive: { fetchImpl: fakeFetch as unknown as typeof fetch },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    // The runner returns whatever processDriveChanges returns on the
    // happy path — pin that pass-through.
    expect(result).toEqual(expectedProcessorResult);
    // processDriveChanges was called with the integration shape the
    // processor expects: id, org_id, last_page_token, watched_folder_ids
    // resolved from the rule layer (NOT from the integration layer).
    expect(processDriveChangesMock).toHaveBeenCalledTimes(1);
    const callArg = processDriveChangesMock.mock.calls[0]?.[0] as {
      integration: { id: string; org_id: string; last_page_token: string; watched_folder_ids: string[] };
      accessToken: string;
      db: unknown;
      deps: { logger: unknown };
    };
    expect(callArg.integration.id).toBe(INT);
    expect(callArg.integration.org_id).toBe(ORG);
    expect(callArg.integration.last_page_token).toBe('pt-1');
    expect(callArg.integration.watched_folder_ids).toEqual(['folder-Z']);
    expect(callArg.accessToken).toBe('access-fresh');
    expect(callArg.db).toBeDefined(); // adapter was passed
    expect(callArg.deps).toBeDefined();
    // Single-flight lease: acquired for the run and released afterward — a
    // later concurrent push for the SAME integration must be able to
    // acquire it again immediately, not find it stuck 'processing'.
    expect(leaseStore.current()?.status).toBe('completed');
    expect(leaseStore.current()?.scheduled_for).toBeNull();
  });

  describe('single-flight lease (orchestrator first-run-flood review)', () => {
    it('returns { skipped: "locked" } and never touches Drive/the processor when another run already holds the lease', async () => {
      const kms = fakeKms();
      const fakeFetch = vi.fn();
      const leaseStore = createRunLeaseStore(driveChangesRunLeaseSpec(INT), {
        held: { holder: 'some-other-instance:123:nonce', expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() },
      });
      const db = {
        from: (t: string) => {
          if (t === 'job_queue') return leaseStore.from(t);
          return {
            select: (_c: string) => ({
              eq: (_c1: string, _v1: unknown) => ({
                eq: (_c2: string, _v2: unknown) => ({
                  eq: (_c3: string, _v3: unknown) =>
                    Promise.resolve({ data: [{ trigger_config: { folder_id: 'folder-Z' } }], error: null }),
                }),
              }),
            }),
          };
        },
        rpc: vi.fn(),
      };
      const integration: DriveIntegrationRow = {
        id: INT,
        org_id: ORG,
        encrypted_tokens: Buffer.from(`ct:${JSON.stringify(FRESH_TOKENS)}`, 'utf8'),
        token_kms_key_id: KEY,
        last_page_token: 'pt-1',
      };
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const result = await runDriveChanges(integration, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
        kms,
        drive: { fetchImpl: fakeFetch as unknown as typeof fetch },
        logger: log,
      });
      expect(result).toEqual({ skipped: 'locked' });
      // No token refresh, no Drive call, no processor call — the whole
      // point of acquiring the lease BEFORE any of that work starts.
      expect(fakeFetch).not.toHaveBeenCalled();
      expect(kms.decrypt).not.toHaveBeenCalled();
      expect(processDriveChangesMock).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalled();
    });

    it('releases the lease even when processDriveChanges throws', async () => {
      const kms = fakeKms();
      const fakeFetch = vi.fn();
      const leaseStore = createRunLeaseStore(driveChangesRunLeaseSpec(INT), 'free');
      const db = {
        from: (t: string) => {
          if (t === 'job_queue') return leaseStore.from(t);
          return {
            select: (_c: string) => ({
              eq: (_c1: string, _v1: unknown) => ({
                eq: (_c2: string, _v2: unknown) => ({
                  eq: (_c3: string, _v3: unknown) =>
                    Promise.resolve({ data: [{ trigger_config: { folder_id: 'folder-Z' } }], error: null }),
                }),
              }),
            }),
          };
        },
        rpc: vi.fn(),
      };
      const integration: DriveIntegrationRow = {
        id: INT,
        org_id: ORG,
        encrypted_tokens: Buffer.from(`ct:${JSON.stringify(FRESH_TOKENS)}`, 'utf8'),
        token_kms_key_id: KEY,
        last_page_token: 'pt-1',
      };
      processDriveChangesMock.mockRejectedValueOnce(new Error('changes.list exploded'));
      await expect(
        runDriveChanges(integration, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          db: db as any,
          kms,
          drive: { fetchImpl: fakeFetch as unknown as typeof fetch },
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }),
      ).rejects.toThrow('changes.list exploded');
      // The lease must not be left stuck 'processing' — the TTL is a
      // backstop, not the primary release path.
      expect(leaseStore.current()?.status).toBe('completed');
    });
  });

  describe('dirty/rerun-requested marker (fix-round item 3)', () => {
    it('a locked skip marks the lease dirty (attempts=1) rather than dropping the push silently', async () => {
      const kms = fakeKms();
      const leaseStore = createRunLeaseStore(driveChangesRunLeaseSpec(INT), {
        held: { holder: 'some-other-instance:123:nonce', expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() },
      });
      const db = {
        from: (t: string) => {
          if (t === 'job_queue') return leaseStore.from(t);
          return {
            select: (_c: string) => ({
              eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [{ trigger_config: { folder_id: 'folder-Z' } }], error: null }) }) }),
            }),
          };
        },
        rpc: vi.fn(),
      };
      const integration: DriveIntegrationRow = {
        id: INT,
        org_id: ORG,
        encrypted_tokens: Buffer.from(`ct:${JSON.stringify(FRESH_TOKENS)}`, 'utf8'),
        token_kms_key_id: KEY,
        last_page_token: 'pt-1',
      };
      expect(leaseStore.current()?.attempts).toBe(0);
      const result = await runDriveChanges(integration, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
        kms,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      expect(result).toEqual({ skipped: 'locked' });
      expect(leaseStore.current()?.attempts).toBe(1);
    });

    it('a push that arrives mid-run (marking the held lease dirty) triggers exactly ONE extra processDriveChanges pass before release, then clears the flag', async () => {
      const kms = fakeKms();
      const leaseStore = createRunLeaseStore(driveChangesRunLeaseSpec(INT), 'free');
      const db = {
        from: (t: string) => {
          if (t === 'job_queue') return leaseStore.from(t);
          return {
            select: (_c: string) => ({
              eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [{ trigger_config: { folder_id: 'folder-Z' } }], error: null }) }) }),
            }),
          };
        },
        rpc: vi.fn(),
      };
      const integration: DriveIntegrationRow = {
        id: INT,
        org_id: ORG,
        encrypted_tokens: Buffer.from(`ct:${JSON.stringify(FRESH_TOKENS)}`, 'utf8'),
        token_kms_key_id: KEY,
        last_page_token: 'pt-1',
      };
      // First pass's own processDriveChanges call simulates a CONCURRENT
      // push landing while this run is still in flight — it marks the SAME
      // lease row dirty, exactly like markLeaseDirty would from another
      // request that found the lease held.
      processDriveChangesMock.mockImplementationOnce(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (leaseStore.from('job_queue') as any).update({ attempts: 1 }).eq('id', INT);
        return { pagesProcessed: 1, queued: 1, parentMismatch: 0, duplicates: 0, changesProcessed: 1, newPageToken: 'pt-2' };
      });
      processDriveChangesMock.mockResolvedValueOnce({
        pagesProcessed: 1, queued: 0, parentMismatch: 0, duplicates: 0, changesProcessed: 0, newPageToken: 'pt-3',
      });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const result = await runDriveChanges(integration, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
        kms,
        logger: log,
      });
      // Exactly TWO processDriveChanges calls: the original pass + ONE
      // bounded extra pass — never a loop.
      expect(processDriveChangesMock).toHaveBeenCalledTimes(2);
      // The second pass resumed from the FIRST pass's own newPageToken.
      expect(processDriveChangesMock.mock.calls[1][0].integration.last_page_token).toBe('pt-2');
      // The runner returns the SECOND pass's result — it is the freshest.
      expect(result).toMatchObject({ newPageToken: 'pt-3' });
      // The dirty flag was cleared, not left set for the NEXT run to
      // re-trigger a pass for work that has already been handled.
      expect(leaseStore.current()?.attempts).toBe(0);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ integrationId: INT }),
        expect.stringContaining('one more bounded pass'),
      );
    });

    it('MERGES both passes: counters are summed and per-pass flags OR-ed, not replaced by pass 2', async () => {
      const kms = fakeKms();
      const leaseStore = createRunLeaseStore(driveChangesRunLeaseSpec(INT), 'free');
      const db = {
        from: (t: string) => {
          if (t === 'job_queue') return leaseStore.from(t);
          return {
            select: (_c: string) => ({
              eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [{ trigger_config: { folder_id: 'folder-Z' } }], error: null }) }) }),
            }),
          };
        },
        rpc: vi.fn(),
      };
      const integration: DriveIntegrationRow = {
        id: INT,
        org_id: ORG,
        encrypted_tokens: Buffer.from(`ct:${JSON.stringify(FRESH_TOKENS)}`, 'utf8'),
        token_kms_key_id: KEY,
        last_page_token: 'pt-1',
      };
      // Pass 1 does REAL work and hits a cursor reset, then a push lands
      // mid-run (marks the lease dirty). Pass 2 does a little more work.
      // The run's reported totals must describe the WHOLE run: before this
      // was fixed, `result = secondResult` threw pass 1's numbers away, so a
      // run under-reported itself in exactly the case the dirty marker
      // exists to handle.
      processDriveChangesMock.mockImplementationOnce(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (leaseStore.from('job_queue') as any).update({ attempts: 1 }).eq('id', INT);
        return {
          pagesProcessed: 3, queued: 7, parentMismatch: 2, duplicates: 1,
          changesProcessed: 10, newPageToken: 'pt-2', cursorReset: true as const,
        };
      });
      processDriveChangesMock.mockResolvedValueOnce({
        pagesProcessed: 1, queued: 4, parentMismatch: 1, duplicates: 3,
        changesProcessed: 5, newPageToken: 'pt-3',
      });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const result = await runDriveChanges(integration, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
        kms,
        logger: log,
      });
      expect(processDriveChangesMock).toHaveBeenCalledTimes(2);
      // Counters describe the whole run, not just its last pass.
      expect(result).toMatchObject({
        pagesProcessed: 4,
        queued: 11,
        parentMismatch: 3,
        duplicates: 4,
        changesProcessed: 15,
        // The cursor still comes from the LATER pass — merging must not
        // rewind it.
        newPageToken: 'pt-3',
      });
      // `cursorReset` is a fact about something that HAPPENED during this
      // run. Pass 2 did not reset, but pass 1 did, so the run did.
      expect(result).toMatchObject({ cursorReset: true });
    });

    it('when NOT dirty, runs exactly once — no extra pass, no wasted work', async () => {
      const kms = fakeKms();
      const leaseStore = createRunLeaseStore(driveChangesRunLeaseSpec(INT), 'free');
      const db = {
        from: (t: string) => {
          if (t === 'job_queue') return leaseStore.from(t);
          return {
            select: (_c: string) => ({
              eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [{ trigger_config: { folder_id: 'folder-Z' } }], error: null }) }) }),
            }),
          };
        },
        rpc: vi.fn(),
      };
      const integration: DriveIntegrationRow = {
        id: INT,
        org_id: ORG,
        encrypted_tokens: Buffer.from(`ct:${JSON.stringify(FRESH_TOKENS)}`, 'utf8'),
        token_kms_key_id: KEY,
        last_page_token: 'pt-1',
      };
      processDriveChangesMock.mockResolvedValueOnce({
        pagesProcessed: 1, queued: 0, parentMismatch: 0, duplicates: 0, changesProcessed: 0, newPageToken: 'pt-2',
      });
      await runDriveChanges(integration, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
        kms,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      expect(processDriveChangesMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('runDriveReconciliationSweep (fix-round item 3, second half)', () => {
    it('scans stale google_drive integrations and invokes runDriveChanges for each, respecting the single-flight lease', async () => {
      const kms = fakeKms();
      const staleIntegrationRow = {
        id: INT,
        org_id: ORG,
        encrypted_tokens: Buffer.from(`ct:${JSON.stringify(FRESH_TOKENS)}`, 'utf8'),
        token_kms_key_id: KEY,
        last_page_token: 'pt-1',
        last_token_advanced_at: '2020-01-01T00:00:00Z',
      };
      const leaseStore = createRunLeaseStore(driveChangesRunLeaseSpec(INT), 'free');
      let scanCall = 0;
      const db = {
        from: (t: string) => {
          if (t === 'job_queue') return leaseStore.from(t);
          if (t === 'org_integrations') {
            scanCall += 1;
            return {
              select: () => ({
                eq: () => ({
                  is: () => ({
                    not: () => ({
                      or: () => ({
                        limit: () => Promise.resolve({ data: [staleIntegrationRow], error: null }),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {
            select: (_c: string) => ({
              eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [{ trigger_config: { folder_id: 'folder-Z' } }], error: null }) }) }),
            }),
          };
        },
        rpc: vi.fn(),
      };
      processDriveChangesMock.mockResolvedValueOnce({
        pagesProcessed: 1, queued: 0, parentMismatch: 0, duplicates: 0, changesProcessed: 0, newPageToken: 'pt-2',
      });
      const result = await runDriveReconciliationSweep({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
        kms,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      expect(scanCall).toBe(1);
      expect(result.scanned).toBe(1);
      expect(result.ran).toBe(1);
      expect(processDriveChangesMock).toHaveBeenCalledTimes(1);
    });

    it('one integration erroring does not stop the sweep from continuing — errored is counted, not thrown', async () => {
      const kms = fakeKms();
      const rowA = {
        id: INT,
        org_id: ORG,
        encrypted_tokens: Buffer.from(`ct:${JSON.stringify(FRESH_TOKENS)}`, 'utf8'),
        token_kms_key_id: KEY,
        last_page_token: 'pt-1',
        last_token_advanced_at: '2020-01-01T00:00:00Z',
      };
      const rowB = { ...rowA, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
      const leaseStoreA = createRunLeaseStore(driveChangesRunLeaseSpec(rowA.id), 'free');
      const leaseStoreB = createRunLeaseStore(driveChangesRunLeaseSpec(rowB.id), 'free');
      const db = {
        from: (t: string) => {
          if (t === 'job_queue') {
            // Route by whichever lease id the caller filters on — both
            // stores share the same `.from()` entry point shape.
            return {
              update: (patch: Record<string, unknown>) => ({
                eq: (_c: string, id: string) => {
                  const store = id === rowA.id ? leaseStoreA : leaseStoreB;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  return (store.from('job_queue') as any).update(patch).eq('id', id);
                },
              }),
              upsert: (values: { id: string }) => {
                const store = values.id === rowA.id ? leaseStoreA : leaseStoreB;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return (store.from('job_queue') as any).upsert(values);
              },
              select: (cols?: string) => ({
                eq: (_c: string, id: string) => {
                  const store = id === rowA.id ? leaseStoreA : leaseStoreB;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  return (store.from('job_queue') as any).select(cols).eq('id', id);
                },
              }),
            };
          }
          if (t === 'org_integrations') {
            return { select: () => ({ eq: () => ({ is: () => ({ not: () => ({ or: () => ({ limit: () => Promise.resolve({ data: [rowA, rowB], error: null }) }) }) }) }) }) };
          }
          return {
            select: (_c: string) => ({
              eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [{ trigger_config: { folder_id: 'folder-Z' } }], error: null }) }) }),
            }),
          };
        },
        rpc: vi.fn(),
      };
      processDriveChangesMock
        .mockRejectedValueOnce(new Error('boom for row A'))
        .mockResolvedValueOnce({ pagesProcessed: 1, queued: 0, parentMismatch: 0, duplicates: 0, changesProcessed: 0, newPageToken: 'pt-2' });
      const result = await runDriveReconciliationSweep({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
        kms,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      expect(result.scanned).toBe(2);
      expect(result.errored).toBe(1);
      expect(result.ran).toBe(1);
    });
  });
});
