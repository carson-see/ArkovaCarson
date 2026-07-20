#!/usr/bin/env node
/**
 * KPI-3 external verifier (SCRUM-2912 / SCRUM-2986) — the "stranger's tool".
 *
 * Independently verifies an Arkova DIRECT-anchor proof with ZERO help from
 * Arkova infrastructure. Given a document fingerprint + txid it queries a
 * PUBLIC Bitcoin explorer (blockstream.info by default) and proves, in order:
 *   1. COMMIT   — the fingerprint is committed at the CANONICAL byte offset of
 *                 an OP_RETURN in the tx (ARKV magic at offset 0, fingerprint at
 *                 bytes [4:36]). Mirrors the worker's own decoder
 *                 services/worker/src/chain/signet.ts:extractAnchorFingerprint
 *                 (BUG-2026-06-24-004): a fixed-offset match, NOT a substring scan.
 *   2. DEPTH    — the tx is confirmed to a minimum depth (reorg floor).
 *   3. INCLUDE  — the tx is in the block: its merkle proof recomputes the block
 *                 header's merkle_root (SPV inclusion, double-SHA256).
 *   4. HEADER   — that header double-SHA256-hashes to the stated block hash, so
 *                 the merkle_root is bound to a specific proof-of-work block.
 *   5. ISSUER   — (optional) the tx was funded by Arkova's expected treasury
 *                 address. Without this the tool proves "a fingerprint is on
 *                 Bitcoin", NOT "Arkova put it there" — see verdict notes.
 *
 * This upgrades the check from explorer-TRUST (status.confirmed says so) to
 * explorer-VERIFY (the header + merkle proof are recomputed locally; the
 * explorer can only lie by producing a valid PoW header, which it cannot forge).
 * Residual trust: that the returned block hash is on the most-work chain — depth
 * mitigates; a full header-chain check is out of scope for a single-record demo.
 *
 * No Arkova dependencies by design: a stranger could run this file verbatim.
 * The explorer is a single injected async `fetchPath(path)` so tests run offline.
 *
 * Library:  import { verifyAnchorProof } from './external-verify.mjs'
 * CLI:      node scripts/kpi3/external-verify.mjs --live \
 *             --fingerprint <hex> --txid <hex> [--block <h>] [--issuer <addr>] [--min-conf N]
 *           node scripts/kpi3/external-verify.mjs --rehearse
 */
import { createHash } from 'node:crypto';

export const ARKOVA_MAGIC_HEX = '41524b56'; // "ARKV"
export const DEFAULT_MIN_CONFIRMATIONS = 6;

// Hex-length constants for the OP_RETURN commitment (1 byte = 2 hex chars).
const MAGIC_HEX_LEN = ARKOVA_MAGIC_HEX.length;       // 8  (4 bytes: ARKV)
const FINGERPRINT_HEX_LEN = 64;                       // 32 bytes: SHA-256
const COMMIT_MIN_HEX = MAGIC_HEX_LEN + FINGERPRINT_HEX_LEN; // 72: magic + fingerprint
/** A 64-hex (32-byte) lowercase SHA-256 string — fingerprint, txid, block hash. */
const HEX64 = /^[0-9a-f]{64}$/;
const isHex64 = (s) => HEX64.test(String(s || '').toLowerCase());

// ── crypto / merkle helpers ──────────────────────────────────────────────────
const sha256 = (buf) => createHash('sha256').update(buf).digest();
const dsha256 = (buf) => sha256(sha256(buf));
const revHex = (hex) => Buffer.from(hex, 'hex').reverse();

/**
 * Recompute a Bitcoin merkle root from a tx's Esplora merkle-proof (siblings + pos).
 * Returns null if any sibling is not valid 32-byte hex (fail closed).
 */
export function computeMerkleRoot(txidHex, siblingsHex, pos) {
  if (!isHex64(txidHex) || !siblingsHex.every(isHex64)) return null;
  let h = revHex(txidHex); // internal (little-endian) byte order
  let idx = pos;
  for (const sib of siblingsHex) {
    const s = revHex(sib);
    h = (idx & 1) ? dsha256(Buffer.concat([s, h])) : dsha256(Buffer.concat([h, s]));
    idx = Math.floor(idx / 2);
  }
  return Buffer.from(h).reverse().toString('hex'); // back to display order
}

/** Parse an 80-byte block header hex → {blockHash, merkleRoot} (display order). */
export function parseBlockHeader(headerHex) {
  if (!/^[0-9a-f]{160}$/i.test(headerHex)) return null;
  const bytes = Buffer.from(headerHex, 'hex');
  const blockHash = Buffer.from(dsha256(bytes)).reverse().toString('hex');
  const merkleRoot = Buffer.from(bytes.subarray(36, 68)).reverse().toString('hex');
  return { blockHash, merkleRoot };
}

/**
 * Canonically decode an OP_RETURN scriptPubKey and return the Arkova-committed
 * fingerprint, or null. Mirrors extractAnchorFingerprint: the script must be
 * exactly `OP_RETURN <single push>`, the push must begin with ARKV at offset 0,
 * and the fingerprint is bytes [4:36]. A trailing metadata hash is allowed; junk
 * bytes, extra pushes, or a magic that isn't at offset 0 are rejected.
 */
export function extractCanonicalFingerprint(scriptHex) {
  const s = String(scriptHex || '').toLowerCase();
  if (!/^[0-9a-f]*$/.test(s) || !s.startsWith('6a')) return null; // must be OP_RETURN
  let rest = s.slice(2);
  if (rest.length < 2) return null;
  const opcode = parseInt(rest.slice(0, 2), 16);
  rest = rest.slice(2);
  let payload;
  if (opcode >= 1 && opcode <= 75) {
    const need = opcode * 2;
    if (rest.length !== need) return null; // exactly one push consuming the whole script
    payload = rest;
  } else if (opcode === 0x4c) {
    if (rest.length < 2) return null;
    const len = parseInt(rest.slice(0, 2), 16) * 2;
    rest = rest.slice(2);
    if (rest.length !== len) return null;
    payload = rest;
  } else {
    return null; // OP_0, PUSHDATA2/4, or non-canonical
  }
  // Need magic (4B) + fingerprint (32B) of committed data at minimum.
  if (payload.length < COMMIT_MIN_HEX) return null;
  if (payload.slice(0, MAGIC_HEX_LEN) !== ARKOVA_MAGIC_HEX) return null; // magic at offset 0
  return payload.slice(MAGIC_HEX_LEN, COMMIT_MIN_HEX); // fingerprint at canonical offset [4:36]
}

/**
 * @param {{fingerprint,txid,expectedBlockHeight?,expectedIssuerAddress?,publicId?}} proof
 * @param {(path:string)=>Promise<any>} fetchPath  Esplora-style client; throws {status:404} on absent
 * @param {{minConfirmations?:number}} [opts]
 */
export async function verifyAnchorProof(proof, fetchPath, opts = {}) {
  const minConf = opts.minConfirmations ?? DEFAULT_MIN_CONFIRMATIONS;
  const checks = {
    confirmed: false,
    fingerprintCommitted: false,
    confirmations: null,
    depthOk: null,
    merkleIncluded: null,
    headerBinds: null,
    blockMatch: null,
    issuerMatch: null,
    committed: null,
  };
  const done = (verified, reason) => ({ verified, reason: reason ?? null, checks, committed: checks.committed });

  const fp = String(proof.fingerprint || '').toLowerCase();
  if (!isHex64(fp)) return done(false, 'bad_fingerprint_format');
  // Validate txid before it is interpolated into any explorer URL path.
  const txid = String(proof.txid || '').toLowerCase();
  if (!isHex64(txid)) return done(false, 'bad_txid_format');

  // 1. Fetch tx.
  let tx;
  try {
    tx = await fetchPath(`tx/${txid}`);
  } catch (e) {
    if (e && e.status === 404) return done(false, 'tx_not_found');
    return done(false, `explorer_error:${e && e.message ? e.message : 'unknown'}`);
  }
  if (!tx || typeof tx !== 'object') return done(false, 'tx_not_found');

  const status = tx.status || {};
  checks.confirmed = status.confirmed === true;
  if (!checks.confirmed) return done(false, 'tx_unconfirmed');

  // 2. COMMIT — canonical fixed-offset match across ALL OP_RETURN outputs.
  const opReturns = (tx.vout || []).filter((v) => v && v.scriptpubkey_type === 'op_return');
  if (opReturns.length === 0) return done(false, 'no_op_return');
  let committed = null;
  let sawArkv = false;
  for (const v of opReturns) {
    const c = extractCanonicalFingerprint(v.scriptpubkey);
    if (c) { sawArkv = true; if (c === fp) { committed = c; break; } }
  }
  checks.committed = committed;
  checks.fingerprintCommitted = committed !== null;
  if (!checks.fingerprintCommitted) {
    return done(false, sawArkv ? 'fingerprint_not_committed_in_op_return' : 'no_canonical_arkv_op_return');
  }

  // 3. DEPTH — confirmation floor against the chain tip.
  let tip;
  try { tip = Number(await fetchPath('blocks/tip/height')); } catch { tip = NaN; }
  if (Number.isInteger(tip) && Number.isInteger(status.block_height)) {
    checks.confirmations = tip - status.block_height + 1;
    checks.depthOk = checks.confirmations >= minConf;
    if (!checks.depthOk) return done(false, 'insufficient_confirmations');
  } else {
    checks.depthOk = false;
    return done(false, 'tip_height_unavailable');
  }

  // 4. INCLUDE + 5. HEADER — SPV: recompute the merkle root, bind it to the PoW header.
  let mp;
  try { mp = await fetchPath(`tx/${txid}/merkle-proof`); } catch { mp = null; }
  if (!mp || !Array.isArray(mp.merkle) || typeof mp.pos !== 'number') {
    checks.merkleIncluded = false;
    return done(false, 'merkle_proof_unavailable');
  }
  // The merkle proof and the tx status must agree on the containing block.
  if (typeof mp.block_height === 'number' && mp.block_height !== status.block_height) {
    checks.merkleIncluded = false;
    return done(false, 'merkle_proof_block_mismatch');
  }
  const computedRoot = computeMerkleRoot(txid, mp.merkle, mp.pos);
  if (computedRoot === null) { checks.merkleIncluded = false; return done(false, 'malformed_merkle_proof'); }

  // block_hash comes from the (untrusted) explorer — validate before interpolating.
  const blockHash = String(status.block_hash || '').toLowerCase();
  if (!isHex64(blockHash)) { checks.headerBinds = false; return done(false, 'bad_block_hash'); }
  let headerHex;
  try { headerHex = String(await fetchPath(`block/${blockHash}/header`)).trim(); } catch { headerHex = null; }
  const header = headerHex ? parseBlockHeader(headerHex) : null;
  if (!header) { checks.headerBinds = false; return done(false, 'block_header_unavailable'); }

  checks.headerBinds = header.blockHash === blockHash;
  if (!checks.headerBinds) return done(false, 'header_hash_mismatch');

  checks.merkleIncluded = header.merkleRoot === computedRoot;
  if (!checks.merkleIncluded) return done(false, 'tx_not_in_block');

  // 6. Optional expected block height.
  if (typeof proof.expectedBlockHeight === 'number') {
    checks.blockMatch = status.block_height === proof.expectedBlockHeight;
    if (!checks.blockMatch) return done(false, 'block_height_mismatch');
  }

  // 7. ISSUER — optional treasury binding.
  if (proof.expectedIssuerAddress) {
    const inAddr = tx.vin?.[0]?.prevout?.scriptpubkey_address ?? null;
    checks.issuerMatch = inAddr === proof.expectedIssuerAddress;
    if (!checks.issuerMatch) return done(false, 'unexpected_issuer');
  }

  return done(true, null);
}

/** Live Esplora client (blockstream.info) — JSON for most paths, text for header/tip. */
export function blockstreamFetch(base = 'https://blockstream.info/api') {
  const textPaths = (p) => p.endsWith('/header') || p === 'blocks/tip/height';
  return async (path) => {
    const res = await fetch(`${base}/${path}`);
    if (res.status === 404) { const e = new Error('not found'); e.status = 404; throw e; }
    if (!res.ok) throw new Error(`explorer HTTP ${res.status}`);
    return textPaths(path) ? res.text() : res.json();
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--live') a.live = true;
    else if (k === '--rehearse') a.rehearse = true;
    else if (k === '--fingerprint') a.fingerprint = argv[++i];
    else if (k === '--txid') a.txid = argv[++i];
    else if (k === '--issuer') a.expectedIssuerAddress = argv[++i];
    else if (k === '--block') { const n = Number(argv[++i]); if (Number.isInteger(n)) a.expectedBlockHeight = n; }
    else if (k === '--min-conf') { const n = Number(argv[++i]); if (Number.isInteger(n)) a.minConfirmations = n; }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.rehearse) {
    const { VALID_PROOF, TAMPERED_PROOF } = await import('./fixtures.mjs');
    const fetcher = blockstreamFetch();
    for (const [label, proof] of [['VALID', VALID_PROOF], ['TAMPERED (negative control)', TAMPERED_PROOF]]) {
      const r = await verifyAnchorProof(proof, fetcher);
      console.log(`\n[${label}] ${proof.publicId}`);
      console.log(`  verified=${r.verified} reason=${r.reason}`);
      console.log(`  checks=${JSON.stringify(r.checks)}`);
    }
    return;
  }
  if (args.live) {
    if (!args.fingerprint || !args.txid) {
      console.error('--live requires --fingerprint <hex> and --txid <hex>');
      process.exit(2);
    }
    const r = await verifyAnchorProof(args, blockstreamFetch(), { minConfirmations: args.minConfirmations });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.verified ? 0 : 1);
  }
  console.error('usage: external-verify.mjs [--rehearse | --live --fingerprint <hex> --txid <hex> [--block N] [--issuer <addr>] [--min-conf N]]');
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`external-verify failed: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
}
