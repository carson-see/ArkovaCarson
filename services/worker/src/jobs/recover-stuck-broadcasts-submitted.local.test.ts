/**
 * F-3 (docs/staging/SOAK-FINDINGS-2026-08.md) — migration 0379 hardened
 * `recover_stuck_broadcasts()` against a REAL local Postgres (local Supabase
 * stack), NOT a mock. Mirrors the
 * `services/worker/src/jobs/proof-materializer-trigger.local.test.ts` pattern.
 *
 * Pre-0379, `recover_stuck_broadcasts()` only queried `status = 'BROADCASTING'`.
 * An anchor left `SUBMITTED` with a NULL `chain_tx_id` had no scheduled job
 * whose WHERE clause ever selected it — proven live during the 72h soak
 * (fixture `5eed0000-...-c1` sat unrecovered for days). This suite proves,
 * against real Postgres row locking / trigger / RLS-adjacent semantics (not a
 * JS reimplementation), that the widened RPC:
 *
 *   (a) DOES reclaim a stale SUBMITTED row with NULL chain_tx_id → PENDING
 *   (b) does NOT touch a SUBMITTED row that already carries a real
 *       chain_tx_id (the broadcast happened — resetting it would double-spend
 *       treasury sats on the next drain)
 *   (c) does NOT touch a SUBMITTED+NULL-chain_tx_id row that is not yet past
 *       the stale threshold (still legitimately in flight)
 *   (d) does NOT touch a SUBMITTED+NULL-chain_tx_id row protected by an
 *       unresolved (PENDING) anchor_txid_journal cohort — the SCRUM-2692
 *       protection extends to the new branch exactly like it already does
 *       for BROADCASTING
 *   (e) still recovers a stale BROADCASTING+NULL-chain_tx_id row (regression
 *       guard on the pre-existing branch) and tags it with the pre-existing
 *       `_recovery_reason: 'stuck_broadcasting'`, while the new SUBMITTED
 *       branch is tagged `_recovery_reason: 'stuck_submitted_null_txid'`
 *
 * `recover_stuck_broadcasts()` is called via raw psql (no PostgREST in the
 * loop), so — exactly like `resolve_anchor_txid_journal()` does internally —
 * the test manually sets `request.jwt.claim.role = 'service_role'` in the
 * SAME session as the call, simulating what PostgREST sets automatically for
 * a real service-role-authenticated request. Without it, `protect_anchor_
 * status_transition()` (the `protect_anchor_fields` BEFORE UPDATE trigger)
 * rejects the status change, exactly as it must for any non-service-role
 * caller.
 *
 * ENV-GATED (operator-sanctioned): runs only when RECOVER_STUCK_BROADCASTS_PG=1
 * and a local stack is reachable. PRE-REQUISITE: the local stack must have
 * migrations through 0358 applied (anchor_txid_journal + the pre-0379
 * recover_stuck_broadcasts) plus this PR's 0379 file. NEVER point these at a
 * remote/staging/prod project.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const GATED = process.env.RECOVER_STUCK_BROADCASTS_PG === '1';

const DB_URL = process.env.RECOVER_STUCK_BROADCASTS_PG_DB_URL
  ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

function sql(query: string): string {
  return execFileSync(
    'psql',
    [DB_URL, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', query],
    { encoding: 'utf8' },
  ).trim();
}

/** Runs `query` as service_role in ONE session (matches PostgREST's per-request GUC). */
function sqlAsServiceRole(query: string): string {
  return sql(`SELECT set_config('request.jwt.claim.role', 'service_role', false); ${query}`);
}

const USER_ID = randomUUID();
const STALE_UPDATED_AT = `now() - interval '1 hour'`;
const FRESH_UPDATED_AT = 'now()';

// One anchor per case so a wrong reclaim in one case cannot mask another.
const ANCHOR_SUBMITTED_NULL_STALE = randomUUID(); // (a) THE fix: reclaim
const ANCHOR_SUBMITTED_WITH_TX = randomUUID();    // (b) never touch — real broadcast
const ANCHOR_SUBMITTED_NULL_FRESH = randomUUID(); // (c) not yet stale
const ANCHOR_SUBMITTED_JOURNALED = randomUUID();  // (d) journal-protected
const ANCHOR_BROADCASTING_STALE = randomUUID();   // (e) regression: old branch still works

const FP = (tag: string) => tag.repeat(32);

describe.skipIf(!GATED)('F-3 — 0379 recover_stuck_broadcasts SUBMITTED+NULL-txid (REAL local PG)', () => {
  // Every psql invocation pays a fresh connection cost (~1.5-2s against the
  // local Docker stack). One combined multi-statement `-c` call per hook
  // keeps beforeAll/afterAll well under the default 10s hook timeout.
  beforeAll(() => {
    sql(`
      INSERT INTO auth.users (id, email) VALUES ('${USER_ID}', 'f3-recovery-${USER_ID}@test.local');
      INSERT INTO public.profiles (id, email) VALUES ('${USER_ID}', 'f3-recovery-${USER_ID}@test.local');
      INSERT INTO public.anchors (id, user_id, fingerprint, filename, status, chain_tx_id, updated_at) VALUES
        ('${ANCHOR_SUBMITTED_NULL_STALE}', '${USER_ID}', '${FP('a1')}', 'f3-a.pdf', 'SUBMITTED', NULL, ${STALE_UPDATED_AT}),
        ('${ANCHOR_SUBMITTED_WITH_TX}', '${USER_ID}', '${FP('b2')}', 'f3-b.pdf', 'SUBMITTED', '${FP('11')}', ${STALE_UPDATED_AT}),
        ('${ANCHOR_SUBMITTED_NULL_FRESH}', '${USER_ID}', '${FP('c3')}', 'f3-c.pdf', 'SUBMITTED', NULL, ${FRESH_UPDATED_AT}),
        ('${ANCHOR_SUBMITTED_JOURNALED}', '${USER_ID}', '${FP('d4')}', 'f3-d.pdf', 'SUBMITTED', NULL, ${STALE_UPDATED_AT}),
        ('${ANCHOR_BROADCASTING_STALE}', '${USER_ID}', '${FP('e5')}', 'f3-e.pdf', 'BROADCASTING', NULL, ${STALE_UPDATED_AT});
      INSERT INTO public.anchor_txid_journal
        (batch_id, txid, fingerprint_root, anchor_ids, leaf_order, recovery_status) VALUES
        ('f3-local-test-batch-${USER_ID}', '${FP('f6')}', '${FP('a7')}',
         ARRAY['${ANCHOR_SUBMITTED_JOURNALED}']::uuid[], '[0]'::jsonb, 'PENDING');
    `);
  }, 30000);

  afterAll(() => {
    try {
      sql(`
        DELETE FROM public.anchor_txid_journal WHERE batch_id = 'f3-local-test-batch-${USER_ID}';
        DELETE FROM public.anchors WHERE user_id = '${USER_ID}';
        DELETE FROM public.profiles WHERE id = '${USER_ID}';
        DELETE FROM auth.users WHERE id = '${USER_ID}';
      `);
    } catch {
      // Best-effort cleanup — rows are uniquely keyed by fresh UUIDs.
    }
  }, 30000);

  it('reclaims a stale SUBMITTED row with NULL chain_tx_id back to PENDING (the F-3 fix)', () => {
    sqlAsServiceRole(`SELECT * FROM public.recover_stuck_broadcasts(5) WHERE anchor_id = '${ANCHOR_SUBMITTED_NULL_STALE}'`);
    expect(sql(`SELECT status FROM public.anchors WHERE id = '${ANCHOR_SUBMITTED_NULL_STALE}'`)).toBe('PENDING');
    const metadata = sql(`SELECT metadata::text FROM public.anchors WHERE id = '${ANCHOR_SUBMITTED_NULL_STALE}'`);
    expect(metadata).toContain('"_recovery_reason": "stuck_submitted_null_txid"');
    expect(metadata).toContain('"_recovered_from_status": "SUBMITTED"');
  });

  it('NEVER touches a SUBMITTED row that already carries a real chain_tx_id', () => {
    sqlAsServiceRole(`SELECT * FROM public.recover_stuck_broadcasts(5) WHERE anchor_id = '${ANCHOR_SUBMITTED_WITH_TX}'`);
    expect(sql(`SELECT status FROM public.anchors WHERE id = '${ANCHOR_SUBMITTED_WITH_TX}'`)).toBe('SUBMITTED');
    expect(sql(`SELECT chain_tx_id FROM public.anchors WHERE id = '${ANCHOR_SUBMITTED_WITH_TX}'`)).toBe(FP('11'));
  });

  it('does not touch a SUBMITTED+NULL-txid row that is not yet past the stale threshold', () => {
    sqlAsServiceRole(`SELECT * FROM public.recover_stuck_broadcasts(5) WHERE anchor_id = '${ANCHOR_SUBMITTED_NULL_FRESH}'`);
    expect(sql(`SELECT status FROM public.anchors WHERE id = '${ANCHOR_SUBMITTED_NULL_FRESH}'`)).toBe('SUBMITTED');
  });

  it('does not touch a SUBMITTED+NULL-txid row protected by an unresolved anchor_txid_journal cohort', () => {
    sqlAsServiceRole(`SELECT * FROM public.recover_stuck_broadcasts(5) WHERE anchor_id = '${ANCHOR_SUBMITTED_JOURNALED}'`);
    expect(sql(`SELECT status FROM public.anchors WHERE id = '${ANCHOR_SUBMITTED_JOURNALED}'`)).toBe('SUBMITTED');
  });

  it('regression: still reclaims a stale BROADCASTING+NULL-txid row, tagged with the pre-existing reason', () => {
    sqlAsServiceRole(`SELECT * FROM public.recover_stuck_broadcasts(5) WHERE anchor_id = '${ANCHOR_BROADCASTING_STALE}'`);
    expect(sql(`SELECT status FROM public.anchors WHERE id = '${ANCHOR_BROADCASTING_STALE}'`)).toBe('PENDING');
    const metadata = sql(`SELECT metadata::text FROM public.anchors WHERE id = '${ANCHOR_BROADCASTING_STALE}'`);
    expect(metadata).toContain('"_recovery_reason": "stuck_broadcasting"');
    expect(metadata).toContain('"_recovered_from_status": "BROADCASTING"');
  });
});
