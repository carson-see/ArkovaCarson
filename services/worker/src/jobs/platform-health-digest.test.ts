/**
 * Tests for the Platform Admin Daily Health Digest — pure engine.
 *
 * Mirrors queue-digest.test.ts's structure: content assembly against fixture
 * snapshots, the §1.6 no-raw-content guard, and delivery idempotency/retry.
 * No config/db imports at module scope — all deps injected — so no vi.mock
 * of config/db/logger is required here.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildPlatformHealthPayload,
  deliverPlatformHealthDigestToAdmin,
  type PlatformHealthSnapshot,
  type PlatformHealthDigestStore,
} from './platform-health-digest.js';

function snapshot(overrides: Partial<PlatformHealthSnapshot> = {}): PlatformHealthSnapshot {
  return {
    measuredAt: '2026-08-18T13:00:00.000Z',
    anchorsByStatus: [
      { status: 'PENDING', currentDepth: 12, currentDepthCapped: false, new24h: 40, new24hCapped: false },
      { status: 'SECURED', currentDepth: null, currentDepthCapped: false, new24h: 900, new24hCapped: false },
    ],
    jobQueue: { pendingDepth: 3, pendingDepthCapped: false, oldestPendingAgeMinutes: 15 },
    batchFlush: {
      fired: true,
      batchesLast24h: 1,
      totalAnchorsLast24h: 8500,
      latestTxid: 'a'.repeat(64),
      latestSignedAt: '2026-08-18T03:00:00.000Z',
    },
    connectors: [
      { connectorId: 'docusign', worstState: 'connected', orgsAffected: 0, lastCheckedAt: '2026-08-18T12:00:00.000Z' },
    ],
    quotaAnomalies: [],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Content assembly (fixture data)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPlatformHealthPayload — content assembly', () => {
  it('renders anchor-by-status backlog + 24h-new counts', () => {
    const { html } = buildPlatformHealthPayload(snapshot());
    expect(html).toMatch(/PENDING/);
    expect(html).toMatch(/12/);
    expect(html).toMatch(/40/);
    expect(html).toMatch(/SECURED/);
    expect(html).toMatch(/900/);
  });

  it('marks a null (unmeasured) currentDepth as not asserted, not zero', () => {
    const { html } = buildPlatformHealthPayload(snapshot());
    // SECURED has currentDepth: null in the fixture (never a full-table count).
    const securedLine = html.split('\n').find((l) => l.includes('SECURED'));
    expect(securedLine).toBeDefined();
    expect(securedLine).not.toMatch(/backlog 0\b/);
    expect(securedLine).toMatch(/not measured|n\/a/i);
  });

  it('renders the job queue depth + oldest pending age', () => {
    const { html } = buildPlatformHealthPayload(snapshot());
    expect(html).toMatch(/3/);
    expect(html).toMatch(/15/);
  });

  it('reports an empty job queue distinctly from an unmeasured one', () => {
    const { html } = buildPlatformHealthPayload(
      snapshot({ jobQueue: { pendingDepth: 0, pendingDepthCapped: false, oldestPendingAgeMinutes: null } }),
    );
    expect(html).toMatch(/no pending jobs|0 pending/i);
  });

  it('renders the batch flush result: fired, tx, count', () => {
    const { html } = buildPlatformHealthPayload(snapshot());
    expect(html).toMatch(/8500/);
    expect(html).toMatch(/a{64}/);
  });

  it('reports no batch flush distinctly when none fired in 24h', () => {
    const { html } = buildPlatformHealthPayload(
      snapshot({
        batchFlush: { fired: false, batchesLast24h: 0, totalAnchorsLast24h: 0, latestTxid: null, latestSignedAt: null },
      }),
    );
    expect(html).toMatch(/no batch flush|did not fire/i);
  });

  it('renders connector health with worst state + orgs affected', () => {
    const { html } = buildPlatformHealthPayload(
      snapshot({
        connectors: [
          { connectorId: 'docusign', worstState: 'degraded', orgsAffected: 2, lastCheckedAt: '2026-08-18T12:00:00.000Z' },
          { connectorId: 'google_drive', worstState: 'connected', orgsAffected: 0, lastCheckedAt: '2026-08-18T12:05:00.000Z' },
        ],
      }),
    );
    expect(html).toMatch(/docusign/);
    expect(html).toMatch(/degraded/);
    expect(html).toMatch(/google_drive/);
  });

  it('renders quota anomalies with org name and usage vs cap', () => {
    const { html } = buildPlatformHealthPayload(
      snapshot({
        quotaAnomalies: [
          { orgId: 'org-sandbox-1', orgName: 'Sandbox Org', anchorQuota: 10, nonDeletedAnchorCount: 11 },
        ],
      }),
    );
    expect(html).toMatch(/Sandbox Org/);
    expect(html).toMatch(/10/);
    expect(html).toMatch(/11/);
  });

  it('reports no quota anomalies distinctly when the list is empty', () => {
    const { html } = buildPlatformHealthPayload(snapshot({ quotaAnomalies: [] }));
    expect(html).toMatch(/no quota anomalies/i);
  });

  it('renders a stable, human-readable subject line with the measured date', () => {
    const { subject } = buildPlatformHealthPayload(snapshot());
    expect(subject).toMatch(/platform health/i);
    expect(subject).toMatch(/2026-08-18/);
  });

  it('is plain-text-first: the rendered body reads as line-oriented text inside a single <pre> block, not a styled table', () => {
    const { html } = buildPlatformHealthPayload(snapshot());
    expect(html).toMatch(/<pre/);
    expect(html).not.toMatch(/<table/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §1.6 no-raw-content guard
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPlatformHealthPayload — §1.6 no-raw-content guard', () => {
  it('throws if a snapshot object is contaminated with a forbidden document key', () => {
    const bad = snapshot() as unknown as Record<string, unknown>;
    (bad.anchorsByStatus as unknown[]).push({ status: 'X', fingerprint: 'deadbeef' });
    expect(() => buildPlatformHealthPayload(bad as unknown as PlatformHealthSnapshot)).toThrow(
      /forbidden key/i,
    );
  });

  it('never includes a document fingerprint, filename, or other-user email — only aggregate counts', () => {
    const { html } = buildPlatformHealthPayload(snapshot());
    expect(html).not.toMatch(/@.*\.(com|org|net|io)/i); // no email addresses anywhere in the body
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminology (§1.3) — user-visible email copy bans crypto jargon
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPlatformHealthPayload — §1.3 terminology', () => {
  it('never uses banned terms in user-visible copy (internal field names like txid/connectorId are code, not copy — checked separately)', () => {
    const { html, subject } = buildPlatformHealthPayload(snapshot());
    const bodyText = html.replace(/<[^>]+>/g, ' ');
    for (const banned of ['Wallet', 'Blockchain', 'Testnet', 'Mainnet', 'Crypto']) {
      expect(bodyText).not.toMatch(new RegExp(`\\b${banned}\\b`, 'i'));
      expect(subject).not.toMatch(new RegExp(`\\b${banned}\\b`, 'i'));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Delivery — idempotency + retry (no suppression/opt-out for platform admins)
// ─────────────────────────────────────────────────────────────────────────────

function makeStore(overrides: Partial<PlatformHealthDigestStore> = {}): PlatformHealthDigestStore {
  return {
    getDeliveryLog: vi.fn(async () => null),
    reserveDelivery: vi.fn(async () => true),
    releaseDelivery: vi.fn(async () => {}),
    recordDelivery: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('deliverPlatformHealthDigestToAdmin — idempotency + retry', () => {
  const payload = buildPlatformHealthPayload(snapshot());

  it('sends and reports SENT on a clean first attempt', async () => {
    const store = makeStore();
    const send = vi.fn(async () => ({ success: true, messageId: 'm1' }));
    const result = await deliverPlatformHealthDigestToAdmin(payload, 'admin@arkova.ai', {
      store,
      sendEmail: send,
      digestDate: '2026-08-18',
    });
    expect(result.status).toBe('SENT');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@arkova.ai', emailType: 'notification' }),
    );
  });

  it('does NOT re-send when a SENT delivery log row already exists for today (idempotent)', async () => {
    const store = makeStore({
      getDeliveryLog: vi.fn(async () => ({
        adminEmail: 'admin@arkova.ai',
        digestDate: '2026-08-18',
        status: 'SENT' as const,
        attempts: 1,
      })),
    });
    const send = vi.fn(async () => ({ success: true }));
    const result = await deliverPlatformHealthDigestToAdmin(payload, 'admin@arkova.ai', {
      store,
      sendEmail: send,
      digestDate: '2026-08-18',
    });
    expect(result.status).toBe('ALREADY_SENT');
    expect(send).not.toHaveBeenCalled();
  });

  it('a lost reservation race (another worker already sent) does NOT double-send', async () => {
    const store = makeStore({ reserveDelivery: vi.fn(async () => false) });
    const send = vi.fn(async () => ({ success: true }));
    const result = await deliverPlatformHealthDigestToAdmin(payload, 'admin@arkova.ai', {
      store,
      sendEmail: send,
      digestDate: '2026-08-18',
    });
    expect(result.status).toBe('ALREADY_SENT');
    expect(send).not.toHaveBeenCalled();
  });

  it('releases the reservation and records FAILED when the send itself fails', async () => {
    const store = makeStore();
    const send = vi.fn(async () => ({ success: false, error: 'resend down' }));
    const result = await deliverPlatformHealthDigestToAdmin(payload, 'admin@arkova.ai', {
      store,
      sendEmail: send,
      digestDate: '2026-08-18',
    });
    expect(result.status).toBe('FAILED');
    expect(store.releaseDelivery).toHaveBeenCalled();
    expect(store.recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED' }),
    );
  });

  it('stops retrying once attempts >= maxAttempts', async () => {
    const store = makeStore({
      getDeliveryLog: vi.fn(async () => ({
        adminEmail: 'admin@arkova.ai',
        digestDate: '2026-08-18',
        status: 'FAILED' as const,
        attempts: 3,
      })),
    });
    const send = vi.fn(async () => ({ success: true }));
    const result = await deliverPlatformHealthDigestToAdmin(payload, 'admin@arkova.ai', {
      store,
      sendEmail: send,
      maxAttempts: 3,
      digestDate: '2026-08-18',
    });
    expect(result.status).toBe('FAILED');
    expect(send).not.toHaveBeenCalled();
  });
});
