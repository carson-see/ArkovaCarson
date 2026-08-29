/**
 * SCRUM-3529 — the public verify page must render the credential's SUB-TYPE,
 * not the generic "Other", when `credential_type` carries no useful label.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM PublicVerification.test.tsx.
 * That suite mocks `CredentialRenderer` at module scope, so it can prove which
 * props are handed over but can never prove what the user actually SEES. This
 * regression was invisible for months precisely because every existing test
 * asserted a helper or a prop rather than the rendered label: SCRUM-952 fixed
 * `formatCredentialSubType`, SCRUM-1482 wired the fallback, and then migration
 * 0355 turned `get_public_anchor`'s metadata into an allow-list, dropped the
 * `sub_type` key, and made the whole path unreachable — with every one of those
 * tests still green.
 *
 * So this file mounts the REAL CredentialRenderer and asserts on visible text,
 * end to end from the RPC payload. It is the pin the earlier fix lacked.
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

// NOTE: CredentialRenderer is deliberately NOT mocked.

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

const securedAnchor = {
  public_id: 'ARK-DOC-123',
  fingerprint: 'a'.repeat(64),
  filename: 'record.pdf',
  verified: true,
  status: 'SECURED',
  credential_type: 'OTHER',
  metadata: {},
  created_at: '2026-04-01T00:00:00Z',
  secured_at: '2026-04-01T12:00:00Z',
};

describe('PublicVerification — credential sub-type label (SCRUM-3529)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the sub-type from the top-level sub_type key instead of "Other"', async () => {
    rpcMock.mockResolvedValue({
      data: { ...securedAnchor, sub_type: 'professional_certification' },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    expect(
      (await screen.findAllByText('Professional Certification')).length,
    ).toBeGreaterThanOrEqual(1);
    // The whole point: the generic parent label must not be what the verifier reads.
    expect(screen.queryByText('Other')).not.toBeInTheDocument();
    // And the raw column value is never shown to a human.
    expect(screen.queryByText('professional_certification')).not.toBeInTheDocument();
  });

  it('still shows the generic label when the anchor genuinely has no sub-type', async () => {
    rpcMock.mockResolvedValue({
      data: { ...securedAnchor, sub_type: null },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    // Wait for the page to settle on the same anchor the other cases use.
    expect(await screen.findByText(/Verified on Apr 1, 2026/)).toBeInTheDocument();
    expect(screen.getByText('Other')).toBeInTheDocument();
    // A null column must never surface the em-dash placeholder that
    // formatCredentialSubType returns for nullish input.
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('renders a pre-0421 payload with NO sub_type key as the generic label', async () => {
    // 0421 always emits the key (the top-level object is not
    // jsonb_strip_nulls-ed), so an ABSENT sub_type is not a shape the current
    // projection produces. It is pinned anyway because it IS the shape every
    // pre-0421 payload has — a cached response, a stale PostgREST schema cache,
    // or a rollback to the 0385 body — and the page must degrade to the parent
    // label rather than to `undefined`.
    rpcMock.mockResolvedValue({ data: { ...securedAnchor }, error: null });

    render(<PublicVerification publicId="ARK-DOC-123" />);

    expect(await screen.findByText(/Verified on Apr 1, 2026/)).toBeInTheDocument();
    expect(screen.getByText('Other')).toBeInTheDocument();
  });
});
