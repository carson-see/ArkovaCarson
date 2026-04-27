/**
 * Unit tests for DataErrorBanner.
 *
 * Locks the contract extracted during the SCRUM-1260 (R1-6) /simplify pass.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataErrorBanner } from './DataErrorBanner';

describe('DataErrorBanner', () => {
  it('renders the title and message', () => {
    render(<DataErrorBanner title="Pipeline stats temporarily unavailable" message="boom" />);
    expect(screen.getByText('Pipeline stats temporarily unavailable')).toBeDefined();
    expect(screen.getByText(/boom/)).toBeDefined();
  });

  it('appends trailingMessage after message when provided', () => {
    render(
      <DataErrorBanner
        title="Pipeline stats temporarily unavailable"
        message="timeout"
        trailingMessage=" — showing last successful values."
      />,
    );
    expect(screen.getByText(/timeout — showing last successful values\./)).toBeDefined();
  });

  it('omits the retry button when onRetry is not provided', () => {
    render(<DataErrorBanner title="X" message="Y" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('fires onRetry when the retry button is clicked', () => {
    const onRetry = vi.fn();
    render(<DataErrorBanner title="X" message="Y" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables the retry button while retrying=true', () => {
    const onRetry = vi.fn();
    render(<DataErrorBanner title="X" message="Y" onRetry={onRetry} retrying />);
    const btn = screen.getByRole('button', { name: /retry/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('uses role="alert" so screen readers + Playwright assertions can find it', () => {
    render(<DataErrorBanner title="X" message="Y" />);
    expect(screen.getByRole('alert')).toBeDefined();
  });

  it('passes data-testid through for Playwright selectors', () => {
    render(<DataErrorBanner title="X" message="Y" data-testid="my-banner" />);
    expect(document.querySelector('[data-testid="my-banner"]')).not.toBeNull();
  });
});
