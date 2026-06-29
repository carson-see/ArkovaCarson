/**
 * Tests for the Daily Queue Digest production wiring (QUEUE-07 / SCRUM-2353).
 *
 * Focus: the audit_events-backed DigestStore (suppression/idempotency/retry),
 * sub-org scope resolution (isolation), and the cron loop aggregation. The
 * pure builder/orchestrator is covered in queue-digest.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

// Stub config/db/logger so importing the SUT does not trip loadConfig().
vi.mock('../config.js', () => ({ config: { frontendUrl: 'https://app.arkova.ai' } }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../email/sender.js', () => ({ sendEmail: vi.fn() }));

const {
  buildDigestUrls,
  createAuditBackedStore,
  resolveScopeOrgIds,
  runDailyQueueDigest,
} = await import('./queue-digest-cron.js');

// ── A tiny query-builder mock that records the filters applied and returns a
// configurable terminal result. Mirrors the PostgREST fluent chain shape.
function makeQuery(result: { data: unknown; error?: unknown }) {
  const calls: Array<[string, unknown, unknown]> = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'is', 'not', 'order', 'lt', 'gte']) {
    chain[m] = vi.fn((...args: unknown[]) => {
      calls.push([m, args[0], args[1]]);
      return chain;
    });
  }
  chain.limit = vi.fn(() => Promise.resolve({ data: result.data, error: result.error ?? null }));
  (chain as { _calls: unknown })._calls = calls;
  return chain;
}

describe('buildDigestUrls', () => {
  it('scopes review + preferences links to the org id and strips trailing slash', () => {
    const urls = buildDigestUrls('https://app.arkova.ai/');
    expect(urls.reviewQueueUrl('org-1')).toBe('https://app.arkova.ai/org/org-1/review');
    expect(urls.preferencesUrl('org-1')).toBe(
      'https://app.arkova.ai/org/org-1/settings/notifications',
    );
  });
});

describe('createAuditBackedStore — suppression', () => {
  it('returns true when an UNSUBSCRIBED audit row exists', async () => {
    const database = { from: vi.fn(() => makeQuery({ data: [{ id: 'a1' }] })) };
    const store = createAuditBackedStore(database as never);
    expect(await store.isSuppressed('a@x.com', 'org-1')).toBe(true);
  });

  it('returns false when no UNSUBSCRIBED row exists', async () => {
    const database = { from: vi.fn(() => makeQuery({ data: [] })) };
    const store = createAuditBackedStore(database as never);
    expect(await store.isSuppressed('a@x.com', 'org-1')).toBe(false);
  });

  it('fails CLOSED (suppressed=true) on a read error — never email an opt-out', async () => {
    const database = { from: vi.fn(() => makeQuery({ data: null, error: { msg: 'boom' } })) };
    const store = createAuditBackedStore(database as never);
    expect(await store.isSuppressed('a@x.com', 'org-1')).toBe(true);
  });
});

describe('createAuditBackedStore — delivery log idempotency + retry counting', () => {
  it('reads back today SENT row → status SENT with attempts', async () => {
    const database = {
      from: vi.fn(() =>
        makeQuery({
          data: [
            {
              event_type: 'QUEUE_DIGEST_SENT',
              details: JSON.stringify({ digest_date: '2026-06-29', attempts: 1 }),
            },
          ],
        }),
      ),
    };
    const store = createAuditBackedStore(database as never);
    const log = await store.getDeliveryLog('a@x.com', 'org-1', '2026-06-29');
    expect(log).toMatchObject({ status: 'SENT', attempts: 1 });
  });

  it('ignores a row from a different digest_date (returns null)', async () => {
    const database = {
      from: vi.fn(() =>
        makeQuery({
          data: [
            {
              event_type: 'QUEUE_DIGEST_SENT',
              details: JSON.stringify({ digest_date: '2026-06-28', attempts: 1 }),
            },
          ],
        }),
      ),
    };
    const store = createAuditBackedStore(database as never);
    expect(await store.getDeliveryLog('a@x.com', 'org-1', '2026-06-29')).toBeNull();
  });

  it('records a FAILED delivery as a QUEUE_DIGEST_FAILED audit row (counts-only details)', async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const database = { from: vi.fn(() => ({ insert })) };
    const store = createAuditBackedStore(database as never);
    await store.recordDelivery({
      adminEmail: 'a@x.com',
      adminOrgId: 'org-1',
      digestDate: '2026-06-29',
      status: 'FAILED',
      attempts: 2,
    });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'QUEUE_DIGEST_FAILED',
        org_id: 'org-1',
        target_id: 'a@x.com',
      }),
    );
    // No document content in the persisted details.
    const firstCall = insert.mock.calls[0] as unknown as [{ details: string }];
    const details = firstCall[0].details;
    expect(details).not.toMatch(/content|filename|fingerprint|sha256|bytes/i);
  });
});

describe('resolveScopeOrgIds — sub-org isolation', () => {
  it('includes the admin org + owned sub-orgs, and never a sibling', async () => {
    const database = {
      from: vi.fn(() =>
        makeQuery({ data: [{ id: 'org-child-a' }, { id: 'org-child-b' }] }),
      ),
    };
    const ids = await resolveScopeOrgIds(database as never, 'org-parent');
    expect(ids).toEqual(['org-parent', 'org-child-a', 'org-child-b']);
    expect(ids).not.toContain('org-sibling');
  });

  it('returns just the admin org when it owns no sub-orgs', async () => {
    const database = { from: vi.fn(() => makeQuery({ data: [] })) };
    const ids = await resolveScopeOrgIds(database as never, 'org-solo');
    expect(ids).toEqual(['org-solo']);
  });
});

describe('runDailyQueueDigest — cron loop', () => {
  it('is a no-op when ENABLE_QUEUE_DIGEST=false', async () => {
    const prev = process.env.ENABLE_QUEUE_DIGEST;
    process.env.ENABLE_QUEUE_DIGEST = 'false';
    const send = vi.fn(async () => ({ success: true }));
    const result = await runDailyQueueDigest({
      database: { from: vi.fn() } as never,
      send: send as never,
    });
    expect(result.admins).toBe(0);
    expect(send).not.toHaveBeenCalled();
    if (prev === undefined) delete process.env.ENABLE_QUEUE_DIGEST;
    else process.env.ENABLE_QUEUE_DIGEST = prev;
  });

  it('sends one scoped digest per admin and aggregates the result', async () => {
    delete process.env.ENABLE_QUEUE_DIGEST;

    // Route per-table so the loop reads admins, scope, names, metrics, store.
    const database = {
      from: vi.fn((table: string) => {
        switch (table) {
          case 'profiles':
            return makeQuery({ data: [{ email: 'admin@acme.example', org_id: 'org-acme' }] });
          case 'organizations':
            // Both the sub-org lookup and the name lookup hit this table;
            // returning a row with id+display_name satisfies both readers.
            return makeQuery({ data: [{ id: 'org-acme', display_name: 'Acme HQ' }] });
          case 'anchors':
            // 2 open items, both recent (not aged).
            return makeQuery({
              data: [
                { created_at: '2026-06-29T07:00:00Z' },
                { created_at: '2026-06-29T07:30:00Z' },
              ],
            });
          case 'connector_alert_state':
            return makeQuery({ data: [] });
          case 'audit_events':
            // No suppression row, no prior delivery log, insert ok.
            return { ...makeQuery({ data: [] }), insert: vi.fn(async () => ({ error: null })) };
          default:
            return makeQuery({ data: [] });
        }
      }),
    };

    const send = vi.fn(async () => ({ success: true, messageId: 'm1' }));
    const result = await runDailyQueueDigest({
      database: database as never,
      send: send as never,
      now: new Date('2026-06-29T08:00:00Z'),
    });

    expect(result.admins).toBe(1);
    expect(result.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@acme.example', emailType: 'queue_reminder', orgId: 'org-acme' }),
    );
  });
});
