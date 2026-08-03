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

  // The worker's OWN response body is a curated, safe-to-show business
  // message (a tier-gate, a rate limit, ...) — it must reach the user
  // verbatim so they can self-diagnose, exactly like it did before the
  // VITE_WORKER_URL fix. See `src/lib/workerResponseError.ts` for why.
  it('displays the worker\'s own response-body error message verbatim on a failed request', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Nessie query endpoint is not enabled' }),
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Nessie query endpoint is not enabled')).toBeInTheDocument();
    });
    expect(screen.queryByText('Analysis unavailable')).not.toBeInTheDocument();
  });

  it('displays the generic safe label on a network failure, never the raw exception text', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText('Analysis unavailable')).toBeInTheDocument();
    });
    expect(screen.queryByText(/network error/i)).not.toBeInTheDocument();
  });

  // Reuse/security review finding: this call site must use BOTH halves of
  // workerUrlSafety.ts's contract — resolveWorkerBaseUrl (picks the base)
  // AND resolveSafeWorkerEndpoint (pins the request path/query to that base's
  // origin) — not a hand-built `${workerUrl}/path` template string.
  it('pins the request to the configured worker origin via resolveSafeWorkerEndpoint', async () => {
    const customWorkerOrigin = 'https://custom-worker.example.test';
    vi.stubEnv('VITE_WORKER_URL', customWorkerOrigin);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ answer: '', citations: [], confidence: 0 }),
    });

    renderComponent();

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(new URL(calledUrl).origin).toBe(customWorkerOrigin);
    expect(new URL(calledUrl).pathname).toBe('/api/v1/nessie/query');
  });
});
