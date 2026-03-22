/**
 * Payment Analytics Page Tests (PH1-PAY-03)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn().mockReturnValue({
    user: { email: 'carson@arkova.ai', id: 'user-1' },
    signOut: vi.fn(),
    session: null,
    loading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: vi.fn().mockReturnValue({
    profile: { org_id: 'org-1', role: 'ORG_ADMIN', full_name: 'Carson' },
    loading: false,
    destination: '/dashboard',
  }),
}));

vi.mock('@/hooks/useTheme', () => ({
  useTheme: vi.fn().mockReturnValue({ theme: 'dark', setTheme: vi.fn() }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    }),
  },
}));

import { PaymentAnalyticsPage } from './PaymentAnalyticsPage';

describe('PaymentAnalyticsPage', () => {
  it('renders page title for admin user', () => {
    render(
      <MemoryRouter>
        <PaymentAnalyticsPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Payment Analytics')).toBeInTheDocument();
  });

  it('renders refresh button', () => {
    render(
      <MemoryRouter>
        <PaymentAnalyticsPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Refresh')).toBeInTheDocument();
  });

  it('shows access restricted for non-admin', async () => {
    const { useAuth } = await import('@/hooks/useAuth');
    vi.mocked(useAuth).mockReturnValue({
      user: { email: 'regular@test.com', id: 'user-2' },
      signOut: vi.fn(),
      session: null,
      loading: false,
      error: null,
    } as unknown as ReturnType<typeof useAuth>);

    render(
      <MemoryRouter>
        <PaymentAnalyticsPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Access Restricted')).toBeInTheDocument();
  });
});
