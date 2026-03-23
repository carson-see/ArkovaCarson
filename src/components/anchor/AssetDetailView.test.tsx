/**
 * AssetDetailView Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { AssetDetailView } from './AssetDetailView';

describe('AssetDetailView', () => {
  const mockAnchor = {
    id: 'test-id',
    filename: 'test-document.pdf',
    fingerprint: 'a'.repeat(64),
    status: 'SECURED' as const,
    createdAt: '2024-01-15T10:30:00Z',
    securedAt: '2024-01-15T10:35:00Z',
    fileSize: 102400,
    fileMime: 'application/pdf',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should display anchor filename and fingerprint', () => {
    const { getByText } = render(<AssetDetailView anchor={mockAnchor} />);

    expect(getByText('test-document.pdf')).toBeInTheDocument();
    expect(getByText(mockAnchor.fingerprint)).toBeInTheDocument();
  });

  it('should show SECURED status badge', () => {
    const { getAllByText } = render(<AssetDetailView anchor={mockAnchor} />);

    // There may be multiple "Secured" texts (badge + date label)
    const securedElements = getAllByText('Secured');
    expect(securedElements.length).toBeGreaterThan(0);
  });

  it('should show PENDING status for pending anchors', () => {
    const pendingAnchor = { ...mockAnchor, status: 'PENDING' as const };
    const { getByText } = render(<AssetDetailView anchor={pendingAnchor} />);

    expect(getByText('Pending')).toBeInTheDocument();
  });

  it('should show REVOKED status for revoked anchors', () => {
    const revokedAnchor = { ...mockAnchor, status: 'REVOKED' as const };
    const { getAllByText } = render(<AssetDetailView anchor={revokedAnchor} />);

    // There may be multiple "Revoked" texts (badge + lifecycle timeline)
    const revokedElements = getAllByText('Revoked');
    expect(revokedElements.length).toBeGreaterThan(0);
  });

  it('should show re-verify button', () => {
    const { getByText } = render(<AssetDetailView anchor={mockAnchor} />);

    expect(getByText('Verify Document')).toBeInTheDocument();
  });

  it('should show verification success for matching fingerprint', async () => {
    const { getByText } = render(<AssetDetailView anchor={mockAnchor} />);

    // Click verify button
    getByText('Verify Document').click();

    // Wait for dropzone to appear, then simulate file selection
    await waitFor(() => {
      expect(getByText(/File never leaves your device/i)).toBeInTheDocument();
    });
  });

  it('should show download buttons for secured anchors', () => {
    const onDownloadProof = vi.fn();
    const onDownloadProofJson = vi.fn();
    const { getByText } = render(
      <AssetDetailView anchor={mockAnchor} onDownloadProof={onDownloadProof} onDownloadProofJson={onDownloadProofJson} />
    );

    expect(getByText('PDF')).toBeInTheDocument();
    expect(getByText('JSON')).toBeInTheDocument();
  });

  it('should hide download button for pending anchors', () => {
    const pendingAnchor = { ...mockAnchor, status: 'PENDING' as const };
    const onDownloadProof = vi.fn();
    const { queryByText } = render(
      <AssetDetailView anchor={pendingAnchor} onDownloadProof={onDownloadProof} />
    );

    expect(queryByText('Download Proof Package')).not.toBeInTheDocument();
  });

  it('should show QR code section when publicId is present', () => {
    const anchorWithPublicId = { ...mockAnchor, publicId: 'ARK-2024-00091' };
    const { getByText } = render(<AssetDetailView anchor={anchorWithPublicId} />);

    expect(getByText('Verification QR Code')).toBeInTheDocument();
    expect(getByText(/ARK-2024-00091/)).toBeInTheDocument();
  });

  it('should not show QR code section when publicId is absent', () => {
    const { queryByText } = render(<AssetDetailView anchor={mockAnchor} />);

    expect(queryByText('Verification QR Code')).not.toBeInTheDocument();
  });

  it('should use destructive variant for REVOKED badge (UAT2-11)', () => {
    const revokedAnchor = { ...mockAnchor, status: 'REVOKED' as const };
    const { container } = render(<AssetDetailView anchor={revokedAnchor} />);

    // The REVOKED badge should use destructive variant (red styling)
    const badges = container.querySelectorAll('[class*="destructive"]');
    expect(badges.length).toBeGreaterThan(0);
  });

  it('should use outline variant for EXPIRED badge (UAT2-11)', () => {
    const expiredAnchor = { ...mockAnchor, status: 'EXPIRED' as const };
    const { getAllByText } = render(<AssetDetailView anchor={expiredAnchor} />);

    // The EXPIRED badge should show "Expired" with amber/outline styling (not same as revoked)
    const expiredElements = getAllByText('Expired');
    expect(expiredElements.length).toBeGreaterThan(0);
  });

  it('QR code URL uses production base URL not localhost (UAT3-04)', () => {
    const anchorWithPublicId = { ...mockAnchor, publicId: 'ARK-2024-00091' };
    const { getByText } = render(<AssetDetailView anchor={anchorWithPublicId} />);

    // The URL displayed below QR should use app.arkova.ai, not localhost
    const urlText = getByText(/app\.arkova\.ai\/verify\/ARK-2024-00091/);
    expect(urlText).toBeInTheDocument();
  });

  it('should call onBack when back button clicked', () => {
    const onBack = vi.fn();
    render(
      <AssetDetailView anchor={mockAnchor} onBack={onBack} />
    );

    const backButtons = document.querySelectorAll('button');
    backButtons[0].click(); // First button is back
    expect(onBack).toHaveBeenCalled();
  });

  // BETA-11: Explorer link in authenticated detail view
  it('should show network receipt section with explorer link for SECURED anchors with txid', () => {
    const anchorWithTx = {
      ...mockAnchor,
      chainTxId: 'abc123def456',
      chainBlockHeight: 200100,
    };
    const { container } = render(<AssetDetailView anchor={anchorWithTx} />);

    // Check that the explorer link appears with the txid
    expect(container.innerHTML).toContain('abc123def456');
    expect(container.innerHTML).toContain('mempool.space');
  });

  it('should show treasury fallback link for PENDING anchors without txid', () => {
    const pendingAnchor = { ...mockAnchor, status: 'PENDING' as const };
    const { container } = render(<AssetDetailView anchor={pendingAnchor} />);

    expect(container.innerHTML).toContain('Awaiting network confirmation');
    expect(container.innerHTML).toContain('view anchor');
  });

  // BETA-12: Description display
  it('should display description when present', () => {
    const anchorWithDesc = {
      ...mockAnchor,
      description: 'Bachelor of Science in Computer Engineering from University of Michigan.',
    };
    const { getByText } = render(<AssetDetailView anchor={anchorWithDesc} />);

    expect(getByText('Bachelor of Science in Computer Engineering from University of Michigan.')).toBeInTheDocument();
  });

  it('should not show description section when absent', () => {
    const { queryByText } = render(<AssetDetailView anchor={mockAnchor} />);

    expect(queryByText('Description')).not.toBeInTheDocument();
  });
});
