/**
 * BillingOverview Component Tests
 * @see P7-TS-01
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BillingOverview, type BillingInfo } from './BillingOverview';

const mockBillingInfo: BillingInfo = {
  plan: { name: 'Professional', price: 100, period: 'month', recordsIncluded: 100 },
  usage: { recordsUsed: 45, recordsLimit: 100, percentUsed: 45 },
  billing: {
    status: 'active',
    paymentMethod: 'visa',
    lastFourDigits: '4242',
    nextBillingDate: '2026-04-10T00:00:00Z',
    currentPeriodEnd: '2026-04-10T00:00:00Z',
  },
  status: 'active',
};

describe('BillingOverview', () => {
  it('renders loading skeleton when loading', () => {
    const { container } = render(<BillingOverview billingInfo={null} loading />);
    // Skeleton elements should be present
    expect(container.querySelectorAll('[class*="animate-pulse"], [class*="skeleton"]').length).toBeGreaterThan(0);
  });

  it('renders empty state when no billing info', () => {
    render(<BillingOverview billingInfo={null} />);
    expect(screen.getByText('No billing information available.')).toBeInTheDocument();
  });

  it('renders plan name and price', () => {
    render(<BillingOverview billingInfo={mockBillingInfo} />);
    expect(screen.getByText('Professional')).toBeInTheDocument();
    expect(screen.getByText('$100/mo')).toBeInTheDocument();
  });

  it('shows active status badge', () => {
    render(<BillingOverview billingInfo={mockBillingInfo} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows past due status', () => {
    const pastDue = { ...mockBillingInfo, status: 'past_due' as const, billing: { ...mockBillingInfo.billing, status: 'past_due' as const } };
    render(<BillingOverview billingInfo={pastDue} />);
    expect(screen.getByText('Past Due')).toBeInTheDocument();
  });

  it('renders usage section with records count', () => {
    render(<BillingOverview billingInfo={mockBillingInfo} />);
    expect(screen.getByText('Records secured')).toBeInTheDocument();
    expect(screen.getByText('45 / 100')).toBeInTheDocument();
  });

  it('shows near-limit warning at 80%+', () => {
    const nearLimit = {
      ...mockBillingInfo,
      usage: { recordsUsed: 85, recordsLimit: 100, percentUsed: 85 },
    };
    render(<BillingOverview billingInfo={nearLimit} />);
    expect(screen.getByText(/approaching your monthly limit/)).toBeInTheDocument();
  });

  it('shows at-limit warning at 100%', () => {
    const atLimit = {
      ...mockBillingInfo,
      usage: { recordsUsed: 100, recordsLimit: 100, percentUsed: 100 },
    };
    render(<BillingOverview billingInfo={atLimit} />);
    expect(screen.getByText(/reached your monthly limit/)).toBeInTheDocument();
  });

  it('renders payment method (Fee Account)', () => {
    render(<BillingOverview billingInfo={mockBillingInfo} />);
    expect(screen.getByText('Fee Account')).toBeInTheDocument();
    expect(screen.getByText('VISA')).toBeInTheDocument();
    expect(screen.getByText('**** **** **** 4242')).toBeInTheDocument();
  });

  it('shows no payment method message when missing', () => {
    const noPay = {
      ...mockBillingInfo,
      billing: { status: 'active' as const },
    };
    render(<BillingOverview billingInfo={noPay} />);
    expect(screen.getByText('No payment method on file.')).toBeInTheDocument();
  });

  it('calls onManageBilling when button clicked', () => {
    const onManage = vi.fn();
    render(<BillingOverview billingInfo={mockBillingInfo} onManageBilling={onManage} />);
    fireEvent.click(screen.getByText('Manage Billing'));
    expect(onManage).toHaveBeenCalled();
  });

  it('calls onUpgrade when button clicked', () => {
    const onUpgrade = vi.fn();
    render(<BillingOverview billingInfo={mockBillingInfo} onUpgrade={onUpgrade} />);
    fireEvent.click(screen.getByText('Upgrade Plan'));
    expect(onUpgrade).toHaveBeenCalled();
  });
});
