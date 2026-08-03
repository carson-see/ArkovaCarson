/**
 * Tests for AuditorBatchPage (COMP-06)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuditorBatchPage } from './AuditorBatchPage';
import { AUDITOR_BATCH_LABELS } from '@/lib/copy';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ session: null, user: null, loading: false, signOut: vi.fn() }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: null, destination: '/dashboard', loading: false }),
}));

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function renderPage() {
  return render(
    <MemoryRouter>
      <AuditorBatchPage />
    </MemoryRouter>,
  );
}

function submit() {
  fireEvent.change(screen.getByLabelText(AUDITOR_BATCH_LABELS.CSV_LABEL), {
    target: { value: 'ARK-2026-001' },
  });
  fireEvent.click(screen.getByRole('button', { name: AUDITOR_BATCH_LABELS.SUBMIT }));
}

describe('AuditorBatchPage', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('renders page title', () => {
    renderPage();
    expect(screen.getByText(AUDITOR_BATCH_LABELS.PAGE_TITLE)).toBeInTheDocument();
  });

  // Root cause this guards: resolveWorkerBaseUrl throws an actionable-but-
  // internal message ("...VITE_WORKER_URL is unset...") when a production
  // build has no VITE_WORKER_URL configured. That message must reach
  // console/monitoring (via resolveWorkerBaseUrl's own console.error) but must
  // NEVER be rendered into the DOM for an end user to read — only the
  // curated ERR_NETWORK label may.
  it('never renders the raw VITE_WORKER_URL config message when the worker URL cannot be resolved in production', async () => {
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_WORKER_URL', '');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderPage();
    submit();

    await waitFor(() => {
      expect(screen.getByText(AUDITOR_BATCH_LABELS.ERR_NETWORK)).toBeInTheDocument();
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('VITE_WORKER_URL');
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('displays the generic safe label on a network failure, never the raw exception text', async () => {
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    // Deliberately distinct from AUDITOR_BATCH_LABELS.ERR_NETWORK ('Network
    // error') so the assertion actually distinguishes "curated label shown"
    // from "raw exception text happened to match the label".
    mockFetch.mockRejectedValueOnce(new Error('TypeError: fetch failed at internal socket layer'));

    renderPage();
    submit();

    await waitFor(() => {
      expect(screen.getByText(AUDITOR_BATCH_LABELS.ERR_NETWORK)).toBeInTheDocument();
    });
    expect(screen.queryByText(/internal socket layer/)).not.toBeInTheDocument();
  });
});
