import { beforeEach, describe, expect, it, vi } from 'vitest';

const captureMessageMock = vi.hoisted(() => vi.fn());
vi.mock('@sentry/node', () => ({ captureMessage: captureMessageMock }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  reconcileDocusignQueueDrift,
  type QueueReconciliationDeps,
  type QueueActiveIntegration,
  type CompletedEnvelopeRef,
} from './docusign-queue-reconciliation.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const INT_ORG: QueueActiveIntegration = {
  id: 'int-org-1',
  org_id: ORG_A,
  account_id: 'acct-a',
  base_uri: 'https://na1.docusign.net',
  token_secret_name: 'secret/org-a',
  scope: 'org',
  owner_user_id: null,
};

const INT_MEMBER: QueueActiveIntegration = {
  id: 'int-member-1',
  org_id: ORG_B,
  account_id: 'acct-b',
  base_uri: 'https://na1.docusign.net',
  token_secret_name: 'secret/member-b',
  scope: 'member',
  owner_user_id: '33333333-3333-4333-8333-333333333333',
};

function env(name: string): CompletedEnvelopeRef {
  return { envelopeId: name, status: 'completed', completedDateTime: '2026-06-30T00:00:00.000Z' };
}

function makeDeps(overrides: Partial<QueueReconciliationDeps> = {}): QueueReconciliationDeps {
  return {
    listActiveIntegrations: vi.fn().mockResolvedValue([]),
    getAccessToken: vi.fn().mockResolvedValue('access-token'),
    listCompletedEnvelopes: vi.fn().mockResolvedValue([]),
    getQueuedEnvelopeRefs: vi.fn().mockResolvedValue(new Set<string>()),
    materializeMissingEnvelope: vi.fn().mockResolvedValue({ enqueued: true, error: null }),
    recordDriftAudit: vi.fn().mockResolvedValue({ error: null }),
    ...overrides,
  };
}

beforeEach(() => {
  captureMessageMock.mockReset();
});

describe('reconcileDocusignQueueDrift', () => {
  it('detects a completed envelope missing from the queue and materializes it idempotently', async () => {
    const materializeMissingEnvelope = vi.fn().mockResolvedValue({ enqueued: true, error: null });
    const deps = makeDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([INT_ORG]),
      listCompletedEnvelopes: vi.fn().mockResolvedValue([env('env-present'), env('env-missing')]),
      // Only env-present is already queued — env-missing is drift.
      getQueuedEnvelopeRefs: vi.fn().mockResolvedValue(new Set(['env-present'])),
      materializeMissingEnvelope,
    });

    const result = await reconcileDocusignQueueDrift(deps);

    expect(result.ok).toBe(true);
    expect(result.integrations_checked).toBe(1);
    expect(result.envelopes_polled).toBe(2);
    expect(result.drift_detected).toBe(1);
    expect(result.materialized).toBe(1);
    // Materialization is scoped to the integration + its queue routing so the
    // missing item lands in the correct (org vs personal) queue.
    expect(materializeMissingEnvelope).toHaveBeenCalledTimes(1);
    expect(materializeMissingEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: INT_ORG,
        envelope: expect.objectContaining({ envelopeId: 'env-missing' }),
      }),
    );
  });

  it('is a no-op when every completed envelope is already queued (no drift, no alert)', async () => {
    const materializeMissingEnvelope = vi.fn();
    const deps = makeDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([INT_ORG]),
      listCompletedEnvelopes: vi.fn().mockResolvedValue([env('a'), env('b')]),
      getQueuedEnvelopeRefs: vi.fn().mockResolvedValue(new Set(['a', 'b'])),
      materializeMissingEnvelope,
    });

    const result = await reconcileDocusignQueueDrift(deps);

    expect(result.drift_detected).toBe(0);
    expect(result.materialized).toBe(0);
    expect(materializeMissingEnvelope).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('fires a bounded Sentry alert + writes a bounded audit event per drift (no bytes/PII beyond ids)', async () => {
    const recordDriftAudit = vi.fn().mockResolvedValue({ error: null });
    const deps = makeDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([INT_ORG]),
      listCompletedEnvelopes: vi.fn().mockResolvedValue([env('env-missing')]),
      getQueuedEnvelopeRefs: vi.fn().mockResolvedValue(new Set<string>()),
      recordDriftAudit,
    });

    const result = await reconcileDocusignQueueDrift(deps);

    expect(result.alerts_fired).toBe(1);
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    expect(recordDriftAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: ORG_A,
        integration_id: 'int-org-1',
        envelope_id: 'env-missing',
      }),
    );
    // The Sentry extra must not smuggle a fingerprint / document bytes — only ids.
    const sentryArgs = JSON.stringify(captureMessageMock.mock.calls[0]);
    expect(sentryArgs).not.toMatch(/[a-f0-9]{64}/);
  });

  it('routes member-owned drift to the personal queue via the integration scope', async () => {
    const materializeMissingEnvelope = vi.fn().mockResolvedValue({ enqueued: true, error: null });
    const deps = makeDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([INT_MEMBER]),
      listCompletedEnvelopes: vi.fn().mockResolvedValue([env('env-member-missing')]),
      getQueuedEnvelopeRefs: vi.fn().mockResolvedValue(new Set<string>()),
      materializeMissingEnvelope,
    });

    const result = await reconcileDocusignQueueDrift(deps);

    expect(result.materialized).toBe(1);
    expect(materializeMissingEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: expect.objectContaining({ scope: 'member', owner_user_id: INT_MEMBER.owner_user_id }),
      }),
    );
  });

  it('per-org isolation: one integration failing does not stop the others', async () => {
    const deps = makeDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([INT_ORG, INT_MEMBER]),
      getAccessToken: vi.fn().mockImplementation(async (i: QueueActiveIntegration) => {
        if (i.id === INT_ORG.id) throw new Error('token boom');
        return 'access-token';
      }),
      listCompletedEnvelopes: vi.fn().mockResolvedValue([env('env-member-missing')]),
      getQueuedEnvelopeRefs: vi.fn().mockResolvedValue(new Set<string>()),
    });

    const result = await reconcileDocusignQueueDrift(deps);

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].integration_id).toBe(INT_ORG.id);
    // The healthy member integration still materialized its drift.
    expect(result.materialized).toBe(1);
  });

  it('records a materialize failure without aborting the run (fail-open per row, ok=false)', async () => {
    const deps = makeDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([INT_ORG]),
      listCompletedEnvelopes: vi.fn().mockResolvedValue([env('m1'), env('m2')]),
      getQueuedEnvelopeRefs: vi.fn().mockResolvedValue(new Set<string>()),
      materializeMissingEnvelope: vi
        .fn()
        .mockResolvedValueOnce({ enqueued: false, error: 'enqueue boom' })
        .mockResolvedValueOnce({ enqueued: true, error: null }),
    });

    const result = await reconcileDocusignQueueDrift(deps);

    expect(result.drift_detected).toBe(2);
    expect(result.materialized).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.error.includes('enqueue boom'))).toBe(true);
  });

  it('returns a hard failure when listing integrations throws', async () => {
    const deps = makeDeps({
      listActiveIntegrations: vi.fn().mockRejectedValue(new Error('list boom')),
    });

    const result = await reconcileDocusignQueueDrift(deps);

    expect(result.ok).toBe(false);
    expect(result.integrations_checked).toBe(0);
    expect(result.errors[0]).toEqual({ integration_id: '*', error: 'list boom' });
  });
});
