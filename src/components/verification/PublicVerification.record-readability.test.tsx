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
 * The public page carries NO link between versions (PR #3190 review
 * finding 2). `get_public_anchor` emits neither `version_number` nor
 * `parent_public_id` (confirmed against production), and the worker's
 * `GET /api/v1/verify/:publicId` writes an audit row and dispatches a
 * customer webhook on every call, so a page view must never call it.
 * `global.fetch` is stubbed here only to prove that it is not called.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PublicVerification } from './PublicVerification';

const rpcMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));
vi.mock('@/lib/logVerificationEvent', () => ({ logVerificationEvent: vi.fn() }));
vi.mock('@/lib/workerClient', () => ({ WORKER_URL: 'https://worker.test' }));
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

function fetchJsonResponse(status: number, body: unknown) {
  return { status, json: async () => body } as Response;
}

describe('PublicVerification — record readability pass', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn().mockResolvedValue(fetchJsonResponse(200, { verified: true, status: 'SUPERSEDED' }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tells a superseded record it remains valid evidence', async () => {
    rpcMock.mockResolvedValue({
      data: { ...baseAnchor, status: 'SUPERSEDED', superseded_at: '2026-09-29T20:47:10.002Z' },
      error: null,
    });

    render(<PublicVerification publicId="ARK-DOC-7RFUVV" />);

    const note = await screen.findByTestId('public-superseded-version-note');
    expect(note).toHaveTextContent(/remains valid evidence/i);
  });

  it('never calls the worker verify endpoint from a page view: that endpoint writes an audit row and notifies the record owner', async () => {
    rpcMock.mockResolvedValue({ data: { ...baseAnchor, status: 'SUPERSEDED' }, error: null });

    render(<PublicVerification publicId="ARK-DOC-7RFUVV" />);

    await screen.findByTestId('public-superseded-version-note');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('public-previous-version-link')).not.toBeInTheDocument();
  });

  it('does not render the version note for a non-superseded record', async () => {
    rpcMock.mockResolvedValue({ data: { ...baseAnchor, status: 'SECURED' }, error: null });

    render(<PublicVerification publicId="ARK-DOC-7RFUVV" />);

    await screen.findByTestId('credential-renderer');
    expect(screen.queryByTestId('public-superseded-version-note')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
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
