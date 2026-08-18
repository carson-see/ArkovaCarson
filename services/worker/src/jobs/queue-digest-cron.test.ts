/**
 * Tests for the Daily Queue Digest production wiring (QUEUE-07 / SCRUM-2353).
 *
 * Focus: the audit_events-backed DigestStore (suppression/idempotency/retry),
 * sub-org scope resolution (isolation), and the cron loop aggregation. The
 * pure builder/orchestrator is covered in queue-digest.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

// Stub config/db/logger so importing the SUT does not trip loadConfig().
// `enableQueueDigest` defaults ON here so the existing send-path tests exercise
// the loop; the gate test below flips it OFF to prove the default-off no-op.
const mockConfig = { frontendUrl: 'https://app.arkova.ai', enableQueueDigest: true };
vi.mock('../config.js', () => ({ config: mockConfig }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../email/sender.js', () => ({ sendEmail: vi.fn() }));

const {
  buildDigestUrls,
  createAuditBackedStore,
  resolveScopeOrgIds,
  readOrgMetrics,
  runDailyQueueDigest,
  isDigestRuleDueToday,
  listQueueDigestPreferences,
  isOrgEnrolledInQueueDigest,
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

describe('createAuditBackedStore — getDeliveryLog fails CLOSED (F2)', () => {
  it('THROWS on an audit read error (never returns null → never re-sends unverified)', async () => {
    const database = {
      from: vi.fn(() => makeQuery({ data: null, error: { message: 'audit boom' } })),
    };
    const store = createAuditBackedStore(database as never);
    await expect(store.getDeliveryLog('a@x.com', 'org-1', '2026-07-01')).rejects.toThrow(
      /delivery-log read failed/i,
    );
  });

  it('returns null only for a genuine no-match (empty array, no read error)', async () => {
    const database = { from: vi.fn(() => makeQuery({ data: [] })) };
    const store = createAuditBackedStore(database as never);
    expect(await store.getDeliveryLog('a@x.com', 'org-1', '2026-07-01')).toBeNull();
  });
});

describe('isDigestRuleDueToday (F4 — per-rule cadence)', () => {
  // 2026-07-01 is a Wednesday (UTC).
  const wed = new Date('2026-07-01T13:00:00Z');
  const mon = new Date('2026-07-06T13:00:00Z'); // Monday
  const first = new Date('2026-07-01T13:00:00Z'); // 1st of month
  const second = new Date('2026-07-02T13:00:00Z');

  it('no cron configured → due (daily default, backward compatible)', () => {
    expect(isDigestRuleDueToday({}, wed)).toBe(true);
    expect(isDigestRuleDueToday(null, wed)).toBe(true);
    expect(isDigestRuleDueToday({ cron: '' }, wed)).toBe(true);
  });

  it('daily cron → due every day', () => {
    expect(isDigestRuleDueToday({ cron: '0 13 * * *' }, wed)).toBe(true);
    expect(isDigestRuleDueToday({ cron: '0 13 * * *' }, mon)).toBe(true);
  });

  it('weekly Monday cron → due Monday, NOT Wednesday', () => {
    expect(isDigestRuleDueToday({ cron: '0 13 * * 1' }, mon)).toBe(true);
    expect(isDigestRuleDueToday({ cron: '0 13 * * 1' }, wed)).toBe(false);
  });

  it('weekdays cron (1-5) → due Wed, NOT Sunday', () => {
    const sun = new Date('2026-07-05T13:00:00Z');
    expect(isDigestRuleDueToday({ cron: '0 13 * * 1-5' }, wed)).toBe(true);
    expect(isDigestRuleDueToday({ cron: '0 13 * * 1-5' }, sun)).toBe(false);
  });

  it('monthly 1st cron → due on the 1st, NOT the 2nd', () => {
    expect(isDigestRuleDueToday({ cron: '0 13 1 * *' }, first)).toBe(true);
    expect(isDigestRuleDueToday({ cron: '0 13 1 * *' }, second)).toBe(false);
  });

  it('cron with 7-as-Sunday normalizes correctly', () => {
    const sun = new Date('2026-07-05T13:00:00Z');
    expect(isDigestRuleDueToday({ cron: '0 13 * * 7' }, sun)).toBe(true);
    expect(isDigestRuleDueToday({ cron: '0 13 * * 7' }, wed)).toBe(false);
  });

  it('malformed cron (wrong field count) → fail safe to due', () => {
    expect(isDigestRuleDueToday({ cron: 'nonsense' }, wed)).toBe(true);
    expect(isDigestRuleDueToday({ cron: '* * *' }, wed)).toBe(true);
  });
});

describe('listQueueDigestPreferences — DEFAULT-ON opt-out store', () => {
  it('reads every QUEUE_DIGEST rule row (both enabled and disabled) keyed by org', async () => {
    const rows = [
      { org_id: 'opted-out-org', enabled: false, trigger_config: {} },
      { org_id: 'custom-cadence-org', enabled: true, trigger_config: { cron: '0 13 * * 1' } },
    ];
    const database = { from: vi.fn(() => makeQuery({ data: rows })) };
    const prefs = await listQueueDigestPreferences(database as never);
    expect(prefs).not.toBeNull();
    expect(prefs?.get('opted-out-org')).toMatchObject({ enabled: false });
    expect(prefs?.get('custom-cadence-org')).toMatchObject({ enabled: true });
    // No preference query filters on `enabled` server-side — an opt-out row
    // (enabled=false) must still come back so it can be honored, unlike the
    // old opt-in world where only enabled=true rows mattered.
    const calls = (
      database.from.mock.results[0]?.value as unknown as {
        _calls: Array<[string, unknown, unknown]>;
      }
    )._calls;
    expect(calls.find(([m, col]) => m === 'eq' && col === 'enabled')).toBeUndefined();
  });

  it('read error → null (fail CLOSED — unreadable preference store, not "empty")', async () => {
    const database = { from: vi.fn(() => makeQuery({ data: null, error: { message: 'boom' } })) };
    const prefs = await listQueueDigestPreferences(database as never);
    expect(prefs).toBeNull();
  });

  it('a genuinely empty result set (no rows, no error) is a real empty map, not a failure', async () => {
    const database = { from: vi.fn(() => makeQuery({ data: [] })) };
    const prefs = await listQueueDigestPreferences(database as never);
    expect(prefs).not.toBeNull();
    expect(prefs?.size).toBe(0);
  });
});

describe('isOrgEnrolledInQueueDigest — DEFAULT-ON enrollment (CTO decision)', () => {
  const wed = new Date('2026-07-01T13:00:00Z'); // Wednesday

  it('an org with NO preference row is enrolled by default (absence = enrolled)', () => {
    const prefs = new Map();
    expect(isOrgEnrolledInQueueDigest(prefs, 'no-row-org', wed)).toBe(true);
  });

  it('an org with an explicit enabled=false row is OPTED OUT', () => {
    const prefs = new Map([['opted-out-org', { enabled: false, triggerConfig: {} }]]);
    expect(isOrgEnrolledInQueueDigest(prefs, 'opted-out-org', wed)).toBe(false);
  });

  it('an org with an explicit enabled=true row stays enrolled and honors its cadence (F4 backward compat)', () => {
    const prefs = new Map([
      ['monday-org', { enabled: true, triggerConfig: { cron: '0 13 * * 1' } }], // due Monday only
    ]);
    expect(isOrgEnrolledInQueueDigest(prefs, 'monday-org', wed)).toBe(false); // wed, not due
    const mon = new Date('2026-07-06T13:00:00Z');
    expect(isOrgEnrolledInQueueDigest(prefs, 'monday-org', mon)).toBe(true);
  });

  it('prefs=null (preference read failed) → every org fails CLOSED (not enrolled)', () => {
    expect(isOrgEnrolledInQueueDigest(null, 'any-org', wed)).toBe(false);
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

  it('records a SUPPRESSED delivery as QUEUE_DIGEST_SUPPRESSED, NOT an unsubscribe', async () => {
    // A delivery skipped by isSuppressed (which fails closed on read errors)
    // must never forge a permanent QUEUE_DIGEST_UNSUBSCRIBED opt-out row.
    const insert = vi.fn(async () => ({ error: null }));
    const database = { from: vi.fn(() => ({ insert })) };
    const store = createAuditBackedStore(database as never);
    await store.recordDelivery({
      adminEmail: 'a@x.com',
      adminOrgId: 'org-1',
      digestDate: '2026-06-29',
      status: 'SUPPRESSED',
      attempts: 0,
    });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'QUEUE_DIGEST_SUPPRESSED', org_id: 'org-1' }),
    );
    const arg = (insert.mock.calls[0] as unknown as [{ event_type: string }])[0];
    expect(arg.event_type).not.toBe('QUEUE_DIGEST_UNSUBSCRIBED');
  });

  it('throws when the delivery-log write fails (idempotency marker must persist)', async () => {
    const insert = vi.fn(async () => ({ error: { msg: 'insert boom' } }));
    const database = { from: vi.fn(() => ({ insert })) };
    const store = createAuditBackedStore(database as never);
    await expect(
      store.recordDelivery({
        adminEmail: 'a@x.com',
        adminOrgId: 'org-1',
        digestDate: '2026-06-29',
        status: 'SENT',
        attempts: 1,
      }),
    ).rejects.toThrow(/delivery-log write failed/);
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

  it('throws on a scope-read error rather than dropping owned sub-orgs', async () => {
    const database = {
      from: vi.fn(() => makeQuery({ data: null, error: { msg: 'scope boom' } })),
    };
    await expect(
      resolveScopeOrgIds(database as never, 'org-parent'),
    ).rejects.toThrow(/failed to resolve sub-org scope/);
  });
});

describe('readOrgMetrics — connector health filtering', () => {
  const now = new Date('2026-06-29T08:00:00Z');

  it('counts ONLY degraded/disconnected connectors, never healthy ones', async () => {
    // The mock filters nothing itself; correctness depends on the SUT pushing
    // an `.in('last_state', ['degraded','disconnected'])` predicate so the DB
    // never returns healthy ('connected') rows. We assert that predicate is
    // applied and that the returned rows are counted verbatim.
    const connQuery = makeQuery({ data: [{ connector_id: 'c-degraded' }] });
    const database = {
      from: vi.fn((table: string) => {
        if (table === 'anchors') return makeQuery({ data: [] });
        if (table === 'connector_alert_state') return connQuery;
        return makeQuery({ data: [] });
      }),
    };

    const metrics = await readOrgMetrics(database as never, 'org-1', 'Org One', now);
    expect(metrics.failedConnectorCount).toBe(1);

    // Prove the unhealthy-only predicate was pushed into the query.
    const calls = (connQuery as unknown as { _calls: Array<[string, unknown, unknown]> })._calls;
    const inCall = calls.find(([m, col]) => m === 'in' && col === 'last_state');
    expect(inCall).toBeDefined();
    expect(inCall?.[2]).toEqual(['degraded', 'disconnected']);
  });

  it('reports zero connector issues for a healthy org (no degraded/disconnected rows)', async () => {
    const database = {
      from: vi.fn((table: string) => {
        if (table === 'anchors') return makeQuery({ data: [] });
        // A healthy org: the filtered query returns no rows.
        if (table === 'connector_alert_state') return makeQuery({ data: [] });
        return makeQuery({ data: [] });
      }),
    };
    const metrics = await readOrgMetrics(database as never, 'org-healthy', 'Healthy Org', now);
    expect(metrics.failedConnectorCount).toBe(0);
  });

  it('throws when a metric read errors instead of reporting a quiet queue', async () => {
    const database = {
      from: vi.fn((table: string) => {
        if (table === 'anchors') return makeQuery({ data: null, error: { msg: 'boom' } });
        return makeQuery({ data: [] });
      }),
    };
    await expect(
      readOrgMetrics(database as never, 'org-err', 'Err Org', now),
    ).rejects.toThrow(/failed to read open queue metrics/);
  });

  it('counts the Review Queue (PENDING_RESOLUTION), NOT ordinary PENDING anchors', async () => {
    // Mirror /api/queue/pending: only PENDING_RESOLUTION items are review work.
    // The mock does not itself filter by status, so we (a) seed a
    // PENDING_RESOLUTION row and assert it counts as open review work, and
    // (b) assert the SUT pushes the PENDING_RESOLUTION status predicate so a
    // plain-PENDING anchoring backlog is never counted as review work.
    const anchorQuery = makeQuery({ data: [{ created_at: '2026-06-29T07:00:00Z' }] });
    const database = {
      from: vi.fn((table: string) => {
        if (table === 'anchors') return anchorQuery;
        return makeQuery({ data: [] });
      }),
    };
    const metrics = await readOrgMetrics(database as never, 'org-1', 'Org One', now);
    expect(metrics.openCount).toBe(1);

    const calls = (anchorQuery as unknown as { _calls: Array<[string, unknown, unknown]> })._calls;
    const statusCall = calls.find(([m, col]) => m === 'in' && col === 'status');
    expect(statusCall).toBeDefined();
    expect(statusCall?.[2]).toEqual(['PENDING_RESOLUTION']);
    // The ordinary anchoring backlog status must NOT be what the digest counts.
    expect(statusCall?.[2]).not.toContain('PENDING');
  });
});

describe('runDailyQueueDigest — cron loop', () => {
  it('is a no-op when the digest is disabled (default-off: enableQueueDigest=false)', async () => {
    const prev = mockConfig.enableQueueDigest;
    try {
      mockConfig.enableQueueDigest = false;
      const send = vi.fn(async () => ({ success: true }));
      const from = vi.fn();
      const result = await runDailyQueueDigest({
        database: { from } as never,
        send: send as never,
      });
      expect(result.admins).toBe(0);
      expect(send).not.toHaveBeenCalled();
      // Default-off must short-circuit BEFORE enumerating admins.
      expect(from).not.toHaveBeenCalled();
    } finally {
      mockConfig.enableQueueDigest = prev;
    }
  });

  it('sends one scoped digest per admin and aggregates the result (DEFAULT-ON: no preference row needed)', async () => {
    // Route per-table so the loop reads admins, scope, names, metrics, store.
    const database = {
      from: vi.fn((table: string) => {
        switch (table) {
          case 'organization_rules':
            // org-acme has NO QUEUE_DIGEST preference row at all — under the
            // default-on flip this org is still enrolled (absence = enrolled).
            return makeQuery({ data: [] });
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

  // Build a per-table routed db where the QUEUE_DIGEST preference rows are
  // configurable. The queue (anchors) is always non-empty so the ONLY thing
  // deciding whether mail is sent is the enrollment gate (default-on / opt-out).
  function makeRoutedDb(preferenceRows: Array<{ org_id: string; enabled: boolean }>) {
    const anchorsFrom = vi.fn(() =>
      makeQuery({ data: [{ created_at: '2026-06-29T07:00:00Z' }] }),
    );
    const profilesFrom = vi.fn(() =>
      makeQuery({ data: [{ email: 'admin@acme.example', org_id: 'org-acme' }] }),
    );
    const from = vi.fn((table: string) => {
      switch (table) {
        case 'organization_rules':
          return makeQuery({ data: preferenceRows });
        case 'profiles':
          return profilesFrom();
        case 'organizations':
          return makeQuery({ data: [{ id: 'org-acme', display_name: 'Acme HQ' }] });
        case 'anchors':
          return anchorsFrom();
        case 'connector_alert_state':
          return makeQuery({ data: [] });
        case 'audit_events':
          return { ...makeQuery({ data: [] }), insert: vi.fn(async () => ({ error: null })) };
        default:
          return makeQuery({ data: [] });
      }
    });
    return { from, anchorsFrom, profilesFrom };
  }

  it('DEFAULT-ON: emails an admin whose org has NO QUEUE_DIGEST preference row at all', async () => {
    const db = makeRoutedDb([]);
    const send = vi.fn(async () => ({ success: true, messageId: 'm1' }));
    const result = await runDailyQueueDigest({
      database: { from: db.from } as never,
      send: send as never,
      now: new Date('2026-06-29T08:00:00Z'),
    });
    expect(result.admins).toBe(1);
    expect(result.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('OPT-OUT HONORED: does NOT email an org with an explicit enabled=false QUEUE_DIGEST rule, even with a non-empty queue', async () => {
    // org-acme has a non-empty queue but explicitly opted out (enabled=false).
    const db = makeRoutedDb([{ org_id: 'org-acme', enabled: false }]);
    const send = vi.fn(async () => ({ success: true, messageId: 'm1' }));
    const result = await runDailyQueueDigest({
      database: { from: db.from } as never,
      send: send as never,
      now: new Date('2026-06-29T08:00:00Z'),
    });
    expect(result.admins).toBe(0);
    expect(send).not.toHaveBeenCalled();
    // Never built metrics for the opted-out org.
    expect(db.anchorsFrom).not.toHaveBeenCalled();
  });

  it('legacy explicit opt-in (enabled=true) still enrolls the org and honors its custom cadence', async () => {
    const db = makeRoutedDb([{ org_id: 'org-acme', enabled: true }]);
    const send = vi.fn(async () => ({ success: true, messageId: 'm1' }));
    const result = await runDailyQueueDigest({
      database: { from: db.from } as never,
      send: send as never,
      now: new Date('2026-06-29T08:00:00Z'),
    });
    expect(result.admins).toBe(1);
    expect(result.sent).toBe(1);
  });

  it('does NOT email when the preferences read fails (fails closed → nobody enrolled)', async () => {
    const from = vi.fn((table: string) => {
      if (table === 'organization_rules') {
        return makeQuery({ data: null, error: { msg: 'prefs read boom' } });
      }
      if (table === 'profiles') {
        return makeQuery({ data: [{ email: 'admin@acme.example', org_id: 'org-acme' }] });
      }
      return makeQuery({ data: [] });
    });
    const send = vi.fn(async () => ({ success: true }));
    const result = await runDailyQueueDigest({
      database: { from } as never,
      send: send as never,
      now: new Date('2026-06-29T08:00:00Z'),
    });
    expect(result.admins).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('EMPTY-QUEUE SKIPPED: a default-enrolled org with an all-zero queue is counted but not emailed (no noise)', async () => {
    // No preference row (default-enrolled), but the org's queue is completely
    // quiet: zero open anchors, zero connector issues. Default-on enrollment
    // must never turn into inbox noise for an org with nothing to review.
    const database = {
      from: vi.fn((table: string) => {
        switch (table) {
          case 'organization_rules':
            return makeQuery({ data: [] }); // no preference row → enrolled
          case 'profiles':
            return makeQuery({ data: [{ email: 'admin@quiet.example', org_id: 'org-quiet' }] });
          case 'organizations':
            return makeQuery({ data: [{ id: 'org-quiet', display_name: 'Quiet Org' }] });
          case 'anchors':
            return makeQuery({ data: [] }); // zero open review items
          case 'connector_alert_state':
            return makeQuery({ data: [] }); // zero connector issues
          case 'audit_events':
            return { ...makeQuery({ data: [] }), insert: vi.fn(async () => ({ error: null })) };
          default:
            return makeQuery({ data: [] });
        }
      }),
    };
    const send = vi.fn(async () => ({ success: true }));
    const result = await runDailyQueueDigest({
      database: database as never,
      send: send as never,
      now: new Date('2026-06-29T08:00:00Z'),
    });
    expect(result.admins).toBe(1); // enrolled...
    expect(result.skippedEmpty).toBe(1); // ...but skipped for having nothing to report
    expect(result.sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
