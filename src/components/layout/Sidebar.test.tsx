/**
 * Tests for Sidebar component
 *
 * SCRUM-1787: Logo navigates to role-aware home route via useProfile destination.
 * Previous behavior (GAP-04): Logo linked to /search for all users.
 * New behavior: Logo links to /dashboard for authenticated users with roles.
 *
 * SCRUM-2004 ([GA-S2/E5] Sidebar discoverability audit and refresh):
 * Key destinations (Records, Organization, Billing, API Keys, Settings) existed
 * as routes but were reachable only by typing the URL — they were absent from the
 * sidebar nav. These tests assert the surfaced destinations render, respect the
 * existing role/permission gating, and highlight the active route.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { ROUTES } from '@/lib/routes';
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

// Mock useProfile — controls the logo destination AND the profile role used for
// role-based nav gating (SCRUM-2004). Both are configurable per test.
const mockDestination = vi.fn<() => RouteDestination>(() => '/dashboard');
const mockProfile = vi.fn<() => { role: string | null; org_id: string | null; is_platform_admin?: boolean }>(
  () => ({ role: 'ORG_ADMIN', org_id: 'org-1', is_platform_admin: false }),
);
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: mockProfile(),
    loading: false,
    updating: false,
    error: null,
    destination: mockDestination(),
    refreshProfile: vi.fn(),
    updateProfile: vi.fn(),
  }),
}));

function renderSidebar(props = {}, initialEntries = ['/dashboard']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Sidebar {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockDestination.mockReturnValue('/dashboard');
  mockProfile.mockReturnValue({ role: 'ORG_ADMIN', org_id: 'org-1', is_platform_admin: false });
});

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

  // ──────────────────────────────────────────────────────────────────────
  // SCRUM-2004: discoverability — surface buried destinations in the sidebar
  // ──────────────────────────────────────────────────────────────────────

  function hrefSet() {
    return screen
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
  }

  it('SCRUM-2004: surfaces Dashboard + Search primary destinations', () => {
    renderSidebar();
    const hrefs = hrefSet();
    expect(hrefs).toContain(ROUTES.DASHBOARD);
    expect(hrefs).toContain(ROUTES.SEARCH);
  });

  it('SCRUM-2004: surfaces Documents in the sidebar nav', () => {
    renderSidebar();
    expect(screen.getAllByText('Documents').length).toBeGreaterThanOrEqual(1);
    expect(hrefSet()).toContain(ROUTES.DOCUMENTS);
  });

  it('SCRUM-2004: surfaces Settings in the sidebar nav', () => {
    renderSidebar();
    expect(screen.getAllByText('Settings').length).toBeGreaterThanOrEqual(1);
    expect(hrefSet()).toContain(ROUTES.SETTINGS);
  });

  it('SCRUM-2004: surfaces Billing in the sidebar nav', () => {
    renderSidebar();
    expect(hrefSet()).toContain(ROUTES.BILLING);
  });

  it('SCRUM-2004: surfaces API Keys in the sidebar nav', () => {
    renderSidebar();
    expect(hrefSet()).toContain(ROUTES.SETTINGS_API_KEYS);
  });

  it('SCRUM-2004: API Keys nav label is §1.3-clean (no banned terms)', () => {
    renderSidebar();
    const apiKeysLink = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === ROUTES.SETTINGS_API_KEYS);
    expect(apiKeysLink).toBeTruthy();
    expect(apiKeysLink?.textContent ?? '').toMatch(/api keys/i);
  });

  // ── Organization is gated by org affiliation (role/permission preserved) ──

  it('SCRUM-2004: surfaces Organization for ORG_ADMIN users', () => {
    mockProfile.mockReturnValue({ role: 'ORG_ADMIN', org_id: 'org-1', is_platform_admin: false });
    renderSidebar();
    expect(screen.getAllByText('Organization').length).toBeGreaterThanOrEqual(1);
    expect(hrefSet()).toContain(ROUTES.ORGANIZATION);
  });

  it('SCRUM-2004: surfaces Organization for ORG_MEMBER users', () => {
    mockProfile.mockReturnValue({ role: 'ORG_MEMBER', org_id: 'org-1' });
    renderSidebar();
    expect(hrefSet()).toContain(ROUTES.ORGANIZATION);
  });

  // ── Primary-nav ORDER (CodeRabbit: Organization must be 3rd, not last) ──
  //
  // Canonical order per the file header + components/layout agents.md is
  // Dashboard, Documents, Organization, Search, Settings. Read the links
  // inside the primary <nav> in DOM order and keep only the primary routes
  // (the logo link lives outside <nav>; Account/Admin destinations are
  // excluded by the route filter). Two sidebar instances render (desktop +
  // mobile overlay) — take the first nav so the order list isn't duplicated.
  function primaryNavOrder() {
    const primaryRoutes: readonly string[] = [
      ROUTES.DASHBOARD,
      ROUTES.DOCUMENTS,
      ROUTES.ORGANIZATION,
      ROUTES.SEARCH,
      ROUTES.SETTINGS,
    ];
    const nav = document.querySelector('nav');
    if (!nav) return [];
    return Array.from(nav.querySelectorAll('a'))
      .map((a) => a.getAttribute('href'))
      .filter((href): href is string => href !== null && primaryRoutes.includes(href));
  }

  it('SCRUM-2004: primary nav order is Dashboard, Documents, Organization, Search, Settings (org user)', () => {
    mockProfile.mockReturnValue({ role: 'ORG_ADMIN', org_id: 'org-1', is_platform_admin: false });
    renderSidebar();
    expect(primaryNavOrder()).toEqual([
      ROUTES.DASHBOARD,
      ROUTES.DOCUMENTS,
      ROUTES.ORGANIZATION,
      ROUTES.SEARCH,
      ROUTES.SETTINGS,
    ]);
  });

  it('SCRUM-2004: primary nav order without Organization is Dashboard, Documents, Search, Settings (INDIVIDUAL user)', () => {
    mockProfile.mockReturnValue({ role: 'INDIVIDUAL', org_id: null });
    renderSidebar();
    expect(primaryNavOrder()).toEqual([
      ROUTES.DASHBOARD,
      ROUTES.DOCUMENTS,
      ROUTES.SEARCH,
      ROUTES.SETTINGS,
    ]);
  });

  it('SCRUM-2004: hides Organization for INDIVIDUAL users (no org affiliation)', () => {
    mockProfile.mockReturnValue({ role: 'INDIVIDUAL', org_id: null });
    renderSidebar();
    expect(hrefSet()).not.toContain(ROUTES.ORGANIZATION);
    expect(screen.queryByText('Organization')).toBeNull();
  });

  it('SCRUM-2004: hides Organization when profile is not yet loaded (null role)', () => {
    mockProfile.mockReturnValue({ role: null, org_id: null });
    renderSidebar();
    expect(hrefSet()).not.toContain(ROUTES.ORGANIZATION);
  });

  it('SCRUM-2004: account destinations (Billing, API Keys) are visible to INDIVIDUAL users', () => {
    mockProfile.mockReturnValue({ role: 'INDIVIDUAL', org_id: null });
    renderSidebar();
    const hrefs = hrefSet();
    expect(hrefs).toContain(ROUTES.BILLING);
    expect(hrefs).toContain(ROUTES.SETTINGS_API_KEYS);
    expect(hrefs).toContain(ROUTES.DOCUMENTS);
    expect(hrefs).toContain(ROUTES.SETTINGS);
  });

  // ── Active-route highlighting ──

  it('SCRUM-2004: highlights the active Documents route', () => {
    renderSidebar({}, [ROUTES.DOCUMENTS]);
    const docsLink = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === ROUTES.DOCUMENTS);
    expect(docsLink?.className).toMatch(/border-\[#00d4ff\]/);
  });

  it('SCRUM-2004: highlights the active Billing route', () => {
    renderSidebar({}, [ROUTES.BILLING]);
    const billingLink = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === ROUTES.BILLING);
    expect(billingLink?.className).toMatch(/border-\[#00d4ff\]/);
  });

  it('SCRUM-2004: highlights the active API Keys route (nested under settings)', () => {
    renderSidebar({}, [ROUTES.SETTINGS_API_KEYS]);
    const apiKeysLink = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === ROUTES.SETTINGS_API_KEYS);
    expect(apiKeysLink?.className).toMatch(/border-\[#00d4ff\]/);
  });

  it('SCRUM-2004: Settings is NOT highlighted when on the API Keys sub-route', () => {
    // /settings/api-keys must not also light up the top-level Settings item,
    // otherwise two items appear active at once.
    renderSidebar({}, [ROUTES.SETTINGS_API_KEYS]);
    const settingsLink = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === ROUTES.SETTINGS);
    expect(settingsLink?.className).not.toMatch(/border-\[#00d4ff\]/);
  });

  // ── Admin section (unchanged role gating) ──

  it('hides the admin section for non-platform-admins (is_platform_admin=false)', () => {
    mockProfile.mockReturnValue({ role: 'ORG_ADMIN', org_id: 'org-1', is_platform_admin: false });
    renderSidebar();
    expect(screen.queryByText('Overview')).toBeNull();
    expect(screen.queryByText('Treasury')).toBeNull();
  });

  it('shows the admin section for platform admins (is_platform_admin=true)', () => {
    mockProfile.mockReturnValue({ role: 'ORG_ADMIN', org_id: 'org-1', is_platform_admin: true });
    renderSidebar({}, [ROUTES.ADMIN_TREASURY]);
    expect(screen.getAllByText('Treasury').length).toBeGreaterThanOrEqual(1);
  });

  // ── Compliance Intelligence dashboard was orphaned (no sidebar link) ──
  // The route /organization/compliance hosts the CPE export panel (#1149) and
  // the org CPE dashboard (#1150) but had no nav entry — reachable only by URL.
  // Surface it in the Admin section so it is discoverable. The admin section is
  // collapsed by default but auto-expands when an admin route is active, so we
  // assert the link is present while sitting on the compliance route.
  it('surfaces the Compliance link in the admin section for platform admins', () => {
    mockProfile.mockReturnValue({ role: 'ORG_ADMIN', org_id: 'org-1', is_platform_admin: true });
    renderSidebar({}, [ROUTES.COMPLIANCE_DASHBOARD]);
    expect(hrefSet()).toContain(ROUTES.COMPLIANCE_DASHBOARD);
    expect(screen.getAllByText('Compliance').length).toBeGreaterThanOrEqual(1);
  });

  it('hides the Compliance link from non-admin users', () => {
    mockProfile.mockReturnValue({ role: 'ORG_ADMIN', org_id: 'org-1', is_platform_admin: false });
    renderSidebar({}, [ROUTES.COMPLIANCE_DASHBOARD]);
    expect(hrefSet()).not.toContain(ROUTES.COMPLIANCE_DASHBOARD);
  });

  it('highlights the active Compliance route', () => {
    mockProfile.mockReturnValue({ role: 'ORG_ADMIN', org_id: 'org-1', is_platform_admin: true });
    renderSidebar({}, [ROUTES.COMPLIANCE_DASHBOARD]);
    const complianceLink = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === ROUTES.COMPLIANCE_DASHBOARD);
    expect(complianceLink?.className).toMatch(/border-\[#00d4ff\]/);
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
