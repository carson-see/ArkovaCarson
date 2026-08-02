/**
 * PublicVerification trust-state regressions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PublicVerification } from './PublicVerification';

const rpcMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

vi.mock('@/lib/logVerificationEvent', () => ({
  logVerificationEvent: vi.fn(),
}));

vi.mock('@/hooks/useCredentialTemplate', () => ({
  useCredentialTemplate: () => ({ template: null }),
}));

vi.mock('@/components/credentials/CredentialRenderer', () => ({
  CredentialRenderer: ({ status, metadata }: { status: string; metadata?: unknown }) => (
    <div data-testid="credential-renderer">
      credential status: {status}
      {JSON.stringify(metadata ?? {})}
    </div>
  ),
}));

vi.mock('@/components/anchor/AnchorLifecycleTimeline', () => ({
  AnchorLifecycleTimeline: () => <div data-testid="lifecycle-timeline" />,
}));

vi.mock('@/components/public/ProvenanceTimeline', () => ({
  ProvenanceTimeline: () => <div data-testid="provenance-timeline" />,
}));

vi.mock('@/components/verification/VerifierProofDownload', () => ({
  // FE-PROOF-GATE (SCRUM-2501): VerifierProofDownload now sources its proof
  // data live from GET /api/v1/verify/:publicId/proof, not from client-side
  // sourceProvenance/metadata — it only needs publicId + status to run its
  // own gate + fetch (see VerifierProofDownload.test.tsx for the full state
  // machine coverage). The mock here just proves PublicVerification wires
  // the right publicId/status through and gates the section on hasProof.
  VerifierProofDownload: ({ publicId, status }: { publicId: string; status: string }) => (
    <div data-testid="proof-download">
      {publicId}:{status}
    </div>
  ),
}));

vi.mock('@/components/verification/EvidenceLayersSection', () => ({
  EvidenceLayersSection: ({ layers }: { layers: Array<{ present: boolean }> }) => (
    <div data-testid="evidence-layers">
      {layers.filter((layer) => layer.present).length} active
    </div>
  ),
}));

vi.mock('@/components/anchor/ComplianceBadge', () => ({
  ComplianceBadge: () => <div data-testid="compliance-badge" />,
}));

const baseAnchor = {
  public_id: 'ARK-DOC-123',
  fingerprint: 'a'.repeat(64),
  filename: 'record.pdf',
  verified: true,
  credential_type: 'OTHER',
  metadata: {},
  created_at: '2026-04-01T00:00:00Z',
};

describe('PublicVerification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not overstate trust for SUBMITTED records', async () => {
    rpcMock.mockResolvedValue({
      data: { ...baseAnchor, status: 'SUBMITTED' },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    expect(await screen.findByText('Record Submitted · Awaiting Network Confirmation')).toBeInTheDocument();
    expect(screen.getByText('Awaiting Confirmation')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Finalization usually takes ≈60 minutes once the network observes the next checkpoint.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Document Verified')).not.toBeInTheDocument();
    expect(screen.queryByText('Cryptographic Proof')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proof-download')).not.toBeInTheDocument();
  });

  it('renders PENDING records as processing without proof affordances', async () => {
    rpcMock.mockResolvedValue({
      data: { ...baseAnchor, status: 'PENDING' },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    expect(await screen.findByText('Submitting to network...')).toBeInTheDocument();
    expect(screen.getByText('Processing')).toBeInTheDocument();
    expect(screen.queryByText('Document Verified')).not.toBeInTheDocument();
    expect(screen.queryByText('Cryptographic Proof')).not.toBeInTheDocument();
    expect(screen.queryByTestId('evidence-layers')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proof-download')).not.toBeInTheDocument();
  });

  it('renders the verified date only for secured records', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'SECURED',
        secured_at: '2026-04-01T12:00:00Z',
        network_receipt_id: 'receipt-123',
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    expect(await screen.findByText(/Verified on Apr 1, 2026/)).toBeInTheDocument();
    // SCRUM-2495 claims review: the hero subtitle binds permanence to the
    // record's FINGERPRINT, never the underlying document — the unscoped
    // "This record is permanently anchored." read as document-level
    // protection, contradicting the does-not-assert disclaimer below it.
    expect(screen.getByText('This record’s fingerprint is permanently anchored.')).toBeInTheDocument();
    expect(screen.queryByText('This record is permanently anchored.')).not.toBeInTheDocument();
    expect(screen.getByTestId('proof-download')).toBeInTheDocument();
  });

  it('treats ACTIVE public API responses as the secured public state', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'ACTIVE',
        secured_at: '2026-04-01T12:00:00Z',
        network_receipt_id: 'receipt-123',
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    expect(await screen.findByText(/Verified on Apr 1, 2026/)).toBeInTheDocument();
    expect(screen.getByText('Secured')).toBeInTheDocument();
    expect(screen.queryByText('ACTIVE')).not.toBeInTheDocument();
    expect(screen.getByTestId('credential-renderer')).toHaveTextContent('credential status: SECURED');
    expect(screen.getByTestId('compliance-badge')).toBeInTheDocument();
    expect(screen.getByTestId('evidence-layers')).toHaveTextContent('1 active');
    expect(screen.getByTestId('proof-download')).toBeInTheDocument();
  });

  it('renders EXPIRED records as terminal with proof affordances', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'EXPIRED',
        secured_at: '2026-04-01T12:00:00Z',
        network_receipt_id: 'receipt-123',
        expires_at: '2026-04-02T00:00:00Z',
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    expect(await screen.findByText('Record Expired')).toBeInTheDocument();
    expect(screen.getByText('This record has passed its expiration date')).toBeInTheDocument();
    expect(screen.getByText('Cryptographic Proof')).toBeInTheDocument();
    expect(screen.getByTestId('evidence-layers')).toHaveTextContent('1 active');
    expect(screen.getByTestId('proof-download')).toBeInTheDocument();
  });

  it('renders REVOKED records as terminal with revocation details and proof affordances', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'REVOKED',
        secured_at: '2026-04-01T12:00:00Z',
        network_receipt_id: 'receipt-123',
        revoked_at: '2026-04-02T00:00:00Z',
        revocation_reason: 'Superseded credential',
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    expect(await screen.findByText('Record Revoked')).toBeInTheDocument();
    expect(screen.getByText('This record has been revoked by the issuing organization')).toBeInTheDocument();
    expect(screen.getByText('Superseded credential')).toBeInTheDocument();
    expect(screen.getByText('Cryptographic Proof')).toBeInTheDocument();
    expect(screen.getByTestId('evidence-layers')).toHaveTextContent('1 active');
    expect(screen.getByTestId('proof-download')).toBeInTheDocument();
    // BUG-2026-06-24-007: revoked credentials must NOT render the SOC2/HIPAA/
    // eIDAS compliance controls — those controls no longer apply once revoked
    // (claims-gate §1.5/§1.13). The compliance section is gated on isSecured.
    expect(screen.queryByTestId('compliance-badge')).not.toBeInTheDocument();
  });

  it('does not render compliance controls for SUPERSEDED records (BUG-2026-06-24-007)', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'SUPERSEDED',
        secured_at: '2026-04-01T12:00:00Z',
        network_receipt_id: 'receipt-123',
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    expect(await screen.findByText('Record Superseded')).toBeInTheDocument();
    expect(screen.queryByTestId('compliance-badge')).not.toBeInTheDocument();
  });

  it('renders SUPERSEDED records as visible terminal records with proof affordances', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'SUPERSEDED',
        secured_at: '2026-04-01T12:00:00Z',
        network_receipt_id: 'receipt-123',
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    expect(await screen.findByText('Record Superseded')).toBeInTheDocument();
    expect(screen.getByText('This record has been replaced by a newer version.')).toBeInTheDocument();
    expect(screen.queryByText('Submitting to network...')).not.toBeInTheDocument();
    expect(screen.getByText('Cryptographic Proof')).toBeInTheDocument();
    expect(screen.getByTestId('evidence-layers')).toHaveTextContent('1 active');
    expect(screen.getByTestId('proof-download')).toBeInTheDocument();
  });

  it('uses public-safe source provenance from sanitized metadata without exposing hidden PII', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'SECURED',
        secured_at: '2026-04-01T12:00:00Z',
        network_receipt_id: 'receipt-123',
        metadata: {
          source_url: 'https://credly.com/badges/abc?token=secret&id=visible',
          source_provider: 'credly',
          verification_level: 'source_signed',
          evidence_package_hash: 'evidence-hash-123',
          source_payload_hash: 'payload-hash-456',
          source_fetched_at: '2026-04-01T11:45:00Z',
          email: 'private@example.com',
        },
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    expect(await screen.findByTestId('source-provenance-display')).toBeInTheDocument();
    const sourceLink = screen.getByTestId('source-url-link');
    expect(sourceLink).toHaveAttribute('href', 'https://credly.com/badges/abc?id=visible');
    expect(screen.getByText('Credly')).toBeInTheDocument();
    expect(screen.getByText('Source Signed')).toBeInTheDocument();

    const credentialRenderer = screen.getByTestId('credential-renderer');
    // FE-PROOF-GATE (SCRUM-2501): proof-download no longer receives
    // sourceProvenance/evidence hashes at all — it fetches its own data live
    // from /api/v1/verify/:publicId/proof. The security-relevant assertion
    // (no PII/secret leak) stays; it's exercised against credential-renderer
    // and the page body, not the (now hash-free) proof-download mock.
    expect(credentialRenderer).not.toHaveTextContent('private@example.com');
    expect(credentialRenderer).not.toHaveTextContent('token=secret');
    expect(credentialRenderer).not.toHaveTextContent('evidence-hash-123');
    expect(screen.queryByText('private@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText(/token=secret/)).not.toBeInTheDocument();
  });

  // R19 (CTO ruling 2026-07-28, advances SCRUM-2481): fingerprint_source
  // renders as a distinct section, orthogonal to Source Provenance/EvidenceLevel.
  describe('R19: fingerprint_source', () => {
    it('renders the document-derived tier for fingerprint_source=document_bytes', async () => {
      rpcMock.mockResolvedValue({
        data: {
          ...baseAnchor,
          status: 'SECURED',
          secured_at: '2026-04-01T12:00:00Z',
          network_receipt_id: 'receipt-123',
          fingerprint_source: 'document_bytes',
        },
        error: null,
      });

      render(<PublicVerification publicId="ARK-DOC-123" />);

      const display = await screen.findByTestId('fingerprint-source-display');
      expect(display).toBeInTheDocument();
      const badge = screen.getByTestId('fingerprint-source-badge');
      expect(badge).toHaveAttribute('data-fingerprint-source', 'document_bytes');
      expect(screen.getByText('Document Fingerprint')).toBeInTheDocument();
    });

    it('renders the record-derived (issuer attestation) tier without implying document custody', async () => {
      rpcMock.mockResolvedValue({
        data: {
          ...baseAnchor,
          status: 'SECURED',
          secured_at: '2026-04-01T12:00:00Z',
          network_receipt_id: 'receipt-123',
          fingerprint_source: 'issuer_record_attestation',
        },
        error: null,
      });

      render(<PublicVerification publicId="ARK-DOC-123" />);

      const badge = await screen.findByTestId('fingerprint-source-badge');
      expect(badge).toHaveAttribute('data-fingerprint-source', 'issuer_record_attestation');
      expect(screen.getByText('Issuer-Attested Record')).toBeInTheDocument();

      // R-7 claims gate: must state no source document was supplied.
      const asserted = screen.getByTestId('fingerprint-source-triad-asserted');
      expect(asserted.textContent?.toLowerCase()).toContain('no source document');
    });

    it('renders nothing when fingerprint_source is null (unclassified/pre-R19 anchor)', async () => {
      rpcMock.mockResolvedValue({
        data: {
          ...baseAnchor,
          status: 'SECURED',
          secured_at: '2026-04-01T12:00:00Z',
          network_receipt_id: 'receipt-123',
          fingerprint_source: null,
        },
        error: null,
      });

      render(<PublicVerification publicId="ARK-DOC-123" />);

      await screen.findByText('Cryptographic Proof');
      expect(screen.queryByTestId('fingerprint-source-display')).not.toBeInTheDocument();
    });
  });

  // SCRUM-2481: a captured_url anchor's PUBLIC page must never present the
  // green issuer-verified evidence badge, and must surface the NOT-asserted
  // issuer-identity disclaimer.
  it('never shows the green issuer-verified badge for a captured_url anchor', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'SECURED',
        secured_at: '2026-04-01T12:00:00Z',
        network_receipt_id: 'receipt-123',
        metadata: {
          source_url: 'https://credly.com/badges/abc?id=visible',
          source_provider: 'credly',
          verification_level: 'captured_url',
          evidence_package_hash: 'evidence-hash-123',
          source_payload_hash: 'payload-hash-456',
          source_fetched_at: '2026-04-01T11:45:00Z',
        },
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    const badge = await screen.findByTestId('evidence-level-badge');
    expect(badge).toHaveAttribute('data-evidence-tier', 'captured_url');
    // Structural honesty: no green treatment, no issuer-family wording.
    expect(badge.className).not.toContain('green');
    const ariaLabel = (badge.getAttribute('aria-label') ?? '').toLowerCase();
    expect(ariaLabel).not.toContain('verified');
    expect(ariaLabel).not.toContain('issuer');

    // The public triad states issuer identity is NOT asserted.
    const notAsserted = screen.getByTestId('evidence-triad-not-asserted');
    expect(notAsserted.textContent?.toLowerCase()).toContain('issuer identity');
  });

  // SCRUM-2481 [P1]: the embeddable Arkova badge + LinkedIn Credential-URL
  // share helper are issuer-STYLE off-platform affordances. They must be gated
  // on isIssuerAuthenticated(level) — the same gate that earns the green
  // treatment — NOT merely on isSecured. A low-trust captured_url /
  // account_linked / ai_captured record that is SECURED must NOT get an
  // embeddable/shareable issuer-looking badge.
  it('does not render the embeddable badge or LinkedIn share for a captured_url anchor', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'SECURED',
        secured_at: '2026-04-01T12:00:00Z',
        network_receipt_id: 'receipt-123',
        metadata: {
          source_provider: 'credly',
          verification_level: 'captured_url',
        },
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    // The record still renders (proof affordances present for a secured anchor)…
    expect(await screen.findByTestId('proof-download')).toBeInTheDocument();
    // …but the issuer-style embeddable/shareable affordances are absent.
    expect(screen.queryByTestId('arkova-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('linkedin-credential-helper')).not.toBeInTheDocument();
  });

  it('does not render the embeddable badge or LinkedIn share for an account_linked anchor', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'SECURED',
        secured_at: '2026-04-01T12:00:00Z',
        network_receipt_id: 'receipt-123',
        metadata: {
          source_provider: 'linkedin',
          verification_level: 'account_linked',
        },
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    expect(await screen.findByTestId('proof-download')).toBeInTheDocument();
    expect(screen.queryByTestId('arkova-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('linkedin-credential-helper')).not.toBeInTheDocument();
  });

  it('does not render the embeddable badge or LinkedIn share for a SECURED anchor with no evidence level', async () => {
    // A plain user-uploaded secured document has no verification_level. It is
    // not issuer-authenticated, so it must not surface an issuer-style badge.
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'SECURED',
        secured_at: '2026-04-01T12:00:00Z',
        network_receipt_id: 'receipt-123',
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    expect(await screen.findByTestId('proof-download')).toBeInTheDocument();
    expect(screen.queryByTestId('arkova-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('linkedin-credential-helper')).not.toBeInTheDocument();
  });

  it('renders the embeddable badge and LinkedIn share for an issuer_anchored anchor', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'SECURED',
        secured_at: '2026-04-01T12:00:00Z',
        network_receipt_id: 'receipt-123',
        metadata: {
          source_provider: 'credly',
          verification_level: 'issuer_anchored',
        },
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    expect(await screen.findByTestId('arkova-badge')).toBeInTheDocument();
    expect(screen.getByTestId('linkedin-credential-helper')).toBeInTheDocument();
  });

  it('renders the embeddable badge and LinkedIn share for a source_signed anchor', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'SECURED',
        secured_at: '2026-04-01T12:00:00Z',
        network_receipt_id: 'receipt-123',
        metadata: {
          source_provider: 'accredible',
          verification_level: 'source_signed',
        },
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    expect(await screen.findByTestId('arkova-badge')).toBeInTheDocument();
    expect(screen.getByTestId('linkedin-credential-helper')).toBeInTheDocument();
  });

  it('renders source provenance when only proof hashes are present', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'SECURED',
        secured_at: '2026-04-01T12:00:00Z',
        network_receipt_id: 'receipt-123',
        metadata: {
          evidence_package_hash: 'evidence-hash-123',
          source_payload_hash: 'payload-hash-456',
        },
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    expect(await screen.findByTestId('source-provenance-display')).toBeInTheDocument();
    expect(screen.getByTestId('source-provenance-display')).not.toHaveTextContent('evidence-hash-123');
  });

  // SCRUM-2913 (Lane 2 wiring) — round-trip: get_public_anchor (0362) nests
  // registry_url / ce_envelope_sha256 under `metadata`. These keys were
  // previously ALLOW-LISTED but never PRODUCED anywhere (an inert column) —
  // this pins that a CE-imported record's page actually surfaces them, and
  // that a normal (non-CE) record's page never shows the row at all.
  describe('CE Registry provenance round-trip (registry_url + ce_envelope_sha256)', () => {
    const REGISTRY_URL = 'https://credentialengineregistry.org/resources/ce-11111111-2222-4333-8444-555555555555';

    it('surfaces the registry reference link for a CE-imported record', async () => {
      rpcMock.mockResolvedValue({
        data: {
          ...baseAnchor,
          status: 'SECURED',
          secured_at: '2026-04-01T12:00:00Z',
          network_receipt_id: 'receipt-123',
          metadata: {
            registry_url: REGISTRY_URL,
            ce_envelope_sha256: 'c'.repeat(64),
          },
        },
        error: null,
      });

      render(<PublicVerification publicId="ARK-DOC-123" />);

      expect(await screen.findByTestId('source-provenance-display')).toBeInTheDocument();
      const registryLink = screen.getByTestId('registry-reference-link');
      expect(registryLink).toHaveAttribute('href', REGISTRY_URL);
      // The integrity fingerprint is carried, but never rendered raw on the page.
      expect(screen.getByTestId('source-provenance-display')).not.toHaveTextContent('c'.repeat(64));
      // Never a raw dump in the generic credential metadata section either.
      expect(screen.getByTestId('credential-renderer')).not.toHaveTextContent(REGISTRY_URL);
    });

    it('OMITS the registry reference entirely for a non-CE record (absent, not a blank row)', async () => {
      rpcMock.mockResolvedValue({
        data: {
          ...baseAnchor,
          status: 'SECURED',
          secured_at: '2026-04-01T12:00:00Z',
          network_receipt_id: 'receipt-123',
          metadata: {
            source_url: 'https://credly.com/badges/abc',
            source_provider: 'credly',
          },
        },
        error: null,
      });

      render(<PublicVerification publicId="ARK-DOC-123" />);

      expect(await screen.findByTestId('source-provenance-display')).toBeInTheDocument();
      expect(screen.queryByTestId('registry-reference-link')).not.toBeInTheDocument();
    });

    it('OMITS the registry reference when the anchor has no metadata at all', async () => {
      rpcMock.mockResolvedValue({
        data: {
          ...baseAnchor,
          status: 'SECURED',
          secured_at: '2026-04-01T12:00:00Z',
          network_receipt_id: 'receipt-123',
        },
        error: null,
      });

      render(<PublicVerification publicId="ARK-DOC-123" />);

      await screen.findByTestId('does-not-assert-disclaimer');
      expect(screen.queryByTestId('registry-reference-link')).not.toBeInTheDocument();
    });
  });

  // SCRUM-2495 / ABUSE-DISCLAIMER: the does-not-assert disclaimer must always
  // render on the verification surface, visibly, without requiring a click or
  // hover to reveal it (CLAUDE.md §1.5).
  it('always renders the does-not-assert disclaimer, visibly, for a secured record', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'SECURED',
        secured_at: '2026-04-01T12:00:00Z',
        network_receipt_id: 'receipt-123',
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    const disclaimer = await screen.findByTestId('does-not-assert-disclaimer');
    expect(disclaimer).toBeVisible();
    expect(disclaimer).toHaveTextContent(/Fingerprint/);
    expect(disclaimer).toHaveTextContent(/Network Observed Time/);
    expect(disclaimer).toHaveTextContent(/Secured status/);
    expect(disclaimer).toHaveTextContent(/identity of the signer or uploader/);
    expect(disclaimer).toHaveTextContent(/legal validity/);
    expect(disclaimer).toHaveTextContent(/informational metadata only/);
  });

  it('always renders the does-not-assert disclaimer for a pre-secured (SUBMITTED) record', async () => {
    rpcMock.mockResolvedValue({
      data: { ...baseAnchor, status: 'SUBMITTED' },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    // Disclaimer renders regardless of proof-affordance gating (hasProof is
    // false for SUBMITTED) — it is not conditioned on the proof section.
    expect(await screen.findByTestId('does-not-assert-disclaimer')).toBeVisible();
  });

  // BUG-2026-07-17-010 (SCRUM-2910, P0): historical fraud_* metadata keys must
  // NEVER render on the PUBLIC verification page. No hidden-key filter covered
  // the fraud_ prefix, so public links could show fraud_score.
  it('never renders fraud_* metadata keys on the public verification page (BUG-2026-07-17-010)', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'SECURED',
        secured_at: '2026-04-01T12:00:00Z',
        network_receipt_id: 'receipt-123',
        metadata: {
          field_of_study: 'Computer Science',
          fraud_score: 0.87,
          fraud_risk_level: 'high',
          fraud_signals: [{ signal_type: 'future_date', score: 0.35, field_affected: 'issuedDate' }],
          fraud_analysis_method: 'client_side_worker_v2',
          fraud_processing_time_ms: 12,
          fraudSignals: '["Font inconsistency detected"]',
        },
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    // The sanitized metadata handed to the credential card keeps legitimate
    // keys but must carry no fraud-derived key or value.
    const credentialRenderer = await screen.findByTestId('credential-renderer');
    expect(credentialRenderer).toHaveTextContent('Computer Science');
    expect(credentialRenderer.textContent?.toLowerCase()).not.toContain('fraud');
    expect(credentialRenderer).not.toHaveTextContent('0.87');
    expect(credentialRenderer).not.toHaveTextContent('client_side_worker_v2');
    expect(credentialRenderer).not.toHaveTextContent('Font inconsistency');
    // And nothing fraud-derived may appear anywhere else on the page either.
    expect(document.body.textContent?.toLowerCase()).not.toContain('fraud');
    expect(document.body.textContent).not.toContain('0.87');
  });
});
