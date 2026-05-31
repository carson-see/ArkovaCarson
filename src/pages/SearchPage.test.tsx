/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * Tests for SearchPage
 *
 * Google-style unified search UI: single input box with auto-detection of
 * query type (verification ID, fingerprint, issuer name), drag-to-verify
 * file drop zone, and a "Back to Dashboard" link.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SearchPage } from './SearchPage';

// Mock hooks
const publicSearchMock = vi.hoisted(() => ({
  state: {
    issuerResults: [] as Array<{
      org_id: string;
      org_name: string;
      org_domain: string | null;
      credential_count: number;
    }>,
    searching: false,
    error: null as string | null,
  },
  searchIssuers: vi.fn(),
  clearResults: vi.fn(),
}));

vi.mock('@/hooks/usePublicSearch', () => ({
  usePublicSearch: () => ({
    ...publicSearchMock.state,
    searchIssuers: publicSearchMock.searchIssuers,
    clearResults: publicSearchMock.clearResults,
  }),
}));

// Mock supabase — factory must not reference outer variables (hoisting)
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            is: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      }),
    }),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  },
}));

// Mock IssuerCard
vi.mock('@/components/search/IssuerCard', () => ({
  IssuerCard: () => <div data-testid="issuer-card" />,
}));

// Mock fileHasher
vi.mock('@/lib/fileHasher', () => ({
  generateFingerprint: vi.fn().mockResolvedValue('a'.repeat(64)),
}));

vi.mock('@/components/layout/ArkovaLogo', () => ({
  ArkovaLogo: ({ size }: { size?: number }) => (
    <svg data-testid="arkova-logo" width={size} height={size} />
  ),
  ArkovaIcon: ({ className }: { className?: string }) => (
    <svg data-testid="arkova-icon" className={className} />
  ),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderSearchPage() {
  return render(
    <MemoryRouter initialEntries={['/search']}>
      <SearchPage />
    </MemoryRouter>,
  );
}

describe('SearchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publicSearchMock.state.issuerResults = [];
    publicSearchMock.state.searching = false;
    publicSearchMock.state.error = null;
    publicSearchMock.searchIssuers.mockResolvedValue(undefined);
  });

  it('renders the "Search & Verify" heading', () => {
    renderSearchPage();
    expect(screen.getByRole('heading', { name: /search & verify/i })).toBeInTheDocument();
  });

  it('renders the Arkova logo', () => {
    renderSearchPage();
    expect(screen.getByTestId('arkova-logo')).toBeInTheDocument();
  });

  it('renders the unified search input with placeholder', () => {
    renderSearchPage();
    expect(
      screen.getByPlaceholderText(/search issuers, credentials, or paste a verification id/i),
    ).toBeInTheDocument();
  });

  it('renders the drop-or-browse file verification affordance', () => {
    renderSearchPage();
    expect(screen.getByText(/drop or browse a file to verify/i)).toBeInTheDocument();
  });

  it('renders back to dashboard link', () => {
    renderSearchPage();
    expect(screen.getByText(/back to dashboard/i)).toBeInTheDocument();
  });

  it('renders results instead of a lingering search spinner when results are already available', async () => {
    const view = renderSearchPage();
    fireEvent.change(screen.getByPlaceholderText(/search issuers/i), {
      target: { value: 'Arkova' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(publicSearchMock.searchIssuers).toHaveBeenCalledWith('Arkova');
    });

    publicSearchMock.state.searching = true;
    publicSearchMock.state.issuerResults = [{
      org_id: 'org-1',
      org_name: 'Arkova',
      org_domain: null,
      credential_count: 3,
    }];
    view.rerender(
      <MemoryRouter initialEntries={['/search']}>
        <SearchPage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('issuer-card')).toBeInTheDocument();
    expect(screen.queryByLabelText('Searching')).not.toBeInTheDocument();
  });

  it('renders human-readable status labels for credential results (SCRUM-2003)', async () => {
    // Make the RPC return one result with PENDING status so the credential
    // results section renders.  The status badge must show "Processing", not
    // the raw "PENDING" enum.
    const { supabase: mockSupabase } = await import('@/lib/supabase');
    (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: [
        {
          public_id: 'ARK-TEST-001',
          title: 'Test Credential',
          credential_type: 'DEGREE',
          status: 'PENDING',
          anchored_at: '2025-01-01T00:00:00Z',
          issuer_public_id: 'issuer-1',
        },
      ],
      error: null,
    });

    renderSearchPage();
    fireEvent.change(screen.getByPlaceholderText(/search issuers/i), {
      target: { value: 'Test University' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    // Human-readable label must appear; raw enum must not.
    await waitFor(() => {
      expect(screen.getByText('Processing')).toBeInTheDocument();
    });
    expect(screen.queryByText('PENDING')).not.toBeInTheDocument();
  });

  it('renders a query-specific empty state after a zero-result search', async () => {
    renderSearchPage();
    fireEvent.change(screen.getByPlaceholderText(/search issuers/i), {
      target: { value: 'No Such Org' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    expect(await screen.findByText('No results for "No Such Org"')).toBeInTheDocument();
  });
});
