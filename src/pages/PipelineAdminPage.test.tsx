/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * Pipeline Admin Page Tests (PH1-DATA-05)
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn().mockReturnValue({
    user: { email: 'carson@arkova.ai', id: 'user-1' },
    signOut: vi.fn(),
    session: null,
    loading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: vi.fn().mockReturnValue({
    profile: { org_id: 'org-1', role: 'ORG_ADMIN', full_name: 'Carson' },
    loading: false,
    destination: '/dashboard',
  }),
}));

vi.mock('@/hooks/useTheme', () => ({
  useTheme: vi.fn().mockReturnValue({ theme: 'dark', setTheme: vi.fn() }),
}));

vi.mock('@/lib/supabase', () => {
  const mockQuery = {
    not: vi.fn().mockResolvedValue({ count: 40, data: null, error: null }),
    is: vi.fn().mockResolvedValue({ count: 10, data: null, error: null }),
    limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    range: vi.fn().mockResolvedValue({ data: [], count: 0, error: null }),
  };
  return {
    supabase: {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue(mockQuery),
      }),
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    },
  };
});

vi.mock('@/lib/workerClient', () => ({
  workerFetch: vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({
      totalRecords: 10000,
      anchoredRecords: 9000,
      pendingRecords: 1000,
      embeddedRecords: 8000,
      anchorLinkedRecords: 9500,
      pendingRecordLinks: 500,
      pendingAnchorRecords: 450,
      broadcastingRecords: 50,
      submittedRecords: 7000,
      securedRecords: 2000,
      cacheUpdatedAt: '2026-04-24T12:00:00Z',
      bySource: {},
    }),
  }),
}));

import { PipelineAdminPage } from './PipelineAdminPage';
import { workerFetch } from '@/lib/workerClient';

describe('PipelineAdminPage', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { useAuth } = await import('@/hooks/useAuth');
    vi.mocked(useAuth).mockReturnValue({
      user: { email: 'carson@arkova.ai', id: 'user-1' },
      signOut: vi.fn(),
      session: null,
      loading: false,
      error: null,
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('renders page title for admin user', () => {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Pipeline Monitoring')).toBeInTheDocument();
  });

  it('renders refresh button', () => {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Refresh')).toBeInTheDocument();
  });

  it('labels anchoring metrics as customer-facing anchoring status', async () => {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Records Anchored')).toBeInTheDocument();
    expect(await screen.findByText('Pending Anchoring')).toBeInTheDocument();
  });

  it('shows access restricted for non-admin', async () => {
    const { useAuth } = await import('@/hooks/useAuth');
    vi.mocked(useAuth).mockReturnValue({
      user: { email: 'regular@test.com', id: 'user-2' },
      signOut: vi.fn(),
      session: null,
      loading: false,
      error: null,
    } as unknown as ReturnType<typeof useAuth>);

    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Access Restricted')).toBeInTheDocument();
  });

  it('wires the continuing education control to a real worker route', async () => {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    await screen.findByText('Records Anchored');
    vi.mocked(workerFetch).mockClear();

    fireEvent.click(screen.getByText('Pipeline Controls'));
    fireEvent.click(await screen.findByTestId('pipeline-job-fetch-continuing-education'));

    await waitFor(() => {
      expect(workerFetch).toHaveBeenCalledWith('/jobs/fetch-continuing-education', { method: 'POST' });
    });
  });

  it('keeps unavailable controls disabled instead of calling missing worker routes', async () => {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    await screen.findByText('Records Anchored');

    fireEvent.click(screen.getByText('Pipeline Controls'));
    const eurlexControl = await screen.findByTestId('pipeline-job-fetch-eurlex');
    expect(eurlexControl).toBeDisabled();
    expect(eurlexControl).toHaveAttribute('title', 'Worker route is not wired in this release.');
  });

  it('documents that the batch anchoring control uses normal trigger rules', async () => {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    await screen.findByText('Records Anchored');

    fireEvent.click(screen.getByText('Pipeline Controls'));
    expect(await screen.findByTestId('pipeline-job-batch-anchors')).toHaveAttribute(
      'title',
      expect.stringContaining('size, age, and fee triggers'),
    );
  });

  it('clears stale completion timers when the same pipeline control is run again', async () => {
    let continuingEducationCalls = 0;
    vi.mocked(workerFetch).mockImplementation(async (path) => {
      if (path === '/jobs/fetch-continuing-education') {
        continuingEducationCalls += 1;
        if (continuingEducationCalls === 1) {
          return {
            ok: true,
            json: vi.fn().mockResolvedValue({ processed: 1 }),
          } as unknown as Response;
        }
        return new Promise<Response>(() => undefined);
      }

      return {
        ok: true,
        json: vi.fn().mockResolvedValue({
          totalRecords: 10000,
          anchoredRecords: 9000,
          pendingRecords: 1000,
          embeddedRecords: 8000,
          anchorLinkedRecords: 9500,
          pendingRecordLinks: 500,
          pendingAnchorRecords: 450,
          broadcastingRecords: 50,
          submittedRecords: 7000,
          securedRecords: 2000,
          cacheUpdatedAt: '2026-04-24T12:00:00Z',
          bySource: {},
        }),
      } as unknown as Response;
    });

    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    await screen.findByText('Records Anchored');

    fireEvent.click(screen.getByText('Pipeline Controls'));
    const control = await screen.findByTestId('pipeline-job-fetch-continuing-education');

    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(control);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(control).not.toBeDisabled();

      await act(async () => {
        vi.advanceTimersByTime(4000);
      });

      await act(async () => {
        fireEvent.click(control);
        await Promise.resolve();
      });
      expect(control).toBeDisabled();

      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(control).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });
});
