/**
 * SCRUM-2917 — 0360 hardened "SECURED ⇒ proof complete" trigger predicate
 * against a REAL local Postgres (local Supabase stack), NOT a mock.
 *
 * Verifies the RULED predicate (CTO ruling, Confluence 110198785) of
 * `enforce_secured_anchor_proof_complete()` after migration 0360:
 *
 *   (merkle_root IS NOT NULL AND proof_path IS NOT NULL)
 *   OR (proof_completeness_class = 'direct_anchored' AND op_return_payload IS NOT NULL)
 *
 * The MANDATED forge test: a bare `proof_completeness_class = 'direct_anchored'`
 * LABEL with NULL op_return_payload must be REJECTED (§1.4 — a label is a
 * classification, not evidence). Honest direct anchors (payload present,
 * merkle fields honestly empty) must pass; batch-shape rows must pass; a
 * missing proof row must fail; and with the GUC off the gate stays inert.
 *
 * GUC handling: each psql invocation is its own session, so
 * `SET arkova.proof_enforce_secured_complete = 'on'` is issued session-level
 * in the SAME psql call as the status UPDATE under test — nothing durable is
 * ever set, so the gate is naturally RESET (off) for the inert-gate case and
 * for every other connection. Fixture rows are cleaned up in afterAll.
 *
 * PRE-REQUISITE: the local stack must have migrations through 0360 applied
 * (0354 proof_completeness_class + 0360 predicate hardening); e.g. after
 * `npx supabase db reset --local` with those files present.
 *
 * ENV-GATED (operator-sanctioned): runs only when PROOF_TRIGGER_PG=1 and a
 * local stack is reachable. Required env (this suite drives everything through
 * psql — no PostgREST client, so only the DB URL is read):
 *   PROOF_TRIGGER_PG=1
 *   PROOF_PG_ROUNDTRIP_DB_URL       e.g. postgresql://postgres:postgres@127.0.0.1:54322/postgres
 * NEVER point these at a remote/staging/prod project.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const GATED = process.env.PROOF_TRIGGER_PG === '1';

const DB_URL = process.env.PROOF_PG_ROUNDTRIP_DB_URL
  ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

function sql(query: string): string {
  return execFileSync(
    'psql',
    [DB_URL, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', query],
    { encoding: 'utf8' },
  ).trim();
}

/**
 * Run a query EXPECTING it to raise; returns psql's verbose stderr (which
 * includes the SQLSTATE, e.g. `ERROR:  23514: ...`) for assertions. Throws if
 * the query unexpectedly succeeds.
 */
function sqlExpectError(query: string): string {
  try {
    execFileSync(
      'psql',
      [DB_URL, '-tA', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-c', query],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
  throw new Error(`expected query to raise check_violation, but it succeeded: ${query}`);
}

const GUC_ON = `SET arkova.proof_enforce_secured_complete = 'on';`;
const CHECK_VIOLATION = '23514';

const USER_ID = randomUUID();
// One anchor per case so rejections cannot contaminate accept cases.
const ANCHOR_BARE_LABEL = randomUUID(); // (a) forged: label only, no payload
const ANCHOR_NO_PROOF = randomUUID();   // (b) no proof row at all
const ANCHOR_BATCH = randomUUID();      // (c) batch shape: merkle_root + proof_path
const ANCHOR_DIRECT = randomUUID();     // (d) honest direct: label + payload bytes
const ANCHOR_GUC_OFF = randomUUID();    // (e) bare label but gate inert

const FP_BARE = 'a1'.repeat(32);
const FP_NOPROOF = 'b2'.repeat(32);
const FP_BATCH = 'c3'.repeat(32);
const FP_DIRECT = 'd4'.repeat(32);
const FP_GUCOFF = 'e5'.repeat(32);

// ARKV(4B) || fingerprint(32B) = 36 raw bytes, written with the \x prefix so
// bytea stores raw bytes (BUG-4 contract, see proof-pg-roundtrip.local.test.ts).
const DIRECT_OP_RETURN = `\\x41524b56${FP_DIRECT}`;

const RECEIPT_ID = `scrum2917_trigger_${Date.now()}`;

describe.skipIf(!GATED)('SCRUM-2917 — 0360 SECURED proof-completeness predicate (REAL local PG)', () => {
  beforeAll(() => {
    // Fixture chain: auth.users → profiles → anchors (FKs). Local stack only.
    sql(`INSERT INTO auth.users (id, email) VALUES ('${USER_ID}', 'scrum2917-trigger-${USER_ID}@test.local')`);
    sql(`INSERT INTO public.profiles (id, email) VALUES ('${USER_ID}', 'scrum2917-trigger-${USER_ID}@test.local')`);
    sql(`INSERT INTO public.anchors (id, user_id, fingerprint, filename, status) VALUES
      ('${ANCHOR_BARE_LABEL}', '${USER_ID}', '${FP_BARE}', 'scrum2917-bare-label.pdf', 'PENDING'),
      ('${ANCHOR_NO_PROOF}', '${USER_ID}', '${FP_NOPROOF}', 'scrum2917-no-proof.pdf', 'PENDING'),
      ('${ANCHOR_BATCH}', '${USER_ID}', '${FP_BATCH}', 'scrum2917-batch.pdf', 'PENDING'),
      ('${ANCHOR_DIRECT}', '${USER_ID}', '${FP_DIRECT}', 'scrum2917-direct.pdf', 'PENDING'),
      ('${ANCHOR_GUC_OFF}', '${USER_ID}', '${FP_GUCOFF}', 'scrum2917-guc-off.pdf', 'PENDING')`);

    // (a) FORGED shape: bare direct_anchored label, NO payload, NO merkle fields.
    sql(`INSERT INTO public.anchor_proofs (anchor_id, receipt_id, proof_completeness_class) VALUES
      ('${ANCHOR_BARE_LABEL}', '${RECEIPT_ID}', 'direct_anchored')`);
    // (b) ANCHOR_NO_PROOF deliberately gets NO anchor_proofs row.
    // (c) Batch shape: merkle_root + proof_path present.
    sql(`INSERT INTO public.anchor_proofs (anchor_id, receipt_id, merkle_root, proof_path) VALUES
      ('${ANCHOR_BATCH}', '${RECEIPT_ID}', '${'f6'.repeat(32)}', '[{"position":"right","hash":"${'a7'.repeat(32)}"}]'::jsonb)`);
    // (d) HONEST direct anchor: label + real OP_RETURN payload bytes,
    //     merkle_root/proof_path honestly NULL (never synthesize a branch).
    sql(`INSERT INTO public.anchor_proofs (anchor_id, receipt_id, proof_completeness_class, op_return_payload) VALUES
      ('${ANCHOR_DIRECT}', '${RECEIPT_ID}', 'direct_anchored', '${DIRECT_OP_RETURN}'::bytea)`);
    // (e) Same forged shape as (a), used with the GUC left OFF.
    sql(`INSERT INTO public.anchor_proofs (anchor_id, receipt_id, proof_completeness_class) VALUES
      ('${ANCHOR_GUC_OFF}', '${RECEIPT_ID}', 'direct_anchored')`);
  });

  afterAll(() => {
    try {
      sql(`DELETE FROM public.anchor_proofs WHERE receipt_id = '${RECEIPT_ID}'`);
      sql(`DELETE FROM public.anchors WHERE user_id = '${USER_ID}'`);
      sql(`DELETE FROM public.profiles WHERE id = '${USER_ID}'`);
      sql(`DELETE FROM auth.users WHERE id = '${USER_ID}'`);
    } catch {
      // Best-effort cleanup — rows are uniquely keyed by fresh UUIDs.
    }
  });

  it('REJECTS a bare direct_anchored label with NULL op_return_payload (the mandated forge test)', () => {
    const stderr = sqlExpectError(
      `${GUC_ON} UPDATE public.anchors SET status = 'SECURED' WHERE id = '${ANCHOR_BARE_LABEL}';`,
    );
    expect(stderr).toContain(CHECK_VIOLATION);
    expect(stderr).toContain('a bare proof_completeness_class label is not proof');
    // The rejected UPDATE rolled back — the anchor must still be PENDING.
    expect(sql(`SELECT status FROM public.anchors WHERE id = '${ANCHOR_BARE_LABEL}'`)).toBe('PENDING');
  });

  it('REJECTS a transition into SECURED when no anchor_proofs row exists', () => {
    const stderr = sqlExpectError(
      `${GUC_ON} UPDATE public.anchors SET status = 'SECURED' WHERE id = '${ANCHOR_NO_PROOF}';`,
    );
    expect(stderr).toContain(CHECK_VIOLATION);
    expect(sql(`SELECT status FROM public.anchors WHERE id = '${ANCHOR_NO_PROOF}'`)).toBe('PENDING');
  });

  it('ACCEPTS the batch shape (merkle_root + proof_path)', () => {
    sql(`${GUC_ON} UPDATE public.anchors SET status = 'SECURED' WHERE id = '${ANCHOR_BATCH}';`);
    expect(sql(`SELECT status FROM public.anchors WHERE id = '${ANCHOR_BATCH}'`)).toBe('SECURED');
  });

  it('ACCEPTS an honest direct anchor (direct_anchored + op_return_payload, NULL merkle fields)', () => {
    // Storage sanity: the payload is the RAW 36 bytes (ARKV || fingerprint).
    expect(sql(`SELECT octet_length(op_return_payload) FROM public.anchor_proofs WHERE anchor_id = '${ANCHOR_DIRECT}'`)).toBe('36');
    expect(sql(`SELECT merkle_root IS NULL AND proof_path IS NULL FROM public.anchor_proofs WHERE anchor_id = '${ANCHOR_DIRECT}'`)).toBe('t');

    sql(`${GUC_ON} UPDATE public.anchors SET status = 'SECURED' WHERE id = '${ANCHOR_DIRECT}';`);
    expect(sql(`SELECT status FROM public.anchors WHERE id = '${ANCHOR_DIRECT}'`)).toBe('SECURED');
  });

  it('is INERT with the GUC off (fresh session, no SET): a bare-label row transitions fine', () => {
    // A fresh psql session with no SET carries the default (unset ≡ off) —
    // the 0340/0360 two-phase gate stays fail-safe until Phase 2 flips it.
    expect(sql(`SELECT COALESCE(NULLIF(current_setting('arkova.proof_enforce_secured_complete', true), ''), 'off')`)).toBe('off');
    sql(`UPDATE public.anchors SET status = 'SECURED' WHERE id = '${ANCHOR_GUC_OFF}';`);
    expect(sql(`SELECT status FROM public.anchors WHERE id = '${ANCHOR_GUC_OFF}'`)).toBe('SECURED');
  });
});
