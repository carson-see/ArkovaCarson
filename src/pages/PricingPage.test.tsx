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
const mockUseEntitlements = vi.fn();

vi.mock('@/hooks/useBilling', () => ({
  useBilling: () => mockUseBilling(),
}));

vi.mock('@/hooks/useEntitlements', async () => {
  // Keep the real sentinel helper (PricingPage imports it); mock only the hook.
  const actual = await vi.importActual<typeof import('@/hooks/useEntitlements')>(
    '@/hooks/useEntitlements',
  );
  return { ...actual, useEntitlements: () => mockUseEntitlements() };
});

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

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import { PricingPage } from './PricingPage';
import { BILLING_LABELS } from '@/lib/copy';
import { toast } from 'sonner';

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

function mockEntitlementsDefaults(overrides: Record<string, unknown> = {}) {
  mockUseEntitlements.mockReturnValue({
    canCreateAnchor: true,
    recordsUsed: 0,
    recordsLimit: 3,
    remaining: 3,
    percentUsed: 0,
    isNearLimit: false,
    planName: 'Free',
    loading: false,
    error: null,
    refresh: vi.fn(),
    canCreateCount: () => true,
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
    mockEntitlementsDefaults();
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

  // NOTE ON SCOPE: this file renders PricingPage directly, so it proves the
  // page's own behaviour only — it CANNOT prove the page is reachable. It
  // passed green for months while the page had no route at all and no CTA in
  // the product led here. Reachability is asserted structurally in
  // `src/tests/pages/route-reachability.test.ts`, and end-to-end in
  // `e2e/billing.spec.ts`. Do not treat a green run here as "checkout works".
  it('calls startCheckout when selecting a plan', async () => {
    mockStartCheckout.mockResolvedValue(null);
    renderPage();

    const selectButtons = screen.getAllByRole('button', { name: 'Select Plan' });
    fireEvent.click(selectButtons[1]);
    await waitFor(() => {
      expect(mockStartCheckout).toHaveBeenCalledWith('individual_verified_monthly');
    });
  });

  it('redirects to the Stripe Checkout URL returned for the selected plan', async () => {
    // The previous test resolved null, so nothing ever asserted the redirect —
    // the one step that actually takes the customer's money.
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, href: '' },
    });
    try {
      mockStartCheckout.mockResolvedValue('https://checkout.stripe.test/c/pay/cs_test_123');
      renderPage();

      fireEvent.click(screen.getAllByRole('button', { name: 'Select Plan' })[1]);

      await waitFor(() => {
        expect(window.location.href).toBe('https://checkout.stripe.test/c/pay/cs_test_123');
      });
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    }
  });

  // The exact user-visible error IS asserted below (toast.error called with the
  // specific BILLING_LABELS.CHECKOUT_UNAVAILABLE constant). There is no status
  // or error code to assert: useBilling.startCheckout deliberately collapses
  // every failure to `null` before this layer sees it — which is precisely why
  // the null branch must not stay silent.
  // eslint-disable-next-line arkova/require-error-code-assertion -- see above
  it('surfaces an error instead of silently doing nothing when checkout cannot start', async () => {
    // startCheckout resolves null on any failure — notably the worker's 400
    // when a plan has no stripe_price_id configured for the environment. A
    // silent no-op is indistinguishable from a broken button.
    mockStartCheckout.mockResolvedValue(null);
    renderPage();

    fireEvent.click(screen.getAllByRole('button', { name: 'Select Plan' })[1]);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(BILLING_LABELS.CHECKOUT_UNAVAILABLE);
    });
  });

  it('routes an existing subscriber to the billing portal instead of a new checkout', async () => {
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, href: '' },
    });
    try {
      mockBillingDefaults({
        subscription: { status: 'active', current_period_end: '2026-04-01' },
        plan: { id: 'individual_verified_monthly', name: 'Verified Individual', records_per_month: 10 },
      });
      mockOpenBillingPortal.mockResolvedValue('https://billing.stripe.test/session/xyz');
      renderPage();

      fireEvent.click(screen.getAllByRole('button', { name: 'Select Plan' })[0]);

      await waitFor(() => {
        expect(window.location.href).toBe('https://billing.stripe.test/session/xyz');
      });
      expect(mockStartCheckout).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
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

  // BUG-2026-06-24-009 — the Pricing-page BillingOverview hardcoded
  // `usage.recordsUsed: 0`, so a user over quota saw "0 records used" with an
  // empty meter and no upgrade warning. Usage must come from useEntitlements.
  it('renders real (non-zero) usage in the Pricing-page overview (BUG-2026-06-24-009)', () => {
    mockBillingDefaults({
      subscription: { status: 'active', current_period_end: '2026-04-01' },
      plan: { id: 'individual_verified_monthly', name: 'Verified Individual', records_per_month: 10 },
    });
    mockEntitlementsDefaults({
      recordsUsed: 8,
      recordsLimit: 10,
      remaining: 2,
      percentUsed: 80,
      isNearLimit: true,
      planName: 'Verified Individual',
    });
    renderPage();

    // BillingOverview usage line ("{used} / {limit}") reflects the live count,
    // not the old hardcoded 0.
    expect(screen.getByText('8 / 10')).toBeInTheDocument();
    expect(screen.queryByText('0 / 10')).not.toBeInTheDocument();
  });

  it('surfaces the at-/near-limit upgrade warning on the Pricing page (BUG-2026-06-24-009)', () => {
    mockBillingDefaults({
      subscription: { status: 'active', current_period_end: '2026-04-01' },
      plan: { id: 'individual_verified_monthly', name: 'Verified Individual', records_per_month: 10 },
    });
    mockEntitlementsDefaults({
      recordsUsed: 10,
      recordsLimit: 10,
      remaining: 0,
      percentUsed: 100,
      isNearLimit: true,
      canCreateAnchor: false,
      planName: 'Verified Individual',
    });
    renderPage();

    // At 100% the BillingOverview meter shows the reached-limit copy.
    expect(screen.getByText(/reached your monthly limit/)).toBeInTheDocument();
  });

  // BUG-2026-06-24-010 — an unlimited (sentinel-normalized → null limit) plan
  // must NOT render the frozen "/ 999999" meter on the Pricing page.
  it('renders an unlimited plan without a numeric meter (BUG-2026-06-24-010)', () => {
    mockBillingDefaults({
      subscription: { status: 'active', current_period_end: '2026-04-01' },
      plan: { id: 'organization', name: 'Organization', records_per_month: 999999 },
    });
    // useEntitlements normalizes the 999999 sentinel to recordsLimit === null.
    mockEntitlementsDefaults({
      recordsUsed: 3,
      recordsLimit: null,
      remaining: null,
      percentUsed: null,
      isNearLimit: false,
      planName: 'Organization',
    });
    renderPage();

    // No frozen sentinel meter anywhere on the page.
    expect(screen.queryByText(/999999/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\/\s*999999/)).not.toBeInTheDocument();
    expect(screen.queryByText('3 / 999999')).not.toBeInTheDocument();
  });
});
