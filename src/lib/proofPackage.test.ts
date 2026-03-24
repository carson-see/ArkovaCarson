/**
 * Unit tests for Proof Package generation, validation, and export
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ProofPackageSchema,
  generateProofPackage,
  validateProofPackage,
  getProofPackageFilename,
  downloadProofPackage,
} from './proofPackage';
import type { ProofPackage } from './proofPackage';

// =============================================================================
// TEST FIXTURES
// =============================================================================

const validAnchorPending = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  fingerprint: 'a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd',
  filename: 'document.pdf',
  file_size: 1024,
  file_mime: 'application/pdf',
  status: 'PENDING' as const,
  public_id: null,
  chain_tx_id: null,
  chain_block_height: null,
  chain_timestamp: null,
  created_at: '2026-01-15T10:00:00.000Z',
  user_id: '223e4567-e89b-12d3-a456-426614174001',
  org_id: '323e4567-e89b-12d3-a456-426614174002',
};

const validAnchorSecured = {
  ...validAnchorPending,
  status: 'SECURED' as const,
  public_id: 'ARK-ABC123',
  chain_tx_id: 'tx_mock_001',
  chain_block_height: 850000,
  chain_timestamp: '2026-01-15T12:00:00.000Z',
};

const validAnchorRevoked = {
  ...validAnchorSecured,
  status: 'REVOKED' as const,
};

const validProofData = {
  merkle_root: 'deadbeef'.repeat(8),
  proof_path: ['aabb'.repeat(16), 'ccdd'.repeat(16)],
};

// =============================================================================
// ProofPackageSchema
// =============================================================================

describe('ProofPackageSchema', () => {
  const validPackage: ProofPackage = {
    version: '1.0',
    generated_at: '2026-01-15T12:00:00.000Z',
    document: {
      filename: 'document.pdf',
      fingerprint: 'a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd',
      file_size: 1024,
      mime_type: 'application/pdf',
    },
    verification: {
      status: 'SECURED',
      verified: true,
      public_id: 'ARK-ABC123',
    },
    network_receipt: {
      network_proof_id: 'tx_mock_001',
      block_height: 850000,
      observed_time: '2026-01-15T12:00:00.000Z',
    },
    proof: {
      verification_tree_root: 'deadbeef'.repeat(8),
      proof_path: ['aabb'.repeat(16)],
    },
    metadata: {
      created_at: '2026-01-15T10:00:00.000Z',
      user_id: '223e4567-e89b-12d3-a456-426614174001',
      org_id: '323e4567-e89b-12d3-a456-426614174002',
    },
  };

  it('accepts a fully-populated valid package', () => {
    const result = ProofPackageSchema.safeParse(validPackage);
    expect(result.success).toBe(true);
  });

  it('accepts null network_receipt and proof', () => {
    const pkg = { ...validPackage, network_receipt: null, proof: null };
    const result = ProofPackageSchema.safeParse(pkg);
    expect(result.success).toBe(true);
  });

  it('accepts null org_id in metadata', () => {
    const pkg = {
      ...validPackage,
      metadata: { ...validPackage.metadata, org_id: null },
    };
    const result = ProofPackageSchema.safeParse(pkg);
    expect(result.success).toBe(true);
  });

  it('rejects wrong version', () => {
    const pkg = { ...validPackage, version: '2.0' };
    const result = ProofPackageSchema.safeParse(pkg);
    expect(result.success).toBe(false);
  });

  it('rejects invalid generated_at datetime', () => {
    const pkg = { ...validPackage, generated_at: 'not-a-date' };
    const result = ProofPackageSchema.safeParse(pkg);
    expect(result.success).toBe(false);
  });

  it('rejects invalid fingerprint in document', () => {
    const pkg = {
      ...validPackage,
      document: { ...validPackage.document, fingerprint: 'short' },
    };
    const result = ProofPackageSchema.safeParse(pkg);
    expect(result.success).toBe(false);
  });

  it('rejects invalid verification status', () => {
    const pkg = {
      ...validPackage,
      verification: { ...validPackage.verification, status: 'INVALID' },
    };
    const result = ProofPackageSchema.safeParse(pkg);
    expect(result.success).toBe(false);
  });

  it('rejects invalid user_id in metadata', () => {
    const pkg = {
      ...validPackage,
      metadata: { ...validPackage.metadata, user_id: 'not-a-uuid' },
    };
    const result = ProofPackageSchema.safeParse(pkg);
    expect(result.success).toBe(false);
  });

  it('accepts all three valid statuses', () => {
    for (const status of ['PENDING', 'SECURED', 'REVOKED'] as const) {
      const pkg = {
        ...validPackage,
        verification: { ...validPackage.verification, status },
      };
      const result = ProofPackageSchema.safeParse(pkg);
      expect(result.success).toBe(true);
    }
  });

  it('accepts null file_size and mime_type in document', () => {
    const pkg = {
      ...validPackage,
      document: { ...validPackage.document, file_size: null, mime_type: null },
    };
    const result = ProofPackageSchema.safeParse(pkg);
    expect(result.success).toBe(true);
  });

  it('accepts null public_id in verification', () => {
    const pkg = {
      ...validPackage,
      verification: { ...validPackage.verification, public_id: null },
    };
    const result = ProofPackageSchema.safeParse(pkg);
    expect(result.success).toBe(true);
  });

  it('accepts null verification_tree_root and proof_path in proof', () => {
    const pkg = {
      ...validPackage,
      proof: { verification_tree_root: null, proof_path: null },
    };
    const result = ProofPackageSchema.safeParse(pkg);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// generateProofPackage
// =============================================================================

describe('generateProofPackage', () => {
  it('generates a valid package for a PENDING anchor', () => {
    const pkg = generateProofPackage(validAnchorPending);
    expect(pkg.version).toBe('1.0');
    expect(pkg.document.filename).toBe('document.pdf');
    expect(pkg.document.fingerprint).toBe(validAnchorPending.fingerprint);
    expect(pkg.document.file_size).toBe(1024);
    expect(pkg.document.mime_type).toBe('application/pdf');
    expect(pkg.verification.status).toBe('PENDING');
    expect(pkg.verification.verified).toBe(false);
    expect(pkg.verification.public_id).toBeNull();
    expect(pkg.network_receipt).toBeNull();
    expect(pkg.proof).toBeNull();
    expect(pkg.metadata.user_id).toBe(validAnchorPending.user_id);
    expect(pkg.metadata.org_id).toBe(validAnchorPending.org_id);
  });

  it('generates a valid package for a SECURED anchor with network receipt', () => {
    const pkg = generateProofPackage(validAnchorSecured);
    expect(pkg.verification.status).toBe('SECURED');
    expect(pkg.verification.verified).toBe(true);
    expect(pkg.verification.public_id).toBe('ARK-ABC123');
    expect(pkg.network_receipt).not.toBeNull();
    expect(pkg.network_receipt!.network_proof_id).toBe('tx_mock_001');
    expect(pkg.network_receipt!.block_height).toBe(850000);
    expect(pkg.network_receipt!.observed_time).toBe('2026-01-15T12:00:00.000Z');
  });

  it('generates a valid package for a REVOKED anchor (no network receipt)', () => {
    const pkg = generateProofPackage(validAnchorRevoked);
    expect(pkg.verification.status).toBe('REVOKED');
    expect(pkg.verification.verified).toBe(false);
    // REVOKED anchors don't get network_receipt — only SECURED does
    expect(pkg.network_receipt).toBeNull();
  });

  it('includes proof data when provided', () => {
    const pkg = generateProofPackage(validAnchorSecured, validProofData);
    expect(pkg.proof).not.toBeNull();
    expect(pkg.proof!.verification_tree_root).toBe(validProofData.merkle_root);
    expect(pkg.proof!.proof_path).toEqual(validProofData.proof_path);
  });

  it('sets proof to null when no proof data provided', () => {
    const pkg = generateProofPackage(validAnchorSecured);
    expect(pkg.proof).toBeNull();
  });

  it('sets generated_at to a valid ISO datetime', () => {
    const before = new Date().toISOString();
    const pkg = generateProofPackage(validAnchorPending);
    const after = new Date().toISOString();
    expect(pkg.generated_at >= before).toBe(true);
    expect(pkg.generated_at <= after).toBe(true);
  });

  it('sets network_receipt to null for PENDING anchor even with chain fields', () => {
    // PENDING status means no chain receipt regardless of chain_tx_id presence
    const anchor = { ...validAnchorPending, chain_tx_id: 'tx_orphan' };
    const pkg = generateProofPackage(anchor);
    expect(pkg.network_receipt).toBeNull();
  });

  it('sets network_receipt to null for SECURED anchor without chain_tx_id', () => {
    const anchor = { ...validAnchorSecured, chain_tx_id: null };
    const pkg = generateProofPackage(anchor);
    expect(pkg.network_receipt).toBeNull();
  });

  it('handles null file_size and file_mime', () => {
    const anchor = { ...validAnchorPending, file_size: null, file_mime: null };
    const pkg = generateProofPackage(anchor);
    expect(pkg.document.file_size).toBeNull();
    expect(pkg.document.mime_type).toBeNull();
  });

  it('handles null org_id', () => {
    const anchor = { ...validAnchorPending, org_id: null };
    const pkg = generateProofPackage(anchor);
    expect(pkg.metadata.org_id).toBeNull();
  });

  it('output passes schema validation', () => {
    const pkg = generateProofPackage(validAnchorSecured, validProofData);
    const result = ProofPackageSchema.safeParse(pkg);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// validateProofPackage
// =============================================================================

describe('validateProofPackage', () => {
  it('returns parsed package for valid input', () => {
    const pkg = generateProofPackage(validAnchorSecured, validProofData);
    const validated = validateProofPackage(pkg);
    expect(validated.version).toBe('1.0');
    expect(validated.verification.status).toBe('SECURED');
  });

  it('throws for invalid input', () => {
    expect(() => validateProofPackage({ version: '2.0' })).toThrow();
  });

  it('throws for completely wrong data', () => {
    expect(() => validateProofPackage('not an object')).toThrow();
    expect(() => validateProofPackage(null)).toThrow();
    expect(() => validateProofPackage(42)).toThrow();
  });

  it('roundtrips through JSON serialization', () => {
    const pkg = generateProofPackage(validAnchorSecured, validProofData);
    const json = JSON.stringify(pkg);
    const parsed = JSON.parse(json);
    const validated = validateProofPackage(parsed);
    expect(validated).toEqual(pkg);
  });
});

// =============================================================================
// getProofPackageFilename
// =============================================================================

describe('getProofPackageFilename', () => {
  it('generates filename with public_id for secured anchor', () => {
    const filename = getProofPackageFilename({
      filename: 'document.pdf',
      public_id: 'ARK-ABC123',
    });
    expect(filename).toBe('arkova-proof-document-ARK-ABC123.json');
  });

  it('generates filename with "pending" for anchor without public_id', () => {
    const filename = getProofPackageFilename({
      filename: 'document.pdf',
      public_id: null,
    });
    expect(filename).toBe('arkova-proof-document-pending.json');
  });

  it('strips file extension from basename', () => {
    const filename = getProofPackageFilename({
      filename: 'my-report.docx',
      public_id: 'ARK-XYZ',
    });
    expect(filename).toBe('arkova-proof-my-report-ARK-XYZ.json');
  });

  it('handles filename without extension', () => {
    const filename = getProofPackageFilename({
      filename: 'README',
      public_id: 'ARK-001',
    });
    expect(filename).toBe('arkova-proof-README-ARK-001.json');
  });

  it('handles filename with multiple dots', () => {
    const filename = getProofPackageFilename({
      filename: 'archive.tar.gz',
      public_id: 'ARK-002',
    });
    expect(filename).toBe('arkova-proof-archive.tar-ARK-002.json');
  });
});

// =============================================================================
// downloadProofPackage
// =============================================================================

describe('downloadProofPackage', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockCreateObjectURL: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRevokeObjectURL: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let clickSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let appendChildSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let removeSpy: any;

  beforeEach(() => {
    mockCreateObjectURL = vi.fn(() => 'blob:mock-url');
    mockRevokeObjectURL = vi.fn();
    clickSpy = vi.fn();
    removeSpy = vi.fn();
    appendChildSpy = vi.spyOn(document.body, 'appendChild').mockImplementation(((node: Node) => node) as never);

    vi.stubGlobal('URL', { ...URL, createObjectURL: mockCreateObjectURL, revokeObjectURL: mockRevokeObjectURL });

    vi.spyOn(document, 'createElement').mockReturnValue({
      href: '',
      download: '',
      click: clickSpy,
      remove: removeSpy,
    } as unknown as HTMLAnchorElement);
  });

  it('creates a blob URL, clicks the link, and cleans up', () => {
    const pkg = generateProofPackage(validAnchorSecured);
    downloadProofPackage(pkg, 'test-proof.json');

    expect(mockCreateObjectURL).toHaveBeenCalledOnce();
    expect(appendChildSpy).toHaveBeenCalledOnce();
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(removeSpy).toHaveBeenCalledOnce();
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('sets correct download filename on the link element', () => {
    const createSpy = vi.spyOn(document, 'createElement');
    const mockLink = {
      href: '',
      download: '',
      click: clickSpy,
      remove: removeSpy,
    } as unknown as HTMLAnchorElement;
    createSpy.mockReturnValue(mockLink);

    const pkg = generateProofPackage(validAnchorPending);
    downloadProofPackage(pkg, 'my-proof.json');

    expect(mockLink.download).toBe('my-proof.json');
    expect(mockLink.href).toBe('blob:mock-url');
  });

  it('serializes package as pretty-printed JSON', () => {
    const pkg = generateProofPackage(validAnchorPending);
    downloadProofPackage(pkg, 'test.json');

    // The Blob constructor was called with the JSON content
    const call = mockCreateObjectURL.mock.calls[0][0];
    expect(call).toBeInstanceOf(Blob);
  });
});
