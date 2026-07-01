import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const processNextJobMock = vi.hoisted(() => vi.fn());
const processDocusignEnvelopeCompletedJobMock = vi.hoisted(() => vi.fn());

// DS-03 (SCRUM-2363) connector-artifact enqueue guard. The job reads
// `config.enableConnectorArtifactEnqueue`; mock it as a mutable object so each
// test can toggle the flag. Default ON here so every pre-existing enqueue-path
// test exercises the same behavior as production-with-the-flag-on (the real
// config throws at import without the full env, so a mock is mandatory anyway).
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { enableConnectorArtifactEnqueue: true },
}));

vi.mock('../config.js', () => ({
  get config() {
    return mockConfig;
  },
}));

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
    // Default the DS-03 enqueue flag ON between tests so the existing enqueue-path
    // assertions reflect production-with-the-drain-flag-on. The dedicated guard
    // tests below flip it OFF explicitly. The materializer reads the flag from the
    // ENABLE_CONNECTOR_ARTIFACT_ENQUEUE env var (not config — avoids loadConfig at import).
    process.env.ENABLE_CONNECTOR_ARTIFACT_ENQUEUE = 'true';
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

  describe('enqueueSignedDocument — DS-03 server-side hash + durable connector artifact', () => {
    const SIGNED_BYTES = Buffer.from('signed bytes');
    const EXPECTED_SHA256 = createHash('sha256').update(SIGNED_BYTES).digest('hex');
    const ORG_ID = '11111111-1111-4111-8111-111111111111';
    const SINK_INPUT = {
      orgId: ORG_ID,
      integrationId: 'integration-1',
      accountId: 'account-1',
      envelopeId: 'envelope-1',
      ruleEventId: 'rule-event-1',
      documentBytes: SIGNED_BYTES,
      contentType: 'application/pdf' as string | null,
      sourceTimestamp: '2026-06-24T10:00:00.000Z' as string | null,
    };

    interface MakeDbOpts {
      artifactResult?: { data: string | null; error: unknown };
      auditResult?: { data: { id: string } | null; error: unknown };
    }

    function makeDb(opts: MakeDbOpts = {}) {
      const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
      const state: { insertedDetails?: Record<string, unknown>; insertCalled: boolean } = {
        insertCalled: false,
      };
      const db = {
        rpc: vi.fn((fn: string, args: Record<string, unknown>) => {
          rpcCalls.push({ fn, args });
          return Promise.resolve(opts.artifactResult ?? { data: 'artifact-1', error: null });
        }),
        from: vi.fn((table: string) => {
          expect(table).toBe('integration_events');
          const query = {
            select: vi.fn(() => query),
            eq: vi.fn(() => query),
            is: vi.fn(() => query),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            insert: vi.fn((value: Record<string, unknown>) => {
              state.insertCalled = true;
              state.insertedDetails = value.details as Record<string, unknown>;
              return {
                select: vi.fn(() => ({
                  single: vi
                    .fn()
                    .mockResolvedValue(opts.auditResult ?? { data: { id: 'event-1' }, error: null }),
                })),
              };
            }),
          };
          return query;
        }),
      };
      return { db, rpcCalls, state };
    }

    it('computes a server-side SHA-256 and enqueues a durable connector artifact via the 0343 RPC', async () => {
      const { db, rpcCalls } = makeDb();
      const deps = makeDocusignEnvelopeJobDeps({ db });

      const result = await deps.enqueueSignedDocument({ ...SINK_INPUT });

      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0].fn).toBe('enqueue_connector_artifact');
      expect(rpcCalls[0].args).toMatchObject({
        p_org_id: ORG_ID,
        p_source: 'docusign',
        p_external_ref: 'envelope-1',
        p_external_revision: null,
        p_fingerprint_sha256: EXPECTED_SHA256,
        p_byte_length: SIGNED_BYTES.byteLength,
        p_source_timestamp: '2026-06-24T10:00:00.000Z',
      });
      // Canonical lowercase 64-hex SHA-256 — matches the 0343 CHECK constraint
      // connector_artifact_fingerprint_format_check.
      expect(EXPECTED_SHA256).toMatch(/^[a-f0-9]{64}$/);
      // The durable artifact id is the queued id the Lane-2 batch loop consumes.
      expect(result).toEqual({ queuedId: 'artifact-1' });
    });

    it('returns the artifact id as the queued id (idempotent on redelivery via the RPC)', async () => {
      const { db } = makeDb({ artifactResult: { data: 'existing-artifact', error: null } });
      const deps = makeDocusignEnvelopeJobDeps({ db });

      const result = await deps.enqueueSignedDocument({ ...SINK_INPUT });

      expect(result).toEqual({ queuedId: 'existing-artifact' });
    });

    it('does not put the fingerprint or raw bytes into the integration_events audit details', async () => {
      const { db, state } = makeDb();
      const deps = makeDocusignEnvelopeJobDeps({ db });

      await deps.enqueueSignedDocument({ ...SINK_INPUT });

      expect(state.insertedDetails).toMatchObject({
        account_id: 'account-1',
        envelope_id: 'envelope-1',
        rule_event_id: 'rule-event-1',
        content_type: 'application/pdf',
        byte_length: 12,
        connector_artifact_id: 'artifact-1',
      });
      expect(state.insertedDetails).not.toHaveProperty('document_sha256');
      expect(state.insertedDetails).not.toHaveProperty('fingerprint');
      expect(state.insertedDetails).not.toHaveProperty('fingerprint_sha256');
      // Defensive: the raw signed bytes never appear anywhere in the audit row.
      expect(JSON.stringify(state.insertedDetails)).not.toContain('signed bytes');
    });

    it('fails closed when the connector-artifact enqueue errors (throws, no audit write)', async () => {
      const { db, state } = makeDb({ artifactResult: { data: null, error: { code: '23514' } } });
      const deps = makeDocusignEnvelopeJobDeps({ db });

      await expect(deps.enqueueSignedDocument({ ...SINK_INPUT })).rejects.toThrow(
        'docusign_connector_artifact_enqueue_failed',
      );
      // No partial state: the audit breadcrumb is never written when the durable
      // artifact failed.
      expect(state.insertCalled).toBe(false);
    });

    it('fails closed when the RPC returns no artifact id', async () => {
      const { db } = makeDb({ artifactResult: { data: null, error: null } });
      const deps = makeDocusignEnvelopeJobDeps({ db });

      await expect(deps.enqueueSignedDocument({ ...SINK_INPUT })).rejects.toThrow(
        'docusign_connector_artifact_enqueue_failed',
      );
    });

    // DS-03 (SCRUM-2363) — feature-flag guard. The connector_artifact drain
    // (QUEUE-06/SCRUM-2352, QUEUE-08/SCRUM-2354) is unbuilt, so DS-03 ships
    // DORMANT behind ENABLE_CONNECTOR_ARTIFACT_ENQUEUE (default off in prod):
    // no rows are enqueued until something drains them.
    it('skips the enqueue gracefully when ENABLE_CONNECTOR_ARTIFACT_ENQUEUE is off (no RPC, no throw, no audit write)', async () => {
      process.env.ENABLE_CONNECTOR_ARTIFACT_ENQUEUE = 'false';
      const { db, rpcCalls, state } = makeDb();
      const deps = makeDocusignEnvelopeJobDeps({ db });

      // Must NOT throw — a dormant connector path is a graceful no-op, not a failure.
      const result = await deps.enqueueSignedDocument({ ...SINK_INPUT });

      // No connector_artifact row: the idempotent enqueue RPC is never called.
      expect(rpcCalls).toHaveLength(0);
      expect(db.rpc).not.toHaveBeenCalled();
      // No partial state: the integration_events audit breadcrumb is not written
      // either (nothing was enqueued to reference).
      expect(state.insertCalled).toBe(false);
      // A structured breadcrumb records the disabled path — and it carries NO
      // fingerprint and NO raw bytes (§1.6A).
      expect(logger.info).toHaveBeenCalledWith(
        { integrationId: 'integration-1' },
        expect.stringContaining('ENABLE_CONNECTOR_ARTIFACT_ENQUEUE'),
      );
      const loggedBreadcrumbs = (logger.info as unknown as { mock: { calls: unknown[][] } }).mock
        .calls;
      const serialized = JSON.stringify(loggedBreadcrumbs);
      expect(serialized).not.toContain(EXPECTED_SHA256);
      expect(serialized).not.toContain('fingerprint');
      expect(serialized).not.toContain('signed bytes');
      // The skip result is a clearly non-id sentinel, never a real artifact id.
      expect(result.queuedId).not.toBe('artifact-1');
      expect(result.queuedId).toContain('disabled');
    });

    it('enqueues exactly as today when ENABLE_CONNECTOR_ARTIFACT_ENQUEUE is on', async () => {
      process.env.ENABLE_CONNECTOR_ARTIFACT_ENQUEUE = 'true';
      const { db, rpcCalls } = makeDb();
      const deps = makeDocusignEnvelopeJobDeps({ db });

      const result = await deps.enqueueSignedDocument({ ...SINK_INPUT });

      // Unchanged behavior: one idempotent enqueue RPC with the server-side digest.
      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0].fn).toBe('enqueue_connector_artifact');
      expect(rpcCalls[0].args).toMatchObject({
        p_org_id: ORG_ID,
        p_source: 'docusign',
        p_external_ref: 'envelope-1',
        p_fingerprint_sha256: EXPECTED_SHA256,
        p_byte_length: SIGNED_BYTES.byteLength,
      });
      expect(result).toEqual({ queuedId: 'artifact-1' });
    });

    // DS-04 (SCRUM-2364): an org-scoped envelope carries NO owner_user_id in the
    // artifact metadata — routing to the org queue is the absence of an owner.
    it('omits owner_user_id from artifact metadata for an org-scoped envelope (DS-04)', async () => {
      const { db, rpcCalls } = makeDb();
      const deps = makeDocusignEnvelopeJobDeps({ db });

      await deps.enqueueSignedDocument({ ...SINK_INPUT, scope: 'org', ownerUserId: null });

      const metadata = rpcCalls[0].args.p_metadata as Record<string, unknown>;
      expect(metadata).toMatchObject({ queue_scope: 'org' });
      expect(metadata).not.toHaveProperty('owner_user_id');
    });

    // DS-04 (SCRUM-2364): a member-owned envelope routes to the PERSONAL queue —
    // materialization is scoped to the owning user via owner_user_id in metadata.
    it('stamps owner_user_id + member scope into artifact metadata for a member envelope (DS-04)', async () => {
      const MEMBER_USER = '55555555-5555-4555-8555-555555555555';
      const { db, rpcCalls } = makeDb();
      const deps = makeDocusignEnvelopeJobDeps({ db });

      const result = await deps.enqueueSignedDocument({
        ...SINK_INPUT,
        scope: 'member',
        ownerUserId: MEMBER_USER,
      });

      expect(rpcCalls).toHaveLength(1);
      const metadata = rpcCalls[0].args.p_metadata as Record<string, unknown>;
      expect(metadata).toMatchObject({
        queue_scope: 'member',
        owner_user_id: MEMBER_USER,
        envelope_id: 'envelope-1',
      });
      expect(result).toEqual({ queuedId: 'artifact-1' });
    });

    // DS-04: member routing must be self-consistent — a 'member' scope with no
    // owning user is a programming error and must fail closed, never silently
    // materialize an unowned personal-queue artifact.
    it('fails closed when a member-scoped envelope has no owner_user_id (DS-04)', async () => {
      const { db, rpcCalls } = makeDb();
      const deps = makeDocusignEnvelopeJobDeps({ db });

      await expect(
        deps.enqueueSignedDocument({ ...SINK_INPUT, scope: 'member', ownerUserId: null }),
      ).rejects.toThrow('docusign_member_scope_missing_owner');
      expect(rpcCalls).toHaveLength(0);
    });
  });

  it('resolves member_integrations when no org_integrations row matches', async () => {
    const queriedTables: string[] = [];
    const memberRow = {
      id: 'member-int-1',
      org_id: '11111111-1111-4111-8111-111111111111',
      account_id: 'account-1',
      base_uri: 'https://demo.docusign.net',
      token_secret_name: 'secret/member-int-1',
      // DS-04: member_integrations carries the owning user; the resolver maps it
      // to owner_user_id ⇒ member scope ⇒ personal-queue materialization.
      user_id: '66666666-6666-4666-8666-666666666666',
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
      // DS-04: the member connection surfaces its personal-queue routing to the
      // materializer — scope 'member' + the owning user id.
      scope: 'member',
      ownerUserId: '66666666-6666-4666-8666-666666666666',
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
      // DS-04: inherited connections are org policy — org scope, no owner user.
      scope: 'org',
      ownerUserId: null,
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
