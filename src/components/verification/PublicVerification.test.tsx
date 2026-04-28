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
  CredentialRenderer: () => <div data-testid="credential-renderer" />,
}));

vi.mock('@/components/anchor/AnchorLifecycleTimeline', () => ({
  AnchorLifecycleTimeline: () => <div data-testid="lifecycle-timeline" />,
}));

vi.mock('@/components/public/ProvenanceTimeline', () => ({
  ProvenanceTimeline: () => <div data-testid="provenance-timeline" />,
}));

vi.mock('@/components/verification/VerifierProofDownload', () => ({
  VerifierProofDownload: () => <div data-testid="proof-download" />,
}));

vi.mock('@/components/verification/EvidenceLayersSection', () => ({
  EvidenceLayersSection: () => <div data-testid="evidence-layers" />,
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
});
