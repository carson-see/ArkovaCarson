/**
 * AssetDetailView — connector-sourced fingerprint caveat
 * (BUG-2026-08-13-010, §1.5 / §1.6A).
 *
 * The re-verify flow compares a dropped file's fingerprint against the
 * record. For a connector-sourced anchor, downloading the document from the
 * source again can legitimately produce different bytes (source systems may
 * regenerate the file per request), so the UI must state the caveat up front
 * and must not let a mismatch read as tampering on its own. Client-uploaded
 * anchors must NOT show the caveat — re-hashing the retained file reproduces
 * their fingerprint.
 *
 * FileUpload is mocked so the mismatch state can be driven deterministically
 * (the real component computes fingerprints from actual file bytes).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AssetDetailView } from './AssetDetailView';
import { CONNECTOR_FINGERPRINT_LABELS } from '@/lib/copy';

vi.mock('./FileUpload', () => ({
  FileUpload: ({ onFileSelect }: { onFileSelect: (file: File, fingerprint: string) => void }) => (
    <button
      data-testid="mock-file-upload"
      onClick={() =>
        onFileSelect(new File(['re-fetched bytes'], 'refetched.pdf'), 'f'.repeat(64))
      }
    >
      mock-upload
    </button>
  ),
}));

const baseAnchor = {
  id: 'test-id',
  filename: 'signed-contract.pdf',
  fingerprint: 'a'.repeat(64),
  status: 'SECURED' as const,
  createdAt: '2026-08-01T10:30:00Z',
  securedAt: '2026-08-01T10:35:00Z',
  fileSize: 102400,
  fileMime: 'application/pdf',
};

const connectorAnchor = {
  ...baseAnchor,
  metadata: { connector_source: 'docusign', external_ref: 'env-123' },
};

describe('AssetDetailView — connector-sourced re-verify caveat', () => {
  it('shows the fetch-time caveat in the re-verify section for a connector-sourced anchor', () => {
    render(<AssetDetailView anchor={connectorAnchor} />);
    const note = screen.getByTestId('connector-fingerprint-reverify-note');
    expect(note).toHaveTextContent(CONNECTOR_FINGERPRINT_LABELS.REVERIFY_NOTE);
  });

  it('does NOT show the caveat for a client-uploaded anchor', () => {
    render(<AssetDetailView anchor={baseAnchor} />);
    expect(screen.queryByTestId('connector-fingerprint-reverify-note')).toBeNull();
  });

  it('does NOT show the caveat for an upload-origin connector_artifact marker', () => {
    render(
      <AssetDetailView
        anchor={{ ...baseAnchor, metadata: { connector_source: 'manual_upload' } }}
      />,
    );
    expect(screen.queryByTestId('connector-fingerprint-reverify-note')).toBeNull();
  });

  it('adds the connector hint to the mismatch alert for a connector-sourced anchor', async () => {
    render(<AssetDetailView anchor={connectorAnchor} />);

    screen.getByText('Verify Document').click();
    await waitFor(() => {
      expect(screen.getByTestId('mock-file-upload')).toBeInTheDocument();
    });
    screen.getByTestId('mock-file-upload').click();

    await waitFor(() => {
      expect(screen.getByTestId('connector-fingerprint-mismatch-hint')).toHaveTextContent(
        CONNECTOR_FINGERPRINT_LABELS.REVERIFY_MISMATCH_HINT,
      );
    });
  });

  it('mismatch alert carries NO connector hint for a client-uploaded anchor', async () => {
    render(<AssetDetailView anchor={baseAnchor} />);

    screen.getByText('Verify Document').click();
    await waitFor(() => {
      expect(screen.getByTestId('mock-file-upload')).toBeInTheDocument();
    });
    screen.getByTestId('mock-file-upload').click();

    // The mismatch alert itself must render (fingerprints differ)...
    await waitFor(() => {
      expect(screen.getByText(/Verification Failed/i)).toBeInTheDocument();
    });
    // ...but without the connector caveat.
    expect(screen.queryByTestId('connector-fingerprint-mismatch-hint')).toBeNull();
  });
});
