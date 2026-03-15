/**
 * VerifierProofDownload Tests
 *
 * @see UF-07
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('renders for REVOKED anchors', () => {
    render(<VerifierProofDownload {...PROPS} status="REVOKED" />);
    expect(screen.getByText('JSON Proof Package')).toBeInTheDocument();
  });

  it('triggers JSON download on click', () => {
    // Spy on createElement but delegate to the real implementation for non-'a' elements
    const original = document.createElement.bind(document);
    const mockClick = vi.fn();
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: ElementCreationOptions) => {
      if (tag === 'a') {
        return { href: '', download: '', click: mockClick, setAttribute: vi.fn() } as unknown as HTMLAnchorElement;
      }
      return original(tag, options);
    });

    try {
      render(<VerifierProofDownload {...PROPS} />);
      fireEvent.click(screen.getByText('JSON Proof Package'));

      expect(mockCreateObjectURL).toHaveBeenCalled();
      expect(mockClick).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('shows download section title', () => {
    render(<VerifierProofDownload {...PROPS} />);
    expect(screen.getByText('Download Proof')).toBeInTheDocument();
  });
});
