/**
 * Platform SLO Dashboard Page Tests (SCRUM-2401 / OPS-03)
 *
 * Covers: platform-admin gating, loading skeleton, empty state, healthy
 * render, and breach-badge rendering (per-surface + overall).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockUseOpsSloStats = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn().mockReturnValue({ user: { email: 'carson@arkova.ai', id: 'user-1' }, signOut: vi.fn() }),
}));
vi.mock('@/hooks/useProfile', () => ({
  useProfile: vi.fn().mockReturnValue({ profile: { org_id: null, role: null, is_platform_admin: true }, loading: false }),
}));
vi.mock('@/hooks/useOpsSloStats', () => ({ useOpsSloStats: mockUseOpsSloStats }));

import { OpsSloDashboardPage } from './OpsSloDashboardPage';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import type { OpsSloStats } from '@/hooks/useOpsSloStats';

function renderPage() {
  return render(
    <MemoryRouter>
      <OpsSloDashboardPage />
    </MemoryRouter>,
  );
}

function healthyStats(): OpsSloStats {
  return {
    anchorSecuredRate: {
      available: true, securedCount: 992, totalCount: 1000, ratePct: 99.2,
      cacheUpdatedAt: '2026-07-06T00:00:00Z', breach: false, error: null,
    },
    connectorQueue: { available: true, depth: 2, anchored: 100, failed: 1, breach: false, error: null },
    creditConservation: { available: true, orgsChecked: 10, divergedCount: 0, divergedOrgIds: [], breach: false, error: null },
    webhookDelivery: { available: true, successCount: 95, totalCount: 100, ratePct: 95, windowHours: 24, breach: false, error: null },
    apiErrors: { available: true, errorCount: 1, totalCount: 100, errorRatePct: 1, windowHours: 24, breach: false, error: null },
    overallBreach: false,
    checkedAt: '2026-07-06T00:00:00Z',
  };
}

describe('OpsSloDashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useAuth as ReturnType<typeof vi.fn>).mockReturnValue({
      user: { email: 'carson@arkova.ai', id: 'user-1' },
      signOut: vi.fn(),
    });
    // Default to platform admin; individual tests override the flag to deny.
    (useProfile as ReturnType<typeof vi.fn>).mockReturnValue({
      profile: { org_id: null, role: null, is_platform_admin: true },
      loading: false,
    });
  });

  it('shows an access-restricted card for a non-admin user', () => {
    (useAuth as ReturnType<typeof vi.fn>).mockReturnValue({
      user: { email: 'someone@example.com', id: 'user-2' },
      signOut: vi.fn(),
    });
    // Access is decided by the is_platform_admin DB flag, not the email.
    (useProfile as ReturnType<typeof vi.fn>).mockReturnValue({
      profile: { org_id: null, role: null, is_platform_admin: false },
      loading: false,
    });
    mockUseOpsSloStats.mockReturnValue({ stats: null, loading: false, error: null, refetch: vi.fn() });

    renderPage();

    expect(screen.getByText('Access Restricted')).toBeInTheDocument();
    expect(mockUseOpsSloStats).toHaveBeenCalled();
  });

  it('renders a loading skeleton while fetching with no stats yet', () => {
    mockUseOpsSloStats.mockReturnValue({ stats: null, loading: true, error: null, refetch: vi.fn() });

    renderPage();

    expect(screen.getByTestId('ops-slo-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('ops-slo-cards')).not.toBeInTheDocument();
  });

  it('renders an empty state when not loading, no error, and no stats', () => {
    mockUseOpsSloStats.mockReturnValue({ stats: null, loading: false, error: null, refetch: vi.fn() });

    renderPage();

    expect(screen.getByTestId('ops-slo-empty')).toBeInTheDocument();
  });

  it('renders an error banner when the fetch fails', () => {
    mockUseOpsSloStats.mockReturnValue({
      stats: null,
      loading: false,
      error: 'Forbidden — platform admin access required',
      refetch: vi.fn(),
    });

    renderPage();

    expect(screen.getByTestId('ops-slo-error')).toBeInTheDocument();
    expect(screen.getByText('Forbidden — platform admin access required')).toBeInTheDocument();
  });

  it('renders all five SLO cards with healthy values and an all-clear badge', async () => {
    mockUseOpsSloStats.mockReturnValue({ stats: healthyStats(), loading: false, error: null, refetch: vi.fn() });

    renderPage();

    await waitFor(() => expect(screen.getByTestId('ops-slo-cards')).toBeInTheDocument());
    expect(screen.getByTestId('slo-card-anchor-secured-rate')).toBeInTheDocument();
    expect(screen.getByTestId('slo-card-connector-queue')).toBeInTheDocument();
    expect(screen.getByTestId('slo-card-credit-conservation')).toBeInTheDocument();
    expect(screen.getByTestId('slo-card-webhook-delivery')).toBeInTheDocument();
    expect(screen.getByTestId('slo-card-api-errors')).toBeInTheDocument();
    expect(screen.getByTestId('overall-healthy-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('overall-breach-badge')).not.toBeInTheDocument();
    expect(screen.getByText('99.2%')).toBeInTheDocument();
  });

  it('renders a breach badge for the whole page and the specific breaching surface', async () => {
    const breached = healthyStats();
    breached.creditConservation = { ...breached.creditConservation, divergedCount: 2, breach: true };
    breached.overallBreach = true;
    mockUseOpsSloStats.mockReturnValue({ stats: breached, loading: false, error: null, refetch: vi.fn() });

    renderPage();

    await waitFor(() => expect(screen.getByTestId('overall-breach-badge')).toBeInTheDocument());
    expect(screen.queryByTestId('overall-healthy-badge')).not.toBeInTheDocument();
    // Per-surface badge on the credit-conservation card specifically.
    const creditCard = screen.getByTestId('slo-card-credit-conservation');
    expect(creditCard.querySelector('[data-testid="slo-breach-badge"]')).toBeTruthy();
  });

  it('renders an unavailable badge for a surface with available:false, not a breach badge', async () => {
    const partial = healthyStats();
    partial.anchorSecuredRate = {
      available: false, securedCount: null, totalCount: null, ratePct: null,
      cacheUpdatedAt: null, breach: false, error: 'cache miss',
    };
    mockUseOpsSloStats.mockReturnValue({ stats: partial, loading: false, error: null, refetch: vi.fn() });

    renderPage();

    await waitFor(() => expect(screen.getByTestId('slo-card-anchor-secured-rate')).toBeInTheDocument());
    const anchorCard = screen.getByTestId('slo-card-anchor-secured-rate');
    expect(anchorCard.querySelector('[data-testid="slo-breach-badge"]')).toBeFalsy();
    expect(anchorCard.textContent).toContain('Unavailable');
  });
});
