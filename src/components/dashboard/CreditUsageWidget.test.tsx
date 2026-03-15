/**
 * CreditUsageWidget Tests
 *
 * @see MVP-25
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

  it('displays credit balance', () => {
    const { getByText } = render(<CreditUsageWidget />);
    expect(getByText('45')).toBeInTheDocument();
    expect(getByText(/50 remaining/)).toBeInTheDocument();
  });

  it('displays plan name badge', () => {
    const { getByText } = render(<CreditUsageWidget />);
    expect(getByText('Free')).toBeInTheDocument();
  });

  it('displays usage count', () => {
    const { getByText } = render(<CreditUsageWidget />);
    expect(getByText('5 used this period')).toBeInTheDocument();
  });

  it('shows low credits warning', () => {
    mockCredits.current = {
      ...mockCredits.current!,
      balance: 5,
      is_low: true,
    };

    const { getByText } = render(<CreditUsageWidget />);
    expect(getByText(/Low credits/)).toBeInTheDocument();
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
    // Should render skeleton, not credit info
    expect(container.querySelector('[data-slot="skeleton"]') || container.querySelector('.animate-pulse')).toBeTruthy();
  });
});
