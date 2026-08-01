/**
 * SourceProvenanceDisplay Tests (CSI-03 / SCRUM-1599)
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SourceProvenanceDisplay } from './SourceProvenanceDisplay';
import { EVIDENCE_TRIAD, EVIDENCE_TRIAD_LABELS, type EvidenceLevel } from '@/lib/copy';

const FULL_DATA = {
  source_url: 'https://www.credly.com/badges/12345678-abcd-efgh',
  source_provider: 'credly',
  verification_level: 'captured_url' as const,
  fetched_at: '2026-05-10T12:00:00Z',
  evidence_package_hash: 'a'.repeat(64),
  source_payload_hash: 'b'.repeat(64),
};

describe('SourceProvenanceDisplay', () => {
  it('renders nothing when no provenance data is available', () => {
    const { container } = render(<SourceProvenanceDisplay data={{}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders section title when data is present', () => {
    render(<SourceProvenanceDisplay data={FULL_DATA} />);
    expect(screen.getByText('Source Provenance')).toBeInTheDocument();
  });

  it('shows the source URL as a link', () => {
    render(<SourceProvenanceDisplay data={FULL_DATA} />);
    const link = screen.getByTestId('source-url-link');
    expect(link).toHaveAttribute('href', 'https://www.credly.com/badges/12345678-abcd-efgh');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does not show source URL when unsafe', () => {
    const data = { ...FULL_DATA, source_url: 'https://user:pass@evil.com' };
    render(<SourceProvenanceDisplay data={data} />);
    expect(screen.queryByTestId('source-url-link')).not.toBeInTheDocument();
  });

  it('strips tokens from source URL before display', () => {
    const data = { ...FULL_DATA, source_url: 'https://example.com/badge?token=secret&id=123' };
    render(<SourceProvenanceDisplay data={data} />);
    const link = screen.getByTestId('source-url-link');
    expect(link.getAttribute('href')).not.toContain('token=secret');
    expect(link.getAttribute('href')).toContain('id=123');
  });

  it('shows formatted provider name', () => {
    render(<SourceProvenanceDisplay data={FULL_DATA} />);
    expect(screen.getByText('Credly')).toBeInTheDocument();
  });

  it('shows fetched_at date formatted', () => {
    render(<SourceProvenanceDisplay data={FULL_DATA} />);
    // Should show the date in some human-readable form
    expect(screen.getByText(/May 10, 2026/)).toBeInTheDocument();
  });

  it('shows evidence level badge', () => {
    render(<SourceProvenanceDisplay data={FULL_DATA} />);
    expect(screen.getByText('Captured URL Evidence')).toBeInTheDocument();
  });

  it('shows only provider when URL is null', () => {
    const data = { source_provider: 'linkedin', source_url: null };
    render(<SourceProvenanceDisplay data={data} />);
    expect(screen.getByText('LinkedIn')).toBeInTheDocument();
    expect(screen.queryByTestId('source-url-link')).not.toBeInTheDocument();
  });

  it('does not expose internal IDs', () => {
    render(<SourceProvenanceDisplay data={FULL_DATA} />);
    const html = screen.getByTestId('source-provenance-display').innerHTML;
    // evidence_package_hash and source_payload_hash should not be in the rendered output
    expect(html).not.toContain('a'.repeat(64));
    expect(html).not.toContain('b'.repeat(64));
  });

  it('renders a package summary for hash-only provenance without exposing hashes', () => {
    render(
      <SourceProvenanceDisplay
        data={{
          evidence_package_hash: 'evidence-hash-123',
          source_payload_hash: 'payload-hash-456',
        }}
      />
    );

    const section = screen.getByTestId('source-provenance-display');
    expect(section).toBeInTheDocument();
    expect(screen.getByTestId('source-evidence-package')).toHaveTextContent('Evidence Package');
    expect(section).not.toHaveTextContent('evidence-hash-123');
    expect(section).not.toHaveTextContent('payload-hash-456');
  });
});

// ─── SCRUM-2913 (Lane 2 wiring): CE Registry provenance link ─────────────────
describe('SourceProvenanceDisplay — CE Registry provenance (registry_url)', () => {
  const REGISTRY_URL = 'https://credentialengineregistry.org/resources/ce-11111111-2222-4333-8444-555555555555';

  it('renders the registry reference as a link when registry_url is present', () => {
    render(<SourceProvenanceDisplay data={{ registry_url: REGISTRY_URL }} />);

    const link = screen.getByTestId('registry-reference-link');
    expect(link).toHaveAttribute('href', REGISTRY_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('Registry reference:')).toBeInTheDocument();
  });

  it('shows R-7-honest provenance copy, never a listing/endorsement claim', () => {
    render(<SourceProvenanceDisplay data={{ registry_url: REGISTRY_URL }} />);

    const description = screen.getByTestId('registry-reference-description');
    expect(description.textContent?.toLowerCase()).not.toContain('listed');
    expect(description.textContent?.toLowerCase()).not.toContain('endorsed');
    expect(description.textContent).toContain('not a Credential Engine listing or endorsement');
  });

  it('does not render a registry reference when registry_url is absent', () => {
    render(<SourceProvenanceDisplay data={FULL_DATA} />);
    expect(screen.queryByTestId('registry-reference-link')).not.toBeInTheDocument();
  });

  it('strips tokens from registry_url before display, same as source_url', () => {
    render(<SourceProvenanceDisplay data={{ registry_url: `${REGISTRY_URL}?token=secret&locale=en` }} />);

    const link = screen.getByTestId('registry-reference-link');
    expect(link.getAttribute('href')).not.toContain('token=secret');
    expect(link.getAttribute('href')).toContain('locale=en');
  });

  it('does not show an unsafe registry_url (credential-embedded userinfo)', () => {
    render(<SourceProvenanceDisplay data={{ registry_url: 'https://user:pass@evil.example/resources/ce-x' }} />);
    expect(screen.queryByTestId('registry-reference-link')).not.toBeInTheDocument();
  });

  it('renders BOTH source_url and registry_url as distinct rows when both are present', () => {
    render(<SourceProvenanceDisplay data={{ ...FULL_DATA, registry_url: REGISTRY_URL }} />);

    expect(screen.getByTestId('source-url-link')).toHaveAttribute(
      'href',
      'https://www.credly.com/badges/12345678-abcd-efgh',
    );
    expect(screen.getByTestId('registry-reference-link')).toHaveAttribute('href', REGISTRY_URL);
  });

  it('renders the section (hasAnyContent) for registry_url alone, with no other provenance data', () => {
    const { container } = render(<SourceProvenanceDisplay data={{ registry_url: REGISTRY_URL }} />);
    expect(container.firstChild).not.toBeNull();
    expect(screen.getByTestId('source-provenance-display')).toBeInTheDocument();
  });

  // ce_envelope_sha256 was plumbed through the type + extractor but never
  // reached the DOM — a field that exists everywhere except the screen. It is
  // an integrity fingerprint of the CE envelope, so it belongs to the evidence
  // package alongside evidence_package_hash / source_payload_hash.
  it('counts ce_envelope_sha256 as evidence-package content', () => {
    render(<SourceProvenanceDisplay data={{ ce_envelope_sha256: 'a'.repeat(64) }} />);
    expect(screen.getByTestId('source-evidence-package')).toBeInTheDocument();
  });

  it('never renders the raw ce_envelope_sha256 value on the page', () => {
    const envelope = 'b'.repeat(64);
    const { container } = render(
      <SourceProvenanceDisplay data={{ registry_url: REGISTRY_URL, ce_envelope_sha256: envelope }} />,
    );
    expect(screen.getByTestId('source-evidence-package')).toBeInTheDocument();
    expect(container.textContent).not.toContain(envelope);
  });

  it('shows no evidence-package row when every hash is absent', () => {
    render(<SourceProvenanceDisplay data={{ registry_url: REGISTRY_URL }} />);
    expect(screen.queryByTestId('source-evidence-package')).not.toBeInTheDocument();
  });
});

// ─── SCRUM-2481: measured / asserted / NOT-asserted triad ────────────────────
describe('SourceProvenanceDisplay — SCRUM-2481 evidence triad', () => {
  it('renders the measured/asserted/NOT-asserted triad for a captured_url card', () => {
    render(
      <SourceProvenanceDisplay
        data={{ ...FULL_DATA, verification_level: 'captured_url' }}
      />
    );

    const triad = screen.getByTestId('evidence-triad');
    expect(triad).toBeInTheDocument();
    // §1.5: state what is measured, asserted, and NOT asserted.
    expect(triad).toHaveTextContent(/measured/i);
    expect(triad).toHaveTextContent(/asserted/i);
    expect(triad).toHaveTextContent(/not asserted/i);
  });

  it('a captured_url card explicitly states issuer identity is NOT asserted', () => {
    render(
      <SourceProvenanceDisplay
        data={{ ...FULL_DATA, verification_level: 'captured_url' }}
      />
    );

    const notAsserted = screen.getByTestId('evidence-triad-not-asserted');
    expect(notAsserted.textContent?.toLowerCase()).toContain('issuer identity');
  });

  it('an ai_captured card explicitly states issuer identity is NOT asserted', () => {
    render(
      <SourceProvenanceDisplay
        data={{ ...FULL_DATA, verification_level: 'ai_captured' }}
      />
    );

    const notAsserted = screen.getByTestId('evidence-triad-not-asserted');
    expect(notAsserted.textContent?.toLowerCase()).toContain('issuer identity');
  });

  it('an account_linked card explicitly states issuer identity is NOT asserted', () => {
    render(
      <SourceProvenanceDisplay
        data={{ ...FULL_DATA, verification_level: 'account_linked' }}
      />
    );

    const notAsserted = screen.getByTestId('evidence-triad-not-asserted');
    expect(notAsserted.textContent?.toLowerCase()).toContain('issuer identity');
  });

  it('an issuer_anchored card does NOT show an issuer-identity NOT-asserted disclaimer', () => {
    render(
      <SourceProvenanceDisplay
        data={{ ...FULL_DATA, verification_level: 'issuer_anchored' }}
      />
    );

    // Issuer tiers DO assert issuer identity, so the "NOT asserted: issuer
    // identity" disclaimer must be absent for them.
    const notAsserted = screen.queryByTestId('evidence-triad-not-asserted');
    if (notAsserted) {
      expect(notAsserted.textContent?.toLowerCase()).not.toContain('issuer identity');
    }
  });

  it('does not render the triad when no verification level is present', () => {
    render(
      <SourceProvenanceDisplay
        data={{ source_provider: 'credly', source_url: null }}
      />
    );
    expect(screen.queryByTestId('evidence-triad')).not.toBeInTheDocument();
  });

  // "No-op swap" guard: the component renders the triad from a local-const
  // EVIDENCE_TRIAD_FALLBACK + SOURCE_PROVENANCE_TRIAD_LABELS, held identical to
  // the canonical EVIDENCE_TRIAD / EVIDENCE_TRIAD_LABELS in copy.ts so the later
  // swap-to-import is a behaviour no-op. This pins the RENDERED triad rows to the
  // canonical copy.ts source per tier — green after the swap, red the moment the
  // fallback drifts from canon.
  const ALL_TIERS: EvidenceLevel[] = [
    'issuer_anchored',
    'source_signed',
    'account_linked',
    'captured_url',
    'ai_captured',
  ];

  it.each(ALL_TIERS)(
    'renders the canonical copy.ts triad (EVIDENCE_TRIAD) rows + labels for %s',
    (tier) => {
      render(<SourceProvenanceDisplay data={{ ...FULL_DATA, verification_level: tier }} />);

      const canon = EVIDENCE_TRIAD[tier];
      expect(screen.getByTestId('evidence-triad-measured').textContent).toBe(canon.measured);
      expect(screen.getByTestId('evidence-triad-asserted').textContent).toBe(canon.asserted);
      expect(screen.getByTestId('evidence-triad-not-asserted').textContent).toBe(canon.notAsserted);

      // Row labels render as "<Label>:" — the canonical label must be present.
      const triad = screen.getByTestId('evidence-triad');
      expect(triad).toHaveTextContent(EVIDENCE_TRIAD_LABELS.MEASURED);
      expect(triad).toHaveTextContent(EVIDENCE_TRIAD_LABELS.ASSERTED);
      expect(triad).toHaveTextContent(EVIDENCE_TRIAD_LABELS.NOT_ASSERTED);
    }
  );
});
