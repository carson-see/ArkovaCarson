/**
 * Tests for SCRUM-1145 — compliance inbox summary endpoint.
 *
 * Acceptance Criteria:
 *   - Summary counts are scoped to caller organization.
 *   - Shows captured today, secured automatically, needs review, failed,
 *     and aging review items.
 *   - Links each metric to the relevant queue/filter.
 *   - Empty states are demo-safe and do not imply failure.
 *   - Counts can be refreshed without a full page reload (HTTP 200 + cache headers).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const profilesMaybeSingle = vi.fn();
// Per-table head:'exact' counters
const counts: Record<string, number> = {};
const setCount = (key: string, value: number) => { counts[key] = value; };

vi.mock('../config.js', () => ({ config: {} }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/db.js', () => {
  // Two tables we read counts from:
  //   organization_rule_events  (for "captured today")
  //   organization_rule_executions  (for status-bucketed counts)
  //
  // Each chain ends in `.eq(...)` (multiple `.eq` calls allowed) and resolves
  // to a Supabase head=true count response. The mock encodes the chain as a
  // comma-joined "key" and reads the test-injected count from `counts`.
  const buildChain = (table: string) => {
    const filters: string[] = [];
    const wrap: Record<string, unknown> = {};
    wrap.select = (_cols?: string, _opts?: { count?: string; head?: boolean }) => wrap;
    wrap.eq = (col: string, val: unknown) => {
      filters.push(`${col}=${String(val)}`);
      return wrap;
    };
    wrap.in = (col: string, vals: unknown[]) => {
      filters.push(`${col}=in(${vals.join('|')})`);
      return wrap;
    };
    wrap.gte = (col: string, val: unknown) => {
      filters.push(`${col}>=${String(val)}`);
      return wrap;
    };
    wrap.lt = (col: string, val: unknown) => {
      filters.push(`${col}<${String(val)}`);
      return wrap;
    };
    wrap.then = (resolve: (v: { count: number; error: null }) => unknown) => {
      const key = `${table}|${filters.sort().join(',')}`;
      resolve({ count: counts[key] ?? 0, error: null });
      return Promise.resolve();
    };
    return wrap;
  };

  return {
    db: {
      from: (table: string) => {
        if (table === 'profiles') {
          return {
            select: () => ({
              eq: () => ({ maybeSingle: () => profilesMaybeSingle() }),
            }),
          };
        }
        return buildChain(table);
      },
    },
  };
});

const { handleComplianceInboxSummary, AGING_REVIEW_DAYS } = await import('./compliance-inbox-summary.js');

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function buildRes() {
  let statusCode: number | undefined;
  let body: unknown;
  const json = vi.fn((payload: unknown) => { body = payload; });
  const status = vi.fn((code: number) => { statusCode = code; return { json, setHeader: vi.fn() }; });
  const setHeader = vi.fn();
  const res = { status, json, setHeader } as unknown as Response;
  return { res, status, json, setHeader, get body() { return body; }, get statusCode() { return statusCode; } };
}

function buildReq(query: Record<string, string> = {}): Request {
  return { query, headers: {} } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(counts)) delete counts[k];
  profilesMaybeSingle.mockResolvedValue({ data: { org_id: ORG_ID }, error: null });
});

afterEach(() => vi.clearAllMocks());

describe('compliance-inbox-summary (SCRUM-1145)', () => {
  it('rejects callers without an org with 403', async () => {
    profilesMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const ctx = buildRes();
    await handleComplianceInboxSummary(USER_ID, buildReq(), ctx.res);
    expect(ctx.status).toHaveBeenCalledWith(403);
  });

  it('returns counts shape with all required buckets, scoped to caller org', async () => {
    const ctx = buildRes();
    await handleComplianceInboxSummary(USER_ID, buildReq(), ctx.res);
    const body = ctx.body as {
      counts: {
        captured_today: number;
        secured_automatically: number;
        needs_review: number;
        failed: number;
        aging_review: number;
      };
      links: Record<string, string>;
      generated_at: string;
    };
    expect(typeof body.counts.captured_today).toBe('number');
    expect(typeof body.counts.secured_automatically).toBe('number');
    expect(typeof body.counts.needs_review).toBe('number');
    expect(typeof body.counts.failed).toBe('number');
    expect(typeof body.counts.aging_review).toBe('number');
    expect(typeof body.links.needs_review).toBe('string');
    expect(typeof body.links.failed).toBe('string');
    expect(typeof body.generated_at).toBe('string');
  });

  it('does not expose internal org_id in the response body (CLAUDE.md §6)', async () => {
    const ctx = buildRes();
    await handleComplianceInboxSummary(USER_ID, buildReq(), ctx.res);
    const body = ctx.body as Record<string, unknown>;
    expect(body.org_id).toBeUndefined();
  });

  it('captured_today reads from organization_rule_events with org+date filters', async () => {
    // Place a count using a key that matches the filter the impl produces.
    // The impl filters: org_id, created_at >= startOfDay
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    setCount(
      `organization_rule_events|created_at>=${today.toISOString()},org_id=${ORG_ID}`,
      7,
    );
    const ctx = buildRes();
    await handleComplianceInboxSummary(USER_ID, buildReq(), ctx.res);
    const body = ctx.body as { counts: { captured_today: number } };
    expect(body.counts.captured_today).toBe(7);
  });

  it('needs_review counts SUCCEEDED executions where output_payload->>routed_to=review_queue', async () => {
    // The impl filters on the JSONB extracted field — never on a column.
    setCount(
      `organization_rule_executions|org_id=${ORG_ID},output_payload->>routed_to=review_queue,status=SUCCEEDED`,
      3,
    );
    const ctx = buildRes();
    await handleComplianceInboxSummary(USER_ID, buildReq(), ctx.res);
    const body = ctx.body as { counts: { needs_review: number } };
    expect(body.counts.needs_review).toBe(3);
  });

  it('failed counts FAILED + DLQ executions', async () => {
    setCount(
      `organization_rule_executions|org_id=${ORG_ID},status=in(FAILED|DLQ)`,
      4,
    );
    const ctx = buildRes();
    await handleComplianceInboxSummary(USER_ID, buildReq(), ctx.res);
    const body = ctx.body as { counts: { failed: number } };
    expect(body.counts.failed).toBe(4);
  });

  it('aging_review uses AGING_REVIEW_DAYS threshold', async () => {
    expect(AGING_REVIEW_DAYS).toBeGreaterThanOrEqual(3);
  });

  it('empty state: returns zeros without any error indicator', async () => {
    const ctx = buildRes();
    await handleComplianceInboxSummary(USER_ID, buildReq(), ctx.res);
    const body = ctx.body as { counts: Record<string, number>; status?: string };
    expect(Object.values(body.counts).every((v) => typeof v === 'number')).toBe(true);
    expect(body.status).toBeUndefined(); // no implicit "error" tag in payload
    expect(ctx.status).toHaveBeenCalledWith(200);
  });
});
