/**
 * Tests for Sidebar component
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

  it('renders main navigation items', () => {
    renderSidebar();
    expect(screen.getAllByText('Dashboard').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('My Records').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Organization').length).toBeGreaterThanOrEqual(1);
  });

  it('renders secondary navigation items', () => {
    renderSidebar();
    expect(screen.getAllByText('Settings').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Help').length).toBeGreaterThanOrEqual(1);
  });

  it('shows org name when provided (UF-09)', () => {
    renderSidebar({ orgName: 'Test University' });
    expect(screen.getAllByText('Test University').length).toBeGreaterThanOrEqual(1);
  });
});
