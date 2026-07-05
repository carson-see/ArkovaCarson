/**
 * Tests for the Daily Queue Review Digest (QUEUE-07 — SCRUM-2353).
 *
 * Covers the three DoD test areas:
 *   1. org / sub-org visibility scoping (an admin sees only their scope)
 *   2. the no-raw-content guarantee (§1.6 — no document bytes/filenames/PII)
 *   3. suppression + retry + idempotency behavior
 *
 * The SUT has no config/db imports at module scope (all deps are injected),
 * so no vi.mock of config/db/logger is required.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  assertNoRawContent,
  buildDigestPayload,
  deliverDigestToAdmin,
  type DigestScope,
  type DigestUrls,
  type DigestStore,
  type DeliveryLogRow,
} from './queue-digest.js';

const urls: DigestUrls = {
  reviewQueueUrl: (orgId) => `https://app.arkova.ai/org/${orgId}/review`,
  preferencesUrl: (orgId) => `https://app.arkova.ai/org/${orgId}/settings/notifications`,
};

function scope(overrides: Partial<DigestScope> = {}): DigestScope {
  return {
    adminEmail: 'admin@acme.example',
    adminOrgId: 'org-acme',
    measuredAt: '2026-06-29T08:00:00.000Z',
    orgMetrics: [
      { orgId: 'org-acme', orgName: 'Acme HQ', openCount: 12, agedCount: 3, failedConnectorCount: 1 },
    ],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Org / sub-org visibility scoping
// ─────────────────────────────────────────────────────────────────────────────

describe('buildDigestPayload — visibility scoping', () => {
  it('covers only the admin org and its owned sub-orgs (never a sibling org)', () => {
    const payload = buildDigestPayload(
      scope({
        orgMetrics: [
          { orgId: 'org-acme', orgName: 'Acme HQ', openCount: 5, agedCount: 1, failedConnectorCount: 0 },
          { orgId: 'org-acme-west', orgName: 'Acme West', openCount: 2, agedCount: 0, failedConnectorCount: 1 },
        ],
      }),
      urls,
    );
    expect(payload).not.toBeNull();
    // Scope is exactly the supplied (owned) orgs — no foreign org leaks in.
    expect(payload!.scopeOrgIds).toEqual(['org-acme', 'org-acme-west']);
    // A sibling/foreign org id never appears in the rendered HTML.
    expect(payload!.html).not.toContain('org-globex');
    expect(payload!.html).toContain('Acme HQ');
    expect(payload!.html).toContain('Acme West');
  });

  it('rolls up totals across the visible scope only', () => {
    const payload = buildDigestPayload(
      scope({
        orgMetrics: [
          { orgId: 'org-acme', orgName: 'Acme HQ', openCount: 5, agedCount: 1, failedConnectorCount: 0 },
          { orgId: 'org-acme-west', orgName: 'Acme West', openCount: 2, agedCount: 4, failedConnectorCount: 1 },
        ],
      }),
      urls,
    );
    expect(payload!.totals).toEqual({ open: 7, aged: 5, failedConnector: 1 });
  });

  it('action links point only at orgs in the admin scope', () => {
    const payload = buildDigestPayload(
      scope({
        orgMetrics: [
          { orgId: 'org-acme', orgName: 'Acme HQ', openCount: 5, agedCount: 1, failedConnectorCount: 0 },
          { orgId: 'org-acme-west', orgName: 'Acme West', openCount: 2, agedCount: 0, failedConnectorCount: 0 },
        ],
      }),
      urls,
    );
    expect(payload!.html).toContain('https://app.arkova.ai/org/org-acme/review');
    expect(payload!.html).toContain('https://app.arkova.ai/org/org-acme-west/review');
    // The preferences link is scoped to the admin's primary org.
    expect(payload!.html).toContain(
      'https://app.arkova.ai/org/org-acme/settings/notifications',
    );
  });

  it('returns null for a quiet queue (no daily email when nothing is pending)', () => {
    const payload = buildDigestPayload(
      scope({
        orgMetrics: [
          { orgId: 'org-acme', orgName: 'Acme HQ', openCount: 0, agedCount: 0, failedConnectorCount: 0 },
        ],
      }),
      urls,
    );
    expect(payload).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. No-raw-content guarantee (§1.6)
// ─────────────────────────────────────────────────────────────────────────────

describe('assertNoRawContent — §1.6 no raw document content / PII', () => {
  it('passes for a counts-only scope', () => {
    expect(() => assertNoRawContent(scope())).not.toThrow();
  });

  it('throws on a forbidden document-content key', () => {
    expect(() =>
      assertNoRawContent({ orgId: 'x', content: 'secret memo text' }),
    ).toThrow(/forbidden key "content"/);
  });

  it.each([
    'filename',
    'fingerprint',
    'sha256',
    'ocr',
    'rawText',
    'mimeType',
    'document',
  ])('throws on forbidden key %s (case-insensitive)', (key) => {
    expect(() => assertNoRawContent({ [key]: 'x' })).toThrow();
    expect(() => assertNoRawContent({ [key.toUpperCase()]: 'x' })).toThrow();
  });

  it('throws on a binary value by TYPE even under an innocuous key name', () => {
    expect(() =>
      assertNoRawContent({ count: 3, attachment: Buffer.from('PDFBYTES') }),
    ).toThrow(/binary value/);
    expect(() =>
      assertNoRawContent({ count: 3, blob: new Uint8Array([1, 2, 3]) }),
    ).toThrow(/binary value/);
  });

  it('detects forbidden keys nested in arrays', () => {
    expect(() =>
      assertNoRawContent({ items: [{ ok: 1 }, { ok: 2, filename: 'leak.pdf' }] }),
    ).toThrow(/forbidden key "filename"/);
  });
});

describe('buildDigestPayload — rendered output carries no document content', () => {
  it('the HTML + subject contain only counts, org names, action links — no doc data', () => {
    const payload = buildDigestPayload(scope(), urls)!;
    // Only the recipient admin email + org display names + counts + links.
    expect(payload.adminEmail).toBe('admin@acme.example');
    // Subject is counts-only.
    expect(payload.subject).toMatch(/\d+ items? awaiting review/);
    // The rendered payload itself must survive the no-raw-content guard.
    expect(() =>
      assertNoRawContent({ subject: payload.subject, scopeOrgIds: payload.scopeOrgIds }),
    ).not.toThrow();
    // Sanity: no obvious document-ish artifacts in the body.
    expect(payload.html).not.toMatch(/\.pdf|\.docx|fingerprint|sha256/i);
  });

  it('refuses to build (throws) if the scope is poisoned with document bytes', () => {
    const poisoned = scope() as unknown as Record<string, unknown>;
    poisoned.orgMetrics = [
      {
        orgId: 'org-acme',
        orgName: 'Acme HQ',
        openCount: 1,
        agedCount: 0,
        failedConnectorCount: 0,
        // A future bug widens the metric to carry raw bytes — must be caught.
        document: Buffer.from('CONFIDENTIAL'),
      },
    ];
    expect(() =>
      buildDigestPayload(poisoned as unknown as DigestScope, urls),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Suppression + retry + idempotency
// ─────────────────────────────────────────────────────────────────────────────

function makeStore(over: Partial<DigestStore> = {}): {
  store: DigestStore;
  recorded: DeliveryLogRow[];
} {
  const recorded: DeliveryLogRow[] = [];
  const store: DigestStore = {
    isSuppressed: vi.fn(async () => false),
    getDeliveryLog: vi.fn(async () => null),
    recordDelivery: vi.fn(async (row: DeliveryLogRow) => {
      recorded.push(row);
    }),
    // F3: default reservation wins (single-worker happy path). Concurrency tests
    // override reserveDelivery to return false (loser).
    reserveDelivery: vi.fn(async () => true),
    releaseDelivery: vi.fn(async () => {}),
    ...over,
  };
  return { store, recorded };
}

describe('deliverDigestToAdmin — F3 atomic reservation (concurrent double-send)', () => {
  it('loser (reservation conflict) returns ALREADY_SENT and NEVER sends', async () => {
    const { store, recorded } = makeStore({ reserveDelivery: vi.fn(async () => false) });
    const sendEmail = vi.fn(async () => ({ success: true, messageId: 'm1' }));
    const r = await deliverDigestToAdmin(scope(), { store, urls, sendEmail, digestDate: '2026-06-29' });
    expect(r.status).toBe('ALREADY_SENT');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });

  it('winner reserves BEFORE sending (reservation precedes the email)', async () => {
    const order: string[] = [];
    const { store } = makeStore({
      reserveDelivery: vi.fn(async () => {
        order.push('reserve');
        return true;
      }),
    });
    const sendEmail = vi.fn(async () => {
      order.push('send');
      return { success: true, messageId: 'm1' };
    });
    const r = await deliverDigestToAdmin(scope(), { store, urls, sendEmail, digestDate: '2026-06-29' });
    expect(r.status).toBe('SENT');
    expect(order).toEqual(['reserve', 'send']);
  });

  it('send failure RELEASES the reservation (so the day can retry) and records FAILED', async () => {
    const { store, recorded } = makeStore();
    const sendEmail = vi.fn(async () => ({ success: false, error: 'smtp down' }));
    const r = await deliverDigestToAdmin(scope(), { store, urls, sendEmail, digestDate: '2026-06-29' });
    expect(r.status).toBe('FAILED');
    expect(store.releaseDelivery).toHaveBeenCalledTimes(1);
    expect(recorded.some((row) => row.status === 'FAILED')).toBe(true);
  });
});

describe('deliverDigestToAdmin — suppression', () => {
  it('skips a suppressed recipient and never calls sendEmail', async () => {
    const { store, recorded } = makeStore({ isSuppressed: vi.fn(async () => true) });
    const sendEmail = vi.fn(async () => ({ success: true, messageId: 'm1' }));

    const result = await deliverDigestToAdmin(scope(), {
      store,
      urls,
      sendEmail,
      digestDate: '2026-06-29',
    });

    expect(result.status).toBe('SUPPRESSED');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(recorded.at(-1)).toMatchObject({ status: 'SUPPRESSED' });
  });
});

describe('deliverDigestToAdmin — delivery + logging', () => {
  it('sends, logs SENT, and uses the queue_reminder email type scoped to the org', async () => {
    const { store } = makeStore();
    const sendEmail = vi.fn(async () => ({ success: true, messageId: 'm1' }));

    const result = await deliverDigestToAdmin(scope(), {
      store,
      urls,
      sendEmail,
      digestDate: '2026-06-29',
    });

    expect(result.status).toBe('SENT');
    expect(result.attempts).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'admin@acme.example',
        emailType: 'queue_reminder',
        orgId: 'org-acme',
      }),
    );
    // F3: the SENT idempotency marker is now written by the reserve (before send),
    // so it is the reservation — not a post-send recordDelivery — that carries it.
    expect(store.reserveDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'SENT', attempts: 1 }),
    );
  });

  it('skips an empty-queue admin without sending', async () => {
    const { store } = makeStore();
    const sendEmail = vi.fn(async () => ({ success: true }));
    const result = await deliverDigestToAdmin(
      scope({
        orgMetrics: [
          { orgId: 'org-acme', orgName: 'Acme HQ', openCount: 0, agedCount: 0, failedConnectorCount: 0 },
        ],
      }),
      { store, urls, sendEmail, digestDate: '2026-06-29' },
    );
    expect(result.status).toBe('SKIPPED_EMPTY');
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('deliverDigestToAdmin — idempotency + retry', () => {
  it('does NOT re-send when a SENT delivery log already exists for the date', async () => {
    const { store } = makeStore({
      getDeliveryLog: vi.fn(async () => ({
        adminEmail: 'admin@acme.example',
        adminOrgId: 'org-acme',
        digestDate: '2026-06-29',
        status: 'SENT' as const,
        attempts: 1,
      })),
    });
    const sendEmail = vi.fn(async () => ({ success: true }));

    const result = await deliverDigestToAdmin(scope(), {
      store,
      urls,
      sendEmail,
      digestDate: '2026-06-29',
    });

    expect(result.status).toBe('ALREADY_SENT');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('retries after a prior FAILED attempt, incrementing the attempt count', async () => {
    const { store } = makeStore({
      getDeliveryLog: vi.fn(async () => ({
        adminEmail: 'admin@acme.example',
        adminOrgId: 'org-acme',
        digestDate: '2026-06-29',
        status: 'FAILED' as const,
        attempts: 1,
      })),
    });
    const sendEmail = vi.fn(async () => ({ success: true, messageId: 'm2' }));

    const result = await deliverDigestToAdmin(scope(), {
      store,
      urls,
      sendEmail,
      digestDate: '2026-06-29',
      maxAttempts: 3,
    });

    expect(result.status).toBe('SENT');
    expect(result.attempts).toBe(2);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // F3: SENT marker is written by the reserve, carrying the incremented attempt.
    expect(store.reserveDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'SENT', attempts: 2 }),
    );
  });

  it('records FAILED (not SENT) when the send fails, leaving it retryable', async () => {
    const { store, recorded } = makeStore();
    const sendEmail = vi.fn(async () => ({ success: false, error: 'resend 500' }));

    const result = await deliverDigestToAdmin(scope(), {
      store,
      urls,
      sendEmail,
      digestDate: '2026-06-29',
    });

    expect(result.status).toBe('FAILED');
    expect(result.attempts).toBe(1);
    expect(recorded.at(-1)).toMatchObject({ status: 'FAILED', attempts: 1 });
  });

  it('gives up (FAILED, no send) once attempts reach maxAttempts', async () => {
    const { store } = makeStore({
      getDeliveryLog: vi.fn(async () => ({
        adminEmail: 'admin@acme.example',
        adminOrgId: 'org-acme',
        digestDate: '2026-06-29',
        status: 'FAILED' as const,
        attempts: 3,
      })),
    });
    const sendEmail = vi.fn(async () => ({ success: true }));

    const result = await deliverDigestToAdmin(scope(), {
      store,
      urls,
      sendEmail,
      digestDate: '2026-06-29',
      maxAttempts: 3,
    });

    expect(result.status).toBe('FAILED');
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
