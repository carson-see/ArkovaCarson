/**
 * NessieIntelligencePanel Component Tests (NMT-07)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  it('renders panel title and input', () => {
    renderComponent();
    expect(screen.getByText('Nessie Intelligence')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/ask a compliance question/i)).toBeInTheDocument();
  });

  it('renders empty state when no query submitted', () => {
    renderComponent();
    expect(screen.getByText(/ask a question to get compliance intelligence/i)).toBeInTheDocument();
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
            verify_url: 'https://app.arkova.io/verify/ARK-001',
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

  it('displays error on failed request', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Nessie query endpoint is not enabled' }),
    });

    renderComponent();
    const input = screen.getByPlaceholderText(/ask a compliance question/i);
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText(/not enabled/i)).toBeInTheDocument();
    });
  });

  it('displays error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    renderComponent();
    const input = screen.getByPlaceholderText(/ask a compliance question/i);
    fireEvent.change(input, { target: { value: 'test' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText(/network error/i)).toBeInTheDocument();
    });
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
