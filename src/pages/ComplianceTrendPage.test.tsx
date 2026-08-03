/**
 * Tests for ComplianceTrendPage (COMP-07)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ComplianceTrendPage } from './ComplianceTrendPage';
import { COMPLIANCE_TREND_LABELS } from '@/lib/copy';

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
      <ComplianceTrendPage />
    </MemoryRouter>,
  );
}

describe('ComplianceTrendPage', () => {
  it('renders page title', () => {
    renderPage();
    expect(screen.getByText(COMPLIANCE_TREND_LABELS.PAGE_TITLE, { exact: false })).toBeInTheDocument();
  });

  it('renders granularity selector', () => {
    renderPage();
    // Select component renders the current value (Weekly by default), not all options
    expect(screen.getByText(COMPLIANCE_TREND_LABELS.WEEKLY)).toBeInTheDocument();
  });

  it('renders page description', () => {
    renderPage();
    expect(screen.getByText(COMPLIANCE_TREND_LABELS.PAGE_DESCRIPTION)).toBeInTheDocument();
  });

  // Root cause this guards: resolveWorkerBaseUrl throws an actionable-but-
  // internal message ("...VITE_WORKER_URL is unset...") when a production
  // build has no VITE_WORKER_URL configured. That message must reach
  // console/monitoring (via resolveWorkerBaseUrl's own console.error) but must
  // NEVER be rendered into the DOM for an end user to read — only the
  // curated ERR_NETWORK label may.
  describe('worker URL misconfiguration', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('never renders the raw VITE_WORKER_URL config message when the worker URL cannot be resolved in production', async () => {
      mockGetSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
      vi.stubEnv('PROD', true);
      vi.stubEnv('VITE_WORKER_URL', '');
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      renderPage();
      fireEvent.click(screen.getByRole('button', { name: new RegExp(COMPLIANCE_TREND_LABELS.FETCH, 'i') }));

      await waitFor(() => {
        expect(screen.getByText(COMPLIANCE_TREND_LABELS.ERR_NETWORK)).toBeInTheDocument();
      });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain('VITE_WORKER_URL');
      expect(consoleError).toHaveBeenCalled();

      consoleError.mockRestore();
    });
  });
});
