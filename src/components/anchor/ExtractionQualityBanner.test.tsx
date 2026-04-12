/**
 * GME-26: Extraction Quality Banner Tests
 *
 * Verifies confidence-based warning banners appear correctly.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExtractionQualityBanner } from './ExtractionQualityBanner';

describe('GME-26: ExtractionQualityBanner', () => {
  it('renders nothing when confidence is high (>= 0.5)', () => {
    const { container } = render(
      <ExtractionQualityBanner confidence={0.8} fraudSignals={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders amber warning when confidence is 0.3-0.5', () => {
    render(
      <ExtractionQualityBanner confidence={0.4} fraudSignals={[]} />,
    );
    expect(screen.getByText(/low confidence/i)).toBeDefined();
    expect(screen.getByText(/please verify/i)).toBeDefined();
  });

  it('renders red warning when confidence < 0.3', () => {
    render(
      <ExtractionQualityBanner confidence={0.2} fraudSignals={[]} />,
    );
    expect(screen.getByText(/may be unreliable/i)).toBeDefined();
    expect(screen.getByText(/manual review/i)).toBeDefined();
  });

  it('renders fraud signals prominently', () => {
    render(
      <ExtractionQualityBanner
        confidence={0.9}
        fraudSignals={['Font inconsistency detected', 'Metadata date mismatch']}
      />,
    );
    expect(screen.getByText(/fraud signal/i)).toBeDefined();
    expect(screen.getByText(/Font inconsistency/i)).toBeDefined();
    expect(screen.getByText(/Metadata date/i)).toBeDefined();
  });

  it('shows both confidence warning and fraud signals', () => {
    render(
      <ExtractionQualityBanner
        confidence={0.25}
        fraudSignals={['Suspicious formatting']}
      />,
    );
    // Both should appear
    expect(screen.getByText(/may be unreliable/i)).toBeDefined();
    expect(screen.getByText(/Suspicious formatting/i)).toBeDefined();
  });

  it('shows stripped fields note when provided', () => {
    render(
      <ExtractionQualityBanner
        confidence={0.7}
        fraudSignals={[]}
        strippedFields={['creditHours', 'barNumber']}
      />,
    );
    expect(screen.getByText(/fields removed/i)).toBeDefined();
    expect(screen.getByText(/creditHours/i)).toBeDefined();
    expect(screen.getByText(/barNumber/i)).toBeDefined();
  });
});
