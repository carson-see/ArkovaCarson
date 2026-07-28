/**
 * FingerprintSourceDisplay Tests (R19, CTO ruling 2026-07-28, advances SCRUM-2481)
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FingerprintSourceDisplay } from './FingerprintSourceDisplay';
import { FINGERPRINT_SOURCE_LABELS } from '@/lib/copy';

describe('FingerprintSourceDisplay', () => {
  it('renders nothing for null (unclassified/pre-R19 anchor)', () => {
    const { container } = render(<FingerprintSourceDisplay value={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for undefined', () => {
    const { container } = render(<FingerprintSourceDisplay value={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for an unknown value', () => {
    const { container } = render(<FingerprintSourceDisplay value="bogus" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the Document Fingerprint label for document_bytes', () => {
    render(<FingerprintSourceDisplay value="document_bytes" />);
    expect(screen.getByText(FINGERPRINT_SOURCE_LABELS.document_bytes)).toBeInTheDocument();
  });

  it('renders the Issuer-Attested Record label for issuer_record_attestation', () => {
    render(<FingerprintSourceDisplay value="issuer_record_attestation" />);
    expect(screen.getByText(FINGERPRINT_SOURCE_LABELS.issuer_record_attestation)).toBeInTheDocument();
  });

  it('renders the measured/asserted/NOT-asserted triad for document_bytes', () => {
    render(<FingerprintSourceDisplay value="document_bytes" />);
    expect(screen.getByTestId('fingerprint-source-triad-measured')).toBeInTheDocument();
    expect(screen.getByTestId('fingerprint-source-triad-asserted')).toBeInTheDocument();
    expect(screen.getByTestId('fingerprint-source-triad-not-asserted')).toBeInTheDocument();
  });

  // R-7 claims gate honesty invariant: the record-derived tier must never
  // claim or imply Arkova received/reviewed a source document.
  it('issuer_record_attestation triad never implies document custody', () => {
    render(<FingerprintSourceDisplay value="issuer_record_attestation" />);
    const asserted = screen.getByTestId('fingerprint-source-triad-asserted').textContent ?? '';
    const notAsserted = screen.getByTestId('fingerprint-source-triad-not-asserted').textContent ?? '';

    // The asserted claim must be scoped to record content, not document
    // custody, and must explicitly disclaim a source document was supplied.
    expect(asserted.toLowerCase()).toContain('no source document');
    // The notAsserted row must carry the document-existence disclaimer.
    expect(notAsserted.toLowerCase()).toContain('document');
  });

  it('sets a data-fingerprint-source attribute matching the tier', () => {
    render(<FingerprintSourceDisplay value="issuer_record_attestation" />);
    expect(screen.getByTestId('fingerprint-source-badge')).toHaveAttribute(
      'data-fingerprint-source',
      'issuer_record_attestation'
    );
  });
});
