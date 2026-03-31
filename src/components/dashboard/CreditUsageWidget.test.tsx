/**
 * CreditUsageWidget Tests
 *
 * Beta mode: shows unlimited credits, no limits.
 * @see MVP-25, feedback: no credit/quota limits during beta
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const mockCredits = vi.hoisted(() => ({
  current: {
    balance: 45,
    monthly_allocation: 50,
    purchased: 0,
    plan_name: 'Free',
    cycle_start: '2026-03-01T00:00:00Z',
    cycle_end: '2026-04-01T00:00:00Z',
    is_low: false,
  } as {
    balance: number;
    monthly_allocation: number;
    purchased: number;
    plan_name: string;
    cycle_start: string | null;
    cycle_end: string | null;
    is_low: boolean;
  } | null,
  loading: false,
  error: null as string | null,
}));

vi.mock('@/hooks/useCredits', () => ({
  useCredits: () => ({
    credits: mockCredits.current,
    loading: mockCredits.loading,
    error: mockCredits.error,
  }),
}));

import { CreditUsageWidget } from './CreditUsageWidget';

describe('CreditUsageWidget', () => {
  beforeEach(() => {
    mockCredits.current = {
      balance: 45,
      monthly_allocation: 50,
      purchased: 0,
      plan_name: 'Free',
      cycle_start: '2026-03-01T00:00:00Z',
      cycle_end: '2026-04-01T00:00:00Z',
      is_low: false,
    };
    mockCredits.loading = false;
    mockCredits.error = null;
  });

  it('displays unlimited credits during beta', () => {
    const { getByText } = render(<CreditUsageWidget />);
    expect(getByText('Unlimited')).toBeInTheDocument();
    expect(getByText('Beta')).toBeInTheDocument();
  });

  it('displays no credit limits message', () => {
    const { getByText } = render(<CreditUsageWidget />);
    expect(getByText('No credit limits during beta')).toBeInTheDocument();
  });

  it('renders nothing on error', () => {
    mockCredits.error = 'Failed';
    mockCredits.current = null;

    const { container } = render(<CreditUsageWidget />);
    expect(container.firstChild).toBeNull();
  });

  it('shows skeleton when loading', () => {
    mockCredits.loading = true;

    const { container } = render(<CreditUsageWidget />);
    expect(container.querySelector('[data-slot="skeleton"]') || container.querySelector('.animate-pulse')).toBeTruthy();
  });
});
