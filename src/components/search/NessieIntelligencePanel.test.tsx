/**
 * NessieIntelligencePanel Component Tests (NMT-07)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NessieIntelligencePanel } from './NessieIntelligencePanel';

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function renderComponent() {
  return render(<NessieIntelligencePanel />);
}

describe('NessieIntelligencePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders panel title and input', () => {
    renderComponent();
    expect(screen.getByText('Document Intelligence')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/ask a compliance question/i)).toBeInTheDocument();
  });

  it('renders empty state when no query submitted', () => {
    renderComponent();
    expect(screen.getByText(/ask a question to get answers backed by verified evidence/i)).toBeInTheDocument();
  });

  it('disables submit button when input is empty', () => {
    renderComponent();
    const buttons = screen.getAllByRole('button');
    const submitButton = buttons[buttons.length - 1];
    expect(submitButton).toBeDisabled();
  });

  it('enables submit button when input has text', () => {
    renderComponent();
    const input = screen.getByPlaceholderText(/ask a compliance question/i);
    fireEvent.change(input, { target: { value: 'Is this compliant?' } });
    const buttons = screen.getAllByRole('button');
    const submitButton = buttons[buttons.length - 1];
    expect(submitButton).not.toBeDisabled();
  });

  it('shows loading state during query', async () => {
    mockFetch.mockImplementation(() => new Promise(() => {})); // never resolves

    renderComponent();
    const input = screen.getByPlaceholderText(/ask a compliance question/i);
    fireEvent.change(input, { target: { value: 'test query' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(input).toBeDisabled();
  });

  it('displays response with citations', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        answer: 'The company is compliant [PR-001].',
        citations: [{
          record_id: 'PR-001',
          source: 'edgar',
          source_url: 'https://sec.gov/filing',
          title: 'SEC 10-K Filing',
          relevance_score: 0.95,
          anchor_proof: {
            chain_tx_id: 'abc123',
            content_hash: 'def456',
            explorer_url: 'https://mempool.space/tx/abc123',
            verify_url: 'https://app.arkova.ai/verify/ARK-001',
          },
          excerpt: 'Filed all required reports.',
        }],
        confidence: 0.85,
        model: 'nessie-intelligence-v1',
        query: 'test query',
      }),
    });

    renderComponent();
    const input = screen.getByPlaceholderText(/ask a compliance question/i);
    fireEvent.change(input, { target: { value: 'Is this compliant?' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText(/the company is compliant/i)).toBeInTheDocument();
    });

    expect(screen.getByText('85%')).toBeInTheDocument();
    expect(screen.getByText('SEC 10-K Filing')).toBeInTheDocument();
    expect(screen.getByText('SEC EDGAR')).toBeInTheDocument();
  });

  // A thrown Error's raw `.message` is NEVER rendered verbatim (§1.4) — it can
  // carry internal detail (e.g. resolveWorkerBaseUrl's VITE_WORKER_URL
  // misconfiguration text, meant for console/engineer visibility only). The
  // catch block always shows the curated, safe label instead.
  it('displays the generic safe label on a failed request, never the raw server error text', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Nessie query endpoint is not enabled' }),
    });

    renderComponent();
    const input = screen.getByPlaceholderText(/ask a compliance question/i);
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText('An error occurred')).toBeInTheDocument();
    });
    expect(screen.queryByText(/not enabled/i)).not.toBeInTheDocument();
  });

  it('displays the generic safe label on a network failure, never the raw exception text', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    renderComponent();
    const input = screen.getByPlaceholderText(/ask a compliance question/i);
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText('An error occurred')).toBeInTheDocument();
    });
    expect(screen.queryByText(/network error/i)).not.toBeInTheDocument();
  });

  // Root cause this guards: resolveWorkerBaseUrl throws an actionable-but-
  // internal message ("...VITE_WORKER_URL is unset...") when a production
  // build has no VITE_WORKER_URL configured. That message must reach
  // console/monitoring (via resolveWorkerBaseUrl's own console.error) but must
  // NEVER be rendered into the DOM for an end user to read.
  it('never renders the raw VITE_WORKER_URL config message when the worker URL cannot be resolved in production', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_WORKER_URL', '');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderComponent();
    const input = screen.getByPlaceholderText(/ask a compliance question/i);
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText('An error occurred')).toBeInTheDocument();
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('VITE_WORKER_URL');
    // The loud, engineer-facing signal still fires.
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('calls correct API endpoint with query params', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        answer: 'Response',
        citations: [],
        confidence: 0.5,
        model: 'test',
        query: 'my query',
      }),
    });

    renderComponent();
    const input = screen.getByPlaceholderText(/ask a compliance question/i);
    fireEvent.change(input, { target: { value: 'my query' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/nessie/query');
    expect(url).toContain('mode=context');
    expect(url).toContain('q=my+query');
  });
});
