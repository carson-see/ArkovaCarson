/**
 * ReferralPanel — SCRUM-5024.
 *
 * Pins the three behaviours the panel exists to get right:
 *   - no auto-mint on load;
 *   - a failed load renders an error + retry, NEVER an empty table;
 *   - the measured / not-asserted sentence is always on the page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockUseReferrals } = vi.hoisted(() => ({ mockUseReferrals: vi.fn() }));
vi.mock('@/hooks/useReferrals', () => ({ useReferrals: mockUseReferrals }));

import { ReferralPanel } from './ReferralPanel';
import { REFERRAL_LABELS } from '@/lib/copy';

function hookState(over: Record<string, unknown> = {}) {
  return {
    loading: false,
    error: null,
    code: null,
    shareUrl: null,
    referred: [],
    minting: false,
    mintError: null,
    mint: vi.fn(),
    refresh: vi.fn(),
    ...over,
  };
}

const ROWS = [
  {
    organizationPublicId: 'org_referred_1',
    displayName: 'Referred One',
    referredAt: '2026-09-01T10:00:00.000Z',
    verificationStatus: 'VERIFIED',
  },
  {
    displayName: 'Legacy Org',
    referredAt: '2026-08-20T09:00:00.000Z',
    verificationStatus: 'UNVERIFIED',
  },
];

describe('ReferralPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a distinct loading message, not a repeat of the page title, while referrals load', () => {
    mockUseReferrals.mockReturnValue(hookState({ loading: true }));

    render(<ReferralPanel orgId="org-1" canManage />);

    expect(screen.getByText(REFERRAL_LABELS.LOADING)).toBeInTheDocument();
    expect(screen.queryByText(REFERRAL_LABELS.PAGE_TITLE)).not.toBeInTheDocument();
  });

  it('never mints on load — the button is the only path', () => {
    const state = hookState();
    mockUseReferrals.mockReturnValue(state);

    render(<ReferralPanel orgId="org-1" canManage />);

    expect(state.mint).not.toHaveBeenCalled();
    expect(screen.getByText(REFERRAL_LABELS.CREATE_TITLE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: REFERRAL_LABELS.CREATE_BUTTON })).toBeInTheDocument();
  });

  it('mints only when the button is pressed', async () => {
    const state = hookState();
    mockUseReferrals.mockReturnValue(state);

    render(<ReferralPanel orgId="org-1" canManage />);
    fireEvent.click(screen.getByRole('button', { name: REFERRAL_LABELS.CREATE_BUTTON }));

    await waitFor(() => expect(state.mint).toHaveBeenCalledTimes(1));
  });

  it('offers no create button to a non-admin, and says why', () => {
    mockUseReferrals.mockReturnValue(hookState());

    render(<ReferralPanel orgId="org-1" canManage={false} />);

    expect(screen.queryByRole('button', { name: REFERRAL_LABELS.CREATE_BUTTON })).toBeNull();
    expect(screen.getByText(REFERRAL_LABELS.ADMIN_ONLY)).toBeInTheDocument();
  });

  it('renders the code, the share link and the referred organizations', () => {
    mockUseReferrals.mockReturnValue(
      hookState({
        code: 'ABCD2345',
        shareUrl: 'https://app.arkova.ai/signup?ref=ABCD2345',
        referred: ROWS,
      }),
    );

    render(<ReferralPanel orgId="org-1" canManage />);

    expect(screen.getByTestId('referral-code')).toHaveTextContent('ABCD2345');
    expect(screen.getByTestId('referral-share-url')).toHaveTextContent(
      'https://app.arkova.ai/signup?ref=ABCD2345',
    );
    expect(screen.getByText('Referred One')).toBeInTheDocument();
    // A row with no public id still renders — the key falls back, it is not dropped.
    expect(screen.getByText('Legacy Org')).toBeInTheDocument();
  });

  it('a failed load shows an error with a retry — NOT an empty table', () => {
    const state = hookState({ error: 'permission denied' });
    mockUseReferrals.mockReturnValue(state);

    render(<ReferralPanel orgId="org-1" canManage />);

    expect(screen.getByText(REFERRAL_LABELS.LOAD_FAILED_TITLE)).toBeInTheDocument();
    // "You referred nobody" must never be shown when we simply do not know.
    expect(screen.queryByText(REFERRAL_LABELS.TABLE_EMPTY_TITLE)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: REFERRAL_LABELS.LOAD_FAILED_RETRY }));
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it('shows the genuine empty state only when the load SUCCEEDED with no rows', () => {
    mockUseReferrals.mockReturnValue(hookState({ code: 'ABCD2345', shareUrl: 'https://x/y' }));

    render(<ReferralPanel orgId="org-1" canManage />);

    expect(screen.getByText(REFERRAL_LABELS.TABLE_EMPTY_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(REFERRAL_LABELS.LOAD_FAILED_TITLE)).toBeNull();
  });

  it('always states what is measured and what is NOT asserted, and implies no commission', () => {
    mockUseReferrals.mockReturnValue(
      hookState({ code: 'ABCD2345', shareUrl: 'https://x/y', referred: ROWS }),
    );

    const { container } = render(<ReferralPanel orgId="org-1" canManage />);

    expect(screen.getByText(REFERRAL_LABELS.NOT_ASSERTED)).toBeInTheDocument();

    // R-7 claims gate: the panel must not PROMISE money. The disclaimer itself
    // names "commission" in order to deny it, so it is removed before the scan
    // — everything else on the page must be free of earnings language.
    const withoutDisclaimer = (container.textContent ?? '').replace(REFERRAL_LABELS.NOT_ASSERTED, '');
    expect(withoutDisclaimer).not.toMatch(/commission|payout|revenue share|you earn|reward/i);
  });

  it('tells a user with no organization what to do instead of rendering an empty panel', () => {
    mockUseReferrals.mockReturnValue(hookState());
    render(<ReferralPanel orgId={null} canManage={false} />);
    expect(screen.getByText(REFERRAL_LABELS.NO_ORG)).toBeInTheDocument();
  });

  it('surfaces a mint failure rather than leaving the button silently idle', () => {
    mockUseReferrals.mockReturnValue(hookState({ mintError: 'insufficient_privilege' }));
    render(<ReferralPanel orgId="org-1" canManage />);
    expect(screen.getByText(REFERRAL_LABELS.CREATE_FAILED)).toBeInTheDocument();
  });
});
