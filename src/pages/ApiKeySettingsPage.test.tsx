/**
 * ApiKeySettingsPage Tests (P4.5-TS-09)
 *
 * Verifies the API Key Settings page renders key list,
 * create button, and usage dashboard.
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
    profile: { full_name: 'Test User', role: 'ORG_ADMIN', org_id: 'org-1' },
    loading: false,
  }),
}));

vi.mock('@/hooks/useApiKeys', () => ({
  useApiKeys: () => ({
    keys: [
      {
        id: 'key-1',
        key_prefix: 'ak_live_abc1',
        name: 'Production',
        scopes: ['verify', 'batch'],
        rate_limit_tier: 'standard',
        is_active: true,
        created_at: '2026-03-10T00:00:00Z',
        expires_at: null,
        last_used_at: '2026-03-14T12:00:00Z',
      },
    ],
    loading: false,
    error: null,
    createKey: vi.fn(),
    revokeKey: vi.fn(),
    deleteKey: vi.fn(),
    refresh: vi.fn(),
  }),
  useApiUsage: () => ({
    usage: {
      used: 1500,
      limit: 10000,
      remaining: 8500,
      reset_date: '2026-04-01T00:00:00Z',
      month: '2026-03',
      keys: [{ key_prefix: 'ak_live_abc1', name: 'Production', used: 1500 }],
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
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

  it('renders the create button', () => {
    renderPage();
    expect(screen.getByText('Create API Key')).toBeInTheDocument();
  });

  it('renders a key card with name and prefix', () => {
    renderPage();
    // "Production" appears in both key card and usage breakdown
    expect(screen.getAllByText('Production').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ak_live_abc1/).length).toBeGreaterThan(0);
  });

  it('renders key status badge', () => {
    renderPage();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders scope badges on key card', () => {
    renderPage();
    expect(screen.getByText('Verify')).toBeInTheDocument();
    expect(screen.getByText('Batch')).toBeInTheDocument();
  });

  it('renders usage dashboard with progress', () => {
    renderPage();
    expect(screen.getByText('API Usage')).toBeInTheDocument();
    expect(screen.getByText(/1,500 \/ 10,000/)).toBeInTheDocument();
  });

  it('renders per-key usage breakdown', () => {
    renderPage();
    expect(screen.getByText('Usage by Key')).toBeInTheDocument();
  });

  it('renders within AppShell layout', () => {
    renderPage();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});
