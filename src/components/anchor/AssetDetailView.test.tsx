/**
 * AssetDetailView Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { AssetDetailView } from './AssetDetailView';
import { DOCUSIGN_RECORD_LINKS_LABELS, DRIVE_RECORD_LINKS_LABELS } from '@/lib/copy';

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

  it('should show SUPERSEDED status for superseded anchors', () => {
    const supersededAnchor = { ...mockAnchor, status: 'SUPERSEDED' as const };
    const { getAllByText } = render(<AssetDetailView anchor={supersededAnchor} />);

    const supersededElements = getAllByText('Superseded');
    expect(supersededElements.length).toBeGreaterThan(0);
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
    const { getByText, getAllByText } = render(<AssetDetailView anchor={anchorWithPublicId} />);

    expect(getByText('Verification QR Code')).toBeInTheDocument();
    // Public ID may appear in multiple places (QR section + badge link)
    const publicIdElements = getAllByText(/ARK-2024-00091/);
    expect(publicIdElements.length).toBeGreaterThan(0);
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
    // Pin VITE_APP_URL so the test does not depend on the developer's local
    // .env (which sets VITE_APP_URL=http://localhost:5173 for `npm run dev`).
    vi.stubEnv('VITE_APP_URL', 'https://app.arkova.ai');
    try {
      const anchorWithPublicId = { ...mockAnchor, publicId: 'ARK-2024-00091' };
      const { getByText } = render(<AssetDetailView anchor={anchorWithPublicId} />);
      const urlText = getByText(/app\.arkova\.ai\/verify\/ARK-2024-00091/);
      expect(urlText).toBeInTheDocument();
    } finally {
      vi.unstubAllEnvs();
    }
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

  it('should show processing message for PENDING anchors without txid', () => {
    const pendingAnchor = { ...mockAnchor, status: 'PENDING' as const };
    const { container } = render(<AssetDetailView anchor={pendingAnchor} />);

    // Session 14 redesign: PENDING anchors show "Preparing for anchoring" instead of "Processing"
    expect(container.innerHTML).toContain('Preparing for anchoring');
    expect(container.innerHTML).toContain('prepared for permanent anchoring');
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

  it('renders source provenance with the same public-safe URL treatment as public verification', () => {
    const anchorWithSource = {
      ...mockAnchor,
      metadata: {
        source_url: 'https://credly.com/badges/internal?token=secret&id=visible',
        source_provider: 'credly',
        verification_level: 'captured_url',
        evidence_package_hash: 'evidence-hash-123',
        source_payload_hash: 'payload-hash-456',
        source_fetched_at: '2026-04-01T12:00:00Z',
      },
    };
    const { getByTestId, getByText, queryByText } = render(<AssetDetailView anchor={anchorWithSource} />);

    const sourceLink = getByTestId('source-url-link');
    expect(sourceLink).toHaveAttribute('href', 'https://credly.com/badges/internal?id=visible');
    expect(getByText('Credly')).toBeInTheDocument();
    expect(getByText('Captured URL Evidence')).toBeInTheDocument();
    expect(queryByText(/token=secret/)).not.toBeInTheDocument();
    expect(queryByText('evidence-hash-123')).not.toBeInTheDocument();
  });

  it('renders source provenance when only proof hashes are present', () => {
    const anchorWithHashOnlySource = {
      ...mockAnchor,
      metadata: {
        evidence_package_hash: 'evidence-hash-123',
        source_payload_hash: 'payload-hash-456',
      },
    };
    const { getByTestId } = render(<AssetDetailView anchor={anchorWithHashOnlySource} />);

    const section = getByTestId('source-provenance-display');
    expect(section).toBeInTheDocument();
    expect(section).not.toHaveTextContent('evidence-hash-123');
    expect(section).not.toHaveTextContent('payload-hash-456');
  });

  it('keeps full metadata available to the internal credential renderer', () => {
    const anchorWithRecipient = {
      ...mockAnchor,
      credentialType: 'DEGREE',
      metadata: {
        recipient_name: 'Ada Lovelace',
        source_url: 'https://credly.com/badges/internal?token=secret&id=visible',
      },
    };
    const { getAllByText, queryByText } = render(<AssetDetailView anchor={anchorWithRecipient} />);

    expect(getAllByText('Ada Lovelace').length).toBeGreaterThan(0);
    expect(queryByText(/token=secret/)).not.toBeInTheDocument();
    expect(queryByText(/AI-extracted metadata/)).not.toBeInTheDocument();
  });

  // BUG-2026-06-24-008: "Network Observed Time" must never show the local
  // upload/creation time for unconfirmed records (§1.5).
  it('shows Network Observed Time for SECURED anchors', () => {
    const { queryByText } = render(<AssetDetailView anchor={mockAnchor} />);

    expect(queryByText('Network Observed Time')).toBeInTheDocument();
    // The honest created-only fallback label is not used for a secured anchor.
    expect(queryByText('Record Created')).not.toBeInTheDocument();
  });

  it('does NOT show Network Observed Time for PENDING anchors (no securedAt)', () => {
    const pendingAnchor = { ...mockAnchor, status: 'PENDING' as const, securedAt: undefined };
    const { queryByText } = render(<AssetDetailView anchor={pendingAnchor} />);

    // The network observed-time label must be absent — nothing has been
    // observed by the network yet; createdAt must not appear under it.
    expect(queryByText('Network Observed Time')).not.toBeInTheDocument();
    expect(queryByText('Record Created')).toBeInTheDocument();
  });

  it('does NOT show Network Observed Time for SUBMITTED anchors (no securedAt)', () => {
    const submittedAnchor = { ...mockAnchor, status: 'SUBMITTED' as const, securedAt: undefined };
    const { queryByText } = render(<AssetDetailView anchor={submittedAnchor} />);

    expect(queryByText('Network Observed Time')).not.toBeInTheDocument();
    expect(queryByText('Record Created')).toBeInTheDocument();
  });

  // Founder-reported rename honesty fix: the pencil is owner-only. RLS
  // (anchors_update_own = user_id match; migration 0393's trigger
  // restrict_org_admin_folder_update narrows org-admin updates to folder_id)
  // means a non-owner rename can never succeed — showing the pencil to a
  // non-owner yields either a raw 42501 error toast or a silent zero-row
  // false success. The parent computes ownership and passes canRename,
  // mirroring the canRevoke pattern; it fails closed when omitted.
  it('shows the rename pencil when the viewer can rename (owner)', () => {
    const { getByLabelText } = render(
      <AssetDetailView anchor={mockAnchor} onRenameFile={vi.fn()} canRename />
    );

    expect(getByLabelText('Edit document name')).toBeInTheDocument();
  });

  it('hides the rename pencil when canRename is false (non-owner)', () => {
    const { queryByLabelText } = render(
      <AssetDetailView anchor={mockAnchor} onRenameFile={vi.fn()} canRename={false} />
    );

    expect(queryByLabelText('Edit document name')).not.toBeInTheDocument();
  });

  it('hides the rename pencil when canRename is omitted (fail-closed default)', () => {
    const { queryByLabelText } = render(
      <AssetDetailView anchor={mockAnchor} onRenameFile={vi.fn()} />
    );

    expect(queryByLabelText('Edit document name')).not.toBeInTheDocument();
  });

  // BUG-2026-07-17-010 (SCRUM-2910, P0): historical fraud_* metadata keys must
  // never render on the OWNER document detail view.
  it('never renders fraud_* metadata keys on the owner detail view (BUG-2026-07-17-010)', () => {
    const anchorWithFraudMeta = {
      ...mockAnchor,
      metadata: {
        field_of_study: 'Computer Science',
        fraud_score: 0.87,
        fraud_risk_level: 'high',
        fraud_signals: [{ signal_type: 'future_date', score: 0.35, field_affected: 'issuedDate' }],
        fraud_analysis_method: 'client_side_worker_v2',
        fraud_processing_time_ms: 12,
        fraudSignals: '["Font inconsistency detected"]',
      },
    };
    const { queryByText, getAllByText } = render(<AssetDetailView anchor={anchorWithFraudMeta} />);

    // Legitimate metadata still renders (may appear in more than one section).
    expect(getAllByText('Computer Science').length).toBeGreaterThan(0);
    // No fraud-derived key, label, or value may appear anywhere in the view.
    expect(queryByText(/fraud/i)).not.toBeInTheDocument();
    expect(queryByText(/0\.87/)).not.toBeInTheDocument();
    expect(queryByText(/client_side_worker_v2/)).not.toBeInTheDocument();
    expect(document.body.textContent?.toLowerCase()).not.toContain('fraud');
  });

  // DocuSign record deep links (bilateral rollout, frontend-targeted T2).
  // Account/envelope metadata values and dedicated signer rows link into
  // DocuSign's own console ONLY for connector_source === 'docusign' anchors,
  // and ONLY after the candidate value passes strict UUID validation
  // (src/lib/docusignLinks.ts) — see that module's own test file for the
  // exhaustive validation/injection matrix. These tests cover the
  // component-level wiring: gating on connector_source, the plain-text
  // fallback on a bad value, the underscore-key exclusion, and the
  // legacy-record (no _signers) case.
  describe('DocuSign record deep links (bilateral rollout, frontend-targeted T2)', () => {
    const VALID_ACCOUNT_ID = '11111111-2222-4333-8444-555555555555';
    const VALID_ENVELOPE_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    const VALID_SIGNER_GUID_1 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const VALID_SIGNER_GUID_2 = 'cccccccc-dddd-4eee-8fff-000000000000';

    const docusignAnchor = {
      ...mockAnchor,
      metadata: {
        connector_source: 'docusign',
        account_id: VALID_ACCOUNT_ID,
        envelope_id: VALID_ENVELOPE_ID,
        _signers: [
          { recipient_id_guid: VALID_SIGNER_GUID_1, user_id: 'user-1-should-never-render', status: 'completed', signed_at: '2026-08-20T12:00:00Z' },
          { recipient_id_guid: VALID_SIGNER_GUID_2, status: 'completed' },
        ],
      },
    };

    it('keeps the account and envelope links VISIBLE, outside the collapsed technical details, each rendered once', () => {
      // Regression caught by e2e/record-detail.spec.ts on PR #3190: the
      // readability pass moved every metadata row into a collapsed
      // disclosure, which hid these two links. `toBeInTheDocument` is true
      // for a hidden element, so the older assertions below could not see it.
      const { getAllByTestId, container } = render(<AssetDetailView anchor={docusignAnchor} />);
      const collapsed = container.querySelector('#technical-details-content');

      for (const testId of ['docusign-account-link', 'docusign-envelope-link']) {
        const links = getAllByTestId(testId);
        expect(links).toHaveLength(1);
        expect(links[0]).toBeVisible();
        expect(collapsed?.contains(links[0]) ?? false).toBe(false);
      }
    });

    it('renders the account id metadata row as a link to the DocuSign account console', () => {
      const { getByTestId } = render(<AssetDetailView anchor={docusignAnchor} />);

      const link = getByTestId('docusign-account-link');
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', `https://apps.docusign.com/send/home?account=${VALID_ACCOUNT_ID}`);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveTextContent(VALID_ACCOUNT_ID);
    });

    it('renders the envelope id metadata row as a link to the DocuSign envelope console', () => {
      const { getByTestId } = render(<AssetDetailView anchor={docusignAnchor} />);

      const link = getByTestId('docusign-envelope-link');
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', `https://apps.docusign.com/send/documents/details/${VALID_ENVELOPE_ID}`);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('uses the demo base URL when metadata._docusign_env is "demo"', () => {
      const demoAnchor = {
        ...docusignAnchor,
        metadata: { ...docusignAnchor.metadata, _docusign_env: 'demo' },
      };
      const { getByTestId } = render(<AssetDetailView anchor={demoAnchor} />);

      expect(getByTestId('docusign-account-link')).toHaveAttribute(
        'href',
        `https://apps-d.docusign.com/send/home?account=${VALID_ACCOUNT_ID}`,
      );
      expect(getByTestId('docusign-envelope-link')).toHaveAttribute(
        'href',
        `https://apps-d.docusign.com/send/documents/details/${VALID_ENVELOPE_ID}`,
      );
    });

    it('renders dedicated signer rows labeled "Signer N · Verified via DocuSign" with the GUID linked', () => {
      const { getByTestId, getAllByTestId, getByText } = render(<AssetDetailView anchor={docusignAnchor} />);

      const rows = getAllByTestId('docusign-signer-row');
      expect(rows.length).toBe(2);

      expect(getByText(/Signer 1 · Verified via DocuSign/)).toBeInTheDocument();
      expect(getByText(/Signer 2 · Verified via DocuSign/)).toBeInTheDocument();

      const firstLink = getByTestId('docusign-signer-link-0');
      expect(firstLink).toHaveAttribute(
        'href',
        `https://apps.docusign.com/send/documents/details/${VALID_SIGNER_GUID_1}`,
      );
      expect(firstLink).toHaveTextContent(VALID_SIGNER_GUID_1);
      expect(firstLink).toHaveAttribute('target', '_blank');
      expect(firstLink).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('prefers recipient_id_guid over user_id for signer display and link (R6 data minimization) — user_id never renders', () => {
      const { queryByText } = render(<AssetDetailView anchor={docusignAnchor} />);

      expect(queryByText(/user-1-should-never-render/)).not.toBeInTheDocument();
    });

    it('shows a "+N more signed via DocuSign" line when _signers exceeds the 20-row display cap', () => {
      const manySigners = Array.from({ length: 23 }, (_, i) => ({
        recipient_id_guid: `${i.toString().padStart(8, '0')}-0000-4000-8000-000000000000`,
        status: 'completed',
      }));
      const cappedAnchor = {
        ...docusignAnchor,
        metadata: { ...docusignAnchor.metadata, _signers: manySigners },
      };
      const { getAllByTestId, getByText } = render(<AssetDetailView anchor={cappedAnchor} />);

      expect(getAllByTestId('docusign-signer-row').length).toBe(20);
      expect(getByText(/\+3 more signed via DocuSign/)).toBeInTheDocument();
    });

    it('does not render signer rows when _signers is absent (legacy DocuSign record) but still links account/envelope', () => {
      const legacyAnchor = {
        ...mockAnchor,
        metadata: {
          connector_source: 'docusign',
          account_id: VALID_ACCOUNT_ID,
          envelope_id: VALID_ENVELOPE_ID,
        },
      };
      const { getByTestId, queryByTestId, queryByText } = render(<AssetDetailView anchor={legacyAnchor} />);

      expect(queryByTestId('docusign-signer-row')).not.toBeInTheDocument();
      expect(queryByText(DOCUSIGN_RECORD_LINKS_LABELS.SIGNERS_SECTION_LABEL)).not.toBeInTheDocument();
      // Legacy record still gets the account/envelope links — the signer
      // block and the metadata-row links are independent features.
      expect(getByTestId('docusign-account-link')).toBeInTheDocument();
      expect(getByTestId('docusign-envelope-link')).toBeInTheDocument();
    });

    it('does not render signer rows when _signers is an empty array', () => {
      const emptySignersAnchor = {
        ...docusignAnchor,
        metadata: { ...docusignAnchor.metadata, _signers: [] },
      };
      const { queryByTestId } = render(<AssetDetailView anchor={emptySignersAnchor} />);

      expect(queryByTestId('docusign-signer-row')).not.toBeInTheDocument();
    });

    // Malformed _signers shapes (post-review hardening): DocusignSignerRows'
    // Array.isArray/isDisplayableSigner guards must degrade to "render
    // nothing" rather than throw, since _signers is producer-written data
    // this component does not control the shape of.
    it('does not crash and renders no signer rows when _signers is not an array', () => {
      const malformedAnchor = {
        ...docusignAnchor,
        metadata: { ...docusignAnchor.metadata, _signers: 'not-an-array' },
      };

      expect(() => render(<AssetDetailView anchor={malformedAnchor} />)).not.toThrow();
      const { queryByTestId } = render(<AssetDetailView anchor={malformedAnchor} />);
      expect(queryByTestId('docusign-signer-row')).not.toBeInTheDocument();
    });

    it('does not crash and renders no signer rows when an entry has no recipient_id_guid', () => {
      const malformedAnchor = {
        ...docusignAnchor,
        metadata: { ...docusignAnchor.metadata, _signers: [{}] },
      };

      expect(() => render(<AssetDetailView anchor={malformedAnchor} />)).not.toThrow();
      const { queryByTestId } = render(<AssetDetailView anchor={malformedAnchor} />);
      expect(queryByTestId('docusign-signer-row')).not.toBeInTheDocument();
    });

    it('does not crash and renders no signer rows when an entry has only user_id (no recipient_id_guid)', () => {
      const malformedAnchor = {
        ...docusignAnchor,
        metadata: {
          ...docusignAnchor.metadata,
          _signers: [{ user_id: 'user-only-should-never-render' }],
        },
      };

      expect(() => render(<AssetDetailView anchor={malformedAnchor} />)).not.toThrow();
      const { queryByTestId, queryByText } = render(<AssetDetailView anchor={malformedAnchor} />);
      expect(queryByTestId('docusign-signer-row')).not.toBeInTheDocument();
      // The data-minimization guard means this could never render anyway,
      // but assert it explicitly for this specific malformed-entry shape.
      expect(queryByText(/user-only-should-never-render/)).not.toBeInTheDocument();
    });

    it('renders a value that fails strict UUID validation as plain text, not a link', () => {
      const badValueAnchor = {
        ...mockAnchor,
        metadata: {
          connector_source: 'docusign',
          account_id: 'not-a-real-uuid',
          envelope_id: VALID_ENVELOPE_ID,
        },
      };
      const { getByTestId, queryByTestId, getAllByText } = render(<AssetDetailView anchor={badValueAnchor} />);

      expect(queryByTestId('docusign-account-link')).not.toBeInTheDocument();
      // The value still renders as text (it also appears once more in the
      // pre-existing CredentialRenderer generic metadata table, which this
      // PR does not touch — assert presence, not a single occurrence).
      expect(getAllByText('not-a-real-uuid').length).toBeGreaterThan(0);
      // The envelope id is still valid and still links.
      expect(getByTestId('docusign-envelope-link')).toBeInTheDocument();
    });

    it('renders a javascript:-shaped account_id value as inert plain text (never as an href)', () => {
      const injectionAnchor = {
        ...mockAnchor,
        metadata: {
          connector_source: 'docusign',
          account_id: 'javascript:alert(document.cookie)',
        },
      };
      const { queryByTestId, container } = render(<AssetDetailView anchor={injectionAnchor} />);

      expect(queryByTestId('docusign-account-link')).not.toBeInTheDocument();
      // No anchor tag anywhere in the document may carry a javascript: href.
      const anchors = container.querySelectorAll('a[href]');
      for (const a of Array.from(anchors)) {
        expect(a.getAttribute('href')?.toLowerCase().trim().startsWith('javascript:')).toBe(false);
      }
    });

    it('does NOT link the account id / envelope id rows for a non-DocuSign anchor (connector_source unset)', () => {
      const nonDocusignAnchor = {
        ...mockAnchor,
        metadata: {
          account_id: VALID_ACCOUNT_ID,
          envelope_id: VALID_ENVELOPE_ID,
        },
      };
      const { queryByTestId, getAllByText } = render(<AssetDetailView anchor={nonDocusignAnchor} />);

      expect(queryByTestId('docusign-account-link')).not.toBeInTheDocument();
      expect(queryByTestId('docusign-envelope-link')).not.toBeInTheDocument();
      // Values still render as plain text (also duplicated once more in the
      // pre-existing CredentialRenderer generic metadata table — assert
      // presence, not a single occurrence).
      expect(getAllByText(VALID_ACCOUNT_ID).length).toBeGreaterThan(0);
      expect(getAllByText(VALID_ENVELOPE_ID).length).toBeGreaterThan(0);
    });

    it('does NOT render signer rows for a non-DocuSign anchor even if _signers is present', () => {
      const nonDocusignAnchor = {
        ...mockAnchor,
        metadata: {
          _signers: [{ recipient_id_guid: VALID_SIGNER_GUID_1, status: 'completed' }],
        },
      };
      const { queryByTestId } = render(<AssetDetailView anchor={nonDocusignAnchor} />);

      expect(queryByTestId('docusign-signer-row')).not.toBeInTheDocument();
    });

    it('never renders _signers or _docusign_env as raw generic metadata rows', () => {
      const demoAnchor = {
        ...docusignAnchor,
        metadata: { ...docusignAnchor.metadata, _docusign_env: 'demo' },
      };
      const { queryByText } = render(<AssetDetailView anchor={demoAnchor} />);

      // The generic metadata loop derives labels via key.replace(/_/g, ' '),
      // so a leaked raw row would read "signers:" / "docusign env:".
      expect(queryByText(/^signers:$/i)).not.toBeInTheDocument();
      expect(queryByText(/^docusign env:$/i)).not.toBeInTheDocument();
      // Nor should the raw array/string ever appear serialized inline.
      expect(queryByText(/recipient_id_guid/)).not.toBeInTheDocument();
    });
  });

  /**
   * SCRUM-4507 — Google Drive source link-back.
   *
   * Same shape as the DocuSign block above and gated the same way: the chips
   * render ONLY when `metadata.connector_source === 'google_drive'` exactly.
   * That equality is the forgery gate — migration 0423 strips
   * `connector_source` from any INSERT by a non-`service_role` caller and
   * reverts it on UPDATE, so for rows written after 0423 the marker can only
   * have come from the worker connector pipeline.
   *
   * The Drive identifiers live in a dedicated source block rather than as
   * links inside the generic metadata dump, because three of the four
   * (`_drive_*`) are underscore-prefixed and that dump hides underscore keys
   * by construction (BUG-2026-07-17-010).
   */
  describe('Google Drive source link-back (SCRUM-4507)', () => {
    const DRIVE_FILE_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
    const DRIVE_FOLDER_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    const DRIVE_SHARED_DRIVE_ID = '0AOaBcDeFgHiJkLmNoP';

    const driveAnchor = {
      ...mockAnchor,
      metadata: {
        connector_source: 'google_drive',
        file_id: DRIVE_FILE_ID,
        revision_id: 'rev-head-0001',
        _drive_folder_id: DRIVE_FOLDER_ID,
        _drive_folder_path: '/Legal/Contracts',
        _drive_shared_drive_id: DRIVE_SHARED_DRIVE_ID,
        _drive_revision_kind: 'head_revision',
      },
    };

    it('renders the source file chip as a link to the Drive file', () => {
      const { getByTestId } = render(<AssetDetailView anchor={driveAnchor} />);

      const link = getByTestId('drive-file-link');
      expect(link).toHaveAttribute('href', `https://drive.google.com/file/d/${DRIVE_FILE_ID}/view`);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('renders the folder chip labelled by the resolved folder path', () => {
      const { getByTestId } = render(<AssetDetailView anchor={driveAnchor} />);

      const link = getByTestId('drive-folder-link');
      expect(link).toHaveAttribute('href', `https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}`);
      // The human path is what the owner recognises; the opaque id is not.
      expect(link).toHaveTextContent('/Legal/Contracts');
    });

    it('falls back to the folder id as the label when no folder path was resolved', () => {
      const noPath = {
        ...driveAnchor,
        metadata: { ...driveAnchor.metadata, _drive_folder_path: null },
      };
      const { getByTestId } = render(<AssetDetailView anchor={noPath} />);

      const link = getByTestId('drive-folder-link');
      expect(link).toHaveAttribute('href', `https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}`);
      expect(link).toHaveTextContent(DRIVE_FOLDER_ID);
    });

    it('renders the shared drive chip', () => {
      const { getByTestId } = render(<AssetDetailView anchor={driveAnchor} />);

      expect(getByTestId('drive-shared-drive-link')).toHaveAttribute(
        'href',
        `https://drive.google.com/drive/folders/${DRIVE_SHARED_DRIVE_ID}`,
      );
    });

    it('omits the shared drive chip for a My Drive record', () => {
      const myDrive = {
        ...driveAnchor,
        metadata: { ...driveAnchor.metadata, _drive_shared_drive_id: null },
      };
      const { queryByTestId, getByTestId } = render(<AssetDetailView anchor={myDrive} />);

      expect(queryByTestId('drive-shared-drive-link')).not.toBeInTheDocument();
      // The rest of the block still renders.
      expect(getByTestId('drive-file-link')).toBeInTheDocument();
    });

    it('renders the revision as plain text, never as a link', () => {
      const { getByTestId, queryByTestId } = render(<AssetDetailView anchor={driveAnchor} />);

      const revision = getByTestId('drive-revision-plain');
      expect(revision).toHaveTextContent('rev-head-0001');
      expect(revision.tagName).not.toBe('A');
      expect(revision.querySelector('a')).toBeNull();
      expect(queryByTestId('drive-revision-link')).not.toBeInTheDocument();
    });

    it('labels a head_revision record as a source revision', () => {
      const { getByText } = render(<AssetDetailView anchor={driveAnchor} />);
      expect(getByText(`${DRIVE_RECORD_LINKS_LABELS.REVISION_LABEL}:`)).toBeInTheDocument();
    });

    it('labels a modified_time record as a modification time, not a revision', () => {
      // §1.5: a Workspace-native file has no revision id at all — the value is
      // a synthetic `mtime:` token. Calling that "revision" would state
      // something the producer never measured.
      const nativeDoc = {
        ...driveAnchor,
        metadata: {
          ...driveAnchor.metadata,
          revision_id: 'mtime:2026-05-04T01:23:00Z',
          _drive_revision_kind: 'modified_time',
        },
      };
      const { getByText, queryByText } = render(<AssetDetailView anchor={nativeDoc} />);

      expect(getByText(`${DRIVE_RECORD_LINKS_LABELS.MODIFIED_TIME_LABEL}:`)).toBeInTheDocument();
      expect(queryByText(`${DRIVE_RECORD_LINKS_LABELS.REVISION_LABEL}:`)).not.toBeInTheDocument();
    });

    it('labels a record with NO recorded revision kind as a modification time', () => {
      // A Drive anchor written before SCRUM-4507 has no `_drive_revision_kind`.
      // Absence must fall to the WEAKER label: claiming "revision" for a value
      // whose kind was never recorded asserts something never measured (§1.5).
      const legacy = {
        ...driveAnchor,
        metadata: { ...driveAnchor.metadata, _drive_revision_kind: null },
      };
      const { getByText, queryByText } = render(<AssetDetailView anchor={legacy} />);

      expect(getByText(`${DRIVE_RECORD_LINKS_LABELS.MODIFIED_TIME_LABEL}:`)).toBeInTheDocument();
      expect(queryByText(`${DRIVE_RECORD_LINKS_LABELS.REVISION_LABEL}:`)).not.toBeInTheDocument();
    });

    it('labels an event_time record as a modification time too', () => {
      const eventTime = {
        ...driveAnchor,
        metadata: {
          ...driveAnchor.metadata,
          revision_id: 'evt:2026-05-04T02:00:00Z:file-evt',
          _drive_revision_kind: 'event_time',
        },
      };
      const { getByText } = render(<AssetDetailView anchor={eventTime} />);
      expect(getByText(`${DRIVE_RECORD_LINKS_LABELS.MODIFIED_TIME_LABEL}:`)).toBeInTheDocument();
    });

    it('states what is measured and what is NOT asserted about the linked Drive item', () => {
      const { getByTestId } = render(<AssetDetailView anchor={driveAnchor} />);
      expect(getByTestId('drive-source-note')).toHaveTextContent(
        DRIVE_RECORD_LINKS_LABELS.SOURCE_NOTE,
      );
    });

    // ── Forgery gate ────────────────────────────────────────────────────────
    it('renders ZERO Drive chips when connector_source is absent', () => {
      const forged = {
        ...mockAnchor,
        metadata: {
          file_id: DRIVE_FILE_ID,
          revision_id: 'rev-head-0001',
          _drive_folder_id: DRIVE_FOLDER_ID,
          _drive_shared_drive_id: DRIVE_SHARED_DRIVE_ID,
          _drive_revision_kind: 'head_revision',
        },
      };
      const { queryByTestId } = render(<AssetDetailView anchor={forged} />);

      for (const testId of [
        'drive-file-link',
        'drive-folder-link',
        'drive-shared-drive-link',
        'drive-revision-plain',
        'drive-source-note',
      ]) {
        expect(queryByTestId(testId)).not.toBeInTheDocument();
      }
    });

    it('renders ZERO Drive chips for a near-miss connector_source value', () => {
      for (const marker of ['googledrive', 'google_drive ', 'Google_Drive', 'drive', 'connector']) {
        const nearMiss = {
          ...driveAnchor,
          metadata: { ...driveAnchor.metadata, connector_source: marker },
        };
        const { queryByTestId, unmount } = render(<AssetDetailView anchor={nearMiss} />);
        expect(queryByTestId('drive-file-link'), `marker ${marker} must not pass the gate`).not.toBeInTheDocument();
        unmount();
      }
    });

    it('renders no Drive chips on a DocuSign anchor, and no DocuSign rows on a Drive anchor', () => {
      const { queryByTestId, unmount } = render(<AssetDetailView anchor={driveAnchor} />);
      expect(queryByTestId('docusign-account-link')).not.toBeInTheDocument();
      expect(queryByTestId('docusign-envelope-link')).not.toBeInTheDocument();
      expect(queryByTestId('docusign-signer-row')).not.toBeInTheDocument();
      // RTL binds queries to document.body, not to this render's container, so
      // the Drive markup has to come down before the DocuSign case is asserted
      // — otherwise the second query would find the first render's chips.
      unmount();

      const docusignOnly = {
        ...mockAnchor,
        metadata: {
          connector_source: 'docusign',
          account_id: '11111111-2222-4333-8444-555555555555',
          envelope_id: '66666666-7777-4888-8999-aaaaaaaaaaaa',
          // A DocuSign row that somehow also carries Drive keys must still
          // show zero Drive chips — the provider gate is exclusive.
          file_id: DRIVE_FILE_ID,
          _drive_folder_id: DRIVE_FOLDER_ID,
        },
      };
      const { queryByTestId: q2, getByTestId: g2 } = render(<AssetDetailView anchor={docusignOnly} />);
      expect(g2('docusign-account-link')).toBeInTheDocument();
      expect(q2('drive-file-link')).not.toBeInTheDocument();
      expect(q2('drive-folder-link')).not.toBeInTheDocument();
    });

    // ── Degrade safely on malformed input ───────────────────────────────────
    it('renders no href and no javascript: URL for an injection-shaped file id', () => {
      const injection = {
        ...driveAnchor,
        metadata: {
          ...driveAnchor.metadata,
          file_id: 'javascript:alert(document.cookie)',
          _drive_folder_id: '../../../etc/passwd',
          _drive_shared_drive_id: 'https://evil.example.com/steal',
        },
      };
      const { queryByTestId, container } = render(<AssetDetailView anchor={injection} />);

      expect(queryByTestId('drive-file-link')).not.toBeInTheDocument();
      expect(queryByTestId('drive-folder-link')).not.toBeInTheDocument();
      expect(queryByTestId('drive-shared-drive-link')).not.toBeInTheDocument();
      for (const a of Array.from(container.querySelectorAll('a[href]'))) {
        const href = a.getAttribute('href')?.toLowerCase().trim() ?? '';
        expect(href.startsWith('javascript:')).toBe(false);
        expect(href.includes('evil.example.com')).toBe(false);
      }
    });

    it('renders the source block with no chips at all when every Drive identifier is invalid', () => {
      const empty = {
        ...mockAnchor,
        metadata: { connector_source: 'google_drive' },
      };
      const { queryByTestId } = render(<AssetDetailView anchor={empty} />);

      expect(queryByTestId('drive-file-link')).not.toBeInTheDocument();
      expect(queryByTestId('drive-folder-link')).not.toBeInTheDocument();
      expect(queryByTestId('drive-shared-drive-link')).not.toBeInTheDocument();
      expect(queryByTestId('drive-revision-plain')).not.toBeInTheDocument();
      // Nothing measured -> nothing claimed: the note does not render either.
      expect(queryByTestId('drive-source-note')).not.toBeInTheDocument();
    });

    /**
     * BUG-2026-09-12-001 (found in CTO review of this PR, in its OWN 375px UAT
     * screenshot: `docs/uat/scrum-4507/drive-source-block-native-doc-375px.png`
     * renders "Source modification time" butted directly against
     * "mtime:2026-09-10T09:12:00Z", with no gap).
     *
     * The label span is `whitespace-nowrap min-w-[120px]` inside a
     * `flex gap-4` row. `min-width` stops the flex item shrinking BELOW 120px
     * but does not stop it being sized AT 120px while `nowrap` keeps its text
     * one line — so a label wider than 120px (every label added by this block
     * except "Folder") overflows its own box and lands on top of the value.
     * `shrink-0` is what makes the label keep its natural width, which is the
     * property the layout actually depends on.
     *
     * Asserted structurally rather than by pixel measurement: jsdom does no
     * layout, so a class ratchet over EVERY label in the block is the only
     * check that catches the next long label somebody adds.
     */
    it('keeps every source label at its natural width so it cannot overlap its value', () => {
      const { getByTestId } = render(
        <AssetDetailView
          anchor={{
            ...driveAnchor,
            // The longest label in the block ("Source modification time"), i.e.
            // the exact case the 375px screenshot caught.
            metadata: { ...driveAnchor.metadata, _drive_revision_kind: 'modified_time' },
          }}
        />,
      );

      const labels = getByTestId('drive-source-section').querySelectorAll('span.whitespace-nowrap');
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        expect(
          label.className,
          `label "${label.textContent}" can be squeezed to its min-width and overlap its value at 375px`,
        ).toContain('shrink-0');
      }
    });

    it('never renders the _drive_* keys as raw generic metadata rows', () => {
      const { queryByText } = render(<AssetDetailView anchor={driveAnchor} />);

      // The generic dump derives labels via key.replace(/_/g, ' '), so a leak
      // would read "drive folder id:" / "drive revision kind:".
      expect(queryByText(/^drive folder id:$/i)).not.toBeInTheDocument();
      expect(queryByText(/^drive shared drive id:$/i)).not.toBeInTheDocument();
      expect(queryByText(/^drive revision kind:$/i)).not.toBeInTheDocument();
      expect(queryByText(/^drive folder path:$/i)).not.toBeInTheDocument();
    });
  });
});
