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
  VerifierProofDownload: ({ sourceProvenance }: { sourceProvenance?: unknown }) => (
    <div data-testid="proof-download">
      {JSON.stringify(sourceProvenance ?? {})}
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
    expect(screen.getByText('This record is permanently anchored.')).toBeInTheDocument();
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

    const proofDownload = screen.getByTestId('proof-download');
    const credentialRenderer = screen.getByTestId('credential-renderer');
    expect(proofDownload).toHaveTextContent('evidence-hash-123');
    expect(proofDownload).toHaveTextContent('payload-hash-456');
    expect(credentialRenderer).not.toHaveTextContent('private@example.com');
    expect(credentialRenderer).not.toHaveTextContent('token=secret');
    expect(credentialRenderer).not.toHaveTextContent('evidence-hash-123');
    expect(proofDownload).not.toHaveTextContent('private@example.com');
    expect(screen.queryByText('private@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText(/token=secret/)).not.toBeInTheDocument();
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
    expect(screen.getByTestId('proof-download')).toHaveTextContent('evidence-hash-123');
  });
});
