/**
 * EvidenceLayersSection Tests (COMP-01)
 *
 * Tests the collapsible evidence layers display on verification pages.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EvidenceLayersSection } from './EvidenceLayersSection';
import { EVIDENCE_LAYER_LABELS } from '@/lib/copy';

const anchorLayer = {
  type: 'anchor' as const,
  present: true,
  timestamp: '2026-03-15T10:00:00Z',
  detail: 'Network record: abc123def456...',
};

const signatureLayer = { type: 'signature' as const, present: false };
const timestampLayer = { type: 'timestamp' as const, present: false };

describe('EvidenceLayersSection', () => {
  it('renders collapsed by default with active layer count', () => {
    render(
      <EvidenceLayersSection layers={[anchorLayer, signatureLayer, timestampLayer]} />,
    );
    expect(screen.getByText(EVIDENCE_LAYER_LABELS.SECTION_TITLE)).toBeInTheDocument();
    expect(screen.getByText('1 active')).toBeInTheDocument();
    // Proves/disproves text should not be visible when collapsed
    expect(screen.queryByText(/Proves:/)).not.toBeInTheDocument();
  });

  it('expands to show layer details on click', () => {
    render(
      <EvidenceLayersSection layers={[anchorLayer, signatureLayer, timestampLayer]} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/Proves:/)).toBeInTheDocument();
    expect(screen.getByText(EVIDENCE_LAYER_LABELS.ANCHOR_PROVES)).toBeInTheDocument();
    expect(screen.getByText(EVIDENCE_LAYER_LABELS.ANCHOR_DOES_NOT_PROVE)).toBeInTheDocument();
  });

  it('shows detail text for present layers', () => {
    render(
      <EvidenceLayersSection layers={[anchorLayer, signatureLayer, timestampLayer]} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Network record: abc123def456...')).toBeInTheDocument();
  });

  it('shows "Not present" for absent layers', () => {
    render(
      <EvidenceLayersSection layers={[anchorLayer, signatureLayer, timestampLayer]} />,
    );
    fireEvent.click(screen.getByRole('button'));
    const notPresent = screen.getAllByText('Not present for this credential.');
    expect(notPresent).toHaveLength(2); // signature + timestamp
  });

  it('shows disclaimer text when expanded', () => {
    render(
      <EvidenceLayersSection layers={[anchorLayer, signatureLayer, timestampLayer]} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(EVIDENCE_LAYER_LABELS.DISCLAIMER)).toBeInTheDocument();
  });

  it('shows jurisdiction legal effect for EU', () => {
    render(
      <EvidenceLayersSection
        layers={[anchorLayer, signatureLayer, timestampLayer]}
        jurisdiction="EU"
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(EVIDENCE_LAYER_LABELS.LEGAL_EFFECT_EIDAS_ADES)).toBeInTheDocument();
  });

  it('shows ESIGN legal effect for US jurisdiction', () => {
    render(
      <EvidenceLayersSection
        layers={[anchorLayer, signatureLayer, timestampLayer]}
        jurisdiction="US"
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(EVIDENCE_LAYER_LABELS.LEGAL_EFFECT_ESIGN)).toBeInTheDocument();
  });

  it('does not show legal effect when jurisdiction is null', () => {
    render(
      <EvidenceLayersSection layers={[anchorLayer, signatureLayer, timestampLayer]} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText(/Legal effect:/)).not.toBeInTheDocument();
  });

  it('collapses on second click', () => {
    render(
      <EvidenceLayersSection layers={[anchorLayer, signatureLayer, timestampLayer]} />,
    );
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(screen.getByText(/Proves:/)).toBeInTheDocument();
    fireEvent.click(button);
    expect(screen.queryByText(/Proves:/)).not.toBeInTheDocument();
  });

  it('shows correct count when all layers present', () => {
    const allPresent = [
      { ...anchorLayer },
      { type: 'signature' as const, present: true },
      { type: 'timestamp' as const, present: true },
    ];
    render(<EvidenceLayersSection layers={allPresent} />);
    expect(screen.getByText('3 active')).toBeInTheDocument();
  });

  it('shows 0 active when no layers present', () => {
    const nonePresent = [
      { type: 'anchor' as const, present: false },
      { type: 'signature' as const, present: false },
      { type: 'timestamp' as const, present: false },
    ];
    render(<EvidenceLayersSection layers={nonePresent} />);
    expect(screen.getByText('0 active')).toBeInTheDocument();
  });
});
