/* eslint-disable arkova/require-error-code-assertion -- Duration config has an `error` severity key; these tests do not exercise a failing request. */
import { describe, expect, it } from 'vitest';
import { TOAST_DURATIONS_MS } from './toastConfig';

describe('toast duration contract', () => {
  it('caps success/default toasts at 5 seconds and errors at 8 seconds', () => {
    expect(TOAST_DURATIONS_MS.default).toBe(5_000);
    expect(TOAST_DURATIONS_MS.success).toBe(5_000);
    expect(TOAST_DURATIONS_MS.error).toBe(8_000);
  });

  it('keeps realtime status toasts within the error-toast cap', () => {
    expect(TOAST_DURATIONS_MS.status).toBeLessThanOrEqual(TOAST_DURATIONS_MS.error);
  });
});
