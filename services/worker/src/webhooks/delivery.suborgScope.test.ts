/**
 * SCRUM-3972 — cross-organization webhook fan-out (CTO ruling R17).
 *
 * These are the behaviours the reversal of decision D2 rests on. Every one of
 * them fails without `suborg-fanout.ts` and the endpoint-selection change in
 * `delivery.ts`:
 *
 *   - a parent endpoint scoped `self_and_descendants` receives an APPROVED
 *     affiliate's `anchor.secured`, and ONLY when the flag is on;
 *   - a `self`-scoped parent endpoint receives nothing (the blast-radius claim
 *     for all 4 endpoints live in production today);
 *   - an affiliate never receives its parent's events, in either configuration;
 *   - REVOKED / PENDING / NULL affiliation stops the feed;
 *   - a parent-lookup failure still delivers the affiliate's own events AND is
 *     counted, so the dispatch is non-ok (builder contract §1 — no fail-open);
 *   - no endpoint is delivered to twice;
 *   - a cross-organization payload always carries `org_public_id`, and when the
 *     event's own schema cannot carry it the cross-org copy is refused rather
 *     than sent unattributed;
 *   - with the flag off, the fan-out issues ZERO additional queries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

const {
  mockLogger,
  mockSentry,
  mockDbFrom,
  mockRpc,
  mockFetch,
  tableResolvers,
  queryLog,
} = vi.hoisted(() => {
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const mockSentry = { captureException: vi.fn(), captureMessage: vi.fn() };

  /** Every query the code under test issued, in order. */
  interface QueryState {
    table: string;
    columns: string;
    filters: Array<[string, unknown]>;
    contains: [string, unknown] | null;
    limit: number | null;
  }
  const queryLog: QueryState[] = [];
  const tableResolvers: Record<string, (q: QueryState) => unknown> = {};

  /**
   * A PostgREST-shaped chain that records what was asked for and answers from a
   * per-table resolver. Deliberately generic: the point of these tests is WHICH
   * predicates the fan-out applies, so the mock must not hard-code one chain.
   */
  function makeQuery(table: string) {
    const state: QueryState = { table, columns: '', filters: [], contains: null, limit: null };
    const resolve = () => {
      queryLog.push({ ...state, filters: [...state.filters] });
      const resolver = tableResolvers[table];
      if (!resolver) throw new Error(`no resolver registered for table ${table}`);
      return Promise.resolve(resolver(state));
    };
    const q: Record<string, unknown> = {
      select: (columns: string) => {
        state.columns = columns;
        return q;
      },
      eq: (key: string, value: unknown) => {
        state.filters.push([key, value]);
        return q;
      },
      in: (key: string, value: unknown) => {
        state.filters.push([key, value]);
        return q;
      },
      contains: (key: string, value: unknown) => {
        state.contains = [key, value];
        return resolve();
      },
      limit: (n: number) => {
        state.limit = n;
        return resolve();
      },
      maybeSingle: () => resolve(),
      single: () => resolve(),
      then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
        resolve().then(onOk, onErr),
    };
    return q;
  }

  // Delivery-log chain (idempotency + audit row), same shape the round-trip
  // suite uses. Not under test here; it just has to succeed.
  const deliveryLogUpdateEq = vi.fn(() => Promise.resolve({ error: null }));
  const deliveryLogs = {
    select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: { code: 'PGRST116' } }) }) }),
    insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'dl_new' }, error: null }) }) }),
    update: () => ({ eq: deliveryLogUpdateEq }),
    upsert: () => Promise.resolve({ error: null }),
  };

  const mockDbFrom = vi.fn((table: string) => {
    if (table === 'webhook_delivery_logs') return deliveryLogs;
    if (table === 'webhook_dead_letter_queue') return deliveryLogs;
    return makeQuery(table);
  });

  const mockRpc = vi.fn();
  const mockFetch = vi.fn();

  return { mockLogger, mockSentry, mockDbFrom, mockRpc, mockFetch, tableResolvers, queryLog };
});

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../utils/sentry.js', () => ({ Sentry: mockSentry }));
vi.mock('../utils/db.js', () => ({ db: { from: mockDbFrom, rpc: mockRpc } }));

const dnsModule = {
  default: {},
  promises: {
    resolve4: vi.fn().mockResolvedValue(['203.0.113.10']),
    resolve6: vi.fn().mockResolvedValue([]),
  },
};
vi.mock('node:dns', () => dnsModule);
vi.mock('dns', () => dnsModule);

vi.stubGlobal('fetch', mockFetch);

import {
  dispatchWebhookEvent,
  resetCircuitBreakers,
  __resetWebhookFlagCacheForTest,
  deriveResourceKey,
} from './delivery.js';
import { __resetSubOrgFanoutCachesForTest, FANOUT_CACHE_TTL_MS } from './suborg-fanout.js';

/**
 * The flag is read from `process.env` on every call (see the rationale in
 * suborg-fanout.ts); flipping the real variable is therefore the honest way to
 * exercise it, and it also proves the read is not memoised.
 */
function setFanoutFlag(on: boolean): void {
  if (on) process.env.ENABLE_SUBORG_WEBHOOK_FANOUT = 'true';
  else delete process.env.ENABLE_SUBORG_WEBHOOK_FANOUT;
}

// ─── Fixture ────────────────────────────────────────────────────────────────

const PARENT_ORG = '11111111-1111-4111-8111-111111111111';
const CHILD_ORG = '22222222-2222-4222-8222-222222222222';
const UNRELATED_ORG = '33333333-3333-4333-8333-333333333333';

const CHILD_PUBLIC_ID = 'ORG-CHILD-0001';
const PARENT_PUBLIC_ID = 'ORG-PARENT-0001';

const SECRET = crypto.randomBytes(32).toString('hex');

function endpoint(id: string, orgId: string, scope: string, events = ['anchor.secured']) {
  return {
    id,
    url: `https://203.0.113.50/hooks/${id}`,
    secret_hash: SECRET,
    events,
    is_active: true,
    org_id: orgId,
    scope,
  };
}

const SECURED_PAYLOAD = {
  public_id: 'anc_child_001',
  chain_tx_id: 'aa'.repeat(32),
  chain_block_height: 900_001,
  status: 'SECURED' as const,
  chain_timestamp: '2026-09-12T10:00:00.000Z',
  secured_at: '2026-09-12T10:00:05.000Z',
};

const BATCH_PAYLOAD = {
  chain_tx_id: 'bb'.repeat(32),
  chain_block_height: 900_002,
  chain_timestamp: '2026-09-12T10:00:00.000Z',
  secured_at: '2026-09-12T10:00:05.000Z',
  anchor_count: 2,
  public_ids: ['anc_a', 'anc_b'],
};

interface OrgFixture {
  parent_org_id: string | null;
  parent_approval_status: string | null;
  public_id: string | null;
  /** CTO review 2026-09-12: tenancy suspension is a column of its own. */
  suspended?: boolean;
}

interface Scenario {
  endpoints: ReturnType<typeof endpoint>[];
  orgs: Record<string, OrgFixture>;
  orgLookupError?: string;
  endpointLookupError?: string;
  descendantProbeError?: string;
}

function install(scenario: Scenario) {
  tableResolvers.webhook_endpoints = (q) => {
    const filters = new Map(q.filters as Array<[string, string]>);
    // The global "does anyone subscribe to descendants" probe: scope filter,
    // no org filter, limit 1.
    if (!filters.has('org_id')) {
      if (scenario.descendantProbeError) {
        return { data: null, error: { message: scenario.descendantProbeError } };
      }
      const any = scenario.endpoints.filter(
        (e) => e.scope === 'self_and_descendants' && e.is_active,
      );
      return { data: any.slice(0, 1).map((e) => ({ id: e.id })), error: null };
    }
    if (scenario.endpointLookupError) {
      return { data: null, error: { message: scenario.endpointLookupError } };
    }
    const wantedEvent = (q.contains?.[1] as string[] | undefined)?.[0];
    const rows = scenario.endpoints.filter((e) => {
      if (e.org_id !== filters.get('org_id')) return false;
      if (!e.is_active) return false;
      if (filters.has('scope') && e.scope !== filters.get('scope')) return false;
      return wantedEvent ? e.events.includes(wantedEvent) : true;
    });
    return { data: rows, error: null };
  };

  tableResolvers.organizations = (q) => {
    if (scenario.orgLookupError) return { data: null, error: { message: scenario.orgLookupError } };
    const id = new Map(q.filters as Array<[string, string]>).get('id');
    return { data: scenario.orgs[id as string] ?? null, error: null };
  };
}

function deliveredUrls(): string[] {
  return mockFetch.mock.calls.map((c) => String(c[0]));
}

function deliveredBodies(): Array<Record<string, unknown>> {
  return mockFetch.mock.calls.map((c) => JSON.parse(String((c[1] as { body: string }).body)));
}

function orgLookupCount(): number {
  return queryLog.filter((q) => q.table === 'organizations').length;
}

describe('cross-organization webhook fan-out (SCRUM-3972)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    queryLog.length = 0;
    for (const k of Object.keys(tableResolvers)) delete tableResolvers[k];
    resetCircuitBreakers();
    __resetWebhookFlagCacheForTest();
    __resetSubOrgFanoutCachesForTest();
    setFanoutFlag(false);
    mockRpc.mockResolvedValue({ data: true, error: null }); // outbound webhooks on
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const APPROVED_TREE: Scenario['orgs'] = {
    [CHILD_ORG]: {
      parent_org_id: PARENT_ORG,
      parent_approval_status: 'APPROVED',
      public_id: CHILD_PUBLIC_ID,
    },
    [PARENT_ORG]: {
      parent_org_id: null,
      parent_approval_status: null,
      public_id: PARENT_PUBLIC_ID,
    },
  };

  it('delivers an approved affiliate event to a self_and_descendants parent endpoint', async () => {
    setFanoutFlag(true);
    install({
      endpoints: [
        endpoint('ep_child', CHILD_ORG, 'self'),
        endpoint('ep_parent', PARENT_ORG, 'self_and_descendants'),
      ],
      orgs: APPROVED_TREE,
    });

    const result = await dispatchWebhookEvent(CHILD_ORG, 'anchor.secured', 'evt_1', SECURED_PAYLOAD);

    expect(result.ok).toBe(true);
    expect(result.ownEndpointCount).toBe(1);
    expect(result.descendantEndpointCount).toBe(1);
    expect(deliveredUrls()).toEqual(
      expect.arrayContaining([expect.stringContaining('ep_child'), expect.stringContaining('ep_parent')]),
    );
  });

  it('stamps org_public_id on the cross-organization copy and leaves the own copy untouched', async () => {
    setFanoutFlag(true);
    install({
      endpoints: [
        endpoint('ep_child', CHILD_ORG, 'self'),
        endpoint('ep_parent', PARENT_ORG, 'self_and_descendants'),
      ],
      orgs: APPROVED_TREE,
    });

    await dispatchWebhookEvent(CHILD_ORG, 'anchor.secured', 'evt_2', SECURED_PAYLOAD);

    const bodies = deliveredBodies();
    const toParent = bodies.find((_b, i) => deliveredUrls()[i].includes('ep_parent'));
    const toChild = bodies.find((_b, i) => deliveredUrls()[i].includes('ep_child'));

    // The parent must be able to attribute the event to an organization.
    expect((toParent?.data as Record<string, unknown>).org_public_id).toBe(CHILD_PUBLIC_ID);
    // ...and no internal identifier rides along with it.
    expect(JSON.stringify(toParent)).not.toContain(CHILD_ORG);
    expect(JSON.stringify(toParent)).not.toContain(PARENT_ORG);
    // The own-organization payload is byte-identical to the pre-3972 shape.
    expect((toChild?.data as Record<string, unknown>).org_public_id).toBeUndefined();
    // Both copies share one event id and one ordering position.
    expect(toParent?.event_id).toBe(toChild?.event_id);
    expect(toParent?.resource_key).toBe(toChild?.resource_key);
  });

  it('does not fan out at all when the flag is off, and issues zero extra queries', async () => {
    setFanoutFlag(false);
    install({
      endpoints: [
        endpoint('ep_child', CHILD_ORG, 'self'),
        endpoint('ep_parent', PARENT_ORG, 'self_and_descendants'),
      ],
      orgs: APPROVED_TREE,
    });

    const result = await dispatchWebhookEvent(CHILD_ORG, 'anchor.secured', 'evt_3', SECURED_PAYLOAD);

    expect(deliveredUrls()).toEqual([expect.stringContaining('ep_child')]);
    expect(result.descendantEndpointCount).toBe(0);
    // The dark path must cost nothing: no organizations read, and exactly one
    // webhook_endpoints query (the pre-existing own-org selection).
    expect(orgLookupCount()).toBe(0);
    expect(queryLog.filter((q) => q.table === 'webhook_endpoints')).toHaveLength(1);
  });

  it('does not deliver an affiliate event to a parent endpoint scoped self', async () => {
    setFanoutFlag(true);
    install({
      endpoints: [
        endpoint('ep_child', CHILD_ORG, 'self'),
        endpoint('ep_parent', PARENT_ORG, 'self'),
      ],
      orgs: APPROVED_TREE,
    });

    const result = await dispatchWebhookEvent(CHILD_ORG, 'anchor.secured', 'evt_4', SECURED_PAYLOAD);

    expect(deliveredUrls()).toEqual([expect.stringContaining('ep_child')]);
    expect(result.ok).toBe(true);
    // Nobody asked for descendants, so the hot `organizations` table is never read.
    expect(orgLookupCount()).toBe(0);
  });

  it('never delivers a parent event to an affiliate endpoint, even one scoped self_and_descendants', async () => {
    setFanoutFlag(true);
    install({
      endpoints: [
        endpoint('ep_parent', PARENT_ORG, 'self'),
        // The affiliate opts into descendants of ITS OWN; that must never be
        // read as "send me my parent's events".
        endpoint('ep_child', CHILD_ORG, 'self_and_descendants'),
      ],
      orgs: APPROVED_TREE,
    });

    const result = await dispatchWebhookEvent(PARENT_ORG, 'anchor.secured', 'evt_5', SECURED_PAYLOAD);

    expect(deliveredUrls()).toEqual([expect.stringContaining('ep_parent')]);
    expect(result.descendantEndpointCount).toBe(0);
    expect(result.ok).toBe(true);
  });

  it.each([['REVOKED'], ['PENDING'], [null]])(
    'stops the feed when the affiliation is %s rather than APPROVED',
    async (status) => {
      setFanoutFlag(true);
      install({
        endpoints: [
          endpoint('ep_child', CHILD_ORG, 'self'),
          endpoint('ep_parent', PARENT_ORG, 'self_and_descendants'),
        ],
        orgs: {
          ...APPROVED_TREE,
          [CHILD_ORG]: {
            parent_org_id: PARENT_ORG,
            parent_approval_status: status,
            public_id: CHILD_PUBLIC_ID,
          },
        },
      });

      const result = await dispatchWebhookEvent(CHILD_ORG, 'anchor.secured', 'evt_6', SECURED_PAYLOAD);

      expect(deliveredUrls()).toEqual([expect.stringContaining('ep_child')]);
      expect(result.descendantEndpointCount).toBe(0);
      expect(result.ok).toBe(true);
    },
  );

  /**
   * CTO review 2026-09-12. `suspend_suborg` (baseline, migration 0290) sets
   * `organizations.suspended = true` and NEVER touches
   * `parent_approval_status`, so an offboarded affiliate stays 'APPROVED'
   * forever. Without this predicate the parent keeps receiving the public ids
   * of everything its former affiliate secures — the exact D2 disclosure the
   * flag exists to gate, continuing after the tenancy that justified it ended.
   */
  it('stops the feed when the affiliate has been suspended, even though it is still APPROVED', async () => {
    setFanoutFlag(true);
    install({
      endpoints: [
        endpoint('ep_child', CHILD_ORG, 'self'),
        endpoint('ep_parent', PARENT_ORG, 'self_and_descendants'),
      ],
      orgs: {
        ...APPROVED_TREE,
        [CHILD_ORG]: {
          parent_org_id: PARENT_ORG,
          parent_approval_status: 'APPROVED',
          public_id: CHILD_PUBLIC_ID,
          suspended: true,
        },
      },
    });

    const result = await dispatchWebhookEvent(CHILD_ORG, 'anchor.secured', 'evt_susp', SECURED_PAYLOAD);

    expect(deliveredUrls()).toEqual([expect.stringContaining('ep_child')]);
    expect(result.descendantEndpointCount).toBe(0);
    // Not a failure: "suspended" is a legitimate answer of "none", not an error.
    expect(result.ok).toBe(true);
  });

  /**
   * CTO review 2026-09-12. The seven `suborg.*` events are already dispatched
   * on the PARENT's own org id by `emitSubOrgEvent`; four are ALSO dispatched
   * on the affiliate's. Fanning the affiliate-side copy back up to the parent
   * can only produce a duplicate — and because the `suborg.*` schemas are
   * `.strict()` without `org_public_id`, it produces it as an error-level
   * Sentry alarm plus a non-ok dispatch, for an entirely correct request.
   */
  it('does not fan a suborg.* event out to the parent — it is already addressed there', async () => {
    setFanoutFlag(true);
    install({
      endpoints: [
        endpoint('ep_parent', PARENT_ORG, 'self_and_descendants', ['suborg.credits_allocated']),
      ],
      orgs: APPROVED_TREE,
    });

    const result = await dispatchWebhookEvent(CHILD_ORG, 'suborg.credits_allocated', 'evt_so', {
      public_id: CHILD_PUBLIC_ID,
      display_name: 'Affiliate Ltd',
      parent_public_id: PARENT_PUBLIC_ID,
      parent_approval_status: 'APPROVED',
      occurred_at: '2026-09-12T10:00:00.000Z',
      amount: 10,
      parent_balance: 90,
      child_balance: 10,
    });

    expect(deliveredUrls()).toEqual([]);
    expect(result.descendantEndpointCount).toBe(0);
    expect(result.ok).toBe(true);
    expect(mockSentry.captureMessage).not.toHaveBeenCalled();
  });

  it('does not reach an unrelated organization that happens to subscribe to descendants', async () => {
    setFanoutFlag(true);
    install({
      endpoints: [
        endpoint('ep_child', CHILD_ORG, 'self'),
        endpoint('ep_unrelated', UNRELATED_ORG, 'self_and_descendants'),
      ],
      orgs: APPROVED_TREE,
    });

    const result = await dispatchWebhookEvent(CHILD_ORG, 'anchor.secured', 'evt_7', SECURED_PAYLOAD);

    expect(deliveredUrls()).toEqual([expect.stringContaining('ep_child')]);
    expect(result.descendantEndpointCount).toBe(0);
  });

  it('still delivers the affiliate its own events when the parent lookup fails, and counts the failure', async () => {
    setFanoutFlag(true);
    install({
      endpoints: [
        endpoint('ep_child', CHILD_ORG, 'self'),
        endpoint('ep_parent', PARENT_ORG, 'self_and_descendants'),
      ],
      orgs: APPROVED_TREE,
      orgLookupError: 'connection terminated unexpectedly',
    });

    const result = await dispatchWebhookEvent(CHILD_ORG, 'anchor.secured', 'evt_8', SECURED_PAYLOAD);

    // Liveness for the uninvolved tenant...
    expect(deliveredUrls()).toEqual([expect.stringContaining('ep_child')]);
    expect(result.ownEndpointCount).toBe(1);
    // ...and NO fail-open: the run is non-ok and the reason is typed, logged
    // at error level and captured.
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.kind)).toContain('owner_org_lookup');
    expect(mockLogger.error).toHaveBeenCalled();
    expect(mockSentry.captureMessage).toHaveBeenCalledWith(
      'suborg_webhook_fanout_unresolved',
      expect.anything(),
    );
  });

  it('counts a failed descendant probe instead of silently skipping the fan-out', async () => {
    setFanoutFlag(true);
    install({
      endpoints: [endpoint('ep_child', CHILD_ORG, 'self')],
      orgs: APPROVED_TREE,
      descendantProbeError: 'statement timeout',
    });

    const result = await dispatchWebhookEvent(CHILD_ORG, 'anchor.secured', 'evt_9', SECURED_PAYLOAD);

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.kind)).toContain('descendant_endpoint_probe');
    expect(deliveredUrls()).toEqual([expect.stringContaining('ep_child')]);
  });

  it('refuses an unattributable cross-organization copy when the schema cannot carry org_public_id', async () => {
    // anchor.batch_secured is `.strict()` WITHOUT org_public_id. Sending it
    // across a tenant boundary would either break the frozen contract or arrive
    // unattributed; both are worse than not sending it.
    setFanoutFlag(true);
    install({
      endpoints: [
        endpoint('ep_child', CHILD_ORG, 'self', ['anchor.batch_secured']),
        endpoint('ep_parent', PARENT_ORG, 'self_and_descendants', ['anchor.batch_secured']),
      ],
      orgs: APPROVED_TREE,
    });

    const result = await dispatchWebhookEvent(
      CHILD_ORG,
      'anchor.batch_secured',
      'evt_10',
      BATCH_PAYLOAD,
    );

    expect(deliveredUrls()).toEqual([expect.stringContaining('ep_child')]);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.kind)).toContain('cross_org_payload_rejected');
    expect(result.descendantEndpointCount).toBe(0);
  });

  it('delivers exactly once to an endpoint that appears in both selections', async () => {
    setFanoutFlag(true);
    const shared = endpoint('ep_shared', CHILD_ORG, 'self_and_descendants');
    install({
      // A self-parenting fixture: the same endpoint row satisfies both the
      // own-org selection and the parent selection. The dedupe must hold even
      // though the database should never produce this.
      endpoints: [shared],
      orgs: {
        [CHILD_ORG]: {
          parent_org_id: CHILD_ORG,
          parent_approval_status: 'APPROVED',
          public_id: CHILD_PUBLIC_ID,
        },
      },
    });

    const result = await dispatchWebhookEvent(CHILD_ORG, 'anchor.secured', 'evt_11', SECURED_PAYLOAD);

    expect(deliveredUrls()).toHaveLength(1);
    expect(result.descendantEndpointCount).toBe(0);
  });

  it('fans out to an affiliate that has no endpoints of its own', async () => {
    setFanoutFlag(true);
    install({
      endpoints: [endpoint('ep_parent', PARENT_ORG, 'self_and_descendants')],
      orgs: APPROVED_TREE,
    });

    const result = await dispatchWebhookEvent(CHILD_ORG, 'anchor.secured', 'evt_12', SECURED_PAYLOAD);

    // The "no endpoints configured" early return must not pre-empt the fan-out.
    expect(deliveredUrls()).toEqual([expect.stringContaining('ep_parent')]);
    expect(result.ownEndpointCount).toBe(0);
    expect(result.descendantEndpointCount).toBe(1);
  });

  it('refuses the cross-organization copy when the owning organization has no public_id', async () => {
    setFanoutFlag(true);
    install({
      endpoints: [
        endpoint('ep_child', CHILD_ORG, 'self'),
        endpoint('ep_parent', PARENT_ORG, 'self_and_descendants'),
      ],
      orgs: {
        ...APPROVED_TREE,
        [CHILD_ORG]: { parent_org_id: PARENT_ORG, parent_approval_status: 'APPROVED', public_id: null },
      },
    });

    const result = await dispatchWebhookEvent(CHILD_ORG, 'anchor.secured', 'evt_13', SECURED_PAYLOAD);

    expect(deliveredUrls()).toEqual([expect.stringContaining('ep_child')]);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.kind)).toContain('owner_public_id_missing');
  });

  it('re-validates the affiliation cache against a clock sampled at the read', async () => {
    setFanoutFlag(true);
    install({
      endpoints: [
        endpoint('ep_child', CHILD_ORG, 'self'),
        endpoint('ep_parent', PARENT_ORG, 'self_and_descendants'),
      ],
      orgs: APPROVED_TREE,
    });

    const t0 = Date.UTC(2026, 8, 12, 10, 0, 0);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(t0);
      await dispatchWebhookEvent(CHILD_ORG, 'anchor.secured', 'evt_14a', SECURED_PAYLOAD);
      expect(orgLookupCount()).toBe(1);

      // Inside the TTL: the cached entry answers, the hot table is not read.
      vi.setSystemTime(t0 + FANOUT_CACHE_TTL_MS - 1);
      await dispatchWebhookEvent(CHILD_ORG, 'anchor.secured', 'evt_14b', SECURED_PAYLOAD);
      expect(orgLookupCount()).toBe(1);

      // Past expiresAt: re-read, so a revocation is picked up within the TTL
      // rather than held for the life of the process.
      vi.setSystemTime(t0 + FANOUT_CACHE_TTL_MS + 1);
      await dispatchWebhookEvent(CHILD_ORG, 'anchor.secured', 'evt_14c', SECURED_PAYLOAD);
      expect(orgLookupCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keys affiliate ordering by the affiliate public id, namespaced by family', () => {
    expect(
      deriveResourceKey('suborg.approved', {
        public_id: CHILD_PUBLIC_ID,
        parent_public_id: PARENT_PUBLIC_ID,
      }),
    ).toBe(`suborg:${CHILD_PUBLIC_ID}`);
  });
});
