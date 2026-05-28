/**
 * NotarizationBadge Tests (SCRUM-1874)
 *
 * TDD: written before the component implementation.
 * Verifies the notarization badge renders DocuSign/notarization
 * status correctly based on legally_binding_attestations data.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NotarizationBadge } from './NotarizationBadge';
import { ATTESTATION_LABELS } from '@/lib/copy';

describe('NotarizationBadge', () => {
  it('renders nothing when no notarization data is provided', () => {
    const { container } = render(<NotarizationBadge />);
    expect(container.firstChild).toBeNull();
  });

  it('renders notarized badge when notarization is complete', () => {
    render(
      <NotarizationBadge
        notarizationCompletedAt="2026-05-15T10:00:00Z"
        notaryName="Jane Smith"
        notaryCommissionNumber="COM-123456"
        notaryCommissionState="California"
      />,
    );
    expect(screen.getByText(ATTESTATION_LABELS.NOTARIZED)).toBeInTheDocument();
  });

  it('renders notary name when provided', () => {
    render(
      <NotarizationBadge
        notarizationCompletedAt="2026-05-15T10:00:00Z"
        notaryName="Jane Smith"
      />,
    );
    expect(screen.getByText('Jane Smith')).toBeInTheDocument();
  });

  it('renders notary commission details when provided', () => {
    render(
      <NotarizationBadge
        notarizationCompletedAt="2026-05-15T10:00:00Z"
        notaryName="Jane Smith"
        notaryCommissionNumber="COM-123456"
        notaryCommissionState="California"
      />,
    );
    expect(screen.getByText('COM-123456')).toBeInTheDocument();
    expect(screen.getByText('California')).toBeInTheDocument();
  });

  it('renders e-signature completion when docusign data is provided', () => {
    render(
      <NotarizationBadge
        docusignEnvelopeId="ENV-789"
        docusignCompletedAt="2026-05-14T09:00:00Z"
      />,
    );
    expect(screen.getByText(ATTESTATION_LABELS.ESIGN_COMPLETED)).toBeInTheDocument();
  });

  it('renders both notarization and e-signature when both are present', () => {
    render(
      <NotarizationBadge
        notarizationCompletedAt="2026-05-15T10:00:00Z"
        notaryName="Jane Smith"
        docusignEnvelopeId="ENV-789"
        docusignCompletedAt="2026-05-14T09:00:00Z"
      />,
    );
    expect(screen.getByText(ATTESTATION_LABELS.NOTARIZED)).toBeInTheDocument();
    expect(screen.getByText(ATTESTATION_LABELS.ESIGN_COMPLETED)).toBeInTheDocument();
  });

  it('renders envelope ID in monospace font', () => {
    render(
      <NotarizationBadge
        docusignEnvelopeId="ENV-789"
        docusignCompletedAt="2026-05-14T09:00:00Z"
      />,
    );
    const envelopeEl = screen.getByText('ENV-789');
    expect(envelopeEl.classList.contains('font-mono') || envelopeEl.closest('.font-mono')).toBeTruthy();
  });

  it('does not render banned terms', () => {
    const banned = ['wallet', 'gas', 'hash', 'block', 'transaction', 'crypto', 'blockchain', 'bitcoin'];
    const { container } = render(
      <NotarizationBadge
        notarizationCompletedAt="2026-05-15T10:00:00Z"
        notaryName="Jane Smith"
        notaryCommissionNumber="COM-123456"
        notaryCommissionState="California"
        docusignEnvelopeId="ENV-789"
        docusignCompletedAt="2026-05-14T09:00:00Z"
      />,
    );
    const text = container.textContent?.toLowerCase() ?? '';
    for (const term of banned) {
      expect(text).not.toContain(term);
    }
  });
});
