/**
 * PublicVerification.record-readability.test.tsx
 *
 * TDD red-first for the record-detail readability pass (founder-reported,
 * 2026-09-29). Checking whether the PUBLIC verification page has the same
 * raw-id/missing-version problems the authenticated Record Detail page had.
 * Findings: the page never rendered `data.filename` as a visible title (so
 * no raw-id title bug here), but it said nothing about a SUPERSEDED record
 * remaining valid evidence, and its JSON-LD `name` field used the raw
 * filename verbatim — the same connector-internal-id problem in a
 * less-visible place (structured data read by search engines/AI crawlers).
 *
 * `version_number`/`parent_public_id` are additive-nullable fields the
 * verification API already returns (§1.8) — no API change here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PublicVerification } from './PublicVerification';

const rpcMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));
vi.mock('@/lib/logVerificationEvent', () => ({ logVerificationEvent: vi.fn() }));
vi.mock('@/hooks/useCredentialTemplate', () => ({ useCredentialTemplate: () => ({ template: null }) }));
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
  public_id: 'ARK-DOC-7RFUVV',
  fingerprint: 'a'.repeat(64),
  filename: 'google_drive:1IxoLk_vWeuU-BB-2Qkmvs8QmV1qi_GKnGxZF8YheIu8',
  verified: true,
  credential_type: 'OTHER',
  metadata: { connector_source: 'google_drive', _drive_folder_path: '/Legal/Q3 Vendor Agreement.gsheet' },
  created_at: '2026-09-01T00:00:00Z',
};

describe('PublicVerification — record readability pass', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tells a superseded record it remains valid evidence, and links to the version it replaced', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'SUPERSEDED',
        superseded_at: '2026-09-29T20:47:10.002Z',
        version_number: 1,
        parent_public_id: null,
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-7RFUVV" />);

    const note = await screen.findByTestId('public-superseded-version-note');
    expect(note).toHaveTextContent(/remains valid evidence/i);
  });

  it('links back to the earlier version when the API provided a parent_public_id', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...baseAnchor,
        status: 'SUPERSEDED',
        version_number: 2,
        parent_public_id: 'ARK-DOC-OLDER',
      },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-7RFUVV" />);

    const link = await screen.findByTestId('public-previous-version-link');
    expect(link).toHaveAttribute('href', '/verify/ARK-DOC-OLDER');
  });

  it('does not render the version note for a non-superseded record', async () => {
    rpcMock.mockResolvedValue({ data: { ...baseAnchor, status: 'SECURED' }, error: null });

    render(<PublicVerification publicId="ARK-DOC-7RFUVV" />);

    await screen.findByTestId('credential-renderer');
    expect(screen.queryByTestId('public-superseded-version-note')).not.toBeInTheDocument();
  });

  it('uses a derived display name — never the raw connector internal id — as the JSON-LD name', async () => {
    rpcMock.mockResolvedValue({ data: { ...baseAnchor, status: 'SECURED' }, error: null });

    render(<PublicVerification publicId="ARK-DOC-7RFUVV" />);
    await screen.findByTestId('credential-renderer');

    const script = document.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const jsonLd = JSON.parse(script!.textContent ?? '{}');
    expect(jsonLd.name).toBe('Q3 Vendor Agreement.gsheet');
    expect(jsonLd.name).not.toContain('google_drive:');
  });
});
