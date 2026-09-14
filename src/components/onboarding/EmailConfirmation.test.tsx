import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailConfirmation } from './EmailConfirmation';

describe('EmailConfirmation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('states the 15-minute lifetime and keeps resend unavailable for 90 seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
    const onResend = vi.fn();

    render(
      <EmailConfirmation
        email="member@arkova.ai"
        onResend={onResend}
        resendAvailableAt={Date.now() + 90_000}
      />,
    );

    expect(screen.getByText(/link expires in 15 minutes/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resend in 90s/i })).toBeDisabled();
    act(() => vi.advanceTimersByTime(89_000));
    expect(screen.getByRole('button', { name: /resend in 1s/i })).toBeDisabled();
    act(() => vi.advanceTimersByTime(1_000));
    fireEvent.click(screen.getByRole('button', { name: /^resend email$/i }));
    expect(onResend).toHaveBeenCalledOnce();
  });

  it('announces only the resend outcome supplied by the caller', () => {
    const { rerender } = render(
      <EmailConfirmation email="member@arkova.ai" resendResult="success" />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/new verification link was sent/i);

    rerender(<EmailConfirmation email="member@arkova.ai" resendResult="error" />);
    expect(screen.getByRole('alert')).toHaveTextContent(/could not send a new verification link/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
