/* eslint-disable arkova/require-error-code-assertion -- Toast-error() here is UI copy shown via sonner, not an API error response; there is no status code or error.message to assert, the test is about auto-dismiss timing. */
/**
 * Empirical regression test for SCRUM-1981 ("error toasts never auto-dismiss").
 *
 * Investigation (2026-07-22): read sonner v2.0.7 source directly
 * (node_modules/sonner/dist/index.mjs). Per-toast duration resolves as
 * `toast.duration || durationFromToaster || TOAST_LIFETIME` — the `type`
 * (success/error/warning/info) never enters that calculation, it only
 * drives icon/color. App.tsx's single `<Toaster duration={TOAST_DURATIONS_MS.default} />`
 * (src/App.tsx) therefore already applies to every `toast.error(...)` call
 * that doesn't pass its own `duration` — and a grep of all ~63 call sites
 * confirmed none pass a custom `duration` or `Infinity`. So error toasts
 * were already auto-dismissing at the 5s Toaster default before this test
 * was added; this file locks that behavior in against the REAL sonner
 * package (no mocking) so a future sonner upgrade or Toaster-prop removal
 * that silently reintroduces "error toasts never dismiss" gets caught here
 * instead of relying on manual UAT.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Toaster, toast } from 'sonner';
import { TOAST_DURATIONS_MS } from './toastConfig';

describe('error toast auto-dismiss (SCRUM-1981 investigation)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      toast.dismiss();
      // Flush sonner's own removal timers so state doesn't leak into the next test.
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
  });

  it('dismisses an error toast at the same Toaster-level default duration as a success toast', () => {
    render(<Toaster duration={TOAST_DURATIONS_MS.default} />);

    act(() => {
      toast.error('Something went wrong');
      // Sonner defers the initial mount through a 0ms setTimeout ("Prevent
      // batching, temp solution" per its own source comment) — flush it.
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    // Just before the configured duration elapses, the toast is still shown.
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATIONS_MS.default - 100);
    });
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    // Past the configured duration (plus sonner's internal unmount grace
    // period), the error toast is gone — it did not persist indefinitely.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('does not special-case toast.error with an implicit Infinity duration', () => {
    render(<Toaster duration={TOAST_DURATIONS_MS.default} />);

    act(() => {
      toast.error('Uncalled-for error');
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByText('Uncalled-for error')).toBeInTheDocument();

    act(() => {
      // Comfortably past the Toaster default + unmount grace period.
      vi.advanceTimersByTime(TOAST_DURATIONS_MS.default + 500);
    });
    expect(screen.queryByText('Uncalled-for error')).not.toBeInTheDocument();
  });
});
