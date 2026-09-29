import type { Page, Response } from '@playwright/test';

export type ProfileAvatarDiagnostic = {
  category: 'page_closed' | 'auth_redirect' | 'mfa_gate' | 'wrong_route' | 'avatar_unavailable' | 'late_avatar_visible';
  path: 'login' | 'signup' | 'settings' | 'other' | 'unknown';
  readyState: 'loading' | 'interactive' | 'complete' | 'unavailable';
  avatarVisible: boolean;
  inspectionTimedOut: boolean;
  responseFailures: { client: number; server: number };
};

export class ProfileAvatarReadinessError extends Error {
  readonly diagnostic: ProfileAvatarDiagnostic;

  constructor(diagnostic: ProfileAvatarDiagnostic) {
    super(`UAT14 avatar input unavailable: ${diagnostic.category}; diagnostic=${JSON.stringify(diagnostic)}`);
    this.name = 'ProfileAvatarReadinessError';
    this.diagnostic = diagnostic;
  }
}

function safePath(url: string): ProfileAvatarDiagnostic['path'] {
  try {
    const path = new URL(url).pathname;
    if (path === '/login') return 'login';
    if (path === '/signup') return 'signup';
    if (path === '/settings') return 'settings';
    return 'other';
  } catch {
    return 'unknown';
  }
}

async function isVisible(page: Page, selector: '#profile-avatar' | 'Verification code'): Promise<boolean> {
  try {
    return selector === '#profile-avatar'
      ? await page.locator(selector).isVisible()
      : await page.getByLabel(selector).isVisible();
  } catch {
    return false;
  }
}

/**
 * Observe only bounded browser state. Failure counts begin when this helper is called;
 * they do not cover earlier login or navigation requests. Never include body text,
 * URLs, cookies or Playwright's raw error.
 */
export async function waitForProfileAvatar(
  page: Page,
  { timeoutMs = 30_000, diagnosticBudgetMs = 500 }: { timeoutMs?: number; diagnosticBudgetMs?: number } = {},
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw new RangeError('Invalid avatar wait timeout');
  if (!Number.isFinite(diagnosticBudgetMs) || diagnosticBudgetMs <= 0 || diagnosticBudgetMs > 500) {
    throw new RangeError('Invalid diagnostic budget');
  }
  const responseFailures = { client: 0, server: 0 };
  const onResponse = (response: Response) => {
    const status = response.status();
    if (status >= 500 && status <= 599) responseFailures.server += 1;
    else if (status >= 400 && status <= 499) responseFailures.client += 1;
  };
  page.on('response', onResponse);
  try {
    await page.locator('#profile-avatar').waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    const closed = page.isClosed();
    let path: ProfileAvatarDiagnostic['path'] = 'unknown';
    if (!closed) {
      try { path = safePath(page.url()); } catch { /* Navigation may have detached the page. */ }
    }
    type Inspection = Pick<ProfileAvatarDiagnostic, 'avatarVisible' | 'readyState' | 'inspectionTimedOut'> & { mfa: boolean };
    const unavailable: Inspection = { mfa: false, avatarVisible: false, readyState: 'unavailable', inspectionTimedOut: true };
    const inspect = async (): Promise<Inspection> => {
      const mfa = await isVisible(page, 'Verification code');
      const avatarVisible = await isVisible(page, '#profile-avatar');
      let readyState: Inspection['readyState'] = 'unavailable';
      try {
        const state: unknown = await page.evaluate(() => document.readyState);
        if (state === 'loading' || state === 'interactive' || state === 'complete') readyState = state;
      } catch { /* Browser inspection may fail when navigation or teardown is in progress. */ }
      return { mfa, avatarVisible, readyState, inspectionTimedOut: false };
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inspection = closed ? unavailable : await Promise.race<Inspection>([
      inspect(),
      new Promise(resolve => { timer = setTimeout(() => resolve(unavailable), diagnosticBudgetMs); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    const category = closed ? 'page_closed'
      : path === 'login' || path === 'signup' ? 'auth_redirect'
        : inspection.mfa ? 'mfa_gate'
          : path !== 'settings' ? 'wrong_route'
            : inspection.avatarVisible ? 'late_avatar_visible'
              : 'avatar_unavailable';
    throw new ProfileAvatarReadinessError({ category, path, readyState: inspection.readyState,
      avatarVisible: inspection.avatarVisible, inspectionTimedOut: inspection.inspectionTimedOut, responseFailures });
  } finally {
    page.off('response', onResponse);
  }
}
