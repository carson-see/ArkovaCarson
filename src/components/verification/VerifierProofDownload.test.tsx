/**
 * VerifierProofDownload Tests
 *
 * @see UF-07
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VerifierProofDownload } from './VerifierProofDownload';

// Mock URL.createObjectURL
const mockCreateObjectURL = vi.fn().mockReturnValue('blob:test');
const mockRevokeObjectURL = vi.fn();
Object.assign(URL, {
  createObjectURL: mockCreateObjectURL,
  revokeObjectURL: mockRevokeObjectURL,
});

beforeEach(() => {
  vi.clearAllMocks();
});

const PROPS = {
  publicId: 'ARK-2024-00091',
  fingerprint: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  status: 'SECURED',
  issuerName: 'UMich Registrar',
  credentialType: 'DEGREE',
  filename: 'diploma.pdf',
  securedAt: '2024-05-22T18:43:11Z',
  networkReceiptId: 'b7f3a9d2e1c8...',
};

async function withMockDownloadAnchor(run: (mockClick: ReturnType<typeof vi.fn>) => Promise<void>) {
  const original = document.createElement.bind(document);
  const mockClick = vi.fn();
  const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: ElementCreationOptions) => {
    if (tag === 'a') {
      return { href: '', download: '', click: mockClick, setAttribute: vi.fn() } as unknown as HTMLAnchorElement;
    }
    return original(tag, options);
  });

  try {
    await run(mockClick);
  } finally {
    spy.mockRestore();
  }
}

describe('VerifierProofDownload', () => {
  it('renders download button for SECURED anchors', () => {
    render(<VerifierProofDownload {...PROPS} />);
    expect(screen.getByText('JSON Proof Package')).toBeInTheDocument();
  });

  it('returns null for PENDING anchors', () => {
    const { container } = render(
      <VerifierProofDownload {...PROPS} status="PENDING" />
    );
    expect(container.firstChild).toBeNull();
  });

  it('returns null for SUBMITTED anchors', () => {
    const { container } = render(
      <VerifierProofDownload {...PROPS} status="SUBMITTED" />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders for ACTIVE alias anchors', () => {
    const { container } = render(
      <VerifierProofDownload {...PROPS} status="ACTIVE" />
    );
    expect(container.firstChild).not.toBeNull();
    expect(screen.getByText('JSON Proof Package')).toBeInTheDocument();
  });

  it('renders for REVOKED anchors', () => {
    render(<VerifierProofDownload {...PROPS} status="REVOKED" />);
    expect(screen.getByText('JSON Proof Package')).toBeInTheDocument();
  });

  it('triggers JSON download on click', async () => {
    await withMockDownloadAnchor(async mockClick => {
      render(<VerifierProofDownload {...PROPS} />);
      fireEvent.click(screen.getByText('JSON Proof Package'));

      await waitFor(() => expect(mockCreateObjectURL).toHaveBeenCalled());
      expect(mockClick).toHaveBeenCalled();
    });
  });

  it('normalizes ACTIVE alias in downloaded JSON proof', async () => {
    await withMockDownloadAnchor(async () => {
      render(<VerifierProofDownload {...PROPS} status="ACTIVE" />);
      fireEvent.click(screen.getByText('JSON Proof Package'));

      await waitFor(() => expect(mockCreateObjectURL).toHaveBeenCalled());
      const [blob] = mockCreateObjectURL.mock.calls[0] as [Blob];
      const proof = JSON.parse(await blob.text()) as { status: string };
      expect(proof.status).toBe('SECURED');
    });
  });

  it('uses the CSI-03 proof schema version when provenance fields are included', async () => {
    await withMockDownloadAnchor(async () => {
      render(
        <VerifierProofDownload
          {...PROPS}
          sourceProvenance={{
            evidence_package_hash: 'evidence-hash-123',
            source_payload_hash: 'payload-hash-456',
            source_url: 'https://example.com/cert?id=visible&code=secret-code&state=secret-state',
          }}
        />
      );
      fireEvent.click(screen.getByText('JSON Proof Package'));

      await waitFor(() => expect(mockCreateObjectURL).toHaveBeenCalled());
      const [blob] = mockCreateObjectURL.mock.calls[0] as [Blob];
      const proof = JSON.parse(await blob.text()) as {
        version: string;
        evidence_package_hash: string;
        source_payload_hash: string;
        source_url: string;
      };
      expect(proof.version).toBe('1.1');
      expect(proof.evidence_package_hash).toBe('evidence-hash-123');
      expect(proof.source_payload_hash).toBe('payload-hash-456');
      expect(proof.source_url).toBe('https://example.com/cert?id=visible');
    });
  });

  it('shows download section title', () => {
    render(<VerifierProofDownload {...PROPS} />);
    expect(screen.getByText('Download Proof')).toBeInTheDocument();
  });
});
