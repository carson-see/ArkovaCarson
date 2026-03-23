/**
 * Tests for Sidebar component
 *
 * Session 10: Updated for simplified sidebar (Documents replaces
 * Records/Credentials/Attestations, Help/Billing/Developers moved to dropdown).
 *
 * @see GAP-02, GAP-04 — Logo clickable link to /search
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';

// Mock ArkovaLogo
vi.mock('@/components/layout/ArkovaLogo', () => ({
  ArkovaLogo: ({ size }: { size?: number }) => (
    <svg data-testid="arkova-logo" width={size} height={size} />
  ),
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

  it('logo links to /search (GAP-04)', () => {
    renderSidebar();
    const logoLink = screen.getAllByRole('link', { name: /arkova.*search/i });
    expect(logoLink.length).toBeGreaterThanOrEqual(1);
    expect(logoLink[0]).toHaveAttribute('href', '/search');
  });

  it('renders simplified main navigation (max 5 items)', () => {
    renderSidebar();
    expect(screen.getAllByText('Dashboard').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Documents').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Organization').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Search').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Settings').length).toBeGreaterThanOrEqual(1);
  });

  it('does not render Help or Billing in sidebar (moved to dropdown)', () => {
    renderSidebar();
    expect(screen.queryByText('Help')).toBeNull();
    expect(screen.queryByText('Billing & Plans')).toBeNull();
  });

  it('renders Developers link in sidebar', () => {
    renderSidebar();
    expect(screen.getByText('Developers')).toBeDefined();
  });

  it('does not render My Records, My Credentials, or Attestations as separate items', () => {
    renderSidebar();
    expect(screen.queryByText('My Records')).toBeNull();
    expect(screen.queryByText('My Credentials')).toBeNull();
    expect(screen.queryByText('Attestations')).toBeNull();
  });

  it('shows admin section only for platform admin emails', () => {
    // Non-admin: no admin items
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
