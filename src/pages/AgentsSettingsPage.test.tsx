/**
 * AgentsSettingsPage Tests (SPEC-AGENTS-UI)
 *
 * Thin pass-through page, mirroring ApiKeySettingsPage.test.tsx: renders the
 * page heading + agent list for an org-affiliated user, and the org-required
 * CTA (not the management UI) for an individual-tier user with no org_id.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'test@arkova.local' },
    signOut: vi.fn(),
  }),
}));

const mockProfile = vi.hoisted(() => ({
  current: { full_name: 'Test User', role: 'ORG_ADMIN' as string, org_id: 'org-1' as string | null },
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: mockProfile.current,
    loading: false,
  }),
}));

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => ({
    agents: [
      {
        id: 'agent-1',
        name: 'Recruiting Bot',
        description: null,
        agent_type: 'ats_integration',
        status: 'active',
        allowed_scopes: ['verify'],
        framework: null,
        version: null,
        callback_url: null,
        created_at: '2026-09-01T00:00:00Z',
        suspended_at: null,
        revoked_at: null,
      },
    ],
    loading: false,
    error: null,
    suspendAgent: vi.fn(),
    resumeAgent: vi.fn(),
    revokeAgent: vi.fn(),
    refresh: vi.fn(),
  }),
}));

import { AgentsSettingsPage } from './AgentsSettingsPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <AgentsSettingsPage />
    </MemoryRouter>,
  );
}

describe('AgentsSettingsPage', () => {
  beforeEach(() => {
    mockProfile.current = { full_name: 'Test User', role: 'ORG_ADMIN', org_id: 'org-1' };
  });

  it('renders the page heading', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /Agents/i })).toBeInTheDocument();
  });

  it('renders an agent card', () => {
    renderPage();
    expect(screen.getByText('Recruiting Bot')).toBeInTheDocument();
  });

  it('renders within AppShell layout', () => {
    renderPage();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('renders org-required CTA for individual users and hides the management UI', () => {
    mockProfile.current = { full_name: 'Test User', role: 'INDIVIDUAL', org_id: null };
    renderPage();
    expect(screen.getByTestId('agents-org-required')).toBeInTheDocument();
    expect(screen.queryByText('Recruiting Bot')).toBeNull();
    expect(screen.getByText('Agents require an organisation')).toBeInTheDocument();
  });
});
