/**
 * IndependentVerifyPage Tests (COMP-03)
 *
 * Tests the public independent verification guide page.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { IndependentVerifyPage } from './IndependentVerifyPage';
import { INDEPENDENT_VERIFY_LABELS } from '@/lib/copy';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/verify/independent']}>
      <IndependentVerifyPage />
    </MemoryRouter>,
  );
}

describe('IndependentVerifyPage', () => {
  it('renders hero section with title and subtitle', () => {
    renderPage();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.HERO_TITLE)).toBeInTheDocument();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.HERO_SUBTITLE)).toBeInTheDocument();
  });

  it('renders all 4 verification steps', () => {
    renderPage();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.STEP_1_TITLE)).toBeInTheDocument();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.STEP_2_TITLE)).toBeInTheDocument();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.STEP_3_TITLE)).toBeInTheDocument();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.STEP_4_TITLE)).toBeInTheDocument();
  });

  it('renders terminal commands for each step', () => {
    renderPage();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.STEP_1_CMD)).toBeInTheDocument();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.STEP_2_CMD)).toBeInTheDocument();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.STEP_3_CMD)).toBeInTheDocument();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.STEP_4_CMD)).toBeInTheDocument();
  });

  // The page used to offer a "Download Verification Script" button linking to
  // `/verify.sh`. No such file has ever existed in this repository, so the
  // button 404'd and step 3's `./verify.sh …` command could not be run by
  // anyone. It is replaced by instructions for the verifier we DO ship
  // (packages/verifier-cli, bin `arkova-verify`).
  it('tells the reader how to obtain the reference verifier that actually exists', () => {
    renderPage();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.VERIFIER_TITLE)).toBeInTheDocument();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.VERIFIER_BODY)).toBeInTheDocument();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.VERIFIER_BUILD_CMD)).toBeInTheDocument();
  });

  it('offers no download link to the non-existent verify.sh', () => {
    const { container } = renderPage();
    const hrefs = Array.from(container.querySelectorAll('a')).map(a => a.getAttribute('href'));
    expect(hrefs).not.toContain('/verify.sh');
    expect(container.querySelector('a[download]')).toBeNull();
  });

  it('renders all 3 FAQ questions and answers', () => {
    renderPage();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.FAQ_SHUTDOWN_Q)).toBeInTheDocument();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.FAQ_SHUTDOWN_A)).toBeInTheDocument();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.FAQ_OFFLINE_Q)).toBeInTheDocument();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.FAQ_OFFLINE_A)).toBeInTheDocument();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.FAQ_TRUST_Q)).toBeInTheDocument();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.FAQ_TRUST_A)).toBeInTheDocument();
  });

  it('renders CTA link to Arkova verification', () => {
    renderPage();
    expect(screen.getByText('Verify on Arkova')).toBeInTheDocument();
  });

  it('includes HowTo JSON-LD structured data', () => {
    renderPage();
    const script = document.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const json = JSON.parse(script!.textContent!);
    expect(json['@type']).toBe('HowTo');
    expect(json.step).toHaveLength(4);
    expect(json.step[0].name).toBe(INDEPENDENT_VERIFY_LABELS.STEP_1_TITLE);
  });

  it('renders step numbers 1-4', () => {
    renderPage();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('renders system requirements note from copy.ts (§1.3 — no bare JSX literal)', () => {
    renderPage();
    expect(
      screen.getByText(INDEPENDENT_VERIFY_LABELS.VERIFIER_REQUIREMENTS),
    ).toBeInTheDocument();
  });
});
