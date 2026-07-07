/**
 * SCRUM-2591 — verifyFingerprint canonical-decode CONTRACT SPEC (adversarial).
 *
 * CONTRACT: the on-chain anchor decoder MUST accept a script ONLY when it is
 * EXACTLY `[OP_RETURN, <buffer>]` where the single pushed buffer BEGINS with the
 * 4-byte `ARKV` prefix at offset 0, immediately followed by the 32-byte SHA-256
 * fingerprint (an optional 8-byte truncated metadata hash may trail). Any script
 * that merely *contains* `ARKV<fingerprint>` somewhere in its bytes — behind a
 * junk byte, split across multiple pushes, under a different opcode, or with a
 * non-canonical push encoding — is NOT a canonical anchor and MUST decode to
 * null.
 *
 * This file imports the ALREADY-SHIPPED public `extractAnchorFingerprint` from
 * `./signet.js` READ-ONLY (zero edit to signet.ts). It pins the shipped Bitcoin
 * decoder to the identical structural contract that base.ts:parseAnchorCalldata
 * (the EVM path) enforces, so the two chains reject the same malformed-payload
 * class. When the soaking hardening PR (#1417) lands, its signet impl remains
 * bound to satisfy this corpus.
 *
 * Per Constitution 1.7: no real chain APIs — this is a pure structural-decode
 * test over crafted scriptPubKey hex.
 */

import { describe, it, expect, vi } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';

// signet.ts loads config + logger at module init — mock them so this pure
// structural-decode test never triggers real worker-config validation.
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config.js', () => ({
  config: {
    bitcoinNetwork: 'signet',
    bitcoinMaxFeeRate: undefined,
  },
}));

// READ-ONLY import of the shipped public decoder — this test never mutates signet.ts.
import { extractAnchorFingerprint } from './signet.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const ARKV = Buffer.from('ARKV');
const FP_HEX = 'a'.repeat(64); // 32-byte fingerprint
const FP_BYTES = Buffer.from(FP_HEX, 'hex');
const META8 = Buffer.from('0011223344556677', 'hex'); // 8-byte truncated metadata

/** Compile `[OP_RETURN, payload]` and return its hex. */
const opReturn = (payload: Buffer): string =>
  bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, payload]).toString('hex');

// ─── Contract spec ──────────────────────────────────────────────────────────

describe('extractAnchorFingerprint — canonical-decode CONTRACT (SCRUM-2591)', () => {
  // ── Positive: the two canonical shapes decode to the committed fingerprint ──

  it('accepts a canonical anchor (ARKV + 32-byte fingerprint)', () => {
    const hex = opReturn(Buffer.concat([ARKV, FP_BYTES]));
    expect(extractAnchorFingerprint(hex)).toBe(FP_HEX);
  });

  it('accepts a canonical anchor with a trailing 8-byte metadata hash', () => {
    const hex = opReturn(Buffer.concat([ARKV, FP_BYTES, META8]));
    expect(extractAnchorFingerprint(hex)).toBe(FP_HEX);
  });

  // ── (a) substring-embed: contains ARKV+fp but not canonically ──

  it('(a) rejects a payload with a leading junk byte before ARKV (substring embed)', () => {
    const hex = opReturn(Buffer.concat([Buffer.from([0xab]), ARKV, FP_BYTES]));
    // The raw hex still CONTAINS "ARKV<fp>" — a substring scan would wrongly match.
    expect(hex).toContain(ARKV.toString('hex') + FP_HEX);
    expect(extractAnchorFingerprint(hex)).toBeNull();
  });

  it('(a2) rejects trailing junk after the ARKV prefix appears mid-buffer', () => {
    // ARKV+fp buried behind a leading prefix byte AND with a trailing byte.
    const hex = opReturn(Buffer.concat([Buffer.from([0x00]), ARKV, FP_BYTES, Buffer.from([0xff])]));
    expect(extractAnchorFingerprint(hex)).toBeNull();
  });

  // ── (b) wrong / absent prefix ──

  it('(b) rejects an OP_RETURN whose 4-byte prefix is not ARKV', () => {
    const hex = opReturn(Buffer.concat([Buffer.from('XXXX'), FP_BYTES]));
    expect(extractAnchorFingerprint(hex)).toBeNull();
  });

  it('(b2) rejects an OP_RETURN with no ARKV prefix at all (bare fingerprint)', () => {
    const hex = opReturn(FP_BYTES);
    expect(extractAnchorFingerprint(hex)).toBeNull();
  });

  // ── (c) prefix at a non-zero offset ──

  it('(c) rejects the ARKV prefix at a non-zero offset inside the buffer', () => {
    const hex = opReturn(Buffer.concat([Buffer.from('zz'), ARKV, FP_BYTES]));
    expect(extractAnchorFingerprint(hex)).toBeNull();
  });

  // ── (d) truncated committed data (< 36 bytes) ──

  it('(d) rejects a payload shorter than prefix + 32-byte fingerprint', () => {
    const hex = opReturn(Buffer.concat([ARKV, FP_BYTES.subarray(0, 16)]));
    expect(extractAnchorFingerprint(hex)).toBeNull();
  });

  // ── (e) split across TWO pushes: [OP_RETURN, ARKV, fingerprint] ──

  it('(e) rejects a split-push OP_RETURN [OP_RETURN, <ARKV>, <fingerprint>] (chunks !== 2)', () => {
    const hex = bitcoin.script
      .compile([bitcoin.opcodes.OP_RETURN, ARKV, FP_BYTES])
      .toString('hex');
    expect(extractAnchorFingerprint(hex)).toBeNull();
  });

  it('(e2) rejects a multi-push OP_RETURN even if a later push equals ARKV+fingerprint', () => {
    const hex = bitcoin.script
      .compile([
        bitcoin.opcodes.OP_RETURN,
        Buffer.from('deadbeef', 'hex'),
        Buffer.concat([ARKV, FP_BYTES]),
      ])
      .toString('hex');
    expect(extractAnchorFingerprint(hex)).toBeNull();
  });

  // ── (g) wrong opcode: OP_RETURN replaced ──

  it('(g) rejects a non-OP_RETURN script that pushes a canonical ARKV+fp buffer', () => {
    // A bare data push (no OP_RETURN) — decompiles to [<buffer>], length 1, not 2.
    const hex = bitcoin.script
      .compile([Buffer.concat([ARKV, FP_BYTES])])
      .toString('hex');
    expect(extractAnchorFingerprint(hex)).toBeNull();
  });

  it('(g2) rejects a P2WPKH-shaped script (OP_0 <20-byte program>)', () => {
    const hex = '0014' + '00'.repeat(20);
    expect(extractAnchorFingerprint(hex)).toBeNull();
  });

  // ── (h) case-insensitivity of the returned fingerprint hex ──

  it('(h) returns the fingerprint in lowercase hex', () => {
    const upperFp = Buffer.from('A'.repeat(64), 'hex'); // hex parse is case-insensitive
    const hex = opReturn(Buffer.concat([ARKV, upperFp]));
    const out = extractAnchorFingerprint(hex);
    expect(out).toBe('a'.repeat(64));
    expect(out).toBe(out?.toLowerCase());
  });

  // ── undecodable / empty ──

  it('returns null for empty / undecodable hex', () => {
    expect(extractAnchorFingerprint('')).toBeNull();
  });
});
