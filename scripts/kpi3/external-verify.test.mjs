/**
 * KPI-3 external-verifier tests (SCRUM-2912 / SCRUM-2986).
 *
 * TDD spec for `verifyAnchorProof` — the "stranger with zero help from us"
 * independent verifier used in the KPI-3 dress rehearsal. It proves:
 *   1. a VALID Arkova direct-anchor proof verifies hash -> OP_RETURN -> block;
 *   2. the NEGATIVE CONTROL (a tampered proof) is REJECTED with a precise
 *      reason — the deliberate "fake proof" the rehearsal must show failing.
 *
 * Deterministic + offline: the explorer is injected as a fake keyed by txid,
 * so the same assertions run in CI without a network. The live rehearsal
 * (external-verify.mjs, --live) hits blockstream.info for the recording.
 *
 * Run: node --test scripts/kpi3/external-verify.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAnchorProof } from './external-verify.mjs';
import { VALID_PROOF, TAMPERED_PROOF, FAKE_EXPLORER } from './fixtures.mjs';

/** An injected fetch that returns canned explorer tx JSON, or 404s. */
function fakeExplorer(map) {
  return async (txid) => {
    if (!(txid in map)) {
      const e = new Error('not found');
      e.status = 404;
      throw e;
    }
    return map[txid];
  };
}

test('VALID direct-anchor proof verifies hash -> OP_RETURN -> block', async () => {
  const r = await verifyAnchorProof(VALID_PROOF, fakeExplorer(FAKE_EXPLORER));
  assert.equal(r.verified, true, `expected verified, got reason=${r.reason}`);
  assert.equal(r.checks.confirmed, true);
  assert.equal(r.checks.magicOk, true);
  assert.equal(r.checks.fingerprintCommitted, true);
  assert.equal(r.checks.blockMatch, true);
  assert.equal(r.reason, null);
});

test('NEGATIVE CONTROL: tampered fingerprint is REJECTED', async () => {
  const r = await verifyAnchorProof(TAMPERED_PROOF, fakeExplorer(FAKE_EXPLORER));
  assert.equal(r.verified, false, 'a tampered proof MUST fail verification');
  assert.equal(r.checks.fingerprintCommitted, false);
  assert.equal(r.reason, 'fingerprint_not_committed_in_op_return');
});

test('REJECT: transaction not found on the explorer', async () => {
  const r = await verifyAnchorProof(
    { ...VALID_PROOF, txid: 'deadbeef'.repeat(8) },
    fakeExplorer(FAKE_EXPLORER),
  );
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'tx_not_found');
});

test('REJECT: transaction present but unconfirmed', async () => {
  const unconf = structuredClone(FAKE_EXPLORER);
  unconf[VALID_PROOF.txid].status.confirmed = false;
  const r = await verifyAnchorProof(VALID_PROOF, fakeExplorer(unconf));
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'tx_unconfirmed');
});

test('REJECT: no OP_RETURN output on the transaction', async () => {
  const noop = structuredClone(FAKE_EXPLORER);
  noop[VALID_PROOF.txid].vout = noop[VALID_PROOF.txid].vout.filter(
    (v) => v.scriptpubkey_type !== 'op_return',
  );
  const r = await verifyAnchorProof(VALID_PROOF, fakeExplorer(noop));
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'no_op_return');
});

test('REJECT: OP_RETURN present but wrong magic prefix (not ARKV)', async () => {
  const badmagic = structuredClone(FAKE_EXPLORER);
  // Replace the 4-byte magic 41524b56 (ARKV) with 00000000, keep the rest.
  const orv = badmagic[VALID_PROOF.txid].vout.find((v) => v.scriptpubkey_type === 'op_return');
  orv.scriptpubkey = orv.scriptpubkey.replace('41524b56', '00000000');
  const r = await verifyAnchorProof(VALID_PROOF, fakeExplorer(badmagic));
  assert.equal(r.verified, false);
  assert.equal(r.checks.magicOk, false);
  assert.equal(r.reason, 'bad_magic');
});

test('REJECT: block height mismatch when an expected height is asserted', async () => {
  const r = await verifyAnchorProof(
    { ...VALID_PROOF, expectedBlockHeight: 999999 },
    fakeExplorer(FAKE_EXPLORER),
  );
  assert.equal(r.verified, false);
  assert.equal(r.checks.blockMatch, false);
  assert.equal(r.reason, 'block_height_mismatch');
});
