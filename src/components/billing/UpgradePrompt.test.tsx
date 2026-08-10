/**
 * UpgradePrompt Component Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { UpgradePrompt } from './UpgradePrompt';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

describe('UpgradePrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render quota reached title', () => {
    const { getByText } = render(
      <UpgradePrompt
        open={true}
        onOpenChange={() => {}}
        recordsUsed={3}
        recordsLimit={3}
        planName="Free"
      />
    );

    expect(getByText('Monthly Limit Reached')).toBeInTheDocument();
  });

  it('should display usage counts', () => {
    const { getByText } = render(
      <UpgradePrompt
        open={true}
        onOpenChange={() => {}}
        recordsUsed={10}
        recordsLimit={10}
        planName="Individual"
      />
    );

    expect(getByText(/10 \/ 10/)).toBeInTheDocument();
    expect(getByText(/Individual Plan/)).toBeInTheDocument();
  });

  // This modal fires at exactly the moment the user is blocked by their quota —
  // the highest-intent upgrade CTA in the product. It navigated to /billing (a
  // summary page with its own dead "Upgrade Plan" button), so the buy path
  // terminated here. Its own docblock always claimed it "directs them to
  // upgrade via the pricing page"; now it does.
  it('should navigate to the pricing/checkout page on upgrade click', () => {
    const onOpenChange = vi.fn();

    const { getByText } = render(
      <UpgradePrompt
        open={true}
        onOpenChange={onOpenChange}
        recordsUsed={3}
        recordsLimit={3}
        planName="Free"
      />
    );

    fireEvent.click(getByText('Upgrade Plan'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockNavigate).toHaveBeenCalledWith('/pricing');
    expect(mockNavigate).not.toHaveBeenCalledWith('/billing');
  });

  it('should close on cancel click', () => {
    const onOpenChange = vi.fn();

    const { getByText } = render(
      <UpgradePrompt
        open={true}
        onOpenChange={onOpenChange}
        recordsUsed={3}
        recordsLimit={3}
        planName="Free"
      />
    );

    fireEvent.click(getByText('Cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('should not render when closed', () => {
    const { queryByText } = render(
      <UpgradePrompt
        open={false}
        onOpenChange={() => {}}
        recordsUsed={3}
        recordsLimit={3}
        planName="Free"
      />
    );

    expect(queryByText('Monthly Limit Reached')).not.toBeInTheDocument();
  });
});
