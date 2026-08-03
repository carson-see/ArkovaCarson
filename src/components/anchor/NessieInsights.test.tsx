/**
 * NessieInsights Component Tests (NMT-07, Phase G)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NessieInsights } from './NessieInsights';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function renderComponent() {
  const utils = render(<NessieInsights credentialType="Diploma" issuerName="Test University" />);
  // The panel starts collapsed; expand it so the error/loading state is visible.
  fireEvent.click(screen.getByRole('button', { name: /document insights/i }));
  return utils;
}

describe('NessieInsights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Root cause this guards: resolveWorkerBaseUrl throws an actionable-but-
  // internal message ("...VITE_WORKER_URL is unset...") when a production
  // build has no VITE_WORKER_URL configured. That message must reach
  // console/monitoring (via resolveWorkerBaseUrl's own console.error) but must
  // NEVER be rendered into the DOM for an end user to read — only the
  // curated 'Analysis unavailable' label may.
  it('never renders the raw VITE_WORKER_URL config message when the worker URL cannot be resolved in production', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_WORKER_URL', '');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Analysis unavailable')).toBeInTheDocument();
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('VITE_WORKER_URL');
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('displays the generic safe label on a failed request, never the raw server error text', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Nessie query endpoint is not enabled' }),
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Analysis unavailable')).toBeInTheDocument();
    });
    expect(screen.queryByText(/not enabled/i)).not.toBeInTheDocument();
  });

  it('displays the generic safe label on a network failure, never the raw exception text', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Analysis unavailable')).toBeInTheDocument();
    });
    expect(screen.queryByText(/network error/i)).not.toBeInTheDocument();
  });
});
