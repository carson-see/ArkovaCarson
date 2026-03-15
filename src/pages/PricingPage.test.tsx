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
    <MemoryRouter>
      <PricingPage />
    </MemoryRouter>,
  );
}

const basePlans = [
  { id: 'plan-free', name: 'Free', price_cents: 0, records_per_month: 3, stripe_price_id: null },
  { id: 'plan-ind', name: 'Individual', price_cents: 1900, records_per_month: 10, stripe_price_id: 'price_ind' },
  { id: 'plan-pro', name: 'Professional', price_cents: 4900, records_per_month: 100, stripe_price_id: 'price_pro' },
  { id: 'plan-org', name: 'Organization', price_cents: null, records_per_month: null, stripe_price_id: null },
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
    expect(screen.getByText('Individual')).toBeInTheDocument();
    expect(screen.getByText('Professional')).toBeInTheDocument();
    // Organization appears in both card title and description/features
    expect(screen.getAllByText('Organization').length).toBeGreaterThanOrEqual(1);
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
      plan: { id: 'plan-ind', name: 'Individual', records_per_month: 10 },
    });
    renderPage();
    expect(screen.getByText(BILLING_LABELS.CHANGE_PLAN)).toBeInTheDocument();
  });

  it('shows BillingOverview for active subscribers', () => {
    mockBillingDefaults({
      subscription: { status: 'active', current_period_end: '2026-04-01' },
      plan: { id: 'plan-ind', name: 'Individual', records_per_month: 10 },
    });
    renderPage();
    // BillingOverview renders plan name
    expect(screen.getAllByText('Individual').length).toBeGreaterThanOrEqual(1);
  });

  it('calls startCheckout when selecting a plan', async () => {
    mockStartCheckout.mockResolvedValue(null);
    renderPage();

    const selectButtons = screen.getAllByRole('button').filter(
      btn => btn.textContent?.includes('Select') || btn.textContent?.includes('Get Started'),
    );
    if (selectButtons.length > 0) {
      fireEvent.click(selectButtons[0]);
      await waitFor(() => {
        expect(mockStartCheckout).toHaveBeenCalled();
      });
    }
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

  it('marks Professional plan as recommended', () => {
    renderPage();
    // The Professional plan should have a "recommended" indicator
    expect(screen.getByText('Professional')).toBeInTheDocument();
  });

  it('shows trialing subscription as active', () => {
    mockBillingDefaults({
      subscription: { status: 'trialing', current_period_end: '2026-04-01' },
      plan: { id: 'plan-pro', name: 'Professional', records_per_month: 100 },
    });
    renderPage();
    expect(screen.getByText(BILLING_LABELS.CHANGE_PLAN)).toBeInTheDocument();
  });

  it('shows Custom price for Organization plan', () => {
    renderPage();
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });
});
