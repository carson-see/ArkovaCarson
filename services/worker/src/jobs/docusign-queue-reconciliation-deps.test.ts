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

describe('makeQueueReconciliationDeps', () => {
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
  });
});
