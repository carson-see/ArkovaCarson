import { describe, expect, it } from 'vitest';
import { shouldDismissToastsForLocationChange } from './toastNavigation';

describe('shouldDismissToastsForLocationChange', () => {
  it('keeps route-result toasts visible when only query params are cleaned up', () => {
    expect(shouldDismissToastsForLocationChange(
      { pathname: '/organization/profile', search: '?drive=connected' },
      { pathname: '/organization/profile', search: '' },
    )).toBe(false);
  });

  it('dismisses stale toasts when the user navigates to a different route', () => {
    expect(shouldDismissToastsForLocationChange(
      { pathname: '/organization/profile', search: '' },
      { pathname: '/dashboard', search: '' },
    )).toBe(true);
  });
});
