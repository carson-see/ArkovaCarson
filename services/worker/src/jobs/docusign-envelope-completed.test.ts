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
import {
  claimDocusignAccountApiSlot,
  resetDocusignAccountRateLimitStoreForTests,
} from '../integrations/oauth/docusign-rate-limit.js';

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
});
