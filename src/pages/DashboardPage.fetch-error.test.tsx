/* eslint-disable arkova/require-error-code-assertion -- UI-layer tests: useAnchors is mocked, so there is no HTTP status/code at this layer; the specific contract asserted is the exact rendered banner copy */
/**
 * DashboardPage — records fetch-error surfacing (SCRUM-3532).
 *
 * `useAnchors` has exposed `error` since the React-Query migration, but the
 * page never consumed it: a failed anchors fetch left `records = []`,
 * `loading = false`, and the page fell through to the "no records yet"
 * onboarding empty state — presenting a fetch failure as an empty account.
 * These tests pin the corrected behavior: the canonical `DataErrorBanner`
 * renders (with a Retry wired to `refreshAnchors`) and the misleading empty
 * state is suppressed while the error stands.
 *
 * Scoped narrowly to the error-state consumption; stats-RPC behavior is
 * covered by DashboardPage.test.tsx. Child widgets and data hooks not needed
 * to reach the records card are mocked out.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage } from './DashboardPage';
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
    profile: {
      role: 'INDIVIDUAL',
      org_id: null,
      disclaimer_accepted_at: '2026-01-01T00:00:00Z',
    },
    loading: false,
    updateProfile: vi.fn(),
  }),
}));

vi.mock('@/hooks/useRevokeAnchor', () => ({
  useRevokeAnchor: () => ({ revokeAnchor: vi.fn(), error: null, clearError: vi.fn() }),
}));

vi.mock('@/hooks/useChecklist', () => ({
  useChecklist: () => ({ hasTemplates: false, hasBillingPlan: false }),
}));

vi.mock('@/hooks/useOrganization', () => ({
  useOrganization: () => ({ organization: null }),
}));

vi.mock('@/hooks/useCanIssueCredential', () => ({
  useCanIssueCredential: () => ({ allowed: false }),
}));

vi.mock('@/hooks/useIssueCredentialSplit', () => ({
  useIssueCredentialSplit: () => ({ loading: false, enabled: false }),
}));

const mockRpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: mockRpc },
}));

vi.mock('@/lib/platform', () => ({
  isPlatformAdmin: () => false,
}));

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/dashboard', () => ({
  StatCard: () => null,
  ProfileCard: () => null,
  EmptyState: ({ title }: { title: string }) => <div data-testid="empty-state">{title}</div>,
}));

vi.mock('@/components/dashboard/CreditUsageWidget', () => ({ CreditUsageWidget: () => null }));
vi.mock('@/components/billing/UsageWidget', () => ({ UsageWidget: () => null }));
vi.mock('@/components/dashboard/CleCreditWidget', () => ({ CleCreditWidget: () => null }));
vi.mock('@/components/onboarding/GettingStartedChecklist', () => ({ GettingStartedChecklist: () => null }));
vi.mock('@/components/anchor', () => ({ SecureDocumentDialog: () => null }));
vi.mock('@/components/organization', () => ({ IssueCredentialForm: () => null }));
vi.mock('@/components/search', () => ({ SemanticSearchPanel: () => null }));

vi.mock('@/components/records', () => ({
  RecordsList: ({ records }: { records: unknown[] }) => (
    <div data-testid="records-list">{records.length}</div>
  ),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

describe('DashboardPage records fetch-error surfacing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    anchorsState.records = [];
    anchorsState.loading = false;
    anchorsState.error = null;
    mockRpc.mockResolvedValue({ data: { total: 0, secured: 0, pending: 0 }, error: null });
  });

  it('renders the DataErrorBanner instead of the onboarding empty state when the anchors fetch fails', async () => {
    anchorsState.error = 'connection refused';

    renderPage();

    const banner = await screen.findByTestId('records-fetch-error-banner');
    expect(banner).toHaveTextContent(DATA_ERROR_LABELS.RECORDS_FETCH_FAILED_TITLE);
    // Generic §1.4-safe copy — never the raw PostgREST/Supabase error text.
    expect(banner).toHaveTextContent(TOAST.RECORDS_FETCH_FAILED);
    expect(banner).not.toHaveTextContent('connection refused');
    // The "secure your first document" onboarding claim would be a lie here.
    expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
  });

  it('wires the banner Retry button to refreshAnchors', async () => {
    anchorsState.error = 'connection refused';

    renderPage();

    const banner = await screen.findByTestId('records-fetch-error-banner');
    const retry = within(banner).getByRole('button', { name: DATA_ERROR_LABELS.RETRY });
    fireEvent.click(retry);
    expect(mockRefreshAnchors).toHaveBeenCalledTimes(1);
  });

  it('renders no banner and keeps the empty state when there is no error', async () => {
    renderPage();

    expect(await screen.findByTestId('empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('records-fetch-error-banner')).not.toBeInTheDocument();
  });

  it('keeps stale records visible below the banner when a refetch fails', async () => {
    anchorsState.records = [
      { id: 'r1', filename: 'a.pdf', status: 'SECURED', fingerprint: 'aa' },
      { id: 'r2', filename: 'b.pdf', status: 'PENDING', fingerprint: 'bb' },
    ];
    anchorsState.error = 'connection refused';

    renderPage();

    expect(await screen.findByTestId('records-fetch-error-banner')).toBeInTheDocument();
    expect(screen.getByTestId('records-list')).toHaveTextContent('2');
  });
});
