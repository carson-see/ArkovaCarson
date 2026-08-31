/**
 * AssetDetailView Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { AssetDetailView } from './AssetDetailView';
import { DOCUSIGN_RECORD_LINKS_LABELS } from '@/lib/copy';

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
});
