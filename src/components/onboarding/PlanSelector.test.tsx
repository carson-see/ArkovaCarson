/**
 * PlanSelector Component Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PlanSelector } from './PlanSelector';

describe('PlanSelector', () => {
  it('renders free, monthly verified, and annual verified choices', () => {
    render(<PlanSelector onSelect={vi.fn()} />);

    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('Verified Annual')).toBeInTheDocument();
    expect(screen.getByText('3 document anchors each month')).toBeInTheDocument();
    expect(screen.getByText('Stripe Identity verification')).toBeInTheDocument();
    expect(screen.getByText('Save $24 per year')).toBeInTheDocument();
  });

  it('submits the selected plan id', () => {
    const onSelect = vi.fn();
    render(<PlanSelector onSelect={onSelect} />);

    fireEvent.click(screen.getByText('Verified Annual'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(onSelect).toHaveBeenCalledWith('verified_annual');
  });

  it('submits free by default', () => {
    const onSelect = vi.fn();
    render(<PlanSelector onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(onSelect).toHaveBeenCalledWith('free');
  });
});
