#!/usr/bin/env node
/**
 * KPI-3 external verifier (SCRUM-2912 / SCRUM-2986) — the "stranger's tool".
 *
 * Independently verifies an Arkova DIRECT-anchor proof with ZERO help from
 * Arkova infrastructure: given a document fingerprint + txid, it queries a
 * PUBLIC Bitcoin explorer (blockstream.info by default) and proves
 *   hash  ->  the fingerprint is committed in the tx's OP_RETURN
 *   tx    ->  the tx is confirmed
 *   block ->  (optionally) it sits in the asserted block height.
 *
 * This is the artifact recorded for the KPI-3 dress rehearsal, run twice:
 *   - against each demo record (verified), and
 *   - against a TAMPERED proof (rejected) — the negative control.
 *
 * No Arkova dependencies by design: a stranger could run this file verbatim.
 *
 * Library:  import { verifyAnchorProof } from './external-verify.mjs'
 * CLI:      node scripts/kpi3/external-verify.mjs --live \
 *             --fingerprint <hex> --txid <hex> [--block <height>]
 *           node scripts/kpi3/external-verify.mjs --rehearse   (fixtures demo)
 */

export const ARKOVA_MAGIC_HEX = '41524b56'; // "ARKV"

/**
 * @param {{fingerprint:string, txid:string, expectedBlockHeight?:number, publicId?:string}} proof
 * @param {(txid:string)=>Promise<any>} explorerFetch  returns blockstream /tx JSON, throws {status:404} when absent
 * @returns {Promise<{verified:boolean, reason:(string|null), checks:object, committed:(string|null)}>}
 */
export async function verifyAnchorProof(proof, explorerFetch) {
  const checks = {
    confirmed: false,
    magicOk: false,
    fingerprintCommitted: false,
    blockMatch: null, // null = not asserted
  };
  const fail = (reason) => ({ verified: false, reason, checks, committed: null });

  const fp = String(proof.fingerprint || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fp)) return fail('bad_fingerprint_format');

  let tx;
  try {
    tx = await explorerFetch(proof.txid);
  } catch (e) {
    if (e && e.status === 404) return fail('tx_not_found');
    return fail(`explorer_error:${e && e.message ? e.message : 'unknown'}`);
  }
  if (!tx || typeof tx !== 'object') return fail('tx_not_found');

  const status = tx.status || {};
  checks.confirmed = status.confirmed === true;
  if (!checks.confirmed) return fail('tx_unconfirmed');

  const opret = (tx.vout || []).find((v) => v && v.scriptpubkey_type === 'op_return');
  if (!opret || !opret.scriptpubkey) return fail('no_op_return');

  // Decode the pushed payload: 6a (OP_RETURN) + pushbyte len + payload.
  const payload = decodeOpReturnPayload(String(opret.scriptpubkey).toLowerCase());
  if (payload == null) return fail('op_return_undecodable');

  checks.magicOk = payload.startsWith(ARKOVA_MAGIC_HEX);
  if (!checks.magicOk) return fail('bad_magic');

  const body = payload.slice(ARKOVA_MAGIC_HEX.length); // fingerprint(32B) + suffix
  const committed = body.slice(0, 64);
  checks.fingerprintCommitted = body.includes(fp);
  if (!checks.fingerprintCommitted) {
    return { verified: false, reason: 'fingerprint_not_committed_in_op_return', checks, committed };
  }

  if (typeof proof.expectedBlockHeight === 'number') {
    checks.blockMatch = status.block_height === proof.expectedBlockHeight;
    if (!checks.blockMatch) {
      return { verified: false, reason: 'block_height_mismatch', checks, committed };
    }
  }

  return { verified: true, reason: null, checks, committed };
}

/** Strip OP_RETURN + a single push opcode (OP_PUSHBYTES_N for N<=75), return payload hex. */
export function decodeOpReturnPayload(scriptHex) {
  if (!/^[0-9a-f]*$/.test(scriptHex) || scriptHex.length < 4) return null;
  if (!scriptHex.startsWith('6a')) return null; // must be OP_RETURN
  let rest = scriptHex.slice(2);
  const opcode = parseInt(rest.slice(0, 2), 16);
  rest = rest.slice(2);
  if (opcode <= 75) {
    const len = opcode * 2;
    return rest.slice(0, len);
  }
  if (opcode === 0x4c) {
    // OP_PUSHDATA1: next byte is length
    const len = parseInt(rest.slice(0, 2), 16) * 2;
    return rest.slice(2, 2 + len);
  }
  return null; // longer pushes not expected for a 44-byte anchor payload
}

/** Live explorer fetch (blockstream.info) — the default in --live mode. */
export function blockstreamFetch(base = 'https://blockstream.info/api') {
  return async (txid) => {
    const res = await fetch(`${base}/tx/${txid}`);
    if (res.status === 404) {
      const e = new Error('not found');
      e.status = 404;
      throw e;
    }
    if (!res.ok) throw new Error(`explorer HTTP ${res.status}`);
    return res.json();
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
    else if (k === '--block') a.expectedBlockHeight = Number(argv[++i]);
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
    const r = await verifyAnchorProof(args, blockstreamFetch());
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.verified ? 0 : 1);
  }
  console.error('usage: external-verify.mjs [--rehearse | --live --fingerprint <hex> --txid <hex> [--block N]]');
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`external-verify failed: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
}
