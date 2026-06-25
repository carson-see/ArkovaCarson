/**
 * CheckoutSuccessPage Tests
 *
 * Tests the post-checkout confirmation page.
 * Verifies plan display, billing refresh, navigation links, and loading states.
 *
 * @see P7-TS-02
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// =========================================================================
// Mocks
// =========================================================================

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useSearchParams: () => [new URLSearchParams('session_id=cs_test_123')],
  };
});

const mockRefresh = vi.fn();
const mockUseBilling = vi.fn();

vi.mock('@/hooks/useBilling', () => ({
  useBilling: () => mockUseBilling(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'test@arkova.local' },
    signOut: vi.fn(),
  }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: { full_name: 'Test User', role: 'INDIVIDUAL' },
    loading: false,
  }),
}));

import { CheckoutSuccessPage } from './CheckoutSuccessPage';
import { BILLING_LABELS } from '@/lib/copy';

// =========================================================================
// Helpers
// =========================================================================

function renderPage() {
  return render(
    <MemoryRouter>
      <CheckoutSuccessPage />
    </MemoryRouter>,
  );
}

// =========================================================================
// Tests
// =========================================================================

describe('CheckoutSuccessPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders success title and description', () => {
    mockUseBilling.mockReturnValue({
      plan: null,
      loading: false,
      refresh: mockRefresh,
    });
    renderPage();
    expect(screen.getByText(BILLING_LABELS.CHECKOUT_SUCCESS_TITLE)).toBeInTheDocument();
    expect(screen.getByText(BILLING_LABELS.CHECKOUT_SUCCESS_DESC)).toBeInTheDocument();
  });

  it('shows loading state while billing data refreshes', () => {
    mockUseBilling.mockReturnValue({
      plan: null,
      loading: true,
      refresh: mockRefresh,
    });
    renderPage();
    expect(screen.getByText(BILLING_LABELS.LOADING_SUBSCRIPTION)).toBeInTheDocument();
  });

  it('displays plan name when billing data is loaded', () => {
    mockUseBilling.mockReturnValue({
      plan: { name: 'Professional', records_per_month: 100 },
      loading: false,
      refresh: mockRefresh,
    });
    renderPage();
    expect(screen.getByText(BILLING_LABELS.YOUR_PLAN)).toBeInTheDocument();
    expect(screen.getByText('Professional')).toBeInTheDocument();
    expect(screen.getByText('100 records per month')).toBeInTheDocument();
  });

  it('hides records count when plan has zero records_per_month', () => {
    mockUseBilling.mockReturnValue({
      plan: { name: 'Free', records_per_month: 0 },
      loading: false,
      refresh: mockRefresh,
    });
    renderPage();
    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.queryByText(/records per month/)).not.toBeInTheDocument();
  });

  // BUG-C (BUG-2026-06-24-009 class): the unlimited "organization" plan encodes
  // its limit as the sentinel 999999 (seed.sql:220). The naive `> 0` guard
  // rendered the raw sentinel — "999999 records per month" — on the post-payment
  // screen instead of "Unlimited records". Mirror the normalization already in
  // useEntitlements/PricingPage via isUnlimitedRecordsLimit + RECORDS_UNLIMITED.
  it('shows "Unlimited records" for the unlimited sentinel plan (999999)', () => {
    mockUseBilling.mockReturnValue({
      plan: { name: 'Organization', records_per_month: 999999 },
      loading: false,
      refresh: mockRefresh,
    });
    renderPage();
    expect(screen.getByText('Organization')).toBeInTheDocument();
    expect(screen.getByText(BILLING_LABELS.RECORDS_UNLIMITED)).toBeInTheDocument();
    // The raw sentinel must never leak to the user.
    expect(screen.queryByText(/999999/)).not.toBeInTheDocument();
    expect(screen.queryByText('999999 records per month')).not.toBeInTheDocument();
  });

  // Finite-boundary guard: 999998 is just below the sentinel and is a real,
  // finite limit — it must render the normal "N records per month" line, NOT
  // the unlimited copy (isUnlimitedRecordsLimit(999998) === false).
  it('shows finite count for a limit just below the sentinel (999998)', () => {
    mockUseBilling.mockReturnValue({
      plan: { name: 'Scale', records_per_month: 999998 },
      loading: false,
      refresh: mockRefresh,
    });
    renderPage();
    expect(screen.getByText('Scale')).toBeInTheDocument();
    expect(screen.getByText('999998 records per month')).toBeInTheDocument();
    expect(screen.queryByText(BILLING_LABELS.RECORDS_UNLIMITED)).not.toBeInTheDocument();
  });

  it('renders dashboard and billing navigation links', () => {
    mockUseBilling.mockReturnValue({
      plan: null,
      loading: false,
      refresh: mockRefresh,
    });
    renderPage();
    expect(screen.getByText(BILLING_LABELS.GO_TO_DASHBOARD)).toBeInTheDocument();
    expect(screen.getByText(BILLING_LABELS.VIEW_BILLING)).toBeInTheDocument();
  });

  it('triggers billing refresh after delay when session_id present', () => {
    mockRefresh.mockResolvedValue(undefined);
    mockUseBilling.mockReturnValue({
      plan: null,
      loading: false,
      refresh: mockRefresh,
    });
    renderPage();

    // Before timeout, refresh not called
    expect(mockRefresh).not.toHaveBeenCalled();

    // After 2s delay
    vi.advanceTimersByTime(2000);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not show plan section when plan is null and not loading', () => {
    mockUseBilling.mockReturnValue({
      plan: null,
      loading: false,
      refresh: mockRefresh,
    });
    renderPage();
    expect(screen.queryByText(BILLING_LABELS.YOUR_PLAN)).not.toBeInTheDocument();
  });
});
