/**
 * PricingCard Component Tests
 * @see P7-TS-02
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PricingCard } from './PricingCard';

const basePlan = {
  id: 'plan-pro',
  name: 'Professional',
  description: 'For professionals',
  price: 100,
  priceLabel: '$100',
  period: 'month' as const,
  features: ['100 records per month', 'Priority support', 'API access'],
  recordsIncluded: 100,
};

describe('PricingCard', () => {
  it('renders plan name, description, and price', () => {
    render(<PricingCard plan={basePlan} />);
    expect(screen.getByText('Professional')).toBeInTheDocument();
    expect(screen.getByText('For professionals')).toBeInTheDocument();
    expect(screen.getByText('$100')).toBeInTheDocument();
    expect(screen.getByText('/mo')).toBeInTheDocument();
  });

  it('renders all features', () => {
    render(<PricingCard plan={basePlan} />);
    expect(screen.getByText('100 records per month')).toBeInTheDocument();
    expect(screen.getByText('Priority support')).toBeInTheDocument();
    expect(screen.getByText('API access')).toBeInTheDocument();
  });

  it('shows records included', () => {
    render(<PricingCard plan={basePlan} />);
    expect(screen.getByText('100 records/month')).toBeInTheDocument();
  });

  it('shows "Unlimited records" for unlimited plan', () => {
    render(<PricingCard plan={{ ...basePlan, recordsIncluded: 'unlimited' }} />);
    expect(screen.getByText('Unlimited records')).toBeInTheDocument();
  });

  it('shows "Contact us" for null price', () => {
    render(<PricingCard plan={{ ...basePlan, price: null, priceLabel: undefined }} />);
    expect(screen.getByText('Contact us')).toBeInTheDocument();
  });

  it('shows custom price label when price is null', () => {
    render(<PricingCard plan={{ ...basePlan, price: null, priceLabel: 'Custom' }} />);
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });

  it('shows "Recommended" badge when recommended', () => {
    render(<PricingCard plan={{ ...basePlan, recommended: true }} />);
    expect(screen.getByText('Recommended')).toBeInTheDocument();
  });

  it('shows "Current Plan" badge and disables button when current', () => {
    render(<PricingCard plan={{ ...basePlan, current: true }} />);
    expect(screen.getAllByText('Current Plan')).toHaveLength(2); // badge + button
    expect(screen.getByRole('button', { name: 'Current Plan' })).toBeDisabled();
  });

  it('calls onSelect with plan id when button clicked', () => {
    const onSelect = vi.fn();
    render(<PricingCard plan={basePlan} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select Plan' }));
    expect(onSelect).toHaveBeenCalledWith('plan-pro');
  });

  it('shows "Contact Sales" for null price plans', () => {
    render(<PricingCard plan={{ ...basePlan, price: null }} />);
    expect(screen.getByRole('button', { name: 'Contact Sales' })).toBeInTheDocument();
  });

  it('disables button when loading', () => {
    render(<PricingCard plan={basePlan} loading />);
    expect(screen.getByRole('button', { name: 'Select Plan' })).toBeDisabled();
  });
});
