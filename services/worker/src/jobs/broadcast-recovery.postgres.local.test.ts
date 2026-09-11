/** Real 0442 SQL behind the production recovery caller; only transport and chain reconciliation are substituted. */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const rpc = vi.fn();
vi.mock('../utils/db.js', () => ({ db: {
  rpc: (...args: unknown[]) => ({ abortSignal: () => rpc(...args) }),
  from: () => { throw new Error('Recovery must not perform client-side anchor writes'); },
} }));
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// The actual journal eligibility predicate remains in SQL. No chain provider is contacted here.
vi.mock('./batch-anchor.js', () => ({ reconcileTxidJournals: async () => ({
  protectionLoaded: true, scanned: 0, adopted: 0, reverted: 0, held: 0,
}) }));
const { recoverStuckBroadcasts } = await import('./broadcast-recovery.js');
const GATED = process.env.RECOVER_STUCK_BROADCASTS_PG === '1';
const DB_URL = process.env.RECOVER_STUCK_BROADCASTS_PG_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const fixture = new URL(DB_URL);
if (!['postgres:', 'postgresql:'].includes(fixture.protocol)
  || !['127.0.0.1', 'localhost', '[::1]'].includes(fixture.hostname)
  || !['54322', '55503', '15422', '16422', '17422', '18422', '19422'].includes(fixture.port)) {
  throw new Error('Recovery integration requires an owned loopback PostgreSQL fixture');
}
function sql(query: string): string {
  return execFileSync('psql', [DB_URL, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'SHOW_ALL_RESULTS=off'],
    { input: query, encoding: 'utf8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 }).trim();
}
function service(query: string): string {
  return sql(`SET ROLE service_role; SET request.jwt.claims = '{"role":"service_role"}'; ${query}`);
}
const user = randomUUID();
function seed(count: number): void {
  sql(`INSERT INTO public.anchors (user_id, fingerprint, filename, status, metadata, updated_at)
    SELECT '${user}', lpad(to_hex(i),64,'0'), 'real-recovery-' || i,
      CASE WHEN i % 2 = 0 THEN 'BROADCASTING'::anchor_status ELSE 'SUBMITTED'::anchor_status END,
      '{"_claimed_by":"old-worker","_claimed_at":"old","retained":"yes"}'::jsonb,
      now() - interval '1 hour' FROM generate_series(1,${count}) i;`);
}
function callSql(args: { p_stale_minutes: number; p_limit: number }): unknown[] {
  if (!Number.isInteger(args.p_stale_minutes) || !Number.isInteger(args.p_limit)) throw new Error('Invalid test arguments');
  return JSON.parse(service(`SELECT coalesce(json_agg(t),'[]') FROM public.recover_stuck_broadcasts(${args.p_stale_minutes},${args.p_limit}) t`));
}
function count(where: string): number {
  return Number(sql(`SELECT count(*) FROM public.anchors WHERE user_id='${user}' AND (${where})`));
}

describe.skipIf(!GATED)('production caller with real bounded recovery SQL', () => {
  beforeAll(() => {
    sql(`INSERT INTO auth.users(id,email) VALUES ('${user}','recovery-${user}@test.local');
      INSERT INTO public.profiles(id,email) VALUES ('${user}','recovery-${user}@test.local');`);
  });
  beforeEach(() => {
    service(`DELETE FROM public.anchor_txid_journal WHERE batch_id LIKE 'review-${user}%';
      DELETE FROM public.anchors WHERE user_id='${user}';`);
    rpc.mockReset();
    rpc.mockImplementation(async (_name: string, args: { p_stale_minutes: number; p_limit: number }) => ({ data: callSql(args), error: null }));
  });
  afterAll(() => {
    service(`DELETE FROM public.anchor_txid_journal WHERE batch_id LIKE 'review-${user}%';
      DELETE FROM public.anchors WHERE user_id='${user}';`);
    sql(`DELETE FROM public.profiles WHERE id='${user}'; DELETE FROM auth.users WHERE id='${user}';`);
  });
  it('drains 10,000 real stale rows in 21 bounded attempts and preserves unrelated metadata', async () => {
    seed(10_000);
    const result = await recoverStuckBroadcasts();
    expect(result).toMatchObject({ recovered: 10_000, passes: 21, incomplete: false });
    expect(new Set(result.anchors.map(a => a.id)).size).toBe(10_000);
    expect(count("status='PENDING' AND metadata->>'retained'='yes' AND NOT metadata ? '_claimed_by' AND NOT metadata ? '_claimed_at' AND metadata->>'_previous_claimed_by'='old-worker'")).toBe(10_000);
    expect(count("metadata->>'_recovered_from_status'='SUBMITTED'")).toBe(5_000);
    expect(count("metadata->>'_recovered_from_status'='BROADCASTING'")).toBe(5_000);
  }, 60_000);
  it('keeps an actual committed reset after a lost reply and allows exactly one subsequent claim', async () => {
    seed(1);
    rpc.mockImplementationOnce(async (_name: string, args: { p_stale_minutes: number; p_limit: number }) => {
      expect(callSql(args)).toHaveLength(1); // psql has committed before the response is discarded.
      return { data: null, error: { code: 'ECONNRESET', message: 'injected lost response after commit' } };
    });
    expect(await recoverStuckBroadcasts()).toMatchObject({ recovered: 0, incomplete: true });
    expect(count("status='PENDING'")).toBe(1);
    const metadata = sql(`SELECT metadata FROM public.anchors WHERE user_id='${user}'`);
    expect(await recoverStuckBroadcasts()).toMatchObject({ recovered: 0, passes: 1, incomplete: false });
    expect(sql(`SELECT metadata FROM public.anchors WHERE user_id='${user}'`)).toBe(metadata);
    expect(Number(service("SELECT count(*) FROM public.claim_pending_anchors('resumed-worker',500,false)"))).toBe(1);
    expect(Number(service("SELECT count(*) FROM public.claim_pending_anchors('resumed-worker',500,false)"))).toBe(0);
    expect(count("status='BROADCASTING' AND metadata->>'_claimed_by'='resumed-worker'")).toBe(1);
  }, 30_000);
  it('preserves txid, deleted and durable pending/held journal rows while resetting eligible rows', async () => {
    seed(6);
    // Insert protected rows with their original stale timestamp; UPDATE would refresh that timestamp.
    service(`DELETE FROM public.anchors WHERE user_id='${user}';`);
    for (let i = 1; i <= 6; i++) {
      const id = randomUUID();
      sql(`INSERT INTO public.anchors(id,user_id,fingerprint,filename,status,chain_tx_id,deleted_at,updated_at)
        VALUES ('${id}','${user}',lpad('${i}',64,'0'),'guard-${i}','BROADCASTING',
        ${i === 1 ? "repeat('a',64)" : 'NULL'},${i === 2 ? 'now()' : 'NULL'},now()-interval '1 hour');`);
      if (i === 3 || i === 4) {
        sql(`INSERT INTO public.anchor_txid_journal(batch_id,txid,fingerprint_root,anchor_ids,leaf_order,recovery_status,held_at,hold_reason)
          VALUES ('review-${user}-${i}',lpad('${i}',64,'0'),repeat('f',64),ARRAY['${id}'::uuid],jsonb_build_array('${id}'),
          '${i === 3 ? 'PENDING' : 'HELD'}',${i === 4 ? 'now()' : 'NULL'},${i === 4 ? "'uncertain'" : 'NULL'});`);
      }
    }
    expect(await recoverStuckBroadcasts()).toMatchObject({ recovered: 2, incomplete: false });
    expect(count("status='BROADCASTING'")).toBe(4);
  }, 30_000);
});
