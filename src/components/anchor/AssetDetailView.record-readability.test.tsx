/**
 * AssetDetailView.record-readability.test.tsx
 *
 * TDD red-first for the record-detail readability pass (founder-reported,
 * 2026-09-29). Looking at the Record Details page for a Google Drive record,
 * the page:
 *   - titled itself with the raw internal id (`google_drive:1IxoL...`)
 *   - showed "0 B" for an unknown size and the raw MIME string as the type
 *   - listed every raw metadata key TWICE (a "Metadata" block, then the same
 *     ten values again inside the credential card)
 *   - showed "Source modification time: mtime:2026-09-29T20:47:10.002Z" (the
 *     internal prefix never stripped)
 *   - said nothing about which version this is, or where the newer/older
 *     version is, for a SUPERSEDED record
 *
 * This file pins the fixes. See also `src/lib/recordDisplay.test.ts` (pure
 * helpers) and `src/hooks/useAnchorVersions.test.ts` (the version-chain hook).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssetDetailView } from './AssetDetailView';
import { VERSION_HISTORY_LABELS, DOCUMENT_TYPE_LABELS } from '@/lib/copy';
import { recordDetailPath } from '@/lib/routes';

const BASE_ANCHOR = {
  id: 'anchor-v1',
  publicId: 'ARK-DOC-7RFUVV',
  filename: 'test-document.pdf',
  fingerprint: 'a'.repeat(64),
  status: 'SECURED' as const,
  createdAt: '2024-01-15T10:30:00Z',
  securedAt: '2024-01-15T10:35:00Z',
  fileSize: 102400,
  fileMime: 'application/pdf',
};

const DRIVE_INTERNAL_FILENAME = 'google_drive:1IxoLk_vWeuU-BB-2Qkmvs8QmV1qi_GKnGxZF8YheIu8';

describe('AssetDetailView — record readability pass', () => {
  describe('1. Title / type / size', () => {
    it('derives a human title from the Drive folder path instead of showing the raw internal id', () => {
      render(
        <AssetDetailView
          anchor={{
            ...BASE_ANCHOR,
            filename: DRIVE_INTERNAL_FILENAME,
            fileMime: 'application/vnd.google-apps.spreadsheet',
            fileSize: 0,
            metadata: {
              connector_source: 'google_drive',
              _drive_folder_path: '/Legal/Contracts/Q3 Vendor Agreement.gsheet',
            },
          }}
        />,
      );

      expect(screen.getByText('Q3 Vendor Agreement.gsheet')).toBeInTheDocument();
      expect(screen.queryByText(DRIVE_INTERNAL_FILENAME)).not.toBeInTheDocument();
      expect(screen.queryByText(/google_drive:/)).not.toBeInTheDocument();
    });

    it('shows a truthful type derived from the MIME type instead of the raw MIME string', () => {
      render(
        <AssetDetailView
          anchor={{
            ...BASE_ANCHOR,
            filename: DRIVE_INTERNAL_FILENAME,
            fileMime: 'application/vnd.google-apps.spreadsheet',
            fileSize: 0,
            metadata: { connector_source: 'google_drive', _drive_folder_path: '/Sheet Name' },
          }}
        />,
      );

      expect(screen.getByText(new RegExp(DOCUMENT_TYPE_LABELS.SPREADSHEET))).toBeInTheDocument();
      expect(screen.queryByText(/application\/vnd\.google-apps\.spreadsheet/)).not.toBeInTheDocument();
    });

    it('hides the size entirely instead of showing "0 B" when the size is unknown', () => {
      render(
        <AssetDetailView
          anchor={{
            ...BASE_ANCHOR,
            filename: DRIVE_INTERNAL_FILENAME,
            fileSize: 0,
            metadata: { connector_source: 'google_drive', _drive_folder_path: '/Sheet Name' },
          }}
        />,
      );
      expect(screen.queryByText(/0 B/)).not.toBeInTheDocument();
    });
  });

  describe('2. Version banner + version history list', () => {
    const olderVersion = {
      id: 'anchor-v1',
      publicId: 'ARK-DOC-7RFUVV',
      versionNumber: 1,
      status: 'SUPERSEDED',
      createdAt: '2026-09-01T00:00:00Z',
      filename: 'Q3 Vendor Agreement.gsheet',
    };
    const newerVersion = {
      id: 'anchor-v2',
      publicId: 'ARK-DOC-DRN2J6',
      versionNumber: 2,
      status: 'SECURED',
      createdAt: '2026-09-29T20:47:10.002Z',
      filename: 'Q3 Vendor Agreement.gsheet',
    };

    it('tells a superseded record that a newer version exists, with a working link to it', () => {
      render(
        <AssetDetailView
          anchor={{
            ...BASE_ANCHOR,
            id: 'anchor-v1',
            publicId: 'ARK-DOC-7RFUVV',
            status: 'SUPERSEDED',
            versionNumber: 1,
            lineage: [newerVersion, olderVersion],
          }}
        />,
      );

      const banner = screen.getByTestId('version-banner');
      expect(within(banner).getByText(/Version 1 of 2/)).toBeInTheDocument();
      const link = within(banner).getByTestId('version-banner-current-link');
      expect(link).toHaveAttribute('href', recordDetailPath('anchor-v2'));
      // Supersede, never revoke: this version still states it remains valid.
      expect(within(banner).getByTestId('version-banner-remains-valid')).toHaveTextContent(
        VERSION_HISTORY_LABELS.REMAINS_VALID_EVIDENCE,
      );
    });

    it('tells the current/newest version which version it replaces, with a working link back', () => {
      render(
        <AssetDetailView
          anchor={{
            ...BASE_ANCHOR,
            id: 'anchor-v2',
            publicId: 'ARK-DOC-DRN2J6',
            status: 'SECURED',
            versionNumber: 2,
            lineage: [newerVersion, olderVersion],
          }}
        />,
      );

      const banner = screen.getByTestId('version-banner');
      expect(within(banner).getByText(/Version 2 of 2/)).toBeInTheDocument();
      expect(within(banner).getByText(VERSION_HISTORY_LABELS.CURRENT_SUFFIX)).toBeInTheDocument();
      const link = within(banner).getByTestId('version-banner-previous-link');
      expect(link).toHaveAttribute('href', recordDetailPath('anchor-v1'));
    });

    it('does not render a version banner for a record with no lineage', () => {
      render(<AssetDetailView anchor={BASE_ANCHOR} />);
      expect(screen.queryByTestId('version-banner')).not.toBeInTheDocument();
    });

    it('lists every version newest-first, each with its own working link', () => {
      render(
        <AssetDetailView
          anchor={{
            ...BASE_ANCHOR,
            id: 'anchor-v1',
            status: 'SUPERSEDED',
            versionNumber: 1,
            lineage: [newerVersion, olderVersion],
          }}
        />,
      );

      const list = screen.getByTestId('version-history-list');
      const rows = within(list).getAllByTestId('version-history-row');
      expect(rows).toHaveLength(2);
      // Newest first.
      expect(within(rows[0]).getByText(/Version 2/)).toBeInTheDocument();
      expect(within(rows[1]).getByText(/Version 1/)).toBeInTheDocument();
      // The non-current row links to the other version; the current row does not.
      const otherVersionLink = within(rows[0]).getByTestId('version-history-row-link');
      expect(otherVersionLink).toHaveAttribute('href', recordDetailPath('anchor-v2'));
    });

    it('states honestly that a fingerprint difference is the only known signal of what changed, without inventing a content diff', () => {
      render(
        <AssetDetailView
          anchor={{
            ...BASE_ANCHOR,
            id: 'anchor-v1',
            fingerprint: 'a'.repeat(64),
            status: 'SUPERSEDED',
            versionNumber: 1,
            lineage: [
              { ...newerVersion, fingerprint: 'b'.repeat(64) },
              { ...olderVersion, fingerprint: 'a'.repeat(64) },
            ],
          }}
        />,
      );

      expect(screen.getByTestId('what-changed-section')).toHaveTextContent(
        VERSION_HISTORY_LABELS.WHAT_CHANGED_NO_DIFF,
      );
      expect(screen.getByTestId('what-changed-fingerprint-differs')).toHaveTextContent('version 2');
    });
  });

  describe('3. Technical details — one collapsed disclosure, rendered once', () => {
    const driveAnchorWithRawMetadata = {
      ...BASE_ANCHOR,
      filename: DRIVE_INTERNAL_FILENAME,
      credentialType: 'CONTRACT_POSTSIGNING',
      metadata: {
        connector_source: 'google_drive',
        _drive_folder_path: '/Legal/Contracts/Q3 Vendor Agreement.gsheet',
        file_id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
        mime_type: 'application/vnd.google-apps.spreadsheet',
        content_type: 'application/vnd.google-apps.spreadsheet',
        external_ref: 'ext-ref-12345',
        rule_event_id: 'rule-event-98765',
        integration_id: 'integration-555',
        connector_artifact_id: 'artifact-777',
        export_mime_type: 'text/csv',
      },
    };

    it('renders the technical details disclosure collapsed by default, with keyboard-accessible aria-expanded state', async () => {
      render(<AssetDetailView anchor={driveAnchorWithRawMetadata} />);

      const toggle = screen.getByTestId('technical-details-toggle');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      const user = userEvent.setup();
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');

      // Keyboard activation works too (native <button> semantics).
      await user.keyboard('{Enter}');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });

    it('renders every raw identifier exactly once on the page, not twice', () => {
      render(<AssetDetailView anchor={driveAnchorWithRawMetadata} />);

      // The founder-reported duplicate: this internal ref used to appear once
      // in the top "Metadata" dump and again inside the credential card's own
      // untemplated fallback dump.
      expect(screen.getAllByText('ext-ref-12345')).toHaveLength(1);
      expect(screen.getAllByText('artifact-777')).toHaveLength(1);
      expect(screen.getAllByText('rule-event-98765')).toHaveLength(1);
    });

    it('keeps the document fingerprint prominent, outside the collapsed section', () => {
      render(<AssetDetailView anchor={driveAnchorWithRawMetadata} />);
      // The fingerprint block renders unconditionally (not hidden).
      expect(screen.getByText(BASE_ANCHOR.fingerprint)).toBeVisible();
    });
  });

  describe('4. Source modification time formatting', () => {
    it('strips the mtime: prefix and shows a formatted date/time, not the raw token', () => {
      render(
        <AssetDetailView
          anchor={{
            ...BASE_ANCHOR,
            metadata: {
              connector_source: 'google_drive',
              file_id: 'file-id-1',
              revision_id: 'mtime:2026-09-29T20:47:10.002Z',
              _drive_revision_kind: 'modified_time',
            },
          }}
        />,
      );

      // The friendly Drive source row is reformatted; the raw token may still
      // sit inside the (collapsed) Technical Details disclosure, which is
      // deliberately a verbatim raw dump — so scope the assertion to the row
      // that must be honest about what it displays.
      const revisionRow = screen.getByTestId('drive-revision-plain');
      expect(revisionRow).not.toHaveTextContent('mtime:');
      expect(revisionRow).toHaveTextContent('2026');
    });
  });

  describe('1b. Rename input seeding (PR #3190 review finding 1)', () => {
  it('seeds the rename input with the STORED filename when it is human, not the derived title', async () => {
    const user = userEvent.setup();
    render(
      <AssetDetailView
        anchor={{ ...BASE_ANCHOR, filename: 'Q3-Contract-Signed.pdf' }}
        onRenameFile={async () => {}}
        canRename
      />,
    );
    await user.click(screen.getByLabelText('Edit document name'));
    expect(screen.getByDisplayValue('Q3-Contract-Signed.pdf')).toBeInTheDocument();
  });

  it('seeds the rename input EMPTY (not the derived title) when the stored filename is a connector id, showing the derived name only as a placeholder', async () => {
    const user = userEvent.setup();
    render(
      <AssetDetailView
        anchor={{
          ...BASE_ANCHOR,
          filename: DRIVE_INTERNAL_FILENAME,
          metadata: { connector_source: 'google_drive', _drive_folder_path: '/Legal/Q3 Vendor Agreement.gsheet' },
        }}
        onRenameFile={async () => {}}
        canRename
      />,
    );
    await user.click(screen.getByLabelText('Edit document name'));
    const input = screen.getByPlaceholderText('Q3 Vendor Agreement.gsheet') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('cannot silently persist the derived guess — saving with the seeded-empty input is impossible (Save stays disabled)', async () => {
    const onRenameFile = vi.fn();
    const user = userEvent.setup();
    render(
      <AssetDetailView
        anchor={{
          ...BASE_ANCHOR,
          filename: DRIVE_INTERNAL_FILENAME,
          metadata: { connector_source: 'google_drive', _drive_folder_path: '/Legal/Q3 Vendor Agreement.gsheet' },
        }}
        onRenameFile={onRenameFile}
        canRename
      />,
    );
    await user.click(screen.getByLabelText('Edit document name'));
    const input = screen.getByPlaceholderText('Q3 Vendor Agreement.gsheet');
    // Pressing Enter on the untouched (empty) input must not save anything.
    await user.type(input, '{Enter}');
    expect(onRenameFile).not.toHaveBeenCalled();
  });
});

describe('5. Non-connector records are unaffected', () => {
    it('renders the ordinary filename unchanged for a plain uploaded document', () => {
      render(<AssetDetailView anchor={BASE_ANCHOR} />);
      expect(screen.getByText('test-document.pdf')).toBeInTheDocument();
    });

    it('renders no version banner, no technical-details toggle, and no Drive/DocuSign blocks for a plain record', () => {
      render(<AssetDetailView anchor={BASE_ANCHOR} />);
      expect(screen.queryByTestId('version-banner')).not.toBeInTheDocument();
      expect(screen.queryByTestId('technical-details-toggle')).not.toBeInTheDocument();
      expect(screen.queryByTestId('drive-source-section')).not.toBeInTheDocument();
    });
  });

  describe('No banned terminology (§1.3)', () => {
    it('never renders a banned term anywhere on the page for a connector record', () => {
      const { container } = render(
        <AssetDetailView
          anchor={{
            ...BASE_ANCHOR,
            filename: DRIVE_INTERNAL_FILENAME,
            status: 'SUPERSEDED',
            versionNumber: 1,
            lineage: [
              { id: 'anchor-v2', publicId: 'ARK-DOC-2', versionNumber: 2, status: 'SECURED', createdAt: '2026-09-29T00:00:00Z', filename: 'x' },
              { id: BASE_ANCHOR.id, publicId: BASE_ANCHOR.publicId, versionNumber: 1, status: 'SUPERSEDED', createdAt: BASE_ANCHOR.createdAt, filename: 'x' },
            ],
            metadata: {
              connector_source: 'google_drive',
              _drive_folder_path: '/Sheet',
              revision_id: 'mtime:2026-09-29T20:47:10.002Z',
              _drive_revision_kind: 'modified_time',
            },
          }}
        />,
      );

      const text = container.textContent ?? '';
      for (const banned of ['Wallet', 'Gas', 'Hash', 'Block', 'Transaction', 'Crypto', 'Blockchain', 'Bitcoin', 'Testnet', 'Mainnet', 'UTXO', 'Broadcast']) {
        expect(text).not.toMatch(new RegExp(`\\b${banned}\\b`));
      }
    });
  });
});
