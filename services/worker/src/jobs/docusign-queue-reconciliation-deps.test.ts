import { beforeEach, describe, expect, it, vi } from 'vitest';

const submitJobMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/jobQueue.js', () => ({ submitJob: submitJobMock }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/db.js', () => ({ db: {} }));

import { makeQueueReconciliationDeps } from './docusign-queue-reconciliation-deps.js';
import type { QueueActiveIntegration } from './docusign-queue-reconciliation.js';

const ORG_INT: QueueActiveIntegration = {
  id: 'int-1',
  org_id: '11111111-1111-4111-8111-111111111111',
  account_id: 'acct-1',
  base_uri: 'https://na1.docusign.net',
  token_secret_name: 'secret/1',
  scope: 'org',
  owner_user_id: null,
};

const MEMBER_INT: QueueActiveIntegration = {
  ...ORG_INT,
  id: 'int-m',
  scope: 'member',
  owner_user_id: '99999999-9999-4999-8999-999999999999',
};

beforeEach(() => submitJobMock.mockReset());

// A small table-aware mock db for listActiveIntegrations. Each `from(table)` call
// returns a chainable query that resolves to `datasets[table]` filtered by the
// recorded `.eq`/`.is` predicates (mirroring the PostgREST semantics the deps use).
function makeListDb(datasets: Record<string, Array<Record<string, unknown>>>) {
  return {
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (f: string, v: unknown) => {
          filters.push([f, v]);
          return q;
        },
        is: (f: string, v: unknown) => {
          filters.push([f, v]);
          return q;
        },
        in: () => q,
        then: (resolve: (r: { data: unknown; error: null }) => unknown) => {
          const rows = (datasets[table] ?? []).filter((row) =>
            filters.every(([f, v]) => row[f] === v),
          );
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return q;
    },
  };
}

describe('makeQueueReconciliationDeps', () => {
  describe('listActiveIntegrations', () => {
    const PARENT_ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const CHILD_ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    it('re-attributes an inherited parent connection to the child org (no cross-org double-materialize)', async () => {
      // Parent owns the DocuSign account; the child holds an inheritance marker
      // (account_id null, inherited_from_org_id = parent). DS-03 keys the child's
      // envelopes under CHILD_ORG, so reconciliation must diff/materialize under
      // CHILD_ORG — not PARENT_ORG — while polling with the parent's credentials.
      const db = makeListDb({
        org_integrations: [
          {
            id: 'parent-int',
            org_id: PARENT_ORG,
            account_id: 'acct-shared',
            base_uri: 'https://na1.docusign.net',
            token_secret_name: 'secret/parent',
            provider: 'docusign',
            revoked_at: null,
            inherited_from_org_id: null,
          },
          {
            id: 'child-marker',
            org_id: CHILD_ORG,
            account_id: null,
            base_uri: null,
            token_secret_name: null,
            provider: 'docusign',
            revoked_at: null,
            inherited_from_org_id: PARENT_ORG,
          },
        ],
        member_integrations: [],
      });
      const deps = makeQueueReconciliationDeps({ db: db as never });

      const integrations = await deps.listActiveIntegrations();

      expect(integrations).toHaveLength(1);
      const eff = integrations[0];
      // Keyed under the CHILD org so drift is computed against the org that owns
      // the artifact — this is the fix for cross-org false drift.
      expect(eff.org_id).toBe(CHILD_ORG);
      // Materialization re-drives the producer with the child's marker id (the same
      // integration_id DS-03/the webhook stamped), so the effective connection
      // resolves to the parent again — the 0343 dedupe makes it a true no-op.
      expect(eff.id).toBe('child-marker');
      // Polling still uses the parent's actual account + token secret.
      expect(eff.account_id).toBe('acct-shared');
      expect(eff.token_secret_name).toBe('secret/parent');
      expect(eff.scope).toBe('org');
    });

    it('skips (does not poll) a parent account with ambiguous inherited markers to prevent cross-tenant leak', async () => {
      const CHILD_ORG_2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const db = makeListDb({
        org_integrations: [
          {
            id: 'parent-int',
            org_id: PARENT_ORG,
            account_id: 'acct-shared',
            base_uri: 'https://na1.docusign.net',
            token_secret_name: 'secret/parent',
            provider: 'docusign',
            revoked_at: null,
            inherited_from_org_id: null,
          },
          {
            id: 'child-marker-1',
            org_id: CHILD_ORG,
            account_id: null,
            base_uri: null,
            token_secret_name: null,
            provider: 'docusign',
            revoked_at: null,
            inherited_from_org_id: PARENT_ORG,
          },
          {
            id: 'child-marker-2',
            org_id: CHILD_ORG_2,
            account_id: null,
            base_uri: null,
            token_secret_name: null,
            provider: 'docusign',
            revoked_at: null,
            inherited_from_org_id: PARENT_ORG,
          },
        ],
        member_integrations: [],
      });
      const deps = makeQueueReconciliationDeps({ db: db as never });

      const integrations = await deps.listActiveIntegrations();

      // Ambiguous attribution: the parent account is not polled at all (mirrors the
      // webhook rejecting ambiguous inherited attribution). No child inherits it.
      expect(integrations).toHaveLength(0);
    });

    it('leaves a non-inherited org connection keyed under its own org', async () => {
      const db = makeListDb({
        org_integrations: [
          {
            id: 'own-int',
            org_id: PARENT_ORG,
            account_id: 'acct-own',
            base_uri: 'https://na1.docusign.net',
            token_secret_name: 'secret/own',
            provider: 'docusign',
            revoked_at: null,
            inherited_from_org_id: null,
          },
        ],
        member_integrations: [],
      });
      const deps = makeQueueReconciliationDeps({ db: db as never });

      const integrations = await deps.listActiveIntegrations();

      expect(integrations).toHaveLength(1);
      expect(integrations[0].org_id).toBe(PARENT_ORG);
      expect(integrations[0].id).toBe('own-int');
    });
  });

  describe('getQueuedEnvelopeRefs', () => {
    it('returns the set of already-queued envelope external_refs for the org', async () => {
      const filters: Record<string, unknown> = {};
      const db = {
        from: vi.fn((table: string) => {
          expect(table).toBe('connector_artifact');
          const q = {
            select: vi.fn(() => q),
            eq: vi.fn((f: string, v: unknown) => {
              filters[f] = v;
              return q;
            }),
            in: vi.fn((_f: string, _v: unknown) =>
              Promise.resolve({ data: [{ external_ref: 'env-a' }], error: null }),
            ),
          };
          return q;
        }),
      };
      const deps = makeQueueReconciliationDeps({ db: db as never });

      const refs = await deps.getQueuedEnvelopeRefs(ORG_INT, ['env-a', 'env-b']);

      expect(refs.has('env-a')).toBe(true);
      expect(refs.has('env-b')).toBe(false);
      // Scoped to the org + docusign source.
      expect(filters.org_id).toBe(ORG_INT.org_id);
      expect(filters.source).toBe('docusign');
    });

    it('short-circuits with an empty set when there are no candidate envelopes', async () => {
      const from = vi.fn();
      const deps = makeQueueReconciliationDeps({ db: { from } as never });
      const refs = await deps.getQueuedEnvelopeRefs(ORG_INT, []);
      expect(refs.size).toBe(0);
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('materializeMissingEnvelope', () => {
    it('re-submits the audited producer job (idempotent via 0343) — never touches bytes', async () => {
      submitJobMock.mockResolvedValue('job-1');
      const deps = makeQueueReconciliationDeps({ db: { from: vi.fn() } as never });

      const outcome = await deps.materializeMissingEnvelope({
        integration: MEMBER_INT,
        envelope: { envelopeId: 'env-x', status: 'completed', completedDateTime: '2026-06-30T00:00:00Z' },
      });

      expect(outcome).toEqual({ enqueued: true, error: null });
      expect(submitJobMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'docusign.envelope_completed',
          payload: expect.objectContaining({
            org_id: MEMBER_INT.org_id,
            integration_id: 'int-m',
            envelope_id: 'env-x',
            rule_event_id: 'recon:env-x',
          }),
        }),
      );
    });

    it('reports a failure when the job submit returns null (fail-closed)', async () => {
      submitJobMock.mockResolvedValue(null);
      const deps = makeQueueReconciliationDeps({ db: { from: vi.fn() } as never });
      const outcome = await deps.materializeMissingEnvelope({
        integration: ORG_INT,
        envelope: { envelopeId: 'env-y', status: 'completed', completedDateTime: '2026-06-30T00:00:00Z' },
      });
      expect(outcome.enqueued).toBe(false);
      expect(outcome.error).toBe('job_submit_returned_null');
    });
  });

  describe('recordDriftAudit', () => {
    it('writes an ids-only audit row with member owner + no fingerprint/bytes', async () => {
      let inserted: Record<string, unknown> | undefined;
      const db = {
        from: vi.fn((table: string) => {
          expect(table).toBe('integration_events');
          return {
            insert: vi.fn((v: Record<string, unknown>) => {
              inserted = v;
              return Promise.resolve({ error: null });
            }),
          };
        }),
      };
      const deps = makeQueueReconciliationDeps({ db: db as never });

      const res = await deps.recordDriftAudit({
        org_id: MEMBER_INT.org_id,
        integration_id: MEMBER_INT.id,
        account_id: MEMBER_INT.account_id,
        envelope_id: 'env-z',
        envelope_status: 'completed',
        completed_at: '2026-06-30T00:00:00Z',
        scope: 'member',
        owner_user_id: MEMBER_INT.owner_user_id,
      });

      expect(res).toEqual({ error: null });
      expect(inserted).toMatchObject({ event_type: 'queue_drift_detected', provider: 'docusign' });
      const details = inserted!.details as Record<string, unknown>;
      expect(details).toMatchObject({
        envelope_id: 'env-z',
        queue_scope: 'member',
        owner_user_id: MEMBER_INT.owner_user_id,
      });
      expect(JSON.stringify(details)).not.toMatch(/[a-f0-9]{64}/);
    });

    // FK bug (SCRUM-2365): integration_events.integration_id has a FK to
    // org_integrations(id) ONLY. A member drift row carries a member_integrations
    // id, so writing it into integration_id violates the FK at runtime. For member
    // scope the FK column must be null and the member id carried in details.
    it('writes a member drift row with integration_id null + member id in details (FK-safe)', async () => {
      let inserted: Record<string, unknown> | undefined;
      const db = {
        from: vi.fn(() => ({
          insert: vi.fn((v: Record<string, unknown>) => {
            inserted = v;
            return Promise.resolve({ error: null });
          }),
        })),
      };
      const deps = makeQueueReconciliationDeps({ db: db as never });

      await deps.recordDriftAudit({
        org_id: MEMBER_INT.org_id,
        integration_id: MEMBER_INT.id,
        account_id: MEMBER_INT.account_id,
        envelope_id: 'env-fk',
        envelope_status: 'completed',
        completed_at: '2026-06-30T00:00:00Z',
        scope: 'member',
        owner_user_id: MEMBER_INT.owner_user_id,
      });

      expect(inserted).toMatchObject({ integration_id: null });
      const details = inserted!.details as Record<string, unknown>;
      expect(details).toMatchObject({ member_integration_id: MEMBER_INT.id });
    });

    // An org drift row carries an org_integrations id, which satisfies the FK.
    it('keeps integration_id set for an org drift row (FK satisfied)', async () => {
      let inserted: Record<string, unknown> | undefined;
      const db = {
        from: vi.fn(() => ({
          insert: vi.fn((v: Record<string, unknown>) => {
            inserted = v;
            return Promise.resolve({ error: null });
          }),
        })),
      };
      const deps = makeQueueReconciliationDeps({ db: db as never });

      await deps.recordDriftAudit({
        org_id: ORG_INT.org_id,
        integration_id: ORG_INT.id,
        account_id: ORG_INT.account_id,
        envelope_id: 'env-fk-org',
        envelope_status: 'completed',
        completed_at: '2026-06-30T00:00:00Z',
        scope: 'org',
        owner_user_id: null,
      });

      expect(inserted).toMatchObject({ integration_id: ORG_INT.id });
      const details = inserted!.details as Record<string, unknown>;
      expect(details).not.toHaveProperty('member_integration_id');
    });
  });
});
