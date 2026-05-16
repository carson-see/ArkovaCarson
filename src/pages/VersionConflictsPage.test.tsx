/**
 * SCRUM-1972 — VersionConflictsPage Tests
 *
 * Verifies: empty state, item rendering, action buttons, resolution flow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { VersionConflictsPage } from './VersionConflictsPage';

const mockFetchPending = vi.fn();
const mockResolve = vi.fn();

vi.mock('@/hooks/useVersionResolution', () => ({
  useVersionResolution: () => ({
    items: mockItems,
    loading: mockLoading,
    error: mockError,
    fetchPending: mockFetchPending,
    resolve: mockResolve,
  }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'test@test.com' }, signOut: vi.fn() }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: { display_name: 'Test' }, loading: false }),
}));

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div data-testid="app-shell">{children}</div>,
}));

let mockItems: unknown[] = [];
let mockLoading = false;
let mockError: string | null = null;

describe('SCRUM-1972: VersionConflictsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockItems = [];
    mockLoading = false;
    mockError = null;
  });

  const renderPage = () =>
    render(
      <MemoryRouter>
        <VersionConflictsPage />
      </MemoryRouter>,
    );

  it('renders page title and subtitle', () => {
    renderPage();
    expect(screen.getByText('Document Version Conflicts')).toBeInTheDocument();
    expect(screen.getByText(/Review and resolve version conflicts/)).toBeInTheDocument();
  });

  it('calls fetchPending on mount', () => {
    renderPage();
    expect(mockFetchPending).toHaveBeenCalledTimes(1);
  });

  it('shows empty state when no items', () => {
    renderPage();
    expect(screen.getByText('No version conflicts to review')).toBeInTheDocument();
  });

  it('renders conflict items', () => {
    mockItems = [
      { id: 'v-1', filename: 'contract.pdf', source: 'docusign', status: 'pending_review', version_number: 2, created_at: '2026-05-16T10:00:00Z' },
      { id: 'v-2', filename: 'offer.pdf', source: 'google_drive', status: 'pending_review', version_number: 3, created_at: '2026-05-15T08:00:00Z' },
    ];
    renderPage();
    expect(screen.getByText('contract.pdf')).toBeInTheDocument();
    expect(screen.getByText('offer.pdf')).toBeInTheDocument();
  });

  it('shows loading skeleton when loading', () => {
    mockLoading = true;
    renderPage();
    expect(screen.getByTestId('version-conflicts-loading')).toBeInTheDocument();
  });

  it('shows error message when error set', () => {
    mockError = 'Failed to load version conflicts';
    renderPage();
    expect(screen.getByText('Failed to load version conflicts')).toBeInTheDocument();
  });

  it('renders action buttons for each item', () => {
    mockItems = [
      { id: 'v-1', filename: 'doc.pdf', source: 'docusign', status: 'pending_review', version_number: 2, created_at: '2026-05-16T10:00:00Z' },
    ];
    renderPage();
    expect(screen.getByText('Secure New Version')).toBeInTheDocument();
    expect(screen.getByText('Skip')).toBeInTheDocument();
    expect(screen.getByText('Flag for Review')).toBeInTheDocument();
  });

  it('calls resolve with decision when action clicked', async () => {
    mockItems = [
      { id: 'v-1', filename: 'doc.pdf', source: 'docusign', status: 'pending_review', version_number: 2, created_at: '2026-05-16T10:00:00Z' },
    ];
    mockResolve.mockResolvedValueOnce({ success: true, decision: 'approve', version_id: 'v-1', status: 'approved' });

    renderPage();
    fireEvent.click(screen.getByText('Secure New Version'));

    await waitFor(() => {
      expect(mockResolve).toHaveBeenCalledWith('v-1', 'approve', '');
    });
  });
});
