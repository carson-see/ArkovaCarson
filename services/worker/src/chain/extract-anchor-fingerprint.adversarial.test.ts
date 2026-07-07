/**
 * SCRUM-2591 — Bitcoin (signet) OP_RETURN anchor-decode REGRESSION SPEC (adversarial).
 *
 * This is a REGRESSION-PINNING corpus over the ALREADY-SHIPPED public
 * `extractAnchorFingerprint` (signet.ts, on main via #1417). It authors ZERO
 * fix lines — the two-halves verifyFingerprint bug (substring false-positive +
 * unspent-only-scan false-negative) already shipped on main; this file only
 * pins the shipped Bitcoin decoder against future regression.
 *
 * SIGNET (this file) CONTRACT — what `extractAnchorFingerprint` enforces:
 *   ACCEPT iff the script is EXACTLY `[OP_RETURN, <buffer>]` (decompiles to
 *   chunks.length === 2, chunks[0] === OP_RETURN) AND the single pushed buffer
 *   BEGINS with the 4-byte `ARKV` prefix at offset 0, immediately followed by
 *   the 32-byte SHA-256 fingerprint (payload.length >= 36).
 *   REJECT any script that merely *contains* `ARKV<fingerprint>` behind a
 *   leading junk byte, split across multiple pushes, under a different opcode,
 *   or with the prefix at a non-zero offset.
 *
 * ── PARITY IS PARTIAL, NOT IDENTICAL (corrected — see the DIVERGENCE block) ──
 * The signet and EVM (base.ts:parseAnchorCalldata) decoders share the
 * offset-0-prefix / no-substring-scan / whole-structure rejection class, so
 * both reject the SAME leading-junk / wrong-prefix / split-push adversarial
 * inputs. They DIVERGE on TRAILING bytes: signet checks `payload.length >= 36`
 * and therefore TOLERATES arbitrary trailing metadata up to the 80-byte
 * OP_RETURN limit; EVM checks `hex.length` is EXACTLY the 36- or 44-byte
 * canonical length and therefore REJECTS all trailing bytes. This file proves
 * that divergence empirically rather than asserting a false "identical
 * contract". The prior header's "identical structural contract" claim was
 * inaccurate and is removed.
 *
 * signet.ts is imported READ-ONLY (zero edit); it is soak-locked this window.
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
// The EVM-side canonical decoder — used ONLY by the DIVERGENCE block to prove
// the two decoders are NOT byte-for-byte identical on trailing bytes.
import { parseAnchorCalldata } from './base.js';

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

  it('(a2) rejects a LEADING 0x00 byte before ARKV (rejection is by the offset-0 prefix check, NOT the trailing byte)', () => {
    // ARKV+fp buried behind a leading 0x00 prefix byte, with a trailing 0xff.
    // The rejection cause is the LEADING 0x00 failing the offset-0 ARKV check
    // (payload.subarray(0,4) !== 'ARKV') — signet TOLERATES the trailing 0xff.
    // See the DIVERGENCE block for a test that isolates trailing-byte tolerance.
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

// ─── DIVERGENCE: signet vs EVM on trailing bytes ─────────────────────────────
//
// The prior file/PR framing claimed the signet and EVM decoders enforce an
// "identical structural contract". They do NOT. This block pins the ACTUAL,
// asymmetric behavior so the honest contract is the one under regression:
//   • signet.ts checks `payload.length >= 36`  → TOLERATES trailing bytes.
//   • base.ts  checks `hex.length === 36|44`   → REJECTS trailing bytes.
// Both still share the offset-0 / no-substring-scan rejection class (covered by
// the cases above), which is the parity that genuinely holds.
describe('signet vs EVM trailing-byte DIVERGENCE (contract is asymmetric, not identical)', () => {
  /** Same committed ARKV+fp payload, hex-encoded for the EVM calldata form. */
  const evmCalldata = (trailing: Buffer): string =>
    Buffer.concat([ARKV, FP_BYTES, trailing]).toString('hex');

  it('signet ACCEPTS a canonical anchor with 1 non-metadata trailing byte (length >= 36)', () => {
    const hex = opReturn(Buffer.concat([ARKV, FP_BYTES, Buffer.from([0xff])]));
    // 37 bytes: prefix(4) + fp(32) + 1 trailing. signet only checks >= 36.
    expect(extractAnchorFingerprint(hex)).toBe(FP_HEX);
  });

  it('signet ACCEPTS a canonical anchor with 5 arbitrary trailing bytes', () => {
    const hex = opReturn(Buffer.concat([ARKV, FP_BYTES, Buffer.from('deadbeefff', 'hex')]));
    expect(extractAnchorFingerprint(hex)).toBe(FP_HEX);
  });

  it('EVM REJECTS the equivalent calldata with 1 trailing byte (length must be EXACTLY 36 or 44)', () => {
    // 37 bytes → not a canonical EVM length → null. This is the divergence.
    expect(parseAnchorCalldata(evmCalldata(Buffer.from([0xff])))).toBeNull();
  });

  it('EVM REJECTS a partial/truncated metadata region (37..43 bytes)', () => {
    // 5 trailing bytes = 41 bytes total: between the 36- and 44-byte canonical
    // forms → EVM rejects; signet (above) accepts the same committed payload.
    expect(parseAnchorCalldata(evmCalldata(Buffer.from('deadbeefff', 'hex')))).toBeNull();
  });

  it('shared parity holds: BOTH reject a leading-junk-byte substring embed', () => {
    // The rejection class that IS identical across both chains.
    const btcHex = opReturn(Buffer.concat([Buffer.from([0xab]), ARKV, FP_BYTES]));
    const evmHex = Buffer.concat([Buffer.from([0xab]), ARKV, FP_BYTES]).toString('hex');
    expect(extractAnchorFingerprint(btcHex)).toBeNull();
    expect(parseAnchorCalldata(evmHex)).toBeNull();
  });

  it('shared parity holds: BOTH accept the canonical 8-byte-metadata form', () => {
    const btcHex = opReturn(Buffer.concat([ARKV, FP_BYTES, META8]));
    const evmHex = Buffer.concat([ARKV, FP_BYTES, META8]).toString('hex');
    expect(extractAnchorFingerprint(btcHex)).toBe(FP_HEX);
    expect(parseAnchorCalldata(evmHex)).toEqual({
      fingerprint: FP_HEX,
      metadataHashTruncated: META8.toString('hex'),
    });
  });
});
