/**
 * Tests for SearchPage
 *
 * Google-style unified search UI: single input box with auto-detection of
 * query type (verification ID, fingerprint, issuer name), drag-to-verify
 * file drop zone, and a "Back to Dashboard" link.
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
});
