/**
 * Tests for SearchPage
 *
 * @see UF-02, GAP-03 — Unified search with auto-detection
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SearchPage } from './SearchPage';

// Mock hooks
vi.mock('@/hooks/usePublicSearch', () => ({
  usePublicSearch: () => ({
    issuerResults: [],
    searching: false,
    error: null,
    searchIssuers: vi.fn(),
    clearResults: vi.fn(),
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
  });

  it('renders the page title', () => {
    renderSearchPage();
    expect(screen.getByText('Search Credentials')).toBeInTheDocument();
  });

  it('renders unified search input with auto-detect placeholder', () => {
    renderSearchPage();
    expect(screen.getByPlaceholderText(/issuer name.*verification ID.*fingerprint/i)).toBeInTheDocument();
  });

  it('renders search button', () => {
    renderSearchPage();
    expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument();
  });

  it('shows subtitle mentioning fingerprint', () => {
    renderSearchPage();
    expect(screen.getByText(/fingerprint/i)).toBeInTheDocument();
  });

  it('renders back to dashboard link', () => {
    renderSearchPage();
    expect(screen.getByText('Back to Dashboard')).toBeInTheDocument();
  });
});
