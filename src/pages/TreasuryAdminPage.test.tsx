/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * Tests for TreasuryAdminPage
 *
 * @see GAP-01 — Admin Treasury Dashboard
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TreasuryAdminPage } from './TreasuryAdminPage';

// Mock hooks
const mockUser = { email: 'carson@arkova.ai' };
const mockProfile = { full_name: 'Admin', role: 'ORG_ADMIN', org_id: null, public_id: 'admin-1', is_public_profile: false, avatar_url: null };
const mockTreasuryBalanceState: {
  balance: null;
  receipts: [];
  feeRates: null;
  anchorStats: null;
  sourceState: {
    cacheUpdatedAt: string | null;
    cacheStale: boolean;
    healthError: string | null;
  };
  loading: boolean;
  error: string | null;
  refresh: ReturnType<typeof vi.fn>;
} = {
  balance: null,
  receipts: [],
  feeRates: null,
  anchorStats: null,
  sourceState: {
    cacheUpdatedAt: '2026-05-12T10:00:00Z',
    cacheStale: false,
    healthError: null as string | null,
  },
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
};

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: mockUser,
    loading: false,
    signOut: vi.fn(),
  }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: mockProfile,
    loading: false,
    destination: '/dashboard' as const,
    updateProfile: vi.fn(),
  }),
  ProfileProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useOrganization', () => ({
  useOrganization: () => ({
    organization: null,
    loading: false,
  }),
}));

vi.mock('@/hooks/useTreasuryBalance', () => ({
  useTreasuryBalance: () => mockTreasuryBalanceState,
}));

vi.mock('@/lib/workerClient', () => ({
  workerFetch: vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({ total: 0, revenue: 0, recent: [] }),
  }),
}));

// Mock supabase — factory must not reference outer variables (hoisting)
vi.mock('@/lib/supabase', () => {
  return {
    supabase: {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          is: vi.fn().mockResolvedValue({ count: 0, error: null }),
          eq: vi.fn().mockReturnValue({
            is: vi.fn().mockResolvedValue({ count: 0, error: null }),
          }),
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
          not: vi.fn().mockReturnValue({
            is: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      }),
      rpc: vi.fn().mockResolvedValue({
        data: {
          total_payments: 0,
          total_revenue_usd: 0,
          recent_payments: [],
        },
        error: null,
      }),
    },
  };
});

// Mock AppShell
vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/treasury']}>
      <TreasuryAdminPage />
    </MemoryRouter>,
  );
}

describe('TreasuryAdminPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.email = 'carson@arkova.ai';
    mockTreasuryBalanceState.sourceState = {
      cacheUpdatedAt: '2026-05-12T10:00:00Z',
      cacheStale: false,
      healthError: null,
    };
    mockTreasuryBalanceState.error = null;
  });

  it('renders the page title for admin users', () => {
    renderPage();
    expect(screen.getByText('Anchoring Infrastructure')).toBeInTheDocument();
  });

  it('renders balance card', () => {
    renderPage();
    expect(screen.getByText('Fee Account Balance')).toBeInTheDocument();
  });

  it('renders anchor statistics panel', () => {
    renderPage();
    expect(screen.getByText('Pipeline Status')).toBeInTheDocument();
  });

  it('renders network status section', () => {
    renderPage();
    expect(screen.getByText('Network Status')).toBeInTheDocument();
  });

  it('renders receipt table', () => {
    renderPage();
    expect(screen.getByText('Recent Network Receipts')).toBeInTheDocument();
  });

  it('renders refresh button', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
  });

  it('shows unauthorized message for non-admin users', () => {
    mockUser.email = 'user@example.com';
    renderPage();
    expect(screen.getByText(/access denied/i)).toBeInTheDocument();
  });

  it('renders x402 payment section', () => {
    renderPage();
    expect(screen.getByText('x402 Payment Revenue')).toBeInTheDocument();
  });

  it('surfaces worker cache freshness from the treasury source state', () => {
    renderPage();
    expect(screen.getByTestId('treasury-cache-freshness')).toHaveTextContent('Worker source');
    expect(screen.getByTestId('treasury-cache-freshness')).toHaveTextContent('Treasury cache refreshed');
  });

  it('surfaces stale/error state when worker cache freshness is unavailable', () => {
    mockTreasuryBalanceState.sourceState = {
      cacheUpdatedAt: null,
      cacheStale: true,
      healthError: 'Worker health returned 503',
    };

    renderPage();

    expect(screen.getByTestId('treasury-cache-error')).toHaveTextContent('Worker/cache freshness unavailable');
    expect(screen.getByTestId('treasury-cache-freshness')).toHaveTextContent('Stale');
  });
});
