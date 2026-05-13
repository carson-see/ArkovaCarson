/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * Pipeline Admin Page Tests (PH1-DATA-05)
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn().mockReturnValue({ user: { email: 'carson@arkova.ai', id: 'user-1' }, signOut: vi.fn(), session: null, loading: false, error: null }) }));

vi.mock('@/hooks/useProfile', () => ({ useProfile: vi.fn().mockReturnValue({ profile: { org_id: 'org-1', role: 'ORG_ADMIN', full_name: 'Carson' }, loading: false, destination: '/dashboard' }) }));

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
import { supabase } from '@/lib/supabase';

const defaultRecordPage = { data: [], total: 0 };
const submittedRecordPage = {
  total: 1,
  data: [{
    id: 'record-1',
    source: 'edgar',
    source_id: 'SRC-1',
    source_url: null,
    record_type: 'filing',
    title: 'Submitted filing',
    content_hash: 'a'.repeat(64),
    anchor_id: 'anchor-1',
    metadata: {},
    created_at: '2026-05-12T10:00:00Z',
    updated_at: '2026-05-12T10:00:00Z',
    anchor_status: 'SUBMITTED',
    chain_tx_id: 'b'.repeat(64),
  }],
};

function mockSupabaseRpc(overrides?: Record<string, unknown>) {
  (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
    if (name === 'get_public_records_page') {
      return Promise.resolve({ data: overrides?.recordPage ?? defaultRecordPage, error: null });
    }
    if (name === 'get_pipeline_stats') {
      return Promise.resolve({
        data: overrides?.pipelineStats ?? {
          total_records: 10000,
          pending_bitcoin_records: 1000,
          embedded_records: 8000,
          pending_record_links: 500,
          pending_anchor_records: 450,
          broadcasting_records: 50,
          submitted_records: 7000,
          secured_records: 2000,
          cache_updated_at: '2026-04-24T12:00:00Z',
        },
        error: null,
      });
    }
    if (name === 'count_public_records_by_source') {
      return Promise.resolve({ data: [], error: null });
    }
    return Promise.resolve({ data: [], error: null });
  });
}

describe('PipelineAdminPage', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockSupabaseRpc();
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

  it('renders SUBMITTED records as in mempool, not anchored', async () => {
    mockSupabaseRpc({
      recordPage: submittedRecordPage,
    });

    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Submitted / In Mempool')).toBeInTheDocument();
    expect(screen.queryByText('Secured / Confirmed')).not.toBeInTheDocument();
  });

  it('surfaces worker/cache failure when direct RPC fallback is used', async () => {
    vi.mocked(workerFetch).mockRejectedValueOnce(new Error('worker unavailable'));

    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('pipeline-stats-fallback')).toHaveTextContent('Worker/cache source failed');
    expect(screen.getByTestId('pipeline-cache-freshness')).toHaveTextContent('Direct RPC fallback');
  });

  it('surfaces unavailable lifecycle counts instead of rendering cache-miss zeros as truth', async () => {
    vi.mocked(workerFetch).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        totalRecords: 10000,
        anchoredRecords: null,
        pendingRecords: null,
        embeddedRecords: 8000,
        anchorLinkedRecords: null,
        pendingRecordLinks: null,
        pendingAnchorRecords: null,
        broadcastingRecords: null,
        submittedRecords: null,
        securedRecords: null,
        cacheUpdatedAt: '2026-05-12T12:00:00Z',
        bySource: {},
        statusCountsAvailable: false,
        statusCountsWarning: 'Pipeline lifecycle counts unavailable: cache miss',
      }),
    } as unknown as Response);
    mockSupabaseRpc({
      recordPage: submittedRecordPage,
    });

    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('pipeline-status-counts-warning')).toHaveTextContent('cache miss');
    expect(screen.getByText('— submitted / — confirmed')).toBeInTheDocument();
    expect(screen.getByText('— unlinked / — queued / — submitting to network')).toBeInTheDocument();
    expect(screen.queryByText('0 submitted / 0 confirmed')).not.toBeInTheDocument();
    expect(await screen.findByText('Submitted / In Mempool')).toBeInTheDocument();
  });

  it('surfaces hard stats failure without coercing missing stat cards to zero', async () => {
    vi.mocked(workerFetch).mockRejectedValueOnce(new Error('worker unavailable'));
    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'get_pipeline_stats') {
        return Promise.resolve({ data: null, error: { message: 'RLS denied' } });
      }
      if (name === 'get_public_records_page') {
        return Promise.resolve({ data: defaultRecordPage, error: null });
      }
      return Promise.resolve({ data: [], error: null });
    });

    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('pipeline-stats-error')).toHaveTextContent('fallback failed: RLS denied');
    expect(screen.queryByTestId('pipeline-cache-freshness')).not.toBeInTheDocument();
    expect(screen.queryByText('0 submitted / 0 confirmed')).not.toBeInTheDocument();
    expect(screen.queryByText('0 unlinked / 0 queued / 0 submitting to network')).not.toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(4);
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
