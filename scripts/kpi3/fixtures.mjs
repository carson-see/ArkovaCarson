/**
 * KPI-3 fixtures — a REAL valid Arkova direct-anchor proof plus its tampered
 * negative control, and a COMPLETE offline SPV dataset (tx, merkle-proof, block
 * header, tip height) so the tests recompute the merkle root + header hash with
 * zero network. All values are the production anchor ARK-2026-D2959176 (HakiChain
 * org), captured from blockstream.info during the Lane-1 2026-07-20 check
 * (docs/lane1/pi05-24h/task1-15anchor-check.md; merkle/header re-fetched for the
 * specialist-review hardening pass).
 */

const REAL_FINGERPRINT =
  '83204bbd57f6fd588a1f3458564b9b494de6a37231982cd1d17c6b12e290f018';
const REAL_TXID =
  'c814f1cec9450c091965b2e419e9a1b3d5edac3e4e79c8e3f95acf6edcb1f0d2';
const REAL_BLOCK = 952022;
// Real values (verified: header double-SHA256 -> this hash; header[36:68] -> this root).
const REAL_BLOCK_HASH =
  '00000000000000000000eb383dddd0d3f905e9ece13261dfb1a127cb9b19725a';
const REAL_BLOCK_HEADER =
  '00c0052085d31bc3bd6700c52f80e119e203a0cd32ec8db72a730000000000000000000073588b69f5d86c307492646982e994380cde50535af995a48139b3c31f1b0fcc7aed1d6a8f06021728046ee4';
const REAL_MERKLE_ROOT =
  'cc0f1b1fc3b33981a495f95a5350de0c3894e98269649274306cd8f5698b5873';
const REAL_TREASURY_ADDR = 'bc1qtm2kk33k6ht4agt48kh7rfkmmhfkapqn4zwerc';
const REAL_TIP_HEIGHT = 958924; // >6000 confirmations
// OP_RETURN observed on-chain: 6a (OP_RETURN) 2c (PUSHBYTES_44) 41524b56 (ARKV)
// <32B fingerprint> <8B trailing metadata>.
const REAL_OP_RETURN_SCRIPT = '6a2c41524b56' + REAL_FINGERPRINT + 'e78d227d111d0c3e';

const REAL_MERKLE_PROOF = {
  block_height: REAL_BLOCK,
  pos: 3936,
  merkle: [
    'ea9807b63277860d78807a65d6b957fbc8bcbe944ee3d8afbc045a1e86b75907',
    '90d4a6596b3abbff06e7ed417fb0450eb711ab12815501f9878e1302a3affcba',
    '0233b3347567cb381e923343328cb0351c3221478b937ad679f563c113e9119a',
    '199b507cf8a2913bf61d35bec62cfb46c449d653cce84f2236b1d84a0b84a531',
    '97949f26a4ddf4538433cccabd934b501ccbd280259615283562dd34e5131023',
    'e227802cd8356dfd4772cd71afeade56a8c09d1c68e2df4264f06882179c45ec',
    '40ddab6b736d18667a549ffde3304a853577ab01540f54bedc16731bd9e55184',
    'f51e3cddf644a9bfa03375c893bc32a479c9187bedca302908df2b5714221ec4',
    'dbc7875420bd55cd36b75cfc846526aab1c16cc033cbeeecb55c0f58193c5451',
    'e10afb6501b07f449a4ec7dec4a1e80ad2235da4345fceed75cfc7483b5736e5',
    '82d2a4db8f682577a78a9156d4394eb02bf075d5a6b2da194d0625772ddc9c2e',
    'd149c5e5ae81242c0f7ce61cb3e5104da6f5bf90b818148a66a5b247e04091e9',
  ],
};

export const CONSTANTS = {
  REAL_FINGERPRINT, REAL_TXID, REAL_BLOCK, REAL_BLOCK_HASH, REAL_BLOCK_HEADER,
  REAL_MERKLE_ROOT, REAL_TREASURY_ADDR, REAL_TIP_HEIGHT, REAL_OP_RETURN_SCRIPT,
  REAL_MERKLE_PROOF, ARKOVA_MAGIC_HEX: '41524b56',
};

/** A genuine, verifiable proof (with issuer binding asserted). */
export const VALID_PROOF = {
  publicId: 'ARK-2026-D2959176',
  fingerprint: REAL_FINGERPRINT,
  txid: REAL_TXID,
  expectedBlockHeight: REAL_BLOCK,
  expectedIssuerAddress: REAL_TREASURY_ADDR,
};

/**
 * NEGATIVE CONTROL — the deliberate "fake proof" the rehearsal shows failing.
 * The presented document's fingerprint differs from the anchored one by a single
 * nibble (…e290f018 -> …e290f019). The on-chain tx is unchanged, so the committed
 * fingerprint will not match — verification must reject.
 */
export const TAMPERED_PROOF = {
  publicId: 'ARK-2026-D2959176 (TAMPERED)',
  fingerprint: REAL_FINGERPRINT.slice(0, -1) + '9',
  txid: REAL_TXID,
  expectedBlockHeight: REAL_BLOCK,
  expectedIssuerAddress: REAL_TREASURY_ADDR,
};

/**
 * Offline Esplora dataset keyed by request path — mirrors blockstream.info.
 * JSON for tx / merkle-proof; raw hex text for header / tip height.
 */
export const FAKE_EXPLORER_PATHS = {
  [`tx/${REAL_TXID}`]: {
    txid: REAL_TXID,
    status: { confirmed: true, block_height: REAL_BLOCK, block_hash: REAL_BLOCK_HASH },
    vin: [{ prevout: { scriptpubkey_address: REAL_TREASURY_ADDR } }],
    vout: [
      { scriptpubkey: REAL_OP_RETURN_SCRIPT, scriptpubkey_type: 'op_return' },
      { scriptpubkey: '0014' + '00'.repeat(20), scriptpubkey_type: 'v0_p2wpkh', value: 546 },
    ],
  },
  [`tx/${REAL_TXID}/merkle-proof`]: REAL_MERKLE_PROOF,
  [`block/${REAL_BLOCK_HASH}/header`]: REAL_BLOCK_HEADER,
  'blocks/tip/height': String(REAL_TIP_HEIGHT),
};

/** Build an injected fetchPath over a (possibly mutated) path map. */
export function fakeExplorer(paths = FAKE_EXPLORER_PATHS) {
  return async (path) => {
    if (!(path in paths)) { const e = new Error(`no fixture for ${path}`); e.status = 404; throw e; }
    return paths[path];
  };
}
