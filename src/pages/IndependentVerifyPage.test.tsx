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

  it('renders download script button', () => {
    renderPage();
    expect(screen.getByText(INDEPENDENT_VERIFY_LABELS.DOWNLOAD_SCRIPT)).toBeInTheDocument();
    const link = screen.getByText(INDEPENDENT_VERIFY_LABELS.DOWNLOAD_SCRIPT).closest('a');
    expect(link).toHaveAttribute('href', '/verify.sh');
    expect(link).toHaveAttribute('download');
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

  it('renders system requirements note', () => {
    renderPage();
    expect(screen.getByText('Requires: bash, curl, shasum, jq')).toBeInTheDocument();
  });
});
