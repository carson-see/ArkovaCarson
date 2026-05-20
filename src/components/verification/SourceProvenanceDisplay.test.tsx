/**
 * SourceProvenanceDisplay Tests (CSI-03 / SCRUM-1599)
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SourceProvenanceDisplay } from './SourceProvenanceDisplay';

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
