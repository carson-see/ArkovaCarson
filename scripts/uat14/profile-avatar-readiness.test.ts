import { describe, expect, it, vi } from 'vitest';
import { ProfileAvatarReadinessError, waitForProfileAvatar } from './profile-avatar-readiness';

type MockPage = Parameters<typeof waitForProfileAvatar>[0];

function pageAt(url: string, options: { avatar?: boolean; mfa?: boolean; closed?: boolean; waitError?: boolean } = {}) {
  const listeners = new Map<string, (response: { status(): number }) => void>();
  const avatar = {
    waitFor: options.waitError ? vi.fn().mockRejectedValue(new Error('secret browser detail')) : vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(options.avatar ?? false),
  };
  const page = {
    url: () => url,
    isClosed: () => options.closed ?? false,
    locator: (selector: string) => selector === '#profile-avatar' ? avatar : { isVisible: vi.fn().mockResolvedValue(false) },
    getByLabel: () => ({ isVisible: vi.fn().mockResolvedValue(options.mfa ?? false) }),
    evaluate: vi.fn().mockResolvedValue('complete'),
    on: (name: string, callback: (response: { status(): number }) => void) => listeners.set(name, callback),
    off: (name: string) => listeners.delete(name),
  };
  return { page: page as unknown as MockPage, avatar, listeners };
}

describe('UAT14 profile avatar readiness diagnostics', () => {
  it.each([
    ['https://app.example/login?token=private', {}, 'auth_redirect', 'login'],
    ['https://app.example/settings?token=private', { mfa: true }, 'mfa_gate', 'settings'],
    ['https://app.example/organizations/private-id', {}, 'wrong_route', 'other'],
    ['https://app.example/settings', {}, 'avatar_unavailable', 'settings'],
    ['https://app.example/settings', { closed: true }, 'page_closed', 'unknown'],
  ] as const)('classifies %s without revealing page data', async (url, options, category, path) => {
    const { page, listeners } = pageAt(url, { ...options, waitError: true });
    const waiting = waitForProfileAvatar(page, { timeoutMs: 20 });
    listeners.get('response')?.({ status: () => 500 });
    await expect(waiting).rejects.toMatchObject({
      name: 'ProfileAvatarReadinessError',
      diagnostic: { category, path, responseFailures: { client: 0, server: 1 } },
    });
    expect(listeners.size).toBe(0);
    await expect(waiting).rejects.not.toThrow(/private|secret browser detail/);
  });

  it('leaves successful avatar interaction untouched and removes its listener', async () => {
    const { page, avatar, listeners } = pageAt('https://app.example/settings', { avatar: true });
    await expect(waitForProfileAvatar(page, { timeoutMs: 20 })).resolves.toBeUndefined();
    expect(avatar.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 20 });
    expect(listeners.size).toBe(0);
  });

  it('uses a bounded failure record when page inspection itself fails', async () => {
    const { page } = pageAt('https://app.example/settings', { waitError: true });
    (page.evaluate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('credential in browser state'));
    await expect(waitForProfileAvatar(page, { timeoutMs: 20 })).rejects.toMatchObject({
      diagnostic: { category: 'avatar_unavailable', readyState: 'unavailable' },
    });
  });

  it('reports an avatar that appeared after the original wait timed out', async () => {
    const { page } = pageAt('https://app.example/settings', { avatar: true, waitError: true });
    await expect(waitForProfileAvatar(page, { timeoutMs: 20 })).rejects.toMatchObject({
      diagnostic: { category: 'late_avatar_visible', avatarVisible: true },
    });
  });

  it('bounds stalled page inspection and marks the incomplete diagnosis', async () => {
    const { page } = pageAt('https://app.example/settings', { waitError: true });
    (page.evaluate as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    await expect(waitForProfileAvatar(page, { timeoutMs: 20, diagnosticBudgetMs: 20 })).rejects.toMatchObject({
      diagnostic: { category: 'avatar_unavailable', inspectionTimedOut: true, readyState: 'unavailable' },
    });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it.each([0, -1, Infinity, Number.NaN])('rejects an unbounded wait timeout %s', async timeoutMs => {
    const { page } = pageAt('https://app.example/settings');
    await expect(waitForProfileAvatar(page, { timeoutMs })).rejects.toThrow(RangeError);
  });

  it.each([0, 501, Infinity])('rejects an inspection budget outside the 500ms cap: %s', async diagnosticBudgetMs => {
    const { page } = pageAt('https://app.example/settings');
    await expect(waitForProfileAvatar(page, { diagnosticBudgetMs })).rejects.toThrow(RangeError);
  });
});
