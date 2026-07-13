/** ARKV prefix as hex (4 bytes: 0x41524b56). */
const ARKV_PREFIX_HEX = '41524b56';

/**
 * Truncated metadata hash length in bytes (appended after fingerprint in calldata).
 * Matches Bitcoin client's 8-byte default for consistency.
 */
const METADATA_HASH_TRUNCATED_BYTES = 8;

/**
 * Build calldata for an anchor transaction.
 *
 * Format: ARKV (4 bytes) + fingerprint (32 bytes) + [metadataHash (8 bytes)]
 * Total: 36 bytes without metadata, 44 bytes with metadata
 *
 * @returns Hex-encoded calldata with 0x prefix
 */
export function buildAnchorCalldata(
  fingerprint: string,
  metadataHash?: string,
): `0x${string}` {
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) {
    throw new Error('Fingerprint must be a 64-character hex string (SHA-256)');
  }

  let calldataHex = ARKV_PREFIX_HEX + fingerprint.toLowerCase();

  if (metadataHash) {
    if (!/^[a-f0-9]{64}$/i.test(metadataHash)) {
      throw new Error('Metadata hash must be a 64-character hex string (SHA-256)');
    }
    calldataHex += metadataHash.toLowerCase().slice(0, METADATA_HASH_TRUNCATED_BYTES * 2);
  }

  return `0x${calldataHex}`;
}

/** SCRUM-2591: Length of the ARKV prefix in hex chars (4 bytes = 8 hex chars). */
const ARKV_PREFIX_HEX_LEN = ARKV_PREFIX_HEX.length;
/** Fingerprint length in hex chars (32 bytes). */
const FINGERPRINT_HEX_LEN = 64;
/** Truncated metadata hash length in hex chars (8 bytes). */
const METADATA_HASH_HEX_LEN = METADATA_HASH_TRUNCATED_BYTES * 2;

/** Canonical total calldata length (hex chars) with NO metadata: ARKV(8) + fp(64) = 72. */
const CANONICAL_LEN_NO_META = ARKV_PREFIX_HEX_LEN + FINGERPRINT_HEX_LEN;
/** Canonical total calldata length (hex chars) WITH metadata: 72 + 16 = 88. */
const CANONICAL_LEN_WITH_META = CANONICAL_LEN_NO_META + METADATA_HASH_HEX_LEN;

/**
 * SCRUM-2591 canonical-decode CONTRACT: parse anchor calldata and return the
 * committed fingerprint (+ optional truncated metadata hash), or null if the
 * calldata is not a CANONICAL Arkova anchor.
 *
 * A canonical anchor is EXACTLY `ARKV (4B) + fingerprint (32B)` (36 bytes) or
 * `ARKV (4B) + fingerprint (32B) + metadataHash (8B)` (44 bytes). This is a
 * structural decode at the canonical byte offset, not a loose substring scan.
 * Any of the following decode to null:
 *   - a prefix that begins at a non-zero offset (junk byte(s) before ARKV);
 *   - trailing bytes after the committed 36/44-byte payload;
 *   - a truncated / partial metadata region (37..43 bytes);
 *   - an odd-length or non-hex string.
 *
 * PARITY NOTE (corrected): the EVM and Bitcoin decoders share the offset-0 /
 * no-substring-scan / whole-structure rejection class, so both reject the same
 * leading-junk, wrong-prefix, and split-push inputs. They are not byte-for-byte
 * identical, however: signet.ts:extractAnchorFingerprint checks
 * `payload.length >= 36` and therefore tolerates arbitrary trailing bytes up to
 * the 80-byte OP_RETURN limit, whereas this EVM decoder requires an exact 36-
 * or 44-byte length and therefore rejects all trailing bytes.
 */
export function parseAnchorCalldata(calldata: string): {
  fingerprint: string;
  metadataHashTruncated?: string;
} | null {
  const hex = (calldata.startsWith('0x') ? calldata.slice(2) : calldata).toLowerCase();

  if (hex.length % 2 !== 0) return null;
  if (!/^[0-9a-f]*$/.test(hex)) return null;

  if (hex.length !== CANONICAL_LEN_NO_META && hex.length !== CANONICAL_LEN_WITH_META) {
    return null;
  }

  if (hex.slice(0, ARKV_PREFIX_HEX_LEN) !== ARKV_PREFIX_HEX) {
    return null;
  }

  const fingerprint = hex.slice(ARKV_PREFIX_HEX_LEN, ARKV_PREFIX_HEX_LEN + FINGERPRINT_HEX_LEN);
  const metadataHashTruncated =
    hex.length === CANONICAL_LEN_WITH_META
      ? hex.slice(ARKV_PREFIX_HEX_LEN + FINGERPRINT_HEX_LEN)
      : undefined;

  return { fingerprint, metadataHashTruncated };
}
