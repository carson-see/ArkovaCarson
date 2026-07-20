/**
 * KPI-3 fixtures — a REAL valid Arkova direct-anchor proof plus its tampered
 * negative control. The valid record is the production anchor ARK-2026-D2959176
 * (HakiChain org), independently confirmed on blockstream.info during the
 * Lane-1 2026-07-20 15-anchor check (docs/lane1/pi05-24h/task1-15anchor-check.md).
 *
 * FAKE_EXPLORER is the exact shape blockstream.info's /tx/<id> returns, trimmed
 * to the fields the verifier reads, so the tests are deterministic and offline.
 */

const REAL_FINGERPRINT =
  '83204bbd57f6fd588a1f3458564b9b494de6a37231982cd1d17c6b12e290f018';
const REAL_TXID =
  'c814f1cec9450c091965b2e419e9a1b3d5edac3e4e79c8e3f95acf6edcb1f0d2';
const REAL_BLOCK = 952022;
const REAL_BLOCK_HASH =
  '00000000000000000000f3a1e9c6b8d4a2f0c1e3b5d7a9c1e3f5b7d9a1c3e5f7'; // illustrative; not asserted by the verifier
// OP_RETURN scriptpubkey observed on-chain: 6a (OP_RETURN) 2c (PUSHBYTES_44)
// 41524b56 (ARKV) <32B fingerprint> <8B suffix>.
const REAL_OP_RETURN_SCRIPT =
  '6a2c41524b56' + REAL_FINGERPRINT + 'e78d227d111d0c3e';

/** A genuine, verifiable proof. */
export const VALID_PROOF = {
  publicId: 'ARK-2026-D2959176',
  fingerprint: REAL_FINGERPRINT,
  txid: REAL_TXID,
  expectedBlockHeight: REAL_BLOCK, // optional assertion; present here
};

/**
 * NEGATIVE CONTROL — the deliberate "fake proof" the rehearsal shows failing.
 * The presented document's fingerprint differs from the anchored one by a
 * single nibble (…e290f018 -> …e290f019). The on-chain tx is unchanged, so the
 * committed fingerprint will NOT match — verification must reject it.
 */
export const TAMPERED_PROOF = {
  publicId: 'ARK-2026-D2959176 (TAMPERED)',
  fingerprint: REAL_FINGERPRINT.slice(0, -1) + '9',
  txid: REAL_TXID,
  expectedBlockHeight: REAL_BLOCK,
};

/** Canned explorer response, keyed by txid (blockstream.info /tx shape). */
export const FAKE_EXPLORER = {
  [REAL_TXID]: {
    txid: REAL_TXID,
    status: {
      confirmed: true,
      block_height: REAL_BLOCK,
      block_hash: REAL_BLOCK_HASH,
    },
    vout: [
      {
        scriptpubkey: REAL_OP_RETURN_SCRIPT,
        scriptpubkey_type: 'op_return',
      },
      {
        scriptpubkey: '0014' + '00'.repeat(20),
        scriptpubkey_type: 'v0_p2wpkh',
        value: 546,
      },
    ],
  },
};

export const ARKOVA_MAGIC_HEX = '41524b56'; // "ARKV"
