// PR #2882 — bitcoinjs-lib 6 -> 7 (services/worker/package.json), with the two
// production call sites that needed adjusting for the new library's return
// types: services/worker/src/chain/confirmation-proof.ts `sha256()` (bitcoinjs
// 7 dropped its Node Buffer dependency, so `bitcoin.crypto.sha256()` now
// returns Uint8Array; this wraps it back to Buffer for this function's callers)
// and services/worker/src/chain/signet.ts `buildOpReturnTransaction` /
// `buildMultiInputOpReturnTransaction` (Psbt.addOutput's `value` field is now
// `bigint`, not `number` — three call sites changed to `BigInt(...)`/`0n`).
// Measured tier: T3 (chain/treasury hot path, services/worker/src/chain/**),
// no override — confirmed independently against requiredTierFor() on the
// PR's real changed-file list before this train was built.
//
// WHAT THIS RIG CAN AND CANNOT PROVE.
//
// This rig runs with USE_MOCKS=true / ENABLE_PROD_NETWORK_ANCHORING=false (the
// standard, deliberate safety posture for every staging rig in this repo —
// see RIG-cto-train-b-0912.md's Env line). services/worker/src/config.ts
// documents the consequence directly ("silently fall through to
// MockChainClient" when USE_MOCKS=true / the network-anchoring flag is off).
// getChainClientAsync() — the ONE seam every HTTP-reachable job/route uses to
// reach the chain — resolves to MockChainClient, not BitcoinChainClient, on
// this rig. `services/worker/src/chain/signet.ts`'s BitcoinChainClient class
// is what calls buildOpReturnTransaction/buildMultiInputOpReturnTransaction
// (lines ~783/812 of signet.ts); MockChainClient never calls into signet.ts
// at all. Verified by reading the actual call graph before writing this
// module (grep for every non-test importer of signet.ts and of
// confirmation-proof.ts across services/worker/src — see the PR body / this
// train's report for the full trace): the only production caller of
// signet.ts is services/worker/src/jobs/supplementary-proof-anchor.adapter.ts
// (via getChainClientAsync(), gated the same way), and the only production
// caller of confirmation-proof.ts's fetchConfirmationProof is
// services/worker/src/jobs/confirmation-proof-populate.ts via
// confirmation-proof-backfill.ts, whose own route comment in
// services/worker/src/routes/cron.ts says outright: "runConfirmationProofBackfill
// already no-ops (skipped:true) in mock mode / when prod anchoring is off."
//
// So: NO HTTP-reachable path on this rig — or on any USE_MOCKS=true rig —
// ever executes the two changed lines this PR actually touches. This is not
// a probe-design gap; it is a property of the safety posture every staging
// rig in this repo deliberately runs under (a probe that WOULD reach real
// signing/broadcast is not something to build for a shared soak loop, mocked
// or not). Health checks against this rig are not evidence for this PR's
// changed behavior, and are not presented as such below.
//
// WHAT ACTUALLY EXERCISES THE CHANGED LINES: the PR's own test suite, run
// locally against this train's merged head (branch rc/train-d-2026-09-14,
// head 26bba2748164db75d91a47467bb1080dfeebf005) before this soak was
// launched — services/worker/src/chain/signet.test.ts (28),
// signet.integration.test.ts (constructs real Psbt/Transaction objects via
// bitcoinjs-lib against fake-but-real UTXOs/signers, no network),
// bitcoin-audit.test.ts, confirmation-proof.test.ts,
// confirmation-proof-faults.test.ts,
// extract-anchor-fingerprint.adversarial.test.ts,
// fingerprint-mapping-regression.test.ts, confirmation-proof-populate.test.ts
// — 261/261 passing (`npx vitest run` in services/worker, this exact merged
// head). Those tests build real PSBTs/Transactions with the real
// bitcoinjs-lib 7 APIs (bigint outputs, Uint8Array-returning crypto helpers)
// and assert on the resulting bytes/hex — that is where the Buffer/bigint
// migration is actually proven correct, not here.
//
// RESIDUAL RISK (state this in the RC manifest / PR body, do not silently
// paper over it with a soak-clock number): this train's 24h Cloud Run soak
// gives #2882 general worker-boot/health confidence (the image built with
// bitcoinjs-lib 7 loads and serves traffic) plus the mock-mode safety-gate
// check below, but NOT chain-path runtime coverage. If Carson wants runtime
// coverage of the real signing path, it needs a non-shared, signet/testnet-
// funded environment with ENABLE_PROD_NETWORK_ANCHORING=true and USE_MOCKS
// unset, run deliberately (spends real signet UTXOs) — out of scope for a
// shared multi-PR train rig.

export const pr = '#2882';

export const changedBehavior = [
  'services/worker/src/chain/confirmation-proof.ts sha256() re-wraps',
  "bitcoinjs-lib 7's Uint8Array-returning bitcoin.crypto.sha256() back into a",
  'Buffer; services/worker/src/chain/signet.ts buildOpReturnTransaction and',
  'buildMultiInputOpReturnTransaction pass bigint (BigInt(...)/0n) to',
  "Psbt.addOutput()'s value field instead of number, matching bitcoinjs-lib",
  "7's API. NEITHER production call site is reachable from this (or any",
  'USE_MOCKS=true) rig: every HTTP-reachable job/route resolves the chain',
  'client via getChainClientAsync(), which falls through to MockChainClient',
  'under USE_MOCKS=true / ENABLE_PROD_NETWORK_ANCHORING=false, and',
  'MockChainClient never calls into signet.ts. What this module DOES prove,',
  'every cycle, against the real deployed route: the mock-mode safety skip on',
  'the one HTTP-reachable job that would otherwise touch',
  'fetchConfirmationProof (POST /jobs/populate-confirmation-proofs) still',
  'engages correctly post-merge — i.e. the merge did not accidentally wire a',
  'live path around the mock gate. The bigint/Buffer migration itself is',
  'proven by services/worker/src/chain/{signet,confirmation-proof,',
  'bitcoin-audit}.test.ts et al. (261/261 passing against this train\'s merged',
  'head, run locally before launch) — NOT by this rig. See this module\'s',
  'header comment for the full call-graph trace and the residual-risk note.',
].join(' ');

export async function run(ctx) {
  const { workerFetch, probe, env } = ctx;
  const results = [];

  const cronSecret = env.CRON_SECRET;
  if (!cronSecret) {
    results.push(probe('2882_cron_secret_available', true, false, {
      pass: false,
      detail: 'CRON_SECRET not present in probe env — cannot exercise the mock-mode safety-gate check at all this cycle.',
    }));
    return results;
  }

  // The one HTTP-reachable route that would otherwise call into
  // confirmation-proof.ts's changed sha256() path. On this rig it MUST
  // report skipped:true (mock mode / anchoring off) — this is the actual,
  // real assertion this module can make: the safety gate that keeps the
  // changed chain code off this shared rig is itself intact post-merge.
  const backfill = await workerFetch('/jobs/populate-confirmation-proofs', {
    method: 'POST',
    headers: { 'X-Cron-Secret': cronSecret },
  });
  const backfillOk = backfill.status === 200 && backfill.body?.skipped === true;
  results.push(probe('2882_confirmation_proof_backfill_mock_skip_engaged', true, backfillOk, {
    detail: {
      status: backfill.status,
      body: backfill.body,
      note: 'Asserts the mock-mode/anchoring-off skip fired (skipped:true), NOT confirmation-proof.ts sha256() correctness — that path is unreachable on this rig (see module header).',
    },
  }));

  // Baseline-only: confirm the deployed candidate still reports the identity
  // this train soaked (redundant with train-cycle.mjs's own identity probe,
  // kept here so a reader of THIS module's cycle output does not need to
  // cross-reference the top-level probe to see #2882's candidate was live).
  const health = await workerFetch('/health');
  results.push(probe('2882_candidate_serving', true, health.status === 200 && health.body?.status === 'healthy', {
    detail: { status: health.status, git_sha: health.body?.git_sha },
  }));

  return results;
}
