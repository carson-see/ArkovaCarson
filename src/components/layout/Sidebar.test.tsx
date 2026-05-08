/**
 * Tests for Sidebar component
 *
 * SCRUM-1787: Logo navigates to role-aware home route via useProfile destination.
 * Previous behavior (GAP-04): Logo linked to /search for all users.
 * New behavior: Logo links to /dashboard for authenticated users with roles.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import type { RouteDestination } from '@/hooks/useProfile';

// Mock ArkovaLogo
vi.mock('@/components/layout/ArkovaLogo', () => ({
  ArkovaLogo: ({ size }: { size?: number }) => (
    <svg data-testid="arkova-logo" width={size} height={size} />
  ),
  ArkovaIcon: ({ className }: { className?: string }) => (
    <svg data-testid="arkova-icon" className={className} />
  ),
}));

// Mock useProfile — controls the logo destination
const mockDestination = vi.fn<() => RouteDestination>(() => '/dashboard');
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: { role: 'INDIVIDUAL', org_id: null },
    loading: false,
    updating: false,
    error: null,
    destination: mockDestination(),
    refreshProfile: vi.fn(),
    updateProfile: vi.fn(),
  }),
}));

function renderSidebar(props = {}) {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Sidebar {...props} />
    </MemoryRouter>,
  );
}

describe('Sidebar', () => {
  it('renders the ArkovaLogo', () => {
    renderSidebar();
    expect(screen.getAllByTestId('arkova-logo').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the Arkova brand name', () => {
    renderSidebar();
    expect(screen.getAllByText('Arkova').length).toBeGreaterThanOrEqual(1);
  });

  function expectLogoHref(destination: RouteDestination, expectedHref: string) {
    mockDestination.mockReturnValue(destination);
    renderSidebar();
    const logoLink = screen.getAllByRole('link', { name: /arkova/i });
    expect(logoLink.length).toBeGreaterThanOrEqual(1);
    expect(logoLink[0]).toHaveAttribute('href', expectedHref);
  }

  it('SCRUM-1787: logo links to /dashboard for authenticated users', () => {
    expectLogoHref('/dashboard', '/dashboard');
  });

  it('SCRUM-1787: logo links to /dashboard for INDIVIDUAL users (vault destination)', () => {
    expectLogoHref('/vault', '/dashboard');
  });

  it('SCRUM-1787: logo links to /onboarding/role when user has no role', () => {
    expectLogoHref('/onboarding/role', '/onboarding/role');
  });

  it('SCRUM-1787: logo links to /onboarding/org when ORG_ADMIN missing org', () => {
    expectLogoHref('/onboarding/org', '/onboarding/org');
  });

  it('SCRUM-1787: logo links to /review-pending when user requires review', () => {
    expectLogoHref('/review-pending', '/review-pending');
  });

  it('renders simplified main navigation (UAT Session 40 redesign)', () => {
    renderSidebar();
    expect(screen.getAllByText('Dashboard').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Search').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Documents')).toBeNull();
    expect(screen.queryByText('Settings')).toBeNull();
    expect(screen.queryByText('Developers')).toBeNull();
  });

  it('does not render Help or Billing in sidebar (moved to dropdown)', () => {
    renderSidebar();
    expect(screen.queryByText('Help')).toBeNull();
    expect(screen.queryByText('Billing & Plans')).toBeNull();
  });

  it('does not render Compliance in main sidebar (admin section only)', () => {
    renderSidebar();
    expect(screen.queryByText('Compliance')).toBeNull();
  });

  it('does not render My Records, My Credentials, or Attestations as separate items', () => {
    renderSidebar();
    expect(screen.queryByText('My Records')).toBeNull();
    expect(screen.queryByText('My Credentials')).toBeNull();
    expect(screen.queryByText('Attestations')).toBeNull();
  });

  it('shows admin section only for platform admin emails', () => {
    renderSidebar({ userEmail: 'user@example.com' });
    expect(screen.queryByText('Overview')).toBeNull();
    expect(screen.queryByText('Treasury')).toBeNull();
  });

  it('shows org name when provided (UF-09)', () => {
    renderSidebar({ orgName: 'Test University' });
    expect(screen.getAllByText('Test University').length).toBeGreaterThanOrEqual(1);
  });

  it('renders theme toggle button visible to all viewports (UAT2-15)', () => {
    renderSidebar();
    const themeButtons = screen.getAllByRole('button', { name: /theme/i });
    expect(themeButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('shows mobile close button when mobileOpen (UAT2-15)', () => {
    renderSidebar({ mobileOpen: true, onMobileClose: vi.fn() });
    const closeButton = screen.getAllByRole('button', { name: /close navigation/i });
    expect(closeButton.length).toBeGreaterThanOrEqual(1);
  });
});
