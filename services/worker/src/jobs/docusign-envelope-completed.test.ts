import { beforeEach, describe, expect, it, vi } from 'vitest';

const processNextJobMock = vi.hoisted(() => vi.fn());
const processDocusignEnvelopeCompletedJobMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/jobQueue.js', () => ({
  processNextJob: processNextJobMock,
}));

vi.mock('../integrations/connectors/docusign.js', () => ({
  processDocusignEnvelopeCompletedJob: processDocusignEnvelopeCompletedJobMock,
}));

vi.mock('../utils/db.js', () => ({ db: {} }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  makeDocusignEnvelopeJobDeps,
  runDocusignEnvelopeCompletedJobs,
  type DocusignEnvelopeJobRuntimeDeps,
} from './docusign-envelope-completed.js';
import { logger } from '../utils/logger.js';
import {
  claimDocusignAccountApiSlot,
  resetDocusignAccountRateLimitStoreForTests,
} from '../integrations/oauth/docusign-rate-limit.js';
import { fetchDocusignCombinedDocument } from '../integrations/oauth/docusign.js';

describe('runDocusignEnvelopeCompletedJobs', () => {
  beforeEach(() => {
    processNextJobMock.mockReset();
    processDocusignEnvelopeCompletedJobMock.mockReset();
    resetDocusignAccountRateLimitStoreForTests();
  });

  it('claims docusign.envelope_completed jobs through the generic queue and invokes the DocuSign processor', async () => {
    const payload = {
      org_id: '11111111-1111-4111-8111-111111111111',
      integration_id: 'int-1',
      account_id: 'acct-1',
      envelope_id: 'env-1',
      rule_event_id: 'evt-1',
      document_ids: ['combined'],
    };
    const jobDeps = {
      resolveConnection: vi.fn(),
      enqueueSignedDocument: vi.fn(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    };
    processNextJobMock
      .mockImplementationOnce(async (_type: string, handler: (job: { payload: unknown }) => Promise<void>) => {
        await handler({ payload });
        return { claimed: true, status: 'completed', jobId: 'job-1' };
      })
      .mockResolvedValueOnce({ claimed: false, status: 'idle' });
    processDocusignEnvelopeCompletedJobMock.mockResolvedValue({ queuedId: 'queue-1' });

    const result = await runDocusignEnvelopeCompletedJobs({ limit: 5, jobDeps });

    expect(processNextJobMock).toHaveBeenCalledWith(
      'docusign.envelope_completed',
      expect.any(Function),
    );
    expect(processDocusignEnvelopeCompletedJobMock).toHaveBeenCalledWith(payload, jobDeps);
    expect(result).toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
      dead: 0,
      updateFailed: 0,
      jobIds: ['job-1'],
    });
  });

  it('returns retry/dead counts from the generic queue result instead of swallowing failures', async () => {
    processNextJobMock
      .mockResolvedValueOnce({ claimed: true, status: 'failed', jobId: 'job-retry' })
      .mockResolvedValueOnce({ claimed: true, status: 'dead', jobId: 'job-dead' });

    const result = await runDocusignEnvelopeCompletedJobs({
      limit: 2,
      jobDeps: {
        resolveConnection: vi.fn(),
        enqueueSignedDocument: vi.fn(),
      },
    });

    expect(result).toEqual({
      claimed: 2,
      completed: 0,
      failed: 1,
      dead: 1,
      updateFailed: 0,
      jobIds: ['job-retry', 'job-dead'],
    });
  });

  it('clamps excessive limits and counts queue update failures distinctly', async () => {
    processNextJobMock.mockResolvedValue({ claimed: true, status: 'update_failed', jobId: 'job-update' });

    const result = await runDocusignEnvelopeCompletedJobs({
      limit: 250,
      jobDeps: {
        resolveConnection: vi.fn(),
        enqueueSignedDocument: vi.fn(),
      },
    });

    expect(processNextJobMock).toHaveBeenCalledTimes(100);
    expect(result).toEqual({
      claimed: 100,
      completed: 0,
      failed: 0,
      dead: 0,
      updateFailed: 100,
      jobIds: Array.from({ length: 100 }, () => 'job-update'),
    });
  });

  it('does not persist document fingerprints in integration event details', async () => {
    let inserted: Record<string, unknown> | undefined;
    const db = {
      from: vi.fn((table: string) => {
        expect(table).toBe('integration_events');
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          is: vi.fn(() => query),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          insert: vi.fn((value: Record<string, unknown>) => {
            inserted = value;
            return {
              select: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({ data: { id: 'event-1' }, error: null }),
              })),
            };
          }),
        };
        return query;
      }),
    };
    const deps = makeDocusignEnvelopeJobDeps({ db });

    await deps.enqueueSignedDocument({
      orgId: '11111111-1111-4111-8111-111111111111',
      integrationId: 'integration-1',
      accountId: 'account-1',
      envelopeId: 'envelope-1',
      ruleEventId: 'rule-event-1',
      documentBytes: Buffer.from('signed bytes'),
      contentType: 'application/pdf',
    });

    expect(inserted?.details).toMatchObject({
      account_id: 'account-1',
      envelope_id: 'envelope-1',
      rule_event_id: 'rule-event-1',
      content_type: 'application/pdf',
      byte_length: 12,
    });
    expect(inserted?.details).not.toHaveProperty('document_sha256');
  });

  it('resolves member_integrations when no org_integrations row matches', async () => {
    const queriedTables: string[] = [];
    const memberRow = {
      id: 'member-int-1',
      org_id: '11111111-1111-4111-8111-111111111111',
      account_id: 'account-1',
      base_uri: 'https://demo.docusign.net',
      token_secret_name: 'secret/member-int-1',
    };
    const db = {
      from: vi.fn((table: string) => {
        queriedTables.push(table);
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          is: vi.fn(() => query),
          maybeSingle: vi.fn().mockResolvedValue({
            data: table === 'member_integrations' ? memberRow : null,
            error: null,
          }),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
            })),
          })),
        };
        return query;
      }),
    };
    const refreshTokenStore = {
      get: vi.fn().mockResolvedValue('refresh-token-1'),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        access_token: 'access-token-1',
        refresh_token: 'refresh-token-2',
        token_type: 'Bearer',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const deps = makeDocusignEnvelopeJobDeps({
      db,
      refreshTokenStore,
      fetchImpl,
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'integration-key',
        DOCUSIGN_CLIENT_SECRET: 'client-secret',
        DOCUSIGN_AUTH_BASE: 'https://account-d.docusign.com',
      },
    });

    const connection = await deps.resolveConnection({
      org_id: '11111111-1111-4111-8111-111111111111',
      integration_id: 'member-int-1',
      account_id: 'account-1',
      envelope_id: 'envelope-1',
      rule_event_id: 'rule-event-1',
      document_ids: ['combined'],
    });

    expect(queriedTables).toEqual(['org_integrations', 'member_integrations']);
    expect(connection).toEqual({
      accessToken: 'access-token-1',
      baseUri: 'https://demo.docusign.net',
    });
    expect(refreshTokenStore.get).toHaveBeenCalledWith({ name: 'secret/member-int-1' });
    expect(refreshTokenStore.put).toHaveBeenCalledWith({
      name: 'secret/member-int-1',
      value: 'refresh-token-2',
    });
  });

  it('throws when member_integrations lookup fails after no org_integrations row matches', async () => {
    const queriedTables: string[] = [];
    const memberLookupError = new Error('lookup failed');
    const db = {
      from: vi.fn((table: string) => {
        queriedTables.push(table);
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          is: vi.fn(() => query),
          maybeSingle: vi.fn().mockResolvedValue({
            data: null,
            error: table === 'member_integrations' ? memberLookupError : null,
          }),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
            })),
          })),
        };
        return query;
      }),
    };
    const refreshTokenStore = {
      get: vi.fn().mockResolvedValue('refresh-token-1'),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const deps = makeDocusignEnvelopeJobDeps({ db, refreshTokenStore });

    await expect(deps.resolveConnection({
      org_id: '11111111-1111-4111-8111-111111111111',
      integration_id: 'member-int-1',
      account_id: 'account-1',
      envelope_id: 'envelope-1',
      rule_event_id: 'rule-event-1',
      document_ids: ['combined'],
    })).rejects.toThrow('docusign_integration_lookup_failed');

    expect(queriedTables).toEqual(['org_integrations', 'member_integrations']);
    expect(logger.error).toHaveBeenCalledWith(
      { error: memberLookupError, integrationId: 'member-int-1' },
      'DocuSign job member integration lookup failed',
    );
    expect(refreshTokenStore.get).not.toHaveBeenCalled();
    expect(refreshTokenStore.put).not.toHaveBeenCalled();
  });

  it('filters inherited parent connection lookup by the requested DocuSign account', async () => {
    const parentOrgId = '11111111-1111-4111-8111-111111111111';
    const subOrgId = '22222222-2222-4222-8222-222222222222';
    const accountId = 'acct-parent-a';
    const parentRow = {
      id: 'parent-int-a',
      org_id: parentOrgId,
      account_id: accountId,
      base_uri: 'https://na1.docusign.net',
      token_secret_name: 'projects/test/secrets/parent-a-refresh',
      inherited_from_org_id: null,
    };
    const lookups: Array<{ table: string; filters: Record<string, unknown> }> = [];
    const db = {
      from: vi.fn((table: string) => {
        const filters: Record<string, unknown> = {};
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn((field: string, value: unknown) => {
            filters[field] = value;
            return query;
          }),
          is: vi.fn((field: string, value: unknown) => {
            filters[field] = value;
            return query;
          }),
          maybeSingle: vi.fn().mockImplementation(async () => {
            lookups.push({ table, filters: { ...filters } });
            if (table === 'org_integrations' && filters.org_id === subOrgId && filters.account_id === null) {
              return {
                data: {
                  id: 'marker-int',
                  org_id: subOrgId,
                  account_id: null,
                  base_uri: null,
                  token_secret_name: null,
                  inherited_from_org_id: parentOrgId,
                },
                error: null,
              };
            }
            if (table === 'org_integrations' && filters.org_id === parentOrgId && filters.account_id === accountId) {
              return { data: parentRow, error: null };
            }
            if (table === 'org_integrations' && filters.org_id === parentOrgId && filters.account_id === undefined) {
              return { data: null, error: new Error('multiple rows returned') };
            }
            if (table === 'organizations') {
              return { data: { parent_org_id: parentOrgId }, error: null };
            }
            return { data: null, error: null };
          }),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
            })),
          })),
        };
        return query;
      }),
    };
    const refreshTokenStore = {
      get: vi.fn().mockResolvedValue('refresh-token-1'),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        access_token: 'access-token-1',
        token_type: 'Bearer',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const deps = makeDocusignEnvelopeJobDeps({
      db: db as unknown as DocusignEnvelopeJobRuntimeDeps['db'],
      refreshTokenStore,
      fetchImpl,
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'integration-key',
        DOCUSIGN_CLIENT_SECRET: 'client-secret',
        DOCUSIGN_AUTH_BASE: 'https://account-d.docusign.com',
      },
    });

    const connection = await deps.resolveConnection({
      org_id: subOrgId,
      integration_id: 'marker-int',
      account_id: accountId,
      envelope_id: 'envelope-1',
      rule_event_id: 'rule-event-1',
      document_ids: ['combined'],
    });

    expect(connection).toEqual({
      accessToken: 'access-token-1',
      baseUri: 'https://na1.docusign.net',
    });
    const parentLookup = lookups.find(
      (lookup) => lookup.table === 'org_integrations' && lookup.filters.org_id === parentOrgId,
    );
    expect(parentLookup?.filters.account_id).toBe(accountId);
    expect(refreshTokenStore.get).toHaveBeenCalledWith({
      name: 'projects/test/secrets/parent-a-refresh',
    });
  });

  it('blocks token refresh when the DocuSign account hourly API budget is exhausted', async () => {
    let nowMs = Date.UTC(2026, 4, 28, 12, 0, 0);
    const makeIntegrationQuery = () => {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        is: vi.fn(() => query),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id: 'integration-1',
            org_id: '11111111-1111-4111-8111-111111111111',
            account_id: 'account-1',
            base_uri: 'https://demo.docusign.net',
            token_secret_name: 'projects/test/secrets/docusign-refresh',
          },
          error: null,
        }),
      };
      return query;
    };
    const db = {
      from: vi.fn((table: string) => {
        expect(table).toBe('org_integrations');
        return makeIntegrationQuery();
      }),
    };
    const fetchImpl = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 }),
    );
    const deps = makeDocusignEnvelopeJobDeps({
      db: db as unknown as DocusignEnvelopeJobRuntimeDeps['db'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'ik',
        DOCUSIGN_CLIENT_SECRET: 'secret',
      },
      refreshTokenStore: {
        get: vi.fn().mockResolvedValue('rt'),
        put: vi.fn(),
        delete: vi.fn(),
      },
      now: () => new Date(nowMs),
    });
    const payload = {
      org_id: '11111111-1111-4111-8111-111111111111',
      integration_id: 'integration-1',
      account_id: 'account-1',
      envelope_id: 'envelope-1',
      rule_event_id: 'rule-event-1',
      document_ids: ['combined'],
    };
    for (let i = 0; i < 2_999; i++) {
      claimDocusignAccountApiSlot({
        accountId: 'account-1',
        now: () => new Date(nowMs),
      });
    }

    await expect(deps.resolveConnection(payload)).resolves.toMatchObject({
      accessToken: 'at',
      baseUri: 'https://demo.docusign.net',
    });
    await expect(deps.resolveConnection(payload)).rejects.toThrow(/rate limit/i);

    nowMs += 60 * 60 * 1000;
    await expect(deps.resolveConnection(payload)).resolves.toMatchObject({
      accessToken: 'at',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('counts completed-envelope document fetches against the same DocuSign account budget', async () => {
    const nowMs = Date.UTC(2026, 4, 28, 12, 0, 0);
    const makeIntegrationQuery = () => {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        is: vi.fn(() => query),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id: 'integration-1',
            org_id: '11111111-1111-4111-8111-111111111111',
            account_id: 'account-1',
            base_uri: 'https://demo.docusign.net',
            token_secret_name: 'projects/test/secrets/docusign-refresh',
          },
          error: null,
        }),
      };
      return query;
    };
    const db = {
      from: vi.fn((table: string) => {
        expect(table).toBe('org_integrations');
        return makeIntegrationQuery();
      }),
    };
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
      }
      if (url.includes('/accounts/account-1/envelopes/envelope-1/documents/combined')) {
        return new Response(new Uint8Array([37, 80, 68, 70]), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      }
      return new Response('unexpected', { status: 500 });
    });
    const deps = makeDocusignEnvelopeJobDeps({
      db: db as unknown as DocusignEnvelopeJobRuntimeDeps['db'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'ik',
        DOCUSIGN_CLIENT_SECRET: 'secret',
      },
      refreshTokenStore: {
        get: vi.fn().mockResolvedValue('rt'),
        put: vi.fn(),
        delete: vi.fn(),
      },
      now: () => new Date(nowMs),
    });
    const payload = {
      org_id: '11111111-1111-4111-8111-111111111111',
      integration_id: 'integration-1',
      account_id: 'account-1',
      envelope_id: 'envelope-1',
      rule_event_id: 'rule-event-1',
      document_ids: ['combined'],
    };
    for (let i = 0; i < 2_998; i++) {
      claimDocusignAccountApiSlot({
        accountId: 'account-1',
        now: () => new Date(nowMs),
      });
    }

    const connection = await deps.resolveConnection(payload);
    const document = await fetchDocusignCombinedDocument({
      baseUri: connection.baseUri,
      accountId: payload.account_id,
      envelopeId: payload.envelope_id,
      accessToken: connection.accessToken,
      deps,
    });

    expect(document.bytes).toEqual(Buffer.from('%PDF'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(deps.resolveConnection(payload)).rejects.toThrow(/rate limit/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
