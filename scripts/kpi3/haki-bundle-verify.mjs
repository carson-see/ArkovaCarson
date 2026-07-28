#!/usr/bin/env node
/**
 * KPI-3 Haki proof-bundle bridge (Lane 1 — Trust & Chain).
 *
 * Routes an Arkova `GET /api/v1/verify/:publicId/proof` response into the
 * clean-room external verifier (`external-verify.mjs`, PR #1611) with an
 * HONEST result for every shape the endpoint can return:
 *
 *   1. BATCH (`proof_bundle` present) — a two-layer check:
 *        (a) APP TREE  — locally recompute the app-tree root by folding
 *            `merkle_proof` over `fingerprint` (double-SHA256, left/right per
 *            sibling position — the same rule as the worker's
 *            utils/merkle-verify.ts, re-implemented here in plain mjs with NO
 *            Arkova imports) and require it to equal `merkle_root`. Includes
 *            the CVE-2012-2459 forged-self-pair guard when `merkle_index` +
 *            `leaf_count` are present (a complete bundle always carries both).
 *        (b) CHAIN     — full SPV via `verifyAnchorProof` with
 *            fingerprint := merkle_root. For a batch tx the 32 bytes committed
 *            at OP_RETURN [4:36] (after the ARKV magic) ARE the app-tree root,
 *            so the external verifier's canonical fixed-offset check applies
 *            unchanged.
 *      Verdict = both layers pass; otherwise the output names which layer
 *      failed (`failed_app_tree` / `failed_chain`).
 *
 *   2. DIRECT (404 NO_BATCH_PROOF, `proof_bundle: null`, or `--direct`) — the
 *      honest empty state for a one-document-per-transaction anchor (e.g. the
 *      4 direct HakiChain anchors). With a fingerprint + txid from the anchor
 *      record / Network Receipt, run `verifyAnchorProof` directly (fingerprint
 *      at OP_RETURN [4:36]). NO bundle exists and none is fabricated:
 *      `bundle: 'none_direct_anchor'`, merkle fields honestly absent — the
 *      OP_RETURN commitment itself is the proof.
 *
 *   3. NEITHER — `verdict: 'unverifiable_missing_inputs'` with the precise
 *      list of what is missing. NEVER a fake pass, NEVER a synthesized branch
 *      (Constitution §1.5: state what is measured vs NOT asserted).
 *
 * No Arkova imports (stranger-tool spirit): the only dependency is the
 * sibling clean-room verifier. The explorer is an injected async
 * `fetchPath(path)`; `--offline --fixtures <file.mjs>` injects a fixture
 * fetcher so nothing here ever needs the network. `--live` (blockstream.info)
 * is operator/Carson-gated — see HAKI-KPI3-RUNBOOK.md.
 *
 * Library:  import { verifyHakiBundle, computeAppTreeRoot } from './haki-bundle-verify.mjs'
 * CLI:      node scripts/kpi3/haki-bundle-verify.mjs \
 *             (--response <file.json> | --bundle <file.json>) \
 *             [--fingerprint <hex> --txid <hex>] [--direct] [--block <h>] \
 *             [--issuer <addr>] [--min-conf N] \
 *             (--offline --fixtures <file.mjs> | --live)
 */
import { createHash } from 'node:crypto';
import { verifyAnchorProof, blockstreamFetch } from './external-verify.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const isHex64 = (s) => typeof s === 'string' && HEX64.test(s.toLowerCase());
const sha256 = (buf) => createHash('sha256').update(buf).digest();
const dsha256 = (buf) => sha256(sha256(buf));

/**
 * Recompute the app-tree root by folding an inclusion branch over a leaf.
 *
 * Mirrors services/worker/src/utils/merkle-verify.ts (plain double-SHA256
 * over positional concatenation; `position` names where the SIBLING sits):
 *   - empty branch ⇒ single-leaf tree ⇒ root == leaf
 *   - every hash must be exactly 64 hex (32 bytes) — else fail closed
 *   - with `leafIndex` + `leafCount`: reject a self-pair (sibling == running
 *     hash) at any position that is not the rightmost node of an odd-sized
 *     level (CVE-2012-2459 duplicated-leaf forgery guard)
 *
 * @returns {{root: string|null, reason: string|null}} root in lowercase hex,
 *          or null with a machine-stable reason (never throws).
 */
export function computeAppTreeRoot(leafHex, branch, opts = {}) {
  if (!isHex64(leafHex)) return { root: null, reason: 'bad_leaf_format' };
  if (!Array.isArray(branch)) return { root: null, reason: 'branch_not_array' };

  const structural =
    Number.isInteger(opts.leafIndex) && Number.isInteger(opts.leafCount) && opts.leafCount >= 1;
  if (structural && (opts.leafIndex < 0 || opts.leafIndex >= opts.leafCount)) {
    return { root: null, reason: 'leaf_index_out_of_range' };
  }

  if (branch.length === 0) return { root: leafHex.toLowerCase(), reason: null };

  let current = Buffer.from(leafHex.toLowerCase(), 'hex');
  let levelIndex = structural ? opts.leafIndex : 0;
  let levelSize = structural ? opts.leafCount : 0;

  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i];
    if (entry == null || !isHex64(entry.hash)) {
      return { root: null, reason: `branch[${i}]_bad_sibling_format` };
    }
    if (entry.position !== 'left' && entry.position !== 'right') {
      return { root: null, reason: `branch[${i}]_bad_position` };
    }
    const sibling = Buffer.from(entry.hash.toLowerCase(), 'hex');

    if (structural) {
      const isRightmostOddNode = levelIndex === levelSize - 1 && levelSize % 2 === 1;
      if (sibling.equals(current) && !isRightmostOddNode) {
        return { root: null, reason: `branch[${i}]_forged_self-pair_rejected_cve-2012-2459` };
      }
      levelIndex = Math.floor(levelIndex / 2);
      levelSize = Math.ceil(levelSize / 2);
    }

    current =
      entry.position === 'right'
        ? dsha256(Buffer.concat([current, sibling]))
        : dsha256(Buffer.concat([sibling, current]));
  }

  return { root: Buffer.from(current).toString('hex'), reason: null };
}

const HONEST_DIRECT_NOTES = [
  'Direct anchor: one document per transaction. Merkle proof fields are honestly absent — no batch tree exists for this anchor and none is fabricated.',
  'The OP_RETURN commitment (ARKV || fingerprint at bytes [4:36]) is itself the proof; it is checked via SPV against the public chain (commit + depth + merkle inclusion + header binding).',
];

/**
 * Verify an Arkova proof-endpoint response (or a bare route decision) against
 * the public chain via the clean-room external verifier.
 *
 * @param {object|null} response  Full GET /verify/:publicId/proof response
 *        body (200 MerkleProofResponse or 404 {error, proof_error_code}), or
 *        null when only CLI flags drive the check.
 * @param {{fingerprint?, txid?, direct?, expectedBlockHeight?,
 *          expectedIssuerAddress?, minConfirmations?, powLimit?}} opts
 *        `powLimit` (BigInt) overrides the mainnet PoW floor — set only for
 *        non-mainnet/synthetic blocks; mainnet Haki anchors use the default.
 * @param {(path:string)=>Promise<any>} fetchPath  injected explorer client
 * @returns honest result — see module docstring for the three shapes.
 */
export async function verifyHakiBundle(response, opts = {}, fetchPath) {
  const resp = response && typeof response === 'object' ? response : {};
  const bundle = resp.proof_bundle && typeof resp.proof_bundle === 'object' ? resp.proof_bundle : null;
  const notes = [];

  // ── Route 1: batch bundle (unless the operator asserts the anchor is direct)
  if (bundle && !opts.direct) {
    return verifyBatchBundle(bundle, opts, fetchPath);
  }

  if (resp.proof_error_code === 'RECORD_NOT_FOUND') {
    notes.push(
      'Arkova API reported RECORD_NOT_FOUND for this publicId; any chain verification below relies solely on operator-supplied fingerprint/txid.',
    );
  }

  // ── Route 2: honest direct-anchor path (no bundle exists — none fabricated)
  const fingerprint = firstHex64(opts.fingerprint, resp.fingerprint);
  const txid = firstHex64(opts.txid, resp.tx_id);

  if (fingerprint && txid) {
    const chain = await verifyAnchorProof(
      {
        fingerprint,
        txid,
        expectedBlockHeight: numOrUndef(opts.expectedBlockHeight ?? resp.block_height),
        expectedIssuerAddress: opts.expectedIssuerAddress,
      },
      fetchPath,
      { minConfirmations: opts.minConfirmations, powLimit: opts.powLimit },
    );
    return {
      mode: 'direct_anchor',
      bundle: 'none_direct_anchor',
      verified: chain.verified,
      verdict: chain.verified ? 'verified' : 'failed_chain',
      failed_layer: chain.verified ? null : 'chain',
      app_tree: null, // honestly absent — there is no app-tree layer to check
      chain,
      missing: [],
      notes: [...notes, ...HONEST_DIRECT_NOTES],
    };
  }

  // ── Route 3: unverifiable — say precisely what is missing, assert nothing.
  const missing = [];
  if (!fingerprint) missing.push('fingerprint');
  if (!txid) missing.push('txid');
  return {
    mode: 'unverifiable',
    bundle: null,
    verified: false,
    verdict: 'unverifiable_missing_inputs',
    failed_layer: null,
    app_tree: null,
    chain: null,
    missing,
    notes: [
      ...notes,
      `Nothing was verified and nothing is asserted about this record (NOT asserted: existence, integrity, or anchoring). Missing required inputs: ${missing.join(', ')} (each must be 64-hex).`,
      'Provide either a complete proof_bundle (batch anchor) or --fingerprint and --txid from the anchor record / Network Receipt (direct anchor). No branch or receipt is ever synthesized.',
    ],
  };
}

/** Batch path: (a) local app-tree recompute, then (b) SPV on the root. */
async function verifyBatchBundle(bundle, opts, fetchPath) {
  const notes = [];
  const expectedRoot = isHex64(bundle.merkle_root) ? bundle.merkle_root.toLowerCase() : null;

  // Layer (a): APP TREE — recompute locally; no network involved.
  const structuralOpts =
    Number.isInteger(bundle.merkle_index) && Number.isInteger(bundle.leaf_count)
      ? { leafIndex: bundle.merkle_index, leafCount: bundle.leaf_count }
      : {};
  const recompute = computeAppTreeRoot(bundle.fingerprint, bundle.merkle_proof ?? [], structuralOpts);
  const appTree = {
    recomputed_root: recompute.root,
    expected_root: expectedRoot,
    match: recompute.root !== null && expectedRoot !== null && recompute.root === expectedRoot,
    reason: recompute.reason ?? (expectedRoot === null ? 'bad_merkle_root_format' : null),
  };
  if (!appTree.match) {
    return {
      mode: 'batch_bundle',
      bundle: 'batch',
      verified: false,
      verdict: 'failed_app_tree',
      failed_layer: 'app_tree',
      app_tree: appTree,
      chain: null,
      missing: [],
      notes: [
        'Layer (a) failed: the merkle_proof does not fold from this fingerprint to the stated merkle_root. Chain layer was not evaluated (the bundle is internally inconsistent).',
      ],
    };
  }

  // Layer (b): CHAIN — the committed 32 bytes at OP_RETURN [4:36] for a batch
  // tx IS the app-tree root, so pass fingerprint := merkle_root to the
  // clean-room verifier. No bundle field is trusted for the verdict — SPV
  // recomputes inclusion + header binding from the public chain.
  if (!isHex64(bundle.tx_id)) {
    return {
      mode: 'batch_bundle',
      bundle: 'batch',
      verified: false,
      verdict: 'unverifiable_missing_inputs',
      failed_layer: null,
      app_tree: appTree,
      chain: null,
      missing: ['txid'],
      notes: [
        'The bundle carries no usable tx_id (64-hex), so the chain layer cannot be checked. The app-tree recompute alone is NOT a verification verdict — NOT asserted: on-chain commitment. No receipt is synthesized.',
      ],
    };
  }
  const chain = await verifyAnchorProof(
    {
      fingerprint: expectedRoot,
      txid: bundle.tx_id,
      expectedBlockHeight: numOrUndef(opts.expectedBlockHeight ?? bundle.block_height),
      expectedIssuerAddress: opts.expectedIssuerAddress,
    },
    fetchPath,
    { minConfirmations: opts.minConfirmations, powLimit: opts.powLimit },
  );
  const verified = chain.verified === true;
  if (verified) {
    notes.push(
      'Both layers pass: (a) merkle_proof folds from the document fingerprint to merkle_root; (b) SPV proves ARKV||merkle_root is committed at the canonical OP_RETURN offset in a confirmed, header-bound Bitcoin block.',
    );
  }
  return {
    mode: 'batch_bundle',
    bundle: 'batch',
    verified,
    verdict: verified ? 'verified' : 'failed_chain',
    failed_layer: verified ? null : 'chain',
    app_tree: appTree,
    chain,
    missing: [],
    notes,
  };
}

function firstHex64(...vals) {
  for (const v of vals) {
    if (isHex64(v)) return String(v).toLowerCase();
  }
  return null;
}

function numOrUndef(v) {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--response') a.response = argv[++i];
    else if (k === '--bundle') a.bundle = argv[++i];
    else if (k === '--fingerprint') a.fingerprint = argv[++i];
    else if (k === '--txid') a.txid = argv[++i];
    else if (k === '--direct') a.direct = true;
    else if (k === '--issuer') a.expectedIssuerAddress = argv[++i];
    else if (k === '--offline') a.offline = true;
    else if (k === '--live') a.live = true;
    else if (k === '--fixtures') a.fixtures = argv[++i];
    else if (k === '--block') { const n = Number(argv[++i]); if (Number.isInteger(n)) a.expectedBlockHeight = n; }
    else if (k === '--min-conf') { const n = Number(argv[++i]); if (Number.isInteger(n)) a.minConfirmations = n; }
  }
  return a;
}

const USAGE = `usage: haki-bundle-verify.mjs (--response <file.json> | --bundle <file.json> | --fingerprint <hex> --txid <hex> --direct)
         [--fingerprint <hex>] [--txid <hex>] [--direct] [--block <height>] [--issuer <addr>] [--min-conf N]
         (--offline --fixtures <file.mjs> | --live)
  --response   full GET /api/v1/verify/:publicId/proof response body (200 or 404 JSON)
  --bundle     a bare proof_bundle object (wrapped as {proof_bundle} internally)
  --direct     assert the anchor is a direct (one-doc-per-tx) anchor: skip the bundle path
  --offline    use an injected fixture fetcher (--fixtures must export fetchPath); zero network
  --live       query blockstream.info (operator/Carson-gated — see HAKI-KPI3-RUNBOOK.md)`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Explorer client: explicitly offline (fixtures) or explicitly live — never
  // an implicit network call.
  let fetchPath;
  if (args.offline) {
    if (!args.fixtures) {
      console.error('--offline requires --fixtures <file.mjs> exporting fetchPath');
      process.exit(2);
    }
    const mod = await import(new URL(args.fixtures, `file://${process.cwd()}/`).href);
    if (typeof mod.fetchPath !== 'function') {
      console.error(`--fixtures module ${args.fixtures} does not export a fetchPath function`);
      process.exit(2);
    }
    fetchPath = mod.fetchPath;
  } else if (args.live) {
    fetchPath = blockstreamFetch();
  } else {
    console.error(USAGE);
    process.exit(2);
  }

  let response = null;
  if (args.response) {
    const { readFile } = await import('node:fs/promises');
    response = JSON.parse(await readFile(args.response, 'utf8'));
  } else if (args.bundle) {
    const { readFile } = await import('node:fs/promises');
    response = { proof_bundle: JSON.parse(await readFile(args.bundle, 'utf8')) };
  }

  const r = await verifyHakiBundle(response, args, fetchPath);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.verified ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`haki-bundle-verify failed: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
}
