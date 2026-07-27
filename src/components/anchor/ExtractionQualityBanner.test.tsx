/**
 * GME-26: Extraction Quality Banner Tests
 *
 * Verifies the PII-stripped-fields notice appears correctly.
 *
 * BUG-2026-07-17-009 (SCRUM-2910, P0): the fraud-signal banner was fed by the
 * Gemini extraction `fraudSignals` field and was NOT gated by
 * ENABLE_FRAUD_DETECTION — flipping the flag off did not remove it. The
 * component no longer renders any fraud UI at all.
 *
 * SCRUM-2914 (Founder UI findings, 2026-07-22): confidence-based warning
 * assertions removed along with the confidence prop/UI.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExtractionQualityBanner } from './ExtractionQualityBanner';

describe('GME-26: ExtractionQualityBanner', () => {
  it('renders nothing when no stripped fields are provided', () => {
    const { container } = render(<ExtractionQualityBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('shows stripped fields note when provided', () => {
    render(
      <ExtractionQualityBanner
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
      <ExtractionQualityBanner strippedFields={['creditHours']} />,
    );
    expect(screen.queryByText(/fraud/i)).toBeNull();
    expect(container.textContent?.toLowerCase()).not.toContain('fraud');
  });
});
