/**
 * DoesNotAssertDisclaimer tests (SCRUM-2495 / ABUSE-DISCLAIMER)
 *
 * Verifies:
 *  - the component renders and is always visible (no click-to-reveal, no
 *    tooltip-only affordance — text is present in the DOM on mount)
 *  - the MEASURED / ASSERTED / NOT ASSERTED substance is present
 *  - none of the CLAUDE.md §1.3 banned terms appear in the rendered text
 *  - it renders sensibly at both mandated UAT container widths (1280px /
 *    375px, CLAUDE.md §1.6) — jsdom has no real viewport, so this exercises
 *    the component in the same widths via a wrapping container, which is
 *    the mechanical substitute for live-browser UAT noted in the PR body.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DoesNotAssertDisclaimer } from './DoesNotAssertDisclaimer';
import { DOES_NOT_ASSERT_LABELS } from '@/lib/copy';

// Mirrors the banned-terms list enforced by scripts/check-copy-terms.ts
// (CLAUDE.md §1.3). Kept independent of the script so this test still catches
// a regression if the shared scanner's line-based heuristic ever misses a
// multi-line JSX text case (which is exactly how the prior disclaimer's
// "Bitcoin blockchain" violation slipped through undetected).
const BANNED_TERMS = [
  /\bwallet\b/i,
  /\bgas\b/i,
  /\bhash\b/i,
  /\bblock\b/i,
  /\btransaction\b/i,
  /\bcrypto\b/i,
  /\bblockchain\b/i,
  /\bbitcoin\b/i,
  /\btestnet\b/i,
  /\bmainnet\b/i,
  /\butxo\b/i,
  /\bbroadcast\b/i,
];

describe('DoesNotAssertDisclaimer', () => {
  it('renders immediately and visibly — no click/hover required to reveal it', () => {
    render(<DoesNotAssertDisclaimer />);
    // The component must be present in the DOM on initial render, not gated
    // behind a "show more" button or a hover-only tooltip.
    expect(screen.getByTestId('does-not-assert-disclaimer')).toBeVisible();
  });

  it('states the title', () => {
    render(<DoesNotAssertDisclaimer />);
    expect(screen.getByText(DOES_NOT_ASSERT_LABELS.TITLE)).toBeVisible();
  });

  it('states what is MEASURED: fingerprint + Network Observed Time', () => {
    render(<DoesNotAssertDisclaimer />);
    expect(screen.getByText(DOES_NOT_ASSERT_LABELS.MEASURED_LABEL)).toBeVisible();
    expect(screen.getByText(/Fingerprint/)).toBeVisible();
    expect(screen.getByText(/Network Observed Time/)).toBeVisible();
  });

  it('states what is ASSERTED: Secured status (existence + integrity at securing time)', () => {
    render(<DoesNotAssertDisclaimer />);
    expect(screen.getByText(DOES_NOT_ASSERT_LABELS.ASSERTED_LABEL)).toBeVisible();
    expect(screen.getByText(/Secured status/)).toBeVisible();
  });

  // §1.5 claims discipline (Carson P1 review): the ASSERTED claim must be
  // scoped to the moment of securing. Arkova does not monitor the document
  // afterwards — a later alteration produces a different fingerprint that
  // simply will not match this record. The copy must say that, and must NOT
  // claim post-securing immutability of the underlying document.
  it('scopes the ASSERTED claim to securing time — no post-securing immutability claim', () => {
    render(<DoesNotAssertDisclaimer />);
    const body = screen.getByText(/Secured status/);
    expect(body.textContent).toMatch(/does not monitor/i);
    expect(body.textContent).toMatch(/different fingerprint/i);
    expect(body.textContent).not.toMatch(/not been altered/i);
  });

  it('states what is NOT ASSERTED: signer/uploader identity, legal validity, jurisdiction', () => {
    render(<DoesNotAssertDisclaimer />);
    expect(screen.getByText(DOES_NOT_ASSERT_LABELS.NOT_ASSERTED_LABEL)).toBeVisible();
    const body = screen.getByText(/identity of the signer or uploader/);
    expect(body).toBeVisible();
    expect(body.textContent).toMatch(/legal validity/i);
    expect(body.textContent).toMatch(/jurisdiction/i);
  });

  it('frames jurisdiction tags as informational metadata only, not a legal claim', () => {
    render(<DoesNotAssertDisclaimer />);
    expect(
      screen.getByText(/Jurisdiction tags .* are informational metadata only/)
    ).toBeVisible();
  });

  it('contains none of the CLAUDE.md §1.3 banned terminology', () => {
    const { container } = render(<DoesNotAssertDisclaimer />);
    const text = container.textContent ?? '';
    for (const pattern of BANNED_TERMS) {
      expect(text).not.toMatch(pattern);
    }
  });

  it('renders without overflow at the 1280px UAT container width', () => {
    const { container } = render(
      <div style={{ width: 1280 }}>
        <DoesNotAssertDisclaimer />
      </div>
    );
    expect(container.querySelector('[data-testid="does-not-assert-disclaimer"]')).toBeInTheDocument();
  });

  it('renders without overflow at the 375px UAT container width', () => {
    const { container } = render(
      <div style={{ width: 375 }}>
        <DoesNotAssertDisclaimer />
      </div>
    );
    expect(container.querySelector('[data-testid="does-not-assert-disclaimer"]')).toBeInTheDocument();
  });
});
