/**
 * SemanticSearch Component Tests (SCRUM-1958)
 *
 * Covers the presentational component (states, match strength, copy) and the
 * flag-gated wrapper (SemanticSearchPanel renders null when the flag is off).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { SemanticSearch, SemanticSearchPanel } from './SemanticSearch';
import { SEMANTIC_SEARCH_LABELS } from '../../lib/copy';
import { isSemanticSearchEnabled } from '../../lib/switchboard';

// Mock the hook
const mockSearch = vi.fn();
const mockClear = vi.fn();

vi.mock('../../hooks/useSemanticSearch', () => ({
  useSemanticSearch: () => ({
    results: mockResults,
    isSearching: mockIsSearching,
    error: mockError,
    creditsRemaining: mockCreditsRemaining,
    search: mockSearch,
    clear: mockClear,
  }),
}));

// Mock the feature flag accessor (used by SemanticSearchPanel)
vi.mock('../../lib/switchboard', () => ({
  isSemanticSearchEnabled: vi.fn(async () => true),
}));

let mockResults: Array<Record<string, unknown>> = [];
let mockIsSearching = false;
let mockError: string | null = null;
let mockCreditsRemaining: number | null = null;

function renderComponent() {
  return render(
    <BrowserRouter>
      <SemanticSearch />
    </BrowserRouter>,
  );
}

function renderPanel() {
  return render(
    <BrowserRouter>
      <SemanticSearchPanel />
    </BrowserRouter>,
  );
}

describe('SemanticSearch (presentational)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResults = [];
    mockIsSearching = false;
    mockError = null;
    mockCreditsRemaining = null;
  });

  it('renders the heading, input and search button', () => {
    renderComponent();
    expect(screen.getByText(SEMANTIC_SEARCH_LABELS.HEADING)).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(SEMANTIC_SEARCH_LABELS.PLACEHOLDER),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: SEMANTIC_SEARCH_LABELS.SEARCH_BUTTON }),
    ).toBeInTheDocument();
  });

  it('calls search on form submit', () => {
    renderComponent();
    const input = screen.getByPlaceholderText(SEMANTIC_SEARCH_LABELS.PLACEHOLDER);
    fireEvent.change(input, { target: { value: 'computer science degree' } });
    fireEvent.submit(input.closest('form')!);

    expect(mockSearch).toHaveBeenCalledWith('computer science degree');
  });

  it('displays search results with a friendly match-strength indicator', () => {
    mockResults = [
      {
        anchorId: 'a1',
        publicId: 'p1',
        fileName: 'diploma.pdf',
        credentialType: 'DEGREE',
        metadata: { issuerName: 'Test University' },
        status: 'SECURED',
        createdAt: '2025-01-01T00:00:00Z',
        similarity: 0.92,
      },
    ];

    renderComponent();
    expect(screen.getByText('diploma.pdf')).toBeInTheDocument();
    expect(screen.getByText('DEGREE')).toBeInTheDocument();
    expect(screen.getByText('Test University')).toBeInTheDocument();
    // Percentage, never a raw vector score.
    expect(screen.getByText('92% match')).toBeInTheDocument();
    // Friendly strength label is exposed for a11y / tooltip.
    expect(
      screen.getByLabelText(SEMANTIC_SEARCH_LABELS.MATCH_STRENGTH_STRONG),
    ).toBeInTheDocument();
    expect(screen.getByText('SECURED')).toBeInTheDocument();
  });

  it('never renders a raw vector score', () => {
    mockResults = [
      {
        anchorId: 'a1',
        publicId: 'p1',
        fileName: 'diploma.pdf',
        credentialType: 'DEGREE',
        metadata: {},
        status: 'SECURED',
        createdAt: '2025-01-01T00:00:00Z',
        similarity: 0.8234,
      },
    ];
    renderComponent();
    expect(screen.getByText('82% match')).toBeInTheDocument();
    expect(screen.queryByText(/0\.8234/)).not.toBeInTheDocument();
  });

  // Match-strength threshold boundaries (pct = Math.round(score*100)):
  //   pct >= 90 -> STRONG, pct >= 75 -> GOOD, else -> FAIR.
  // Lock down the exact-boundary and just-below-boundary cases.
  it('labels similarity 0.90 as a Strong match (exactly at the Strong boundary)', () => {
    mockResults = [
      {
        anchorId: 'a1',
        publicId: 'p1',
        fileName: 'diploma.pdf',
        credentialType: 'DEGREE',
        metadata: {},
        status: 'SECURED',
        createdAt: '2025-01-01T00:00:00Z',
        similarity: 0.9,
      },
    ];
    renderComponent();
    expect(screen.getByText('90% match')).toBeInTheDocument();
    expect(
      screen.getByLabelText(SEMANTIC_SEARCH_LABELS.MATCH_STRENGTH_STRONG),
    ).toBeInTheDocument();
  });

  it('labels similarity 0.89 as a Good match (just below the Strong boundary)', () => {
    mockResults = [
      {
        anchorId: 'a1',
        publicId: 'p1',
        fileName: 'diploma.pdf',
        credentialType: 'DEGREE',
        metadata: {},
        status: 'SECURED',
        createdAt: '2025-01-01T00:00:00Z',
        similarity: 0.89,
      },
    ];
    renderComponent();
    expect(screen.getByText('89% match')).toBeInTheDocument();
    expect(
      screen.getByLabelText(SEMANTIC_SEARCH_LABELS.MATCH_STRENGTH_GOOD),
    ).toBeInTheDocument();
  });

  it('labels similarity 0.75 as a Good match (exactly at the Good boundary)', () => {
    mockResults = [
      {
        anchorId: 'a1',
        publicId: 'p1',
        fileName: 'diploma.pdf',
        credentialType: 'DEGREE',
        metadata: {},
        status: 'SECURED',
        createdAt: '2025-01-01T00:00:00Z',
        similarity: 0.75,
      },
    ];
    renderComponent();
    expect(screen.getByText('75% match')).toBeInTheDocument();
    expect(
      screen.getByLabelText(SEMANTIC_SEARCH_LABELS.MATCH_STRENGTH_GOOD),
    ).toBeInTheDocument();
  });

  it('labels similarity 0.74 as a Fair match (just below the Good boundary)', () => {
    mockResults = [
      {
        anchorId: 'a1',
        publicId: 'p1',
        fileName: 'diploma.pdf',
        credentialType: 'DEGREE',
        metadata: {},
        status: 'SECURED',
        createdAt: '2025-01-01T00:00:00Z',
        similarity: 0.74,
      },
    ];
    renderComponent();
    expect(screen.getByText('74% match')).toBeInTheDocument();
    expect(
      screen.getByLabelText(SEMANTIC_SEARCH_LABELS.MATCH_STRENGTH_FAIR),
    ).toBeInTheDocument();
  });

  it('shows loading shimmer during search', () => {
    mockIsSearching = true;
    const { container } = renderComponent();
    expect(container.querySelectorAll('.shimmer')).toHaveLength(3);
  });

  it('shows the out-of-credits error (402 copy)', () => {
    mockError = SEMANTIC_SEARCH_LABELS.ERROR_NO_CREDITS;
    renderComponent();
    expect(screen.getByRole('alert')).toHaveTextContent(
      SEMANTIC_SEARCH_LABELS.ERROR_NO_CREDITS,
    );
  });

  it('shows the service-unavailable error (503 copy)', () => {
    mockError = SEMANTIC_SEARCH_LABELS.ERROR_UNAVAILABLE;
    renderComponent();
    expect(screen.getByRole('alert')).toHaveTextContent(
      SEMANTIC_SEARCH_LABELS.ERROR_UNAVAILABLE,
    );
  });

  it('shows the network error', () => {
    mockError = SEMANTIC_SEARCH_LABELS.ERROR_NETWORK;
    renderComponent();
    expect(screen.getByRole('alert')).toHaveTextContent(
      SEMANTIC_SEARCH_LABELS.ERROR_NETWORK,
    );
  });

  it('shows credits remaining', () => {
    mockCreditsRemaining = 42;
    renderComponent();
    expect(screen.getByText(/42 AI credits remaining/)).toBeInTheDocument();
  });

  it('disables the search button when input is empty', () => {
    renderComponent();
    const button = screen.getByRole('button', {
      name: SEMANTIC_SEARCH_LABELS.SEARCH_BUTTON,
    });
    expect(button).toBeDisabled();
  });

  it('does not show the empty state before a search has run', () => {
    mockResults = [];
    renderComponent();
    expect(
      screen.queryByText(SEMANTIC_SEARCH_LABELS.EMPTY_TITLE),
    ).not.toBeInTheDocument();
  });

  it('shows the honest empty state after a search returns nothing', () => {
    mockResults = [];
    renderComponent();
    const input = screen.getByPlaceholderText(SEMANTIC_SEARCH_LABELS.PLACEHOLDER);
    fireEvent.change(input, { target: { value: 'nonexistent doc' } });
    fireEvent.submit(input.closest('form')!);

    expect(
      screen.getByText(SEMANTIC_SEARCH_LABELS.EMPTY_TITLE),
    ).toBeInTheDocument();
    expect(
      screen.getByText(SEMANTIC_SEARCH_LABELS.EMPTY_DESC),
    ).toBeInTheDocument();
  });

  it('does not show the empty state while an error is present', () => {
    mockResults = [];
    mockError = SEMANTIC_SEARCH_LABELS.ERROR_GENERIC;
    renderComponent();
    const input = screen.getByPlaceholderText(SEMANTIC_SEARCH_LABELS.PLACEHOLDER);
    fireEvent.change(input, { target: { value: 'anything' } });
    fireEvent.submit(input.closest('form')!);

    expect(
      screen.queryByText(SEMANTIC_SEARCH_LABELS.EMPTY_TITLE),
    ).not.toBeInTheDocument();
  });
});

describe('SemanticSearchPanel (flag-gated mount)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResults = [];
    mockIsSearching = false;
    mockError = null;
    mockCreditsRemaining = null;
    vi.mocked(isSemanticSearchEnabled).mockResolvedValue(true);
  });

  it('renders the search panel when the flag is on', async () => {
    vi.mocked(isSemanticSearchEnabled).mockResolvedValue(true);
    renderPanel();
    expect(
      await screen.findByText(SEMANTIC_SEARCH_LABELS.HEADING),
    ).toBeInTheDocument();
  });

  it('renders nothing when the flag is off', async () => {
    vi.mocked(isSemanticSearchEnabled).mockResolvedValue(false);
    const { container } = renderPanel();
    // Give the async flag check a tick to resolve.
    await waitFor(() => {
      expect(
        screen.queryByText(SEMANTIC_SEARCH_LABELS.HEADING),
      ).not.toBeInTheDocument();
    });
    // Regression lock for the empty-Card-chrome bug: the Card chrome must live
    // INSIDE SemanticSearchPanel (not in DashboardPage), so flag-off returns
    // null and yields a truly empty DOM — no orphaned/empty Card wrapper.
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a contentful container (not an empty wrapper) when the flag is on', async () => {
    vi.mocked(isSemanticSearchEnabled).mockResolvedValue(true);
    const { container } = renderPanel();
    // Panel owns its own chrome now: when on, it renders real content, not an
    // empty shell. Complements the flag-off empty-DOM regression lock above.
    await screen.findByText(SEMANTIC_SEARCH_LABELS.HEADING);
    expect(container).not.toBeEmptyDOMElement();
    expect(
      screen.getByPlaceholderText(SEMANTIC_SEARCH_LABELS.PLACEHOLDER),
    ).toBeInTheDocument();
  });

  it('fails closed (renders nothing) when the flag lookup throws', async () => {
    vi.mocked(isSemanticSearchEnabled).mockRejectedValue(new Error('rpc down'));
    const { container } = renderPanel();
    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
    expect(
      screen.queryByText(SEMANTIC_SEARCH_LABELS.HEADING),
    ).not.toBeInTheDocument();
  });
});
