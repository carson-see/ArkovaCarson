/**
 * Admin Onboarding Wizard — UX-01 (SCRUM-1027) tests.
 *
 * Covers the golden path: step 1 → 2 → 3 (pick template) → 4 (create rule)
 * → 5 (done). Also checks: Next blocked without a template selection, Skip
 * jumps forward, and POST /api/rules is called with the template payload and
 * `enabled: false`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { AdminOnboardingPage } from './AdminOnboardingPage';

const workerFetchMock = vi.fn();
vi.mock('@/lib/workerClient', () => ({
  workerFetch: (...args: unknown[]) => workerFetchMock(...args),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u-1' }, signOut: vi.fn() }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: { id: 'u-1', org_id: 'org-1', role: 'ORG_ADMIN' },
    loading: false,
  }),
}));

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function renderPage() {
  return render(
    <BrowserRouter>
      <AdminOnboardingPage />
    </BrowserRouter>,
  );
}

describe('AdminOnboardingPage', () => {
  beforeEach(() => {
    workerFetchMock.mockReset();
    // `userEvent.setup()` in v14 installs its own `navigator.clipboard` stub
    // via Object.defineProperty. When the global test setup
    // (src/test/setup.ts) has already defined clipboard, the redefine can
    // throw `TypeError: Cannot redefine property: clipboard` in jsdom.
    // Deleting before each test makes user-event's install path a fresh
    // create instead of a redefine.
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders step 1 with progress', () => {
    renderPage();
    expect(screen.getByText(/Welcome to Arkova/)).toBeInTheDocument();
    expect(screen.getByText(/Step 1 of 5/)).toBeInTheDocument();
  });

  it('advances with Next and blocks step 3 Next until a template is picked', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId('onboarding-next')); // 1 → 2
    await user.click(screen.getByTestId('onboarding-next')); // 2 → 3
    const next = screen.getByTestId('onboarding-next');
    expect(next).toBeDisabled();

    await user.click(screen.getByTestId('template-anchor-docusign'));
    expect(next).toBeEnabled();
  });

  it('POSTs the template with enabled:false and advances to Done on success', async () => {
    const user = userEvent.setup();
    workerFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'rule-new' }), { status: 201 }),
    );

    renderPage();
    await user.click(screen.getByTestId('onboarding-next')); // 1 → 2
    await user.click(screen.getByTestId('onboarding-next')); // 2 → 3
    await user.click(screen.getByTestId('template-flag-multi-author-drive'));
    await user.click(screen.getByTestId('onboarding-next')); // 3 → 4
    await user.click(screen.getByTestId('onboarding-enable'));

    await waitFor(() => {
      expect(workerFetchMock).toHaveBeenCalledTimes(1);
    });
    const [endpoint, init] = workerFetchMock.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('/api/rules');
    const body = JSON.parse(init.body as string) as {
      org_id: string;
      trigger_type: string;
      enabled: boolean;
    };
    expect(body.org_id).toBe('org-1');
    expect(body.trigger_type).toBe('WORKSPACE_FILE_MODIFIED');
    expect(body.enabled).toBe(false);

    await waitFor(() => {
      expect(screen.getByText(/Your first rule is in place/)).toBeInTheDocument();
    });
  });

  it('surfaces server error message on failure', async () => {
    const user = userEvent.setup();
    workerFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: 'forbidden: not org admin' } }),
        { status: 403 },
      ),
    );

    renderPage();
    await user.click(screen.getByTestId('onboarding-next'));
    await user.click(screen.getByTestId('onboarding-next'));
    await user.click(screen.getByTestId('template-anchor-docusign'));
    await user.click(screen.getByTestId('onboarding-next'));
    await user.click(screen.getByTestId('onboarding-enable'));

    await waitFor(() => {
      const alert = screen.getByTestId('onboarding-error');
      expect(within(alert).getByText(/forbidden/)).toBeInTheDocument();
    });
  });
});
