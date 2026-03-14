/**
 * Anchor Verification by Fingerprint
 *
 * Accepts a SHA-256 fingerprint (64-char hex string) and checks whether
 * it matches a SECURED anchor in the database with a valid on-chain receipt.
 *
 * Constitution 1.6: Documents never leave the user's device.
 * This module accepts ONLY a hash — never a file. The client hashes the
 * document in-browser using Web Crypto API (src/lib/fileHasher.ts) and
 * sends only the 64-char hex fingerprint.
 *
 * Returns the frozen verification schema (CLAUDE.md Section 10).
 */

/** Valid SHA-256 hex: exactly 64 lowercase hex characters */
const SHA256_REGEX = /^[a-f0-9]{64}$/;

/** Anchor record as returned by the DB lookup */
export interface AnchorRecord {
  fingerprint: string;
  status: string;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  chain_block_timestamp: string | null;
  public_id: string | null;
  created_at: string;
  jurisdiction?: string | null;
  credential_type?: string | null;
  org_name?: string | null;
  recipient_hash?: string | null;
  issued_at?: string | null;
  expires_at?: string | null;
}

/** Abstraction for DB lookup — injectable for testing */
export interface AnchorLookup {
  lookupByFingerprint(fingerprint: string): Promise<AnchorRecord | null>;
}

/** Result returned by verifyAnchorByFingerprint */
export interface VerifyAnchorResult {
  verified: boolean;
  status?: string;
  network_receipt_id?: string;
  anchor_timestamp?: string;
  record_uri?: string;
  credential_type?: string;
  issuer_name?: string;
  jurisdiction?: string;
  error?: string;
}

/**
 * Verify an anchor by its SHA-256 fingerprint.
 *
 * 1. Validates the fingerprint format (64-char hex)
 * 2. Looks up the fingerprint in the database
 * 3. Returns the frozen verification schema result
 *
 * @param fingerprint - 64-character hex SHA-256 hash (from client-side hashing)
 * @param db - Injected DB lookup (for testability)
 */
export async function verifyAnchorByFingerprint(
  fingerprint: string,
  db: AnchorLookup,
): Promise<VerifyAnchorResult> {
  // Validate input format
  if (!fingerprint || !SHA256_REGEX.test(fingerprint.toLowerCase())) {
    return {
      verified: false,
      error: 'Invalid fingerprint format. Expected 64-character hex SHA-256 hash.',
    };
  }

  const normalizedFp = fingerprint.toLowerCase();

  // Look up anchor by fingerprint
  const anchor = await db.lookupByFingerprint(normalizedFp);

  if (!anchor) {
    return { verified: false };
  }

  // Map internal status to public-facing status
  const publicStatus = mapStatus(anchor.status);

  // Only SECURED/ACTIVE anchors are "verified"
  const isVerified = anchor.status === 'SECURED' || anchor.status === 'ACTIVE';

  const result: VerifyAnchorResult = {
    verified: isVerified,
    status: publicStatus,
    anchor_timestamp: anchor.created_at,
  };

  // Include chain receipt if it exists (even for revoked — it was once anchored)
  if (anchor.chain_tx_id) {
    result.network_receipt_id = anchor.chain_tx_id;
  }

  // Include record URI if public_id exists
  if (anchor.public_id) {
    result.record_uri = `https://app.arkova.io/verify/${anchor.public_id}`;
  }

  // Optional fields from enriched lookup
  if (anchor.credential_type) {
    result.credential_type = anchor.credential_type;
  }
  if (anchor.org_name) {
    result.issuer_name = anchor.org_name;
  }

  // Omit jurisdiction when null (frozen schema: never return null)
  if (anchor.jurisdiction) {
    result.jurisdiction = anchor.jurisdiction;
  }

  return result;
}

function mapStatus(status: string): string {
  switch (status) {
    case 'SECURED':
    case 'ACTIVE':
      return 'ACTIVE';
    case 'REVOKED':
      return 'REVOKED';
    case 'SUPERSEDED':
      return 'SUPERSEDED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'PENDING':
      return 'PENDING';
    default:
      return 'UNKNOWN';
  }
}
