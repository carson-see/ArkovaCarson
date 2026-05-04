/**
 * SCRUM-1661 [Verify] code-path tests for the Drive changes-feed runner.
 *
 * Pins the four behaviors the runner is responsible for:
 *   1. Returns access_token from cache when stored tokens are still fresh.
 *   2. Refreshes + re-encrypts + persists when stored tokens are expired.
 *   3. loadWatchedFolderIds unions legacy folder_id + drive_folders[].
 *   4. createProcessorDbAdapter maps unique-violation to conflict=true.
 *
 * Drive HTTP, KMS, and DB are all dependency-injected — no real network
 * or Postgres traffic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadDriveAccessToken,
  loadWatchedFolderIds,
  createProcessorDbAdapter,
  type DriveIntegrationRow,
} from './drive-changes-runner.js';

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
  const updates: Array<{ table: string; patch: Record<string, unknown>; eq: [string, unknown] }> = [];
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const deletes: Array<{ table: string; eqs: Array<[string, unknown]> }> = [];
  let conflictKey: { file_id: string; revision_id: string } | null = null;

  return {
    updates,
    inserts,
    deletes,
    setConflictOnNext(key: { file_id: string; revision_id: string }) {
      conflictKey = key;
    },
    db: {
      from: (table: string) => ({
        update: (patch: Record<string, unknown>) => ({
          eq: (col: string, val: unknown) => {
            updates.push({ table, patch, eq: [col, val] });
            return Promise.resolve({ error: null });
          },
        }),
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
                return Promise.resolve({ error: null });
              }
              return chain;
            },
          };
          return chain;
        },
        select: (_cols: string) => ({
          eq: (_c: string, _v: unknown) => ({
            eq: (_c2: string, _v2: unknown) => ({
              eq: (_c3: string, _v3: unknown) => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
      }),
      rpc: vi.fn(async (_name: string, _args: unknown) => ({ data: 'evt-1', error: null })),
    },
  };
}

beforeEach(() => {
  process.env.GCP_KMS_INTEGRATION_TOKEN_KEY = KEY;
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
    expect(ids.sort()).toEqual(['folder-A', 'folder-B', 'folder-C']);
  });

  it('returns [] on rule-lookup error and logs warn (does not throw)', async () => {
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
    const warn = vi.fn();
    const ids = await loadWatchedFolderIds(ORG, {
      db,
      logger: { info: () => undefined, warn, error: () => undefined },
    });
    expect(ids).toEqual([]);
    expect(warn).toHaveBeenCalled();
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

  it('advancePageToken updates org_integrations.last_page_token + last_token_advanced_at', async () => {
    const fake = makeFakeDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = createProcessorDbAdapter({ db: fake.db as any });
    await adapter.advancePageToken({ integration_id: INT, new_page_token: 'pt-2' });
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0].patch).toMatchObject({ last_page_token: 'pt-2' });
    expect(typeof fake.updates[0].patch.last_token_advanced_at).toBe('string');
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
});
