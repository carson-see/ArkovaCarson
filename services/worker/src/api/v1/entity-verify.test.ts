/**
 * SCRUM-4985 — GET /api/v1/verify/entity attestation lookup must never
 * assemble PostgREST filter grammar from caller input.
 *
 * Before the fix the handler built
 *   .or(`subject_identifier.eq.${identifier}`)
 * so an identifier such as `x,attester_name.neq.zzz` appended a second OR
 * clause and turned a targeted lookup into enumeration of every ACTIVE
 * attestation. The tests pin the query-builder form: no `.or()` at all, and
 * the raw identifier passed as a builder argument so it lands in a position
 * (`subject_identifier=eq.<value>`) where a comma is not grammar. The last
 * test proves that at the wire level — percent-encoding alone never closed
 * this, because PostgREST decodes a parameter value before parsing it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../utils/queryMonitor.js', () => ({
  monitorQuery: (_name: string, fn: () => unknown) => fn(),
}));

import { entityVerifyRouter } from './entity-verify.js';
import { db } from '../../utils/db.js';

interface Recorded { table: string; calls: Array<{ method: string; args: unknown[] }> }

function mockChain(table: string, data: unknown, log: Recorded[]) {
  const rec: Recorded = { table, calls: [] };
  log.push(rec);
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'or', 'ilike', 'order', 'limit', 'single']) {
    chain[method] = vi.fn((...args: unknown[]) => { rec.calls.push({ method, args }); return chain; });
  }
  Object.defineProperty(chain, 'then', {
    value: (resolve: (v: unknown) => void) => Promise.resolve({ data, error: null }).then(resolve),
  });
  return chain;
}

function createApp() {
  const app = express();
  app.use('/', entityVerifyRouter);
  return app;
}

describe('entity-verify attestation filter (SCRUM-4985)', () => {
  const app = createApp();
  let log: Recorded[];

  beforeEach(() => {
    vi.clearAllMocks();
    log = [];
    vi.mocked(db.from).mockImplementation((...args: unknown[]) => {
      const table = (args as unknown as string[])[0];
      if (table === 'attestations') {
        return mockChain(table, [{ id: 'att-1', public_id: 'ATT-1', subject_identifier: 'x', status: 'ACTIVE' }], log) as never;
      }
      return mockChain(table, [], log) as never;
    });
  });

  it('never builds an .or() filter string and passes the raw identifier to the builder', async () => {
    const injected = 'x,attester_name.neq.zzz';
    const res = await request(app).get('/').query({ identifier: injected });
    expect(res.status).toBe(200);

    const attestationCalls = log.filter((r) => r.table === 'attestations').flatMap((r) => r.calls);
    expect(attestationCalls.some((c) => c.method === 'or')).toBe(false);
    expect(attestationCalls).toContainEqual({ method: 'eq', args: ['subject_identifier', injected] });
    expect(attestationCalls).toContainEqual({ method: 'eq', args: ['status', 'ACTIVE'] });
  });

  it('runs the name term as a separate ilike with wildcards stripped', async () => {
    const res = await request(app).get('/').query({ name: 'Ada%_\\Lovelace' });
    expect(res.status).toBe(200);

    const attestationCalls = log.filter((r) => r.table === 'attestations').flatMap((r) => r.calls);
    expect(attestationCalls.some((c) => c.method === 'or')).toBe(false);
    const ilike = attestationCalls.find((c) => c.method === 'ilike');
    expect(ilike?.args[0]).toBe('subject_identifier');
    expect(String(ilike?.args[1])).toBe('%AdaLovelace%');
  });

  it('skips the name query once identifier matches have filled the limit', async () => {
    vi.mocked(db.from).mockImplementation((...args: unknown[]) => {
      const table = (args as unknown as string[])[0];
      if (table === 'attestations') {
        return mockChain(table, [{ id: 'a1' }, { id: 'a2' }], log) as never;
      }
      return mockChain(table, [], log) as never;
    });
    const res = await request(app).get('/').query({ name: 'x', identifier: 'x', limit: 2 });
    expect(res.status).toBe(200);
    expect(res.body.total_attestations).toBe(2);
    const attestationQueries = log.filter((r) => r.table === 'attestations');
    expect(attestationQueries).toHaveLength(1);
    expect(attestationQueries[0].calls.some((c) => c.method === 'ilike')).toBe(false);
  });

  // CTO review: the three tests above pin the *call shape* (no `.or()`), which
  // is only meaningful if the builder form is actually injection-proof. This
  // one proves that at the wire level against the real postgrest-js, and shows
  // why "the builder encodes the value" is NOT the reason: the old `.or()`
  // payload was percent-encoded too, and PostgREST decodes a query-parameter
  // value before parsing it, so the comma was still read as an OR separator.
  it('emits the injected identifier as one literal eq value, where a comma carries no grammar', async () => {
    const { PostgrestClient } = await import('@supabase/postgrest-js');
    const client = new PostgrestClient('http://postgrest.invalid');
    const injected = 'x,attester_name.neq.zzz';

    const urlOf = (b: unknown) => String((b as { url: URL }).url);

    const fixed = urlOf(client
      .from('attestations')
      .select('id')
      .eq('status', 'ACTIVE')
      .eq('subject_identifier', injected));
    // One filter param; the comma lives inside the value, so PostgREST reads
    // `x,attester_name.neq.zzz` as the literal string to match.
    expect(fixed).toContain('subject_identifier=eq.x%2Cattester_name.neq.zzz');
    expect(fixed).not.toContain('or=');

    const vulnerable = urlOf(client
      .from('attestations')
      .select('id')
      .eq('status', 'ACTIVE')
      .or(`subject_identifier.eq.${injected}`));
    // Same percent-encoding — and still a second OR term after the decode.
    expect(vulnerable).toContain('%2Cattester_name.neq.zzz');
    expect(decodeURIComponent(vulnerable)).toContain('or=(subject_identifier.eq.x,attester_name.neq.zzz)');
  });

  it('unions name and identifier results by id and caps at limit', async () => {
    const res = await request(app).get('/').query({ name: 'x', identifier: 'x', limit: 5 });
    expect(res.status).toBe(200);
    // Both queries return the same row; the union must contain it once.
    const attestations: Array<{ id: string }> = res.body.attestations;
    expect(attestations.filter((a) => a.id === 'att-1')).toHaveLength(1);
    expect(res.body.total_attestations).toBe(1);
  });
});
