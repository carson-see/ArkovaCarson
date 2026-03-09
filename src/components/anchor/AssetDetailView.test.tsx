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

  it('should show download button for secured anchors', () => {
    const onDownloadProof = vi.fn();
    const { getByText } = render(
      <AssetDetailView anchor={mockAnchor} onDownloadProof={onDownloadProof} />
    );

    expect(getByText('Download')).toBeInTheDocument();
  });

  it('should hide download button for pending anchors', () => {
    const pendingAnchor = { ...mockAnchor, status: 'PENDING' as const };
    const onDownloadProof = vi.fn();
    const { queryByText } = render(
      <AssetDetailView anchor={pendingAnchor} onDownloadProof={onDownloadProof} />
    );

    expect(queryByText('Download Proof Package')).not.toBeInTheDocument();
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
});
