/**
 * CheckoutCancelPage Tests
 *
 * Tests the checkout cancellation page.
 * Verifies cancel messaging and navigation links.
 *
 * @see P7-TS-02
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// =========================================================================
// Mocks
// =========================================================================

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
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

import { CheckoutCancelPage } from './CheckoutCancelPage';
import { BILLING_LABELS } from '@/lib/copy';

// =========================================================================
// Tests
// =========================================================================

describe('CheckoutCancelPage', () => {
  function renderPage() {
    return render(
      <MemoryRouter>
        <CheckoutCancelPage />
      </MemoryRouter>,
    );
  }

  it('renders cancel title and description', () => {
    renderPage();
    expect(screen.getByText(BILLING_LABELS.CHECKOUT_CANCEL_TITLE)).toBeInTheDocument();
    expect(screen.getByText(BILLING_LABELS.CHECKOUT_CANCEL_DESC)).toBeInTheDocument();
  });

  it('renders back to pricing link', () => {
    renderPage();
    expect(screen.getByText(BILLING_LABELS.BACK_TO_PRICING)).toBeInTheDocument();
  });

  it('renders dashboard link', () => {
    renderPage();
    expect(screen.getByText(BILLING_LABELS.GO_TO_DASHBOARD)).toBeInTheDocument();
  });

  it('links back to billing route', () => {
    renderPage();
    const backLink = screen.getByText(BILLING_LABELS.BACK_TO_PRICING).closest('a');
    expect(backLink).toHaveAttribute('href', '/billing');
  });

  it('links to dashboard route', () => {
    renderPage();
    const dashLink = screen.getByText(BILLING_LABELS.GO_TO_DASHBOARD).closest('a');
    expect(dashLink).toHaveAttribute('href', '/dashboard');
  });
});
