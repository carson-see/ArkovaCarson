/**
 * GME-26: Extraction Quality Banner Tests
 *
 * Verifies confidence-based warning banners appear correctly.
 *
 * BUG-2026-07-17-009 (SCRUM-2910, P0): the fraud-signal banner was fed by the
 * Gemini extraction `fraudSignals` field and was NOT gated by
 * ENABLE_FRAUD_DETECTION — flipping the flag off did not remove it. The
 * component no longer renders any fraud UI at all.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExtractionQualityBanner } from './ExtractionQualityBanner';

describe('GME-26: ExtractionQualityBanner', () => {
  it('renders nothing when confidence is high (>= 0.5)', () => {
    const { container } = render(
      <ExtractionQualityBanner confidence={0.8} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders amber warning when confidence is 0.3-0.5', () => {
    render(
      <ExtractionQualityBanner confidence={0.4} />,
    );
    expect(screen.getByText(/low confidence/i)).toBeDefined();
    expect(screen.getByText(/please verify/i)).toBeDefined();
  });

  it('renders red warning when confidence < 0.3', () => {
    render(
      <ExtractionQualityBanner confidence={0.2} />,
    );
    expect(screen.getByText(/may be unreliable/i)).toBeDefined();
    expect(screen.getByText(/manual review/i)).toBeDefined();
  });

  it('shows stripped fields note when provided', () => {
    render(
      <ExtractionQualityBanner
        confidence={0.7}
        strippedFields={['creditHours', 'barNumber']}
      />,
    );
    expect(screen.getByText(/fields removed/i)).toBeDefined();
    expect(screen.getByText(/creditHours/i)).toBeDefined();
    expect(screen.getByText(/barNumber/i)).toBeDefined();
  });

  // BUG-2026-07-17-009 (SCRUM-2910, P0): no fraud UI, ever — regardless of
  // extraction output or flag state.
  it('never renders fraud-signal UI (BUG-2026-07-17-009)', () => {
    const { container } = render(
      <ExtractionQualityBanner confidence={0.25} strippedFields={['creditHours']} />,
    );
    expect(screen.queryByText(/fraud/i)).toBeNull();
    expect(container.textContent?.toLowerCase()).not.toContain('fraud');
  });
});
