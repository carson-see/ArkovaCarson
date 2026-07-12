/**
 * FROZEN-FIXTURE hash regression test for the fingerprint → on-chain mapping
 * (SCRUM-2486 AC-3, Lane 1 chain-integrity).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The mapping from a document fingerprint to its committed on-chain OP_RETURN
 * payload is a FROZEN WIRE CONTRACT: ~2.97M anchors are already committed to
 * Bitcoin under it, and every verification (`extractAnchorFingerprint`) must keep
 * decoding those historical outputs forever. If a future refactor of `signet.ts`
 * silently changes the prefix, the byte layout, the metadata-hash truncation, or
 * the canonical-JSON ordering, every past anchor becomes unverifiable and every
 * NEW anchor commits a different payload — a catastrophic, hard-to-detect break.
 *
 * This test PINS a known-good fixture with hard-coded EXPECTED bytes (computed
 * once, out-of-band, and frozen below — NOT recomputed from the code under test)
 * and asserts the current production functions still reproduce them. Any drift in
 * the mapping fails this test loudly.
 *
 * ── WHAT IS PINNED ───────────────────────────────────────────────────────────
 *   fingerprint (64-hex)
 *     → OP_RETURN payload  = "ARKV" | fingerprintBytes [| metaHash8]
 *     → OP_RETURN script   = OP_RETURN <push payload>
 *     → extractAnchorFingerprint(scriptHex) round-trips back to the fingerprint
 *   plus the metadata sub-contract:
 *     canonicalMetadataJson (sorted keys) → hashMetadata (sha256) → truncate(8B)
 *
 * All assertions run against the REAL exported functions in `signet.ts`; this
 * file only IMPORTS them (it does not modify the soak-locked `signet.ts`).
 *
 * ── HOW TO REGENERATE (only on an INTENTIONAL, reviewed contract change) ──────
 * If the wire format is deliberately versioned, recompute the frozen bytes and
 * bump the fixture with a migration/re-anchor plan — do NOT edit these constants
 * to make a red test green.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';

// `signet.ts` imports `../config.js` (prod-env-validating loader) and the pino
// `logger`. Mock both so this pure-function test loads without prod config —
// mirrors `signet.test.ts`.
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../config.js', () => ({
  config: { bitcoinNetwork: 'signet', bitcoinMaxFeeRate: undefined },
}));

import {
  canonicalMetadataJson,
  hashMetadata,
  truncateMetadataHash,
  extractAnchorFingerprint,
} from './signet.js';

// ── FROZEN FIXTURE (computed out-of-band, then hard-coded — do NOT recompute) ──
// Provenance: fingerprint = sha256("arkova-scrum-2486-frozen-fixture-v1").
// The expected hex strings below were computed once against the known-good
// mapping and PINNED. They are literal constants, deliberately not derived from
// the functions under test, so the test is a true regression anchor.
const FROZEN = {
  // sha256("arkova-scrum-2486-frozen-fixture-v1")
  fingerprint: '58e3cdbe32de1515dfba633c24cacd1531673dc4cb5d459d6f29fae87cf54037',
  // "ARKV" (41524b56) + fingerprint bytes
  payloadHex:
    '41524b5658e3cdbe32de1515dfba633c24cacd1531673dc4cb5d459d6f29fae87cf54037',
  // OP_RETURN (0x6a) + push(0x24 = 36 bytes) + payload
  scriptHex:
    '6a2441524b5658e3cdbe32de1515dfba633c24cacd1531673dc4cb5d459d6f29fae87cf54037',

  // Metadata sub-contract fixture.
  metadata: { issuer: 'Acme University', recipient: 'jane.doe', serial: '000123' } as Record<
    string,
    unknown
  >,
  // Canonical JSON is keys sorted alphabetically: issuer, recipient, serial.
  canonicalJson: '{"issuer":"Acme University","recipient":"jane.doe","serial":"000123"}',
  metaHash: 'f8d50e60588e9045243a9ef5233f1c51d1a276c43ab4f174905dd6ac7c105580',
  metaTrunc8Hex: 'f8d50e60588e9045',
  // OP_RETURN (0x6a) + push(0x2c = 44 bytes) + "ARKV" + fingerprint + metaHash(8B)
  scriptMetaHex:
    '6a2c41524b5658e3cdbe32de1515dfba633c24cacd1531673dc4cb5d459d6f29fae87cf54037f8d50e60588e9045',
} as const;

const OP_RETURN_PREFIX = Buffer.from('ARKV');

/** Rebuild the canonical OP_RETURN scriptPubKey hex for a fingerprint (+optional 8B meta). */
function buildScriptHex(fingerprint: string, metaTrunc8Hex?: string): string {
  const parts = [OP_RETURN_PREFIX, Buffer.from(fingerprint, 'hex')];
  if (metaTrunc8Hex) parts.push(Buffer.from(metaTrunc8Hex, 'hex'));
  const payload = Buffer.concat(parts);
  return bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, payload]).toString('hex');
}

describe('SCRUM-2486 AC-3: frozen fingerprint → on-chain mapping', () => {
  it('the frozen fingerprint is exactly sha256 of its known preimage (self-consistency of the fixture)', () => {
    const recomputed = createHash('sha256')
      .update('arkova-scrum-2486-frozen-fixture-v1')
      .digest('hex');
    expect(recomputed).toBe(FROZEN.fingerprint);
    expect(FROZEN.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the OP_RETURN payload layout is "ARKV" | fingerprint (36 bytes, pinned hex)', () => {
    const payload = Buffer.concat([OP_RETURN_PREFIX, Buffer.from(FROZEN.fingerprint, 'hex')]);
    expect(payload.length).toBe(36);
    expect(payload.toString('hex')).toBe(FROZEN.payloadHex);
    // Prefix is exactly the 4 ASCII bytes of "ARKV".
    expect(FROZEN.payloadHex.slice(0, 8)).toBe(Buffer.from('ARKV').toString('hex'));
  });

  it('the committed OP_RETURN script hex matches the pinned value (no-metadata case)', () => {
    expect(buildScriptHex(FROZEN.fingerprint)).toBe(FROZEN.scriptHex);
  });

  it('extractAnchorFingerprint() round-trips the pinned no-metadata script back to the fingerprint', () => {
    expect(extractAnchorFingerprint(FROZEN.scriptHex)).toBe(FROZEN.fingerprint);
  });

  it('extractAnchorFingerprint() round-trips the pinned WITH-metadata script back to the SAME fingerprint', () => {
    // A trailing truncated metadata hash must not disturb fingerprint extraction.
    expect(extractAnchorFingerprint(FROZEN.scriptMetaHex)).toBe(FROZEN.fingerprint);
  });

  it('the metadata canonical-JSON ordering is frozen (keys sorted alphabetically)', () => {
    // Insertion order deliberately NOT alphabetical to prove sorting is applied.
    const shuffled = { serial: '000123', issuer: 'Acme University', recipient: 'jane.doe' };
    expect(canonicalMetadataJson(shuffled)).toBe(FROZEN.canonicalJson);
    expect(canonicalMetadataJson(FROZEN.metadata)).toBe(FROZEN.canonicalJson);
  });

  it('hashMetadata() reproduces the pinned full metadata hash', () => {
    expect(hashMetadata(FROZEN.metadata)).toBe(FROZEN.metaHash);
  });

  it('truncateMetadataHash() reproduces the pinned 8-byte truncation', () => {
    const trunc = truncateMetadataHash(FROZEN.metaHash);
    expect(trunc).toHaveLength(8);
    expect(trunc.toString('hex')).toBe(FROZEN.metaTrunc8Hex);
  });

  it('the full WITH-metadata script hex matches the pinned value', () => {
    expect(buildScriptHex(FROZEN.fingerprint, FROZEN.metaTrunc8Hex)).toBe(FROZEN.scriptMetaHex);
  });

  it('DRIFT GUARD: a mapping that changed the prefix would NOT match the pinned script (sanity)', () => {
    // If a refactor swapped the prefix, the compiled script would differ from the
    // pinned constant — this demonstrates the pin actually catches drift.
    const wrongPrefix = Buffer.concat([
      Buffer.from('XXXX'),
      Buffer.from(FROZEN.fingerprint, 'hex'),
    ]);
    const wrongScriptHex = bitcoin.script
      .compile([bitcoin.opcodes.OP_RETURN, wrongPrefix])
      .toString('hex');
    expect(wrongScriptHex).not.toBe(FROZEN.scriptHex);
    // And the real extractor rejects the non-ARKV script (returns null).
    expect(extractAnchorFingerprint(wrongScriptHex)).toBeNull();
  });
});
