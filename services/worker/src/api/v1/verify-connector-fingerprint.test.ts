/**
 * BUG-2026-08-13-010 — connector-sourced fingerprints are NOT re-derivable
 * from the source system (§1.5 / §1.6A).
 *
 * Proven during the 2026-08 full soak: four fetches of the SAME unchanged
 * DocuSign envelope's `/documents/combined` produced four DIFFERENT SHA-256
 * hashes — DocuSign re-renders the file per request. A connector-sourced
 * anchor still cryptographically proves the exact fetched bytes existed at
 * fetch time, but nothing told a verifier that re-fetching the source document
 * is NOT expected to reproduce the fingerprint. §1.5 requires the proof
 * surface to state what is measured, asserted, and NOT asserted.
 *
 * These tests pin the additive-nullable response pair
 * (`fingerprint_rederivability` + `fingerprint_rederivability_note`,
 * Constitution §1.8) and the closed-set marker resolution that keys it.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock db and logger to avoid config validation at import time
vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: { bitcoinNetwork: 'signet', frontendUrl: 'https://app.arkova.ai' },
}));

import {
  EMPTY_API_RICH_FIELDS,
  buildVerificationResult,
  mapAnchorRow,
  type AnchorByPublicId,
  type AnchorSelectRow,
} from './verify.js';
import {
  FINGERPRINT_REDERIVABILITY,
  FINGERPRINT_REDERIVABILITY_NOTE,
  CONNECTOR_FETCH_SOURCE_MARKERS,
  resolveConnectorFetchSource,
  resolveServerFetchedConnectorSource,
  isServerFetchedConnectorAnchor,
  connectorFingerprintRederivabilityFields,
  connectorFingerprintRederivabilityFieldsFor,
} from '../../constants/connectorFingerprint.js';
import { buildMerkleTree } from '../../utils/merkle.js';
import { buildProofResponse, type MerkleProofResponse } from './verify-proof.js';

function createRow(overrides: Partial<AnchorSelectRow> = {}): AnchorSelectRow {
  return {
    public_id: 'ARK-2026-CONN-001',
    fingerprint: 'a'.repeat(64),
    status: 'SECURED',
    chain_tx_id: 'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57',
    chain_block_height: 204567,
    chain_timestamp: '2026-03-12T10:30:00Z',
    created_at: '2026-03-10T08:00:00Z',
    credential_type: 'CONTRACT_POSTSIGNING',
    sub_type: null,
    issued_at: null,
    expires_at: null,
    description: null,
    directory_info_opt_out: false,
    compliance_controls: null,
    chain_confirmations: null,
    version_number: 1,
    revocation_tx_id: null,
    revocation_block_height: null,
    file_mime: null,
    file_size: null,
    org_id: 'org-test-1',
    fingerprint_source: null,
    metadata: null,
    organization: { display_name: 'Acme Legal' },
    parent: null,
    anchor_proofs: null,
    extraction_manifests: [],
    ...overrides,
  };
}

function createAnchor(overrides: Partial<AnchorByPublicId> = {}): AnchorByPublicId {
  return {
    public_id: 'ARK-2026-CONN-001',
    fingerprint: 'a'.repeat(64),
    status: 'SECURED',
    org_id: 'org-test-1',
    chain_tx_id: 'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57',
    chain_block_height: 204567,
    chain_timestamp: '2026-03-12T10:30:00Z',
    created_at: '2026-03-10T08:00:00Z',
    credential_type: 'CONTRACT_POSTSIGNING',
    org_name: 'Acme Legal',
    recipient_hash: null,
    issued_at: null,
    expires_at: null,
    jurisdiction: null,
    merkle_root: null,
    description: null,
    directory_info_opt_out: false,
    compliance_controls: null,
    chain_confirmations: null,
    parent_public_id: null,
    version_number: null,
    revocation_tx_id: null,
    revocation_block_height: null,
    file_mime: null,
    file_size: null,
    confidence_scores: null,
    sub_type: null,
    fingerprint_source: null,
    ...overrides,
  };
}

describe('resolveConnectorFetchSource — closed marker set, never free text', () => {
  it('recognises the server-written connector fetch markers', () => {
    for (const marker of ['docusign', 'google_drive', 'microsoft_365', 'connector']) {
      expect(resolveConnectorFetchSource({ connector_source: marker })).toBe(marker);
    }
  });

  it('rejects upload-origin connector_artifact sources — those bytes were user-supplied, not fetched', () => {
    expect(resolveConnectorFetchSource({ connector_source: 'manual_upload' })).toBeNull();
    expect(resolveConnectorFetchSource({ connector_source: 'batch_upload' })).toBeNull();
  });

  it('rejects free text, case variants, non-strings, and missing metadata', () => {
    expect(resolveConnectorFetchSource({ connector_source: 'DocuSign' })).toBeNull();
    expect(resolveConnectorFetchSource({ connector_source: 'docusign<script>' })).toBeNull();
    expect(resolveConnectorFetchSource({ connector_source: 42 })).toBeNull();
    expect(resolveConnectorFetchSource({ connector_source: null })).toBeNull();
    expect(resolveConnectorFetchSource({})).toBeNull();
    expect(resolveConnectorFetchSource(null)).toBeNull();
    expect(resolveConnectorFetchSource(undefined)).toBeNull();
  });

  it('the marker set itself excludes the upload-origin sources', () => {
    expect(CONNECTOR_FETCH_SOURCE_MARKERS.has('manual_upload')).toBe(false);
    expect(CONNECTOR_FETCH_SOURCE_MARKERS.has('batch_upload')).toBe(false);
  });
});

describe('resolveServerFetchedConnectorSource — the single fetch-evidence rule', () => {
  it('returns the marker only when a recognised marker AND a connector_artifact_id are both present', () => {
    expect(
      resolveServerFetchedConnectorSource({ connector_source: 'docusign', connector_artifact_id: 'cart_1' }),
    ).toBe('docusign');
    expect(
      resolveServerFetchedConnectorSource({ connector_source: 'google_drive', connector_artifact_id: 'cart_2' }),
    ).toBe('google_drive');
  });

  it('returns null for a DECLARED-hash anchor — marker but no connector_artifact_id', () => {
    expect(resolveServerFetchedConnectorSource({ connector_source: 'docusign' })).toBeNull();
    expect(resolveServerFetchedConnectorSource({ connector_source: 'connector' })).toBeNull();
    expect(
      resolveServerFetchedConnectorSource({ connector_source: 'docusign', connector_artifact_id: '' }),
    ).toBeNull();
    expect(
      resolveServerFetchedConnectorSource({ connector_source: 'docusign', connector_artifact_id: 42 }),
    ).toBeNull();
  });

  it('returns null for a user-supplied source even with an artifact id, and for absent metadata', () => {
    expect(
      resolveServerFetchedConnectorSource({ connector_source: 'manual_upload', connector_artifact_id: 'c' }),
    ).toBeNull();
    expect(resolveServerFetchedConnectorSource({ connector_artifact_id: 'c' })).toBeNull();
    expect(resolveServerFetchedConnectorSource(null)).toBeNull();
    expect(resolveServerFetchedConnectorSource(undefined)).toBeNull();
    expect(resolveServerFetchedConnectorSource({})).toBeNull();
  });

  // The boolean form must stay DERIVED from the resolver, never a second copy
  // of the rule — a divergence would let one emission site claim a measurement
  // another site denies.
  it('agrees with isServerFetchedConnectorAnchor on every shape', () => {
    const shapes: Array<Record<string, unknown> | null | undefined> = [
      { connector_source: 'docusign', connector_artifact_id: 'cart_1' },
      { connector_source: 'docusign' },
      { connector_source: 'manual_upload', connector_artifact_id: 'cart_1' },
      { connector_artifact_id: 'cart_1' },
      {},
      null,
      undefined,
    ];
    for (const shape of shapes) {
      expect(isServerFetchedConnectorAnchor(shape)).toBe(
        resolveServerFetchedConnectorSource(shape) !== null,
      );
    }
  });
});

describe('isServerFetchedConnectorAnchor — fetch marker AND connector_artifact_id proof', () => {
  it('true only when a recognised fetch marker AND a connector_artifact_id are both present', () => {
    expect(
      isServerFetchedConnectorAnchor({ connector_source: 'docusign', connector_artifact_id: 'cart_1' }),
    ).toBe(true);
    expect(
      isServerFetchedConnectorAnchor({ connector_source: 'google_drive', connector_artifact_id: 'cart_2' }),
    ).toBe(true);
  });

  it('false for a DECLARED-hash anchor — fetch marker but NO connector_artifact_id (the dispatcher path)', () => {
    expect(isServerFetchedConnectorAnchor({ connector_source: 'docusign' })).toBe(false);
    expect(isServerFetchedConnectorAnchor({ connector_source: 'connector' })).toBe(false);
    // empty / non-string artifact id is not proof of a fetch
    expect(isServerFetchedConnectorAnchor({ connector_source: 'docusign', connector_artifact_id: '' })).toBe(false);
    expect(isServerFetchedConnectorAnchor({ connector_source: 'docusign', connector_artifact_id: 42 })).toBe(false);
  });

  it('false for upload-origin markers even with an artifact id (user-supplied bytes, reproducible)', () => {
    expect(
      isServerFetchedConnectorAnchor({ connector_source: 'manual_upload', connector_artifact_id: 'cart_3' }),
    ).toBe(false);
  });

  it('false for non-connector / missing metadata', () => {
    expect(isServerFetchedConnectorAnchor({ connector_artifact_id: 'cart_4' })).toBe(false);
    expect(isServerFetchedConnectorAnchor(null)).toBe(false);
    expect(isServerFetchedConnectorAnchor(undefined)).toBe(false);
    expect(isServerFetchedConnectorAnchor({})).toBe(false);
  });
});

describe('connectorFingerprintRederivabilityFieldsFor — the single gated emission helper', () => {
  it('returns the indivisible pair for a fetched connector anchor', () => {
    const fields = connectorFingerprintRederivabilityFieldsFor({
      connector_source: 'docusign',
      connector_artifact_id: 'cart_1',
    }) as Record<string, string>;
    expect(fields.fingerprint_rederivability).toBe(FINGERPRINT_REDERIVABILITY.FETCH_TIME_SNAPSHOT);
    expect(fields.fingerprint_rederivability_note).toBe(
      FINGERPRINT_REDERIVABILITY_NOTE[FINGERPRINT_REDERIVABILITY.FETCH_TIME_SNAPSHOT],
    );
  });

  it('returns an EMPTY object (omit, never null) for a declared-hash anchor', () => {
    expect(connectorFingerprintRederivabilityFieldsFor({ connector_source: 'docusign' })).toEqual({});
  });

  it('returns an EMPTY object for a non-connector anchor', () => {
    expect(connectorFingerprintRederivabilityFieldsFor(null)).toEqual({});
    expect(connectorFingerprintRederivabilityFieldsFor({})).toEqual({});
  });
});

describe('verify path: declared-hash anchor omits the caveat end-to-end (mapAnchorRow → buildVerificationResult)', () => {
  it('a declared-hash anchor (marker, no connector_artifact_id) yields NO re-derivability pair', () => {
    const result = buildVerificationResult(
      mapAnchorRow(createRow({ metadata: { connector_source: 'docusign' } })),
    );
    expect('fingerprint_rederivability' in result).toBe(false);
    expect('fingerprint_rederivability_note' in result).toBe(false);
  });

  it('a server-fetched anchor (marker + connector_artifact_id) yields the pair', () => {
    const result = buildVerificationResult(
      mapAnchorRow(
        createRow({ metadata: { connector_source: 'docusign', connector_artifact_id: 'cart_1' } }),
      ),
    );
    expect(result.fingerprint_rederivability).toBe(FINGERPRINT_REDERIVABILITY.FETCH_TIME_SNAPSHOT);
  });
});

describe('mapAnchorRow — server_fetched_connector_source derivation (fetch-evidence gated)', () => {
  it('derives server_fetched_connector_source for a server-FETCHED anchor (marker + connector_artifact_id)', () => {
    const anchor = mapAnchorRow(
      createRow({ metadata: { connector_source: 'docusign', connector_artifact_id: 'cart_1' } }),
    );
    expect(anchor.server_fetched_connector_source).toBe('docusign');
  });

  it('yields null for a DECLARED-hash anchor (marker present, NO connector_artifact_id)', () => {
    // rule-action-dispatcher.ts writes connector_source='docusign' but never
    // fetches — so it must not key the FETCH_TIME_SNAPSHOT "Measured…" claim.
    expect(
      mapAnchorRow(createRow({ metadata: { connector_source: 'docusign' } })).server_fetched_connector_source,
    ).toBeNull();
  });

  it('yields null for non-connector anchors and unrecognised markers', () => {
    expect(mapAnchorRow(createRow()).server_fetched_connector_source).toBeNull();
    expect(
      mapAnchorRow(
        createRow({ metadata: { connector_source: 'manual_upload', connector_artifact_id: 'cart_2' } }),
      ).server_fetched_connector_source,
    ).toBeNull();
  });
});

describe('buildVerificationResult — fingerprint_rederivability pair (§1.5 / §1.8)', () => {
  it('emits the class AND its note for a connector-sourced anchor', () => {
    const result = buildVerificationResult(createAnchor({ server_fetched_connector_source: 'google_drive' }));
    expect(result.fingerprint_rederivability).toBe(FINGERPRINT_REDERIVABILITY.FETCH_TIME_SNAPSHOT);
    expect(result.fingerprint_rederivability_note).toBe(
      FINGERPRINT_REDERIVABILITY_NOTE[FINGERPRINT_REDERIVABILITY.FETCH_TIME_SNAPSHOT],
    );
  });

  it('OMITS both fields (never null) for a client-uploaded / non-connector anchor — frozen schema §6', () => {
    const result = buildVerificationResult(createAnchor());
    expect('fingerprint_rederivability' in result).toBe(false);
    expect('fingerprint_rederivability_note' in result).toBe(false);
  });

  it('OMITS both fields when server_fetched_connector_source is absent (not measured — batch/oracle paths)', () => {
    const bare = createAnchor();
    delete (bare as unknown as Record<string, unknown>).server_fetched_connector_source;
    const result = buildVerificationResult(bare);
    expect('fingerprint_rederivability' in result).toBe(false);
  });

  it('the class never travels without its note, and vice versa', () => {
    const withPair = buildVerificationResult(createAnchor({ server_fetched_connector_source: 'docusign' }));
    expect(withPair.fingerprint_rederivability !== undefined).toBe(
      withPair.fingerprint_rederivability_note !== undefined,
    );
  });

  it('EMPTY_API_RICH_FIELDS stays silent — server_fetched_connector_source null emits nothing', () => {
    expect(EMPTY_API_RICH_FIELDS.server_fetched_connector_source).toBeNull();
    const result = buildVerificationResult(createAnchor({ ...EMPTY_API_RICH_FIELDS }));
    expect('fingerprint_rederivability' in result).toBe(false);
  });
});

describe('the note — fixed prose, §1.5 triad, no metadata echo, no overclaim in either direction', () => {
  const note = FINGERPRINT_REDERIVABILITY_NOTE[FINGERPRINT_REDERIVABILITY.FETCH_TIME_SNAPSHOT];

  it('carries the measured / asserted / NOT-asserted triad', () => {
    expect(note).toContain('Measured:');
    expect(note).toContain('Asserted:');
    expect(note).toContain('Not asserted:');
  });

  it('states the re-fetch caveat without weakening the anchor claim', () => {
    // The caveat: re-fetching is NOT expected to reproduce the fingerprint.
    expect(note.toLowerCase()).toContain('not asserted: that retrieving the same document');
    // The strength: the exact fetched bytes ARE committed.
    expect(note.toLowerCase()).toContain('exact bytes');
    // A mismatch on a re-fetched copy must not read as evidence of tampering.
    expect(note.toLowerCase()).toContain('not, by itself, evidence');
  });

  it('distinguishes the client-upload case (§1.6) where re-hashing the retained file reproduces the fingerprint', () => {
    expect(note.toLowerCase()).toContain('client-uploaded');
  });

  it('never echoes a vendor-identifying marker — spoofed metadata must not become a vendor provenance claim (R-7)', () => {
    // 'connector' is excluded: it is a generic word the fixed prose may use
    // ("connector-sourced"), not a vendor identity. The vendor markers are the
    // ones a spoofer could launder into "this came out of DocuSign".
    for (const marker of ['docusign', 'google_drive', 'microsoft_365']) {
      expect(note.toLowerCase()).not.toContain(marker);
    }
    expect(note).not.toMatch(/DocuSign|Google Drive|Microsoft/i);
  });

  it('the field pair helper is indivisible', () => {
    const pair = connectorFingerprintRederivabilityFields();
    expect(pair.fingerprint_rederivability).toBe(FINGERPRINT_REDERIVABILITY.FETCH_TIME_SNAPSHOT);
    expect(pair.fingerprint_rederivability_note).toBe(note);
  });
});

describe('buildProofResponse — the /proof response carries the pair; the signed bundle is untouched', () => {
  const FP_A = 'aa'.repeat(32);
  const FP_B = 'bb'.repeat(32);
  const FP_C = 'cc'.repeat(32);
  const tree = buildMerkleTree([FP_A, FP_B, FP_C]);

  // Bitcoin genesis block header — a REAL 80-byte header (160 hex), so the
  // bundle producer emits a complete bundle (mirrors verify-proof.bundle-producer.test.ts).
  const GENESIS_HEADER =
    '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
  const GENESIS_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

  const storedProof = {
    merkle_root: tree.root,
    proof_path: tree.proofs.get(FP_A),
    batch_id: 'batch_1751760000000_3',
    merkle_index: 0,
    block_header: `\\x${GENESIS_HEADER}`,
    block_hash: GENESIS_HASH,
    op_return_payload: `\\x41524b56${tree.root}`,
    proof_schema_version: 1,
  };

  const baseAnchor = {
    public_id: 'ARK-2026-CONN-002',
    fingerprint: FP_A,
    status: 'SECURED',
    chain_tx_id: 'f1'.repeat(32),
    chain_block_height: 800100,
    chain_timestamp: '2026-07-06T00:00:00.000Z',
    metadata: null as Record<string, unknown> | null,
  };

  it('emits the pair top-level for a server-fetched connector anchor', () => {
    const resp = buildProofResponse(
      { ...baseAnchor, metadata: { connector_source: 'docusign', connector_artifact_id: 'cart_1' } },
      storedProof,
      3,
    ) as MerkleProofResponse;
    expect(resp).not.toBeNull();
    expect(resp.fingerprint_rederivability).toBe(FINGERPRINT_REDERIVABILITY.FETCH_TIME_SNAPSHOT);
    expect(resp.fingerprint_rederivability_note).toBe(
      FINGERPRINT_REDERIVABILITY_NOTE[FINGERPRINT_REDERIVABILITY.FETCH_TIME_SNAPSHOT],
    );
  });

  it('never places the pair inside the signed proof_bundle', () => {
    const resp = buildProofResponse(
      { ...baseAnchor, metadata: { connector_source: 'docusign', connector_artifact_id: 'cart_1' } },
      storedProof,
      3,
    ) as MerkleProofResponse;
    expect(resp.proof_bundle).not.toBeNull();
    const bundleKeys = Object.keys(resp.proof_bundle as unknown as Record<string, unknown>);
    expect(bundleKeys).not.toContain('fingerprint_rederivability');
    expect(bundleKeys).not.toContain('fingerprint_rederivability_note');
  });

  it('omits the pair for a non-connector anchor', () => {
    const resp = buildProofResponse(baseAnchor, storedProof, 3) as MerkleProofResponse;
    expect(resp).not.toBeNull();
    expect('fingerprint_rederivability' in resp).toBe(false);
    expect('fingerprint_rederivability_note' in resp).toBe(false);
  });

  it('omits the pair for an upload-origin connector_artifact marker', () => {
    const resp = buildProofResponse(
      { ...baseAnchor, metadata: { connector_source: 'manual_upload' } },
      storedProof,
      3,
    ) as MerkleProofResponse;
    expect('fingerprint_rederivability' in resp).toBe(false);
  });

  // Declared-hash rules path (rule-action-dispatcher.ts): connector_source is a
  // fetch marker BUT there is no connector_artifact_id — the hash was DECLARED by
  // DocuSign, never fetched/measured by Arkova. FETCH_TIME_SNAPSHOT ("Measured:
  // Arkova computed…") would be a false measurement claim (§1.5 / R-7). Silence.
  it('omits the pair for a declared-hash anchor (connector marker, NO connector_artifact_id)', () => {
    const resp = buildProofResponse(
      { ...baseAnchor, metadata: { connector_source: 'docusign' } },
      storedProof,
      3,
    ) as MerkleProofResponse;
    expect('fingerprint_rederivability' in resp).toBe(false);
    expect('fingerprint_rederivability_note' in resp).toBe(false);
  });

  it('emits the pair for a server-FETCHED anchor (connector marker + connector_artifact_id)', () => {
    const resp = buildProofResponse(
      { ...baseAnchor, metadata: { connector_source: 'docusign', connector_artifact_id: 'cart_1' } },
      storedProof,
      3,
    ) as MerkleProofResponse;
    expect(resp.fingerprint_rederivability).toBe(FINGERPRINT_REDERIVABILITY.FETCH_TIME_SNAPSHOT);
  });
});
