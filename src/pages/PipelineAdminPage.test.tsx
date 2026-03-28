/**
 * Pipeline Admin Page Tests (PH1-DATA-05)
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

vi.mock('@/lib/supabase', () => {
  const mockQuery = {
    not: vi.fn().mockResolvedValue({ count: 40, data: null, error: null }),
    is: vi.fn().mockResolvedValue({ count: 10, data: null, error: null }),
    limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    range: vi.fn().mockResolvedValue({ data: [], count: 0, error: null }),
  };
  return {
    supabase: {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue(mockQuery),
      }),
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    },
  };
});

import { PipelineAdminPage } from './PipelineAdminPage';

describe('PipelineAdminPage', () => {
  it('renders page title for admin user', () => {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Pipeline Monitoring')).toBeInTheDocument();
  });

  it('renders refresh button', () => {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
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
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Access Restricted')).toBeInTheDocument();
  });
});
