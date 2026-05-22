import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BillingPage } from './BillingPage';

const mockGetSession = vi.hoisted(() => vi.fn());
const mockSignOut = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mockGetSession,
    },
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'user@example.test' },
    signOut: mockSignOut,
  }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: { id: 'user-1', role: 'INDIVIDUAL' },
    loading: false,
  }),
}));

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/billing/BillingOverview', () => ({
  BillingOverview: ({ billingInfo, loading }: { billingInfo: { plan?: { name?: string } } | null; loading?: boolean }) => (
    <div data-testid="billing-overview" data-loading={String(Boolean(loading))}>
      {billingInfo?.plan?.name ?? 'no billing info'}
    </div>
  ),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function renderBillingPage() {
  return render(
    <MemoryRouter initialEntries={['/billing']}>
      <BillingPage />
    </MemoryRouter>,
  );
}

describe('BillingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'token-1' } },
    });
  });

  it('renders confirmed billing data from the worker status endpoint', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        plan: { name: 'Individual', recordsIncluded: 25 },
        usage: { recordsUsed: 3, recordsLimit: 25 },
        billing: { status: 'active' },
        status: 'active',
      }),
    });

    renderBillingPage();

    expect(await screen.findByText('Individual')).toBeInTheDocument();
    expect(screen.getByTestId('billing-overview')).toHaveAttribute('data-loading', 'false');
  });

  it('shows an explicit unavailable state instead of a silent Beta fallback when billing status fails', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'not found' }),
    });

    renderBillingPage();

    expect(await screen.findByText('Unable to load billing data')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
    expect(screen.queryByTestId('billing-overview')).not.toBeInTheDocument();
  });
});
