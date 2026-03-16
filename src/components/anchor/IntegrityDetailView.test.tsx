/**
 * IntegrityDetailView Tests (P8-S8)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IntegrityDetailView } from './IntegrityDetailView';
import type { IntegrityScore } from '@/hooks/useIntegrityScore';

const mockScore: IntegrityScore = {
  id: 'score-1',
  anchorId: 'anchor-1',
  orgId: 'org-1',
  overallScore: 72,
  level: 'MEDIUM',
  metadataCompleteness: 75,
  extractionConfidence: 80,
  issuerVerification: 60,
  duplicateCheck: 100,
  temporalConsistency: 50,
  flags: ['issuer_not_in_registry', 'missing_issued_date'],
  details: {},
  computedAt: '2026-03-16T10:00:00Z',
};

describe('IntegrityDetailView', () => {
  it('renders the integrity analysis header', () => {
    render(<IntegrityDetailView score={mockScore} />);
    expect(screen.getByText('Integrity Analysis')).toBeTruthy();
  });

  it('renders all breakdown bars', () => {
    render(<IntegrityDetailView score={mockScore} />);
    expect(screen.getByText('Metadata Completeness')).toBeTruthy();
    expect(screen.getByText('Extraction Confidence')).toBeTruthy();
    expect(screen.getByText('Issuer Verification')).toBeTruthy();
    expect(screen.getByText('Duplicate Check')).toBeTruthy();
    expect(screen.getByText('Temporal Consistency')).toBeTruthy();
  });

  it('renders score values', () => {
    render(<IntegrityDetailView score={mockScore} />);
    expect(screen.getByText('75/100')).toBeTruthy();
    expect(screen.getByText('80/100')).toBeTruthy();
    expect(screen.getByText('60/100')).toBeTruthy();
    expect(screen.getByText('100/100')).toBeTruthy();
    expect(screen.getByText('50/100')).toBeTruthy();
  });

  it('renders flags', () => {
    render(<IntegrityDetailView score={mockScore} />);
    expect(screen.getByText('Issuer not found in registry')).toBeTruthy();
    expect(screen.getByText('Missing issue date')).toBeTruthy();
  });

  it('renders no-issues message for HIGH score with no flags', () => {
    const highScore: IntegrityScore = {
      ...mockScore,
      overallScore: 95,
      level: 'HIGH',
      flags: [],
    };
    render(<IntegrityDetailView score={highScore} />);
    expect(screen.getByText('No integrity issues detected')).toBeTruthy();
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    render(<IntegrityDetailView score={mockScore} onClose={onClose} />);
    // Close button is the last button in the header
    const buttons = screen.getAllByRole('button');
    const closeButton = buttons[buttons.length - 1];
    closeButton.click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders badge with correct level', () => {
    render(<IntegrityDetailView score={mockScore} />);
    expect(screen.getByText('Medium Integrity')).toBeTruthy();
  });
});
