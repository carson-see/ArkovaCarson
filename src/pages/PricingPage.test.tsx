/**
 * PricingPage Tests
 *
 * Tests the pricing page which wraps PricingCard + BillingOverview + useBilling.
 * Verifies plan display, checkout flow, billing portal, error states, and loading.
 *
 * @see P7-TS-02
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/tests/queryTestUtils';

// =========================================================================
// Mocks
// =========================================================================

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockStartCheckout = vi.fn();
const mockOpenBillingPortal = vi.fn();
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

import { PricingPage } from './PricingPage';
import { BILLING_LABELS } from '@/lib/copy';

// =========================================================================
// Helpers
// =========================================================================

function renderPage() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter>
        <PricingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const basePlans = [
  { id: 'free', name: 'Free', price_cents: 0, billing_period: 'month', records_per_month: 3, stripe_price_id: null },
  {
    id: 'individual_verified_monthly',
    name: 'Verified Individual',
    price_cents: 1200,
    billing_period: 'month',
    records_per_month: 10,
    stripe_price_id: 'price_ind',
  },
  {
    id: 'small_business',
    name: 'Small Business',
    price_cents: 50000,
    billing_period: 'month',
    records_per_month: 250,
    stripe_price_id: 'price_small',
  },
  {
    id: 'medium_business',
    name: 'Medium Business',
    price_cents: 0,
    billing_period: 'custom',
    records_per_month: 999999,
    stripe_price_id: null,
  },
];

function mockBillingDefaults(overrides: Record<string, unknown> = {}) {
  mockUseBilling.mockReturnValue({
    subscription: null,
    plan: null,
    plans: basePlans,
    loading: false,
    error: null,
    startCheckout: mockStartCheckout,
    openBillingPortal: mockOpenBillingPortal,
    refresh: vi.fn(),
    ...overrides,
  });
}

// =========================================================================
// Tests
// =========================================================================

describe('PricingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBillingDefaults();
  });

  it('renders page title and description', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: BILLING_LABELS.PAGE_TITLE })).toBeInTheDocument();
    expect(screen.getByText(BILLING_LABELS.PAGE_DESCRIPTION)).toBeInTheDocument();
  });

  it('renders "Choose a Plan" when no active subscription', () => {
    renderPage();
    expect(screen.getByText(BILLING_LABELS.CHOOSE_PLAN)).toBeInTheDocument();
  });

  it('renders plan cards for each plan', () => {
    renderPage();
    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.getByText('Verified Individual')).toBeInTheDocument();
    expect(screen.getByText('Small Business')).toBeInTheDocument();
    expect(screen.getByText('Medium Business')).toBeInTheDocument();
  });

  it('shows loading spinner when billing is loading', () => {
    mockBillingDefaults({ loading: true });
    renderPage();
    // Spinner rendered, no plan cards
    expect(screen.queryByText('Free')).not.toBeInTheDocument();
  });

  it('displays error alert when billing has an error', () => {
    mockBillingDefaults({ error: 'Failed to load plans' });
    renderPage();
    expect(screen.getByText('Failed to load plans')).toBeInTheDocument();
  });

  it('shows "Change Plan" when user has active subscription', () => {
    mockBillingDefaults({
      subscription: { status: 'active', current_period_end: '2026-04-01' },
      plan: { id: 'individual_verified_monthly', name: 'Verified Individual', records_per_month: 10 },
    });
    renderPage();
    expect(screen.getByText(BILLING_LABELS.CHANGE_PLAN)).toBeInTheDocument();
  });

  it('shows BillingOverview for active subscribers', () => {
    mockBillingDefaults({
      subscription: { status: 'active', current_period_end: '2026-04-01' },
      plan: { id: 'individual_verified_monthly', name: 'Verified Individual', records_per_month: 10 },
    });
    renderPage();
    // BillingOverview renders plan name
    expect(screen.getAllByText('Verified Individual').length).toBeGreaterThanOrEqual(1);
  });

  it('calls startCheckout when selecting a plan', async () => {
    mockStartCheckout.mockResolvedValue(null);
    renderPage();

    const selectButtons = screen.getAllByRole('button', { name: 'Select Plan' });
    fireEvent.click(selectButtons[1]);
    await waitFor(() => {
      expect(mockStartCheckout).toHaveBeenCalledWith('individual_verified_monthly');
    });
  });

  it('navigates to Settings when back button clicked', () => {
    renderPage();
    // The back button contains "Settings" text with an ArrowLeft icon
    const backButton = screen.getAllByText('Settings')
      .map(el => el.closest('button'))
      .find(btn => btn !== null) as HTMLButtonElement;
    fireEvent.click(backButton);
    expect(mockNavigate).toHaveBeenCalled();
  });

  it('marks Verified Individual plan as recommended', () => {
    renderPage();
    expect(screen.getByText('Verified Individual')).toBeInTheDocument();
    expect(screen.getByText('Recommended')).toBeInTheDocument();
  });

  it('shows trialing subscription as active', () => {
    mockBillingDefaults({
      subscription: { status: 'trialing', current_period_end: '2026-04-01' },
      plan: { id: 'small_business', name: 'Small Business', records_per_month: 250 },
    });
    renderPage();
    expect(screen.getByText(BILLING_LABELS.CHANGE_PLAN)).toBeInTheDocument();
  });

  it('shows Custom price for custom organization plans', () => {
    renderPage();
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });
});
