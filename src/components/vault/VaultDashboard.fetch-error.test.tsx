/* eslint-disable arkova/require-error-code-assertion -- UI-layer tests: useAnchors is mocked, so there is no HTTP status/code at this layer; the specific contract asserted is the exact rendered banner copy */
/**
 * VaultDashboard — records fetch-error surfacing (SCRUM-3532).
 *
 * Same defect class as DashboardPage (see DashboardPage.fetch-error.test.tsx):
 * `useAnchors().error` was never destructured, so a failed anchors fetch fell
 * through to the "No records yet" onboarding empty state. Pins the corrected
 * behavior: `DataErrorBanner` with Retry → `refreshAnchors`, empty state
 * suppressed while the error stands, stale records kept visible.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { VaultDashboard } from './VaultDashboard';
import { DATA_ERROR_LABELS, TOAST } from '@/lib/copy';

const anchorsState = vi.hoisted(() => ({
  records: [] as unknown[],
  loading: false,
  error: null as string | null,
}));
const mockRefreshAnchors = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAnchors', () => ({
  useAnchors: () => ({
    records: anchorsState.records,
    loading: anchorsState.loading,
    error: anchorsState.error,
    refreshAnchors: mockRefreshAnchors,
  }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.test' }, signOut: vi.fn() }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: { role: 'INDIVIDUAL', org_id: null, is_public_profile: false, full_name: 'Test User' },
    loading: false,
    updateProfile: vi.fn(),
  }),
}));

vi.mock('@/hooks/useRevokeAnchor', () => ({
  useRevokeAnchor: () => ({ revokeAnchor: vi.fn(), error: null, clearError: vi.fn() }),
}));

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/dashboard', () => ({
  StatCard: () => null,
  EmptyState: ({ title }: { title: string }) => <div data-testid="empty-state">{title}</div>,
}));

vi.mock('@/components/anchor', () => ({ SecureDocumentDialog: () => null }));

vi.mock('@/components/records', () => ({
  RecordsList: ({ records }: { records: unknown[] }) => (
    <div data-testid="records-list">{records.length}</div>
  ),
}));

function renderVault() {
  return render(<VaultDashboard onSignOut={vi.fn()} />);
}

describe('VaultDashboard records fetch-error surfacing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    anchorsState.records = [];
    anchorsState.loading = false;
    anchorsState.error = null;
  });

  it('renders the DataErrorBanner instead of the onboarding empty state when the anchors fetch fails', () => {
    anchorsState.error = 'connection refused';

    renderVault();

    const banner = screen.getByTestId('records-fetch-error-banner');
    expect(banner).toHaveTextContent(DATA_ERROR_LABELS.RECORDS_FETCH_FAILED_TITLE);
    // Generic §1.4-safe copy — never the raw PostgREST/Supabase error text.
    expect(banner).toHaveTextContent(TOAST.RECORDS_FETCH_FAILED);
    expect(banner).not.toHaveTextContent('connection refused');
    expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
  });

  it('wires the banner Retry button to refreshAnchors', () => {
    anchorsState.error = 'connection refused';

    renderVault();

    const banner = screen.getByTestId('records-fetch-error-banner');
    const retry = within(banner).getByRole('button', { name: DATA_ERROR_LABELS.RETRY });
    fireEvent.click(retry);
    expect(mockRefreshAnchors).toHaveBeenCalledTimes(1);
  });

  it('renders no banner and keeps the empty state when there is no error', () => {
    renderVault();

    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('records-fetch-error-banner')).not.toBeInTheDocument();
  });

  it('keeps stale records visible below the banner when a refetch fails', () => {
    anchorsState.records = [
      { id: 'r1', filename: 'a.pdf', status: 'SECURED', fingerprint: 'aa' },
    ];
    anchorsState.error = 'connection refused';

    renderVault();

    expect(screen.getByTestId('records-fetch-error-banner')).toBeInTheDocument();
    expect(screen.getByTestId('records-list')).toHaveTextContent('1');
  });
});
