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
//
// FIX C (CodeRabbit): `vi.clearAllMocks()` resets call history but does NOT
// drain a `mockResolvedValueOnce` / `mockRejectedValueOnce` queue or restore a
// default implementation. The fingerprint query and the RLS fallback both walk
// the SAME `.from(...)` chain, so a one-shot queued by one test would leak into
// the next. `resetSupabase()` (called in beforeEach) re-creates every chain mock
// from scratch each test, draining any leftover queue and restoring defaults.
const supabaseMock = vi.hoisted(() => {
  const rpc = vi.fn();
  // `chain` identity is stable (`from()` always returns it); only the method
  // mocks on it are swapped out on reset.
  const chain = {} as Record<string, ReturnType<typeof vi.fn>>;
  const resetSupabase = () => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: [], error: null });
    for (const method of ['select', 'eq', 'in', 'is', 'ilike']) {
      chain[method] = vi.fn(() => chain);
    }
    // Default: resolve to no rows so the query settles immediately.
    chain.limit = vi.fn().mockResolvedValue({ data: [], error: null });
  };
  resetSupabase();
  return { rpc, chain, resetSupabase };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => supabaseMock.chain),
    rpc: (...args: unknown[]) => supabaseMock.rpc(...args),
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
    // FIX C: fully re-create the supabase chain + rpc mocks (drains any
    // mockResolvedValueOnce/mockRejectedValueOnce queue left by a prior test).
    supabaseMock.resetSupabase();
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
    // The results-area spinner must clear the moment results render. (Asserts
    // the bottom spinner, not the button: after FIX A the Search button's
    // label/disabled track `buttonSearching` — which stays true while a search
    // leg is genuinely in flight — so the button, not the spinner, is the wrong
    // thing to assert here.)
    expect(screen.queryByTestId('search-loading-spinner')).not.toBeInTheDocument();
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

    it('clears a stale fingerprint error when a subsequent issuer search runs', async () => {
      // Cross-mode regression (review finding B2): a fingerprint search that
      // errors leaves `fpError` set. `displayError = error || fpError ||
      // personError`, and the spinner / issuer-results block are both gated on
      // `!displayError`. Without clearing the other-mode channels on a new
      // submit, the stale fingerprint error (a) suppresses the in-flight
      // spinner of the new issuer search and (b) hides the issuer results on
      // success — leaving the user staring at a stale error card.
      const { supabase } = await import('@/lib/supabase');
      const fpLimitMock = (supabase.from('anchors') as unknown as {
        select: () => { eq: () => { in: () => { is: () => { limit: ReturnType<typeof vi.fn> } } } };
      }).select().eq().in().is().limit as unknown as ReturnType<typeof vi.fn>;
      // First `.limit()` (the fingerprint query) errors → sets fpError.
      fpLimitMock.mockResolvedValueOnce({ data: null, error: { message: 'fp boom' } });

      const view = renderSearchPage();
      const input = screen.getByPlaceholderText(/search issuers/i);

      // 1) Fingerprint search (64-hex) errors → error card shown.
      fireEvent.change(input, { target: { value: 'a'.repeat(64) } });
      fireEvent.click(screen.getByRole('button', { name: /search/i }));
      expect(await screen.findByText('Search failed. Please try again.')).toBeInTheDocument();

      // 2) Now run an issuer/name search while the credential leg stays in
      //    flight (never resolves) so `personSearching` stays true.
      supabaseMock.rpc.mockReturnValue(new Promise(() => { /* never resolves */ }));
      fireEvent.change(input, { target: { value: 'Arkova' } });
      fireEvent.click(screen.getByRole('button', { name: /search/i }));

      await waitFor(() => {
        expect(publicSearchMock.searchIssuers).toHaveBeenCalledWith('Arkova');
      });

      // The stale fingerprint error must be cleared: the in-flight spinner
      // shows and the stale error card is gone.
      await waitFor(() => {
        expect(screen.getByTestId('search-loading-spinner')).toBeInTheDocument();
      });
      expect(screen.queryByText('Search failed. Please try again.')).not.toBeInTheDocument();

      // 3) Issuer leg resolves with a result → issuer card renders, no error.
      publicSearchMock.state.searching = false;
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
      expect(screen.queryByText('Search failed. Please try again.')).not.toBeInTheDocument();
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

    it('keeps the Search button disabled while one leg is still in flight even after the other errors (FIX A)', async () => {
      // Regression: the Search button used to share `showSearchLoading` with the
      // results spinner. When the issuer leg errored (or returned) first,
      // `displayError`/`hasDisplayableResults` flipped `showSearchLoading` false
      // — re-enabling the button mid-flight. A second overlapping query B could
      // then fire, and query A's late credential RPC would write stale rows into
      // `personResults`. FIX A drives the button from `buttonSearching =
      // isSearching && !verifyingFile`, which stays true while ANY leg is in
      // flight, so no overlapping submit is possible.

      // Freeze the credential leg "in flight" (never settles) → personSearching
      // stays true → isSearching stays true.
      supabaseMock.rpc.mockReturnValue(new Promise(() => { /* never resolves */ }));

      const view = renderSearchPage();
      fireEvent.change(screen.getByPlaceholderText(/search issuers/i), {
        target: { value: 'Race Condition' },
      });
      fireEvent.click(screen.getByRole('button', { name: /search/i }));

      await waitFor(() => {
        expect(publicSearchMock.searchIssuers).toHaveBeenCalledWith('Race Condition');
      });

      // The issuer leg has errored while the credential leg is still resolving.
      publicSearchMock.state.searching = false;
      publicSearchMock.state.error = 'Search failed. Please try again.';
      view.rerender(
        <MemoryRouter initialEntries={['/search']}>
          <SearchPage />
        </MemoryRouter>,
      );

      // Precondition: the error card is shown (one leg has errored)…
      expect(screen.getByText('Search failed. Please try again.')).toBeInTheDocument();
      // …yet the button stays disabled because the credential leg is in flight,
      // so a second overlapping search cannot be submitted.
      expect(screen.getByRole('button', { name: /search/i })).toBeDisabled();
    });

    it('renders a §1.3-safe status label for a non-SECURED credential, never the raw enum (FIX B)', async () => {
      // Public, unauthenticated surface: the credential badge must never leak the
      // raw anchor_status enum (PENDING / REVOKED / EXPIRED / …) to visitors.
      supabaseMock.rpc.mockResolvedValue({
        data: [{
          public_id: 'cred-pending-1',
          title: 'Pending Credential',
          credential_type: 'professional_certification',
          status: 'PENDING',
          anchored_at: '2026-05-01T00:00:00Z',
          issuer_public_id: 'org-pub-1',
        }],
        error: null,
      });

      renderSearchPage();
      fireEvent.change(screen.getByPlaceholderText(/search issuers/i), {
        target: { value: 'Pending Credential' },
      });
      fireEvent.click(screen.getByRole('button', { name: /search/i }));

      // The friendly label renders…
      expect(await screen.findByText('Processing')).toBeInTheDocument();
      // …and the raw enum token must NOT appear anywhere on the page.
      expect(screen.queryByText('PENDING')).not.toBeInTheDocument();
    });
  });
});
