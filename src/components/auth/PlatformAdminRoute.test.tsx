/**
 * Route-matrix tests for PlatformAdminRoute (SCRUM-2939).
 *
 * Platform-only surfaces (treasury, pipeline, controls, payments, ops-slo,
 * system-health, platform-overview) must be reachable ONLY by platform admins.
 * An ORG_ADMIN — even a legitimate, fully-onboarded one — must be redirected
 * to their own dashboard, NOT shown platform data. This is the client route
 * guard; the worker/RLS layer re-verifies `is_platform_admin` independently.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlatformAdminRoute } from './PlatformAdminRoute';

const useProfileMock = vi.fn();
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => useProfileMock(),
}));

function renderGuard() {
  return render(
    <MemoryRouter initialEntries={['/admin/treasury']}>
      <PlatformAdminRoute>
        <div>PLATFORM CONTENT</div>
      </PlatformAdminRoute>
    </MemoryRouter>
  );
}

describe('PlatformAdminRoute', () => {
  beforeEach(() => useProfileMock.mockReset());

  it('renders children for a platform admin (is_platform_admin=true)', () => {
    useProfileMock.mockReturnValue({
      loading: false,
      profile: { role: 'ORG_ADMIN', org_id: 'o1', is_platform_admin: true },
    });
    renderGuard();
    expect(screen.getByText('PLATFORM CONTENT')).toBeInTheDocument();
  });

  it('blocks a legitimate ORG_ADMIN (flag false) — no platform content', () => {
    useProfileMock.mockReturnValue({
      loading: false,
      profile: { role: 'ORG_ADMIN', org_id: 'o1', is_platform_admin: false },
    });
    renderGuard();
    expect(screen.queryByText('PLATFORM CONTENT')).not.toBeInTheDocument();
  });

  it('blocks an INDIVIDUAL user', () => {
    useProfileMock.mockReturnValue({
      loading: false,
      profile: { role: 'INDIVIDUAL', is_platform_admin: false },
    });
    renderGuard();
    expect(screen.queryByText('PLATFORM CONTENT')).not.toBeInTheDocument();
  });

  it('fails secure when the flag is null/undefined', () => {
    useProfileMock.mockReturnValue({
      loading: false,
      profile: { role: 'ORG_ADMIN', org_id: 'o1', is_platform_admin: null },
    });
    renderGuard();
    expect(screen.queryByText('PLATFORM CONTENT')).not.toBeInTheDocument();
  });

  it('shows a spinner (renders neither content nor redirect) while loading', () => {
    useProfileMock.mockReturnValue({ loading: true, profile: null });
    renderGuard();
    expect(screen.queryByText('PLATFORM CONTENT')).not.toBeInTheDocument();
  });
});
