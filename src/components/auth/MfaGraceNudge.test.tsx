/**
 * MfaGraceNudge Component Tests — SCRUM-3167.
 *
 * Dismissible banner shown by AuthGuard ABOVE `children` (children still
 * render underneath) between now and the MFA enforcement date, for a role
 * that will be required to enroll once enforcement activates. Dismissal is
 * per-tab-session (sessionStorage) and keyed by the enforcement ISO date so
 * a date change (Carson moving the rollout via env + redeploy) resets any
 * prior dismissal rather than silently continuing to suppress the banner
 * against a deadline nobody actually saw.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MfaGraceNudge } from './MfaGraceNudge';
import { ROUTES } from '@/lib/routes';

const ENFORCE_FROM = '2026-09-21T00:00:00Z';

function renderNudge(props: { enforceFrom?: string } = {}) {
  return render(
    <MemoryRouter>
      <MfaGraceNudge {...props} />
    </MemoryRouter>
  );
}

describe('MfaGraceNudge', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ALLOW_DATE_OVERRIDE', undefined);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', ENFORCE_FROM);
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    sessionStorage.clear();
  });

  it('renders with the "N days" copy when several days remain', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z')); // 10 days before enforcement

    renderNudge();

    expect(screen.getByTestId('mfa-grace-nudge')).toHaveTextContent('10 days');
  });

  it('renders the "tomorrow" copy when exactly 1 day remains (not "1 days")', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T06:00:00Z')); // 18h before enforcement, ceils to 1 day

    renderNudge();

    const nudge = screen.getByTestId('mfa-grace-nudge');
    expect(nudge).toHaveTextContent(/tomorrow/i);
    expect(nudge).not.toHaveTextContent(/1 days/i);
  });

  it('CTA links to ROUTES.SETTINGS', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));

    renderNudge();

    const cta = screen.getByTestId('mfa-grace-nudge-cta');
    expect(cta.closest('a')).toHaveAttribute('href', ROUTES.SETTINGS);
  });

  it('dismissing hides the nudge immediately', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));

    renderNudge();
    expect(screen.getByTestId('mfa-grace-nudge')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mfa-grace-nudge-dismiss'));

    expect(screen.queryByTestId('mfa-grace-nudge')).not.toBeInTheDocument();
  });

  it('dismissal persists across a remount for the SAME enforcement date (sessionStorage)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));

    const { unmount } = renderNudge();
    fireEvent.click(screen.getByTestId('mfa-grace-nudge-dismiss'));
    unmount();

    renderNudge();
    expect(screen.queryByTestId('mfa-grace-nudge')).not.toBeInTheDocument();
  });

  it('dismissal for one enforcement date does NOT suppress the nudge for a DIFFERENT date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));

    const { unmount } = renderNudge();
    fireEvent.click(screen.getByTestId('mfa-grace-nudge-dismiss'));
    unmount();

    // Operator moves the rollout date (new deploy) — a fresh deadline the
    // user has never dismissed.
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', '2026-10-05T00:00:00Z');
    renderNudge();

    expect(screen.getByTestId('mfa-grace-nudge')).toBeInTheDocument();
  });

  it('sessionStorage access is wrapped in try/catch — a throwing getItem/setItem never crashes the component', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    expect(() => renderNudge()).not.toThrow();
    expect(screen.getByTestId('mfa-grace-nudge')).toBeInTheDocument();

    expect(() => fireEvent.click(screen.getByTestId('mfa-grace-nudge-dismiss'))).not.toThrow();

    getItemSpy.mockRestore();
    setItemSpy.mockRestore();
  });

  // ---------------------------------------------------------------------
  // Item 18/EA4 (PR #2637 review): AuthGuard resolves the enforcement date
  // once per render and threads it down, instead of this component
  // re-resolving the same env/localStorage inputs a second/third time.
  // ---------------------------------------------------------------------

  it('ITEM 18/EA4: uses the explicitly passed enforceFrom prop instead of re-resolving from env', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
    // The env says 2026-09-21 (10 days from "now"); the prop says a FAR
    // later date whose day-count would obviously differ if honoured.
    renderNudge({ enforceFrom: '2026-12-01T00:00:00Z' });

    expect(screen.getByTestId('mfa-grace-nudge')).not.toHaveTextContent('10 days');
  });

  it('ITEM 18/EA4: falls back to resolving its own date when no prop is passed (standalone use / backward compatible)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
    renderNudge();

    expect(screen.getByTestId('mfa-grace-nudge')).toHaveTextContent('10 days');
  });

  it('ITEM 18/EA4: the dismissal key is keyed off the passed enforceFrom prop, not a re-resolved value', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
    const { unmount } = renderNudge({ enforceFrom: '2026-12-01T00:00:00Z' });
    fireEvent.click(screen.getByTestId('mfa-grace-nudge-dismiss'));
    unmount();

    // Same prop value again -> stays dismissed.
    renderNudge({ enforceFrom: '2026-12-01T00:00:00Z' });
    expect(screen.queryByTestId('mfa-grace-nudge')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------
  // Item 27 (SonarCloud typescript:S6819): role="status" replaced with a
  // semantic <output> (or aria-live="polite"), per the rule's guidance.
  // ---------------------------------------------------------------------

  it('ITEM 27/S6819: uses aria-live="polite" instead of role="status"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
    renderNudge();

    const nudge = screen.getByTestId('mfa-grace-nudge');
    expect(nudge).toHaveAttribute('aria-live', 'polite');
    expect(nudge).not.toHaveAttribute('role', 'status');
  });

  // ---------------------------------------------------------------------
  // Item 35: MFA_GRACE_NUDGE_LABELS.BODY was defined but never rendered —
  // prefer rendering it over deleting it.
  // ---------------------------------------------------------------------

  it('ITEM 35: renders the BODY copy, not just the title and days-remaining line', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
    renderNudge();

    const { MFA_GRACE_NUDGE_LABELS } = await import('@/lib/copy');
    expect(screen.getByTestId('mfa-grace-nudge')).toHaveTextContent(MFA_GRACE_NUDGE_LABELS.BODY);
  });
});
