/**
 * ApiKeySettingsPage Tests
 *
 * Verifies the API Key Settings placeholder page renders correctly
 * with a "coming soon" message (P4.5-TS-09 is deferred post-launch).
 *
 * @see P4.5-TS-09
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'test@arkova.local' },
    signOut: vi.fn(),
  }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: { full_name: 'Test User', role: 'INDIVIDUAL' },
    loading: false,
  }),
}));

import { ApiKeySettingsPage } from './ApiKeySettingsPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <ApiKeySettingsPage />
    </MemoryRouter>,
  );
}

describe('ApiKeySettingsPage', () => {
  it('renders the page heading', () => {
    renderPage();
    expect(screen.getByText('API Keys')).toBeInTheDocument();
  });

  it('shows coming soon message since P4.5 is deferred', () => {
    renderPage();
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });

  it('renders within AppShell layout', () => {
    renderPage();
    // AppShell renders a main content area
    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});
