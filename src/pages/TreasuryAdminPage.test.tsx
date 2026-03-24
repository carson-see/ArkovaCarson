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

vi.mock('@/hooks/useTreasuryStatus', () => ({
  useTreasuryStatus: () => ({
    status: null,
    loading: false,
    error: null,
    fetchStatus: vi.fn(),
  }),
}));

// Mock supabase — factory must not reference outer variables (hoisting)
vi.mock('@/lib/supabase', () => {
  const mockResolve = { count: 5, error: null };
  const mockIs = vi.fn().mockResolvedValue(mockResolve);
  return {
    supabase: {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          is: mockIs,
          eq: vi.fn().mockReturnValue({
            is: mockIs,
          }),
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
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
  });

  it('renders the page title for admin users', () => {
    renderPage();
    expect(screen.getByText('Anchoring Infrastructure')).toBeInTheDocument();
  });

  it('renders anchor stat cards', () => {
    renderPage();
    expect(screen.getByText('Total Anchors')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Secured')).toBeInTheDocument();
    expect(screen.getByText('Last 24 Hours')).toBeInTheDocument();
  });

  it('renders treasury vault section', () => {
    renderPage();
    expect(screen.getByText('Anchoring Account')).toBeInTheDocument();
  });

  it('renders network status section', () => {
    renderPage();
    expect(screen.getByText('Network Status')).toBeInTheDocument();
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

  it('shows recent anchors section', () => {
    renderPage();
    expect(screen.getByText('Recent Anchors')).toBeInTheDocument();
  });
});
