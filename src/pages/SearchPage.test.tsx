/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/* eslint-disable arkova/require-error-code-assertion -- SearchPage maps every RPC/fallback failure to one user-facing copy string (SEARCH_LABELS.SEARCH_ERROR); these tests assert that rendered message, not the wire error code. Specific codes are covered in usePublicSearch.test.ts / RLS suites. */
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

// Controllable supabase mock — the credential RPC (`search_public_credentials`)
// is held in a hoisted ref so individual tests can hand it a deferred promise
// and freeze the person-search leg "in flight" while asserting spinner state.
const supabaseMock = vi.hoisted(() => ({
  // Default: resolve to no rows so the RPC settles immediately.
  rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
}));

vi.mock('@/lib/supabase', () => {
  // `.from(...)` chain used by the fingerprint query and the RLS fallback.
  const terminal = () => ({ data: [], error: null });
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    in: vi.fn(() => chain),
    is: vi.fn(() => chain),
    ilike: vi.fn(() => chain),
    limit: vi.fn().mockResolvedValue(terminal()),
  };
  return {
    supabase: {
      from: vi.fn(() => chain),
      rpc: (...args: unknown[]) => supabaseMock.rpc(...args),
    },
  };
});

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
    supabaseMock.rpc.mockResolvedValue({ data: [], error: null });
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

  it('renders a query-specific empty state after a zero-result search', async () => {
    renderSearchPage();
    fireEvent.change(screen.getByPlaceholderText(/search issuers/i), {
      target: { value: 'No Such Org' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    expect(await screen.findByText('No results for "No Such Org"')).toBeInTheDocument();
  });

  // ── SCRUM-1980: search loading-state reset (spinner persists below results) ──
  describe('SCRUM-1980 loading-state reset', () => {
    it('clears the results spinner once the credential search resolves with results', async () => {
      // Person/credential leg resolves with one result; issuer leg stays empty.
      supabaseMock.rpc.mockResolvedValue({
        data: [{
          public_id: 'cred-1',
          title: 'Jane Doe — RN License',
          credential_type: 'professional_certification',
          status: 'SECURED',
          anchored_at: '2026-05-01T00:00:00Z',
          issuer_public_id: 'org-pub-1',
        }],
        error: null,
      });

      renderSearchPage();
      fireEvent.change(screen.getByPlaceholderText(/search issuers/i), {
        target: { value: 'Jane Doe' },
      });
      fireEvent.click(screen.getByRole('button', { name: /search/i }));

      // The credential result renders…
      expect(await screen.findByText('Jane Doe — RN License')).toBeInTheDocument();
      // …and the bottom results spinner must be gone (loading state was reset).
      await waitFor(() => {
        expect(screen.queryByTestId('search-loading-spinner')).not.toBeInTheDocument();
      });
    });

    it('does not keep a spinner below the error card when one search leg fails', async () => {
      // Freeze the credential leg "in flight" with a promise that never settles,
      // so `personSearching` stays true for the duration of the assertion.
      supabaseMock.rpc.mockReturnValue(new Promise(() => { /* never resolves */ }));

      const view = renderSearchPage();
      fireEvent.change(screen.getByPlaceholderText(/search issuers/i), {
        target: { value: 'Broken Search' },
      });
      fireEvent.click(screen.getByRole('button', { name: /search/i }));

      await waitFor(() => {
        expect(publicSearchMock.searchIssuers).toHaveBeenCalledWith('Broken Search');
      });

      // Issuer leg has errored; the credential leg is still resolving.
      publicSearchMock.state.searching = false;
      publicSearchMock.state.error = 'Search failed. Please try again.';
      view.rerender(
        <MemoryRouter initialEntries={['/search']}>
          <SearchPage />
        </MemoryRouter>,
      );

      // Error card is shown…
      expect(screen.getByText('Search failed. Please try again.')).toBeInTheDocument();
      // …and the loading spinner must NOT linger beneath it.
      expect(screen.queryByTestId('search-loading-spinner')).not.toBeInTheDocument();
    });

    it('clears loading and surfaces an error when the credential search rejects', async () => {
      // RPC rejects AND the RLS fallback (`.from(...).limit()`) also rejects, so
      // the error path is exercised end-to-end.
      supabaseMock.rpc.mockRejectedValue(new Error('rpc boom'));
      const { supabase } = await import('@/lib/supabase');
      const limitMock = (supabase.from('anchors') as unknown as {
        select: () => { is: () => { in: () => { ilike: () => { limit: ReturnType<typeof vi.fn> } } } };
      }).select().is().in().ilike().limit as unknown as ReturnType<typeof vi.fn>;
      limitMock.mockRejectedValueOnce(new Error('fallback boom'));

      renderSearchPage();
      fireEvent.change(screen.getByPlaceholderText(/search issuers/i), {
        target: { value: 'Error Path' },
      });
      fireEvent.click(screen.getByRole('button', { name: /search/i }));

      // Error copy appears and the spinner is cleared (loading reset on error).
      expect(await screen.findByText('Search failed. Please try again.')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.queryByTestId('search-loading-spinner')).not.toBeInTheDocument();
      });
    });
  });
});
