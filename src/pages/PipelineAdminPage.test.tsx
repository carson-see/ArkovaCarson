/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * Pipeline Admin Page Tests (PH1-DATA-05)
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn().mockReturnValue({ user: { email: 'carson@arkova.ai', id: 'user-1' }, signOut: vi.fn(), session: null, loading: false, error: null }) }));

vi.mock('@/hooks/useProfile', () => ({ useProfile: vi.fn().mockReturnValue({ profile: { org_id: 'org-1', role: 'ORG_ADMIN', full_name: 'Carson', is_platform_admin: true }, loading: false, destination: '/dashboard' }) }));

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
    // SCRUM-5044: per-source freshness ("Last: … · n rows / 30d") ends its
    // chain on .gte(created_at cutoff) for the rows_30d head-count query.
    // The last-insert query ends on the existing .limit(1) above (data: []
    // by default, which renders as "No records yet" — a safe universal
    // default no other assertion in this file depends on).
    gte: vi.fn().mockResolvedValue({ count: 0, error: null }),
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

// Radix Select uses pointer-capture + portals that jsdom can't drive. Render a
// faithful native <select> instead so EVERY Select on the page (the source /
// type / status filters AND the SCRUM-2006 page-size selector) stays fully
// interactive via fireEvent.change. Multi-instance safe (no shared controller).
//
// Each <option>'s VISIBLE text is its value (not the human label). Radix only
// portals the selected item's label into the DOM when closed, so rendering the
// full label set as text would leak strings like "Secured / Confirmed" from the
// status-filter dropdown and trip pre-existing record-row assertions. Driving
// the select via fireEvent.change keys off the value, so this is sufficient.
vi.mock('@/components/ui/select', async () => {
  const React = await import('react');
  type Node = React.ReactNode;
  // Walk children to collect <SelectItem> values for the <option>s.
  const collect = (children: Node, out: string[]) => {
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return;
      const props = child.props as { value?: string; children?: Node };
      if (typeof props.value === 'string') {
        out.push(props.value);
      } else if (props.children) {
        collect(props.children, out);
      }
    });
  };
  return {
    Select: ({
      children,
      value,
      onValueChange,
      disabled,
      'data-testid': testId,
    }: {
      children: Node;
      value?: string;
      onValueChange?: (v: string) => void;
      disabled?: boolean;
      'data-testid'?: string;
    }) => {
      const values: string[] = [];
      collect(children, values);
      return (
        <select
          data-testid={testId}
          value={value}
          disabled={disabled}
          onChange={(e) => onValueChange?.(e.target.value)}
        >
          {values.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      );
    },
    SelectTrigger: ({ children }: { children: Node }) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: Node }) => <>{children}</>,
    SelectItem: () => null,
  };
});

import { PipelineAdminPage } from './PipelineAdminPage';
import { workerFetch } from '@/lib/workerClient';
import { supabase } from '@/lib/supabase';

function mockAuthUser(email: string, id: string) {
  return {
    id,
    email,
    app_metadata: {},
    user_metadata: {},
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function mockAuthState(email: string, id: string) {
  return {
    user: mockAuthUser(email, id),
    signOut: vi.fn(),
    signIn: vi.fn(),
    signUp: vi.fn(),
    signInWithGoogle: vi.fn(),
    signInWithLinkedIn: vi.fn(),
    clearError: vi.fn(),
    session: null,
    loading: false,
    error: null,
  };
}

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

// SCRUM-2006: a multi-page record set so the go-to-page + page-size controls
// have boundaries to clamp against. `total` is what drives totalPages; the row
// payload itself is irrelevant to the pagination math, so a single stub row is
// enough.
function multiPageRecordPage(total: number) {
  return {
    total,
    data: [{
      id: 'record-1',
      source: 'edgar',
      source_id: 'SRC-1',
      source_url: null,
      record_type: 'filing',
      title: 'Filing 1',
      content_hash: 'a'.repeat(64),
      anchor_id: null,
      metadata: {},
      created_at: '2026-05-12T10:00:00Z',
      updated_at: '2026-05-12T10:00:00Z',
      anchor_status: null,
      chain_tx_id: null,
    }],
  };
}

/** Returns the args of the most recent `get_public_records_page` RPC call. */
function lastRecordsPageCall(): Record<string, unknown> | undefined {
  const mock = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
  const calls = mock.mock.calls.filter((c) => c[0] === 'get_public_records_page');
  return calls.length ? (calls[calls.length - 1][1] as Record<string, unknown>) : undefined;
}

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
    vi.mocked(useAuth).mockReturnValue(mockAuthState('carson@arkova.ai', 'user-1'));
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
    vi.mocked(workerFetch).mockResolvedValueOnce(new Response(
      JSON.stringify({
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
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
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

  it('nulls all lifecycle sub-counts when direct RPC fallback reports a cache miss', async () => {
    vi.mocked(workerFetch).mockRejectedValueOnce(new Error('worker unavailable'));
    mockSupabaseRpc({
      recordPage: submittedRecordPage,
      pipelineStats: {
        total_records: 10000,
        anchored_records: 0,
        pending_records: 0,
        embedded_records: 0,
        anchor_linked_records: 0,
        pending_record_links: 0,
        pending_anchor_records: 0,
        broadcasting_records: 0,
        submitted_records: 0,
        secured_records: 0,
        cache_miss: true,
        cache_updated_at: null,
      },
    });

    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('pipeline-status-counts-warning')).toHaveTextContent('unavailable');
    expect(screen.getByText('— submitted / — confirmed')).toBeInTheDocument();
    expect(screen.getByText('— unlinked / — queued / — submitting to network')).toBeInTheDocument();
    expect(screen.queryByText('0 submitted / 0 confirmed')).not.toBeInTheDocument();
    expect(screen.queryByText('0 unlinked / 0 queued / 0 submitting to network')).not.toBeInTheDocument();
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
    const { useProfile } = await import('@/hooks/useProfile');
    vi.mocked(useAuth).mockReturnValue(mockAuthState('regular@test.com', 'user-2'));
    // Access is decided by the is_platform_admin DB flag, not the email.
    vi.mocked(useProfile).mockReturnValue({
      profile: { org_id: 'org-1', role: 'ORG_ADMIN', full_name: 'Regular', is_platform_admin: false },
      loading: false,
      destination: '/dashboard',
    } as never);

    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Access Restricted')).toBeInTheDocument();

    // Restore the admin default so later describe blocks (which only
    // clearAllMocks, preserving implementations) still see a platform admin.
    vi.mocked(useProfile).mockReturnValue({
      profile: { org_id: 'org-1', role: 'ORG_ADMIN', full_name: 'Carson', is_platform_admin: true },
      loading: false,
      destination: '/dashboard',
    } as never);
  });

  it('wires the EDGAR control to a real worker route', async () => {
    // Was 'fetch-continuing-education' — SCRUM-5045/5046 moved that control to
    // disabled (upstream endpoint moved, 404), so it can no longer stand in as
    // "the enabled control" for this wiring assertion. fetch-edgar stays enabled.
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    await screen.findByText('Records Anchored');
    vi.mocked(workerFetch).mockClear();

    fireEvent.click(screen.getByText('Pipeline Controls'));
    fireEvent.click(await screen.findByTestId('pipeline-job-fetch-edgar'));

    await waitFor(() => {
      expect(workerFetch).toHaveBeenCalledWith('/jobs/fetch-edgar', { method: 'POST' });
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
    // Was 'fetch-continuing-education' — now disabled (SCRUM-5046); fetch-edgar
    // stays enabled and exercises the same timer-clearing path.
    let edgarCalls = 0;
    vi.mocked(workerFetch).mockImplementation(async (path) => {
      if (path === '/jobs/fetch-edgar') {
        edgarCalls += 1;
        if (edgarCalls === 1) {
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
    const control = await screen.findByTestId('pipeline-job-fetch-edgar');

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

  // ─── SCRUM-5045: retire controls that never produced a record ───────────

  it('marks every source that has never produced a record as Disabled with an honest reason', async () => {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    await screen.findByText('Records Anchored');
    fireEvent.click(screen.getByText('Pipeline Controls'));

    const placeholderCases: Array<[string, string]> = [
      ['fetch-certifications', 'Placeholder — no data source is implemented (SCRUM-5045).'],
      ['fetch-cle', 'Source has never produced a record; retired pending re-source (SCRUM-5045).'],
      ['fetch-licensing-board', 'Source has never produced a record; retired pending re-source (SCRUM-5045).'],
      ['fetch-insurance-licenses', 'Source has never produced a record; retired pending re-source (SCRUM-5045).'],
      ['fetch-sos', 'Source has never produced a record; retired pending re-source (SCRUM-5045).'],
      ['fetch-uspto', 'No USPTO credential — source unavailable (SCRUM-5041).'],
      ['fetch-sam-entities', 'SAM.gov API key invalid — awaiting re-issue (SCRUM-5037).'],
      ['fetch-courtlistener', 'CourtListener account blocked — awaiting new credential (SCRUM-5039).'],
      ['fetch-sec-iapd', 'Upstream returns 403 (bot protection) (SCRUM-5046).'],
      ['fetch-fcc', 'Upstream returns 403 (bot protection) (SCRUM-5046).'],
      ['fetch-moh-sg', 'Upstream endpoint moved (404) (SCRUM-5046).'],
      ['fetch-continuing-education', 'Upstream endpoint moved (404) (SCRUM-5046).'],
      ['fetch-ipeds', 'Job fails (502) — code-side defect (SCRUM-5046).'],
      ['fetch-ecfr', 'Returns 200 with zero rows — date bug (SCRUM-5042).'],
      ['fetch-enforcement', 'Returns 200 with zero rows — date bug (SCRUM-5042).'],
    ];

    for (const [path, reason] of placeholderCases) {
      const el = await screen.findByTestId(`pipeline-job-${path}`);
      expect(el).toBeDisabled();
      expect(el).toHaveAttribute('title', reason);

      // UAT (SCRUM-5045 follow-up): button.tsx applies
      // disabled:pointer-events-none, so a disabled control never receives
      // hover and its `title` tooltip never renders for a mouse user — the
      // reason must also exist as visible text, not just in title/aria-label.
      const reasonCaption = await screen.findByTestId(`pipeline-job-reason-${path}`);
      expect(reasonCaption).toHaveTextContent(reason);
    }
  });

  it('does not render a disabled-reason caption for an enabled control', async () => {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    await screen.findByText('Records Anchored');
    fireEvent.click(screen.getByText('Pipeline Controls'));
    await screen.findByTestId('pipeline-job-fetch-edgar');

    expect(screen.queryByTestId('pipeline-job-reason-fetch-edgar')).not.toBeInTheDocument();
  });

  it('keeps the three pre-existing international "not wired" controls disabled as-is', async () => {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    await screen.findByText('Records Anchored');
    fireEvent.click(screen.getByText('Pipeline Controls'));

    for (const path of ['fetch-eurlex', 'fetch-fca-uk', 'fetch-companies-house']) {
      const el = await screen.findByTestId(`pipeline-job-${path}`);
      expect(el).toBeDisabled();
      expect(el).toHaveAttribute('title', 'Worker route is not wired in this release.');
    }
  });

  // ─── SCRUM-5043 (UI half): 504 on a long-running job is not a failure ───

  it('flags fetch-finra, fetch-npi, fetch-calbar and fetch-all-state-bills as long-running with a background hint', async () => {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    await screen.findByText('Records Anchored');
    fireEvent.click(screen.getByText('Pipeline Controls'));

    for (const path of ['fetch-finra', 'fetch-npi', 'fetch-calbar', 'fetch-all-state-bills']) {
      const button = await screen.findByTestId(`pipeline-job-${path}`);
      expect(button).not.toBeDisabled();
      expect(button).toHaveAttribute('title', expect.stringContaining('Runs in background'));
    }
  });

  it('treats a 504 from a long-running control as started, not failed', async () => {
    vi.mocked(workerFetch).mockImplementation(async (path) => {
      if (path === '/jobs/fetch-finra') {
        return {
          ok: false,
          status: 504,
          json: vi.fn().mockResolvedValue(null),
        } as unknown as Response;
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

    const control = await screen.findByTestId('pipeline-job-fetch-finra');
    fireEvent.click(control);

    await waitFor(() => {
      expect(control).toHaveAttribute(
        'title',
        'Started; runs in the background past the request timeout. Check source volume for completion.',
      );
    });
    // 'done', not 'error' — no destructive-variant Error badge.
    expect(screen.queryByText('Error')).not.toBeInTheDocument();
  });

  it('still treats a 504 from a NON-long-running control as an error', async () => {
    vi.mocked(workerFetch).mockImplementation(async (path) => {
      if (path === '/jobs/fetch-edgar') {
        return {
          ok: false,
          status: 504,
          json: vi.fn().mockResolvedValue(null),
        } as unknown as Response;
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

    const control = await screen.findByTestId('pipeline-job-fetch-edgar');
    fireEvent.click(control);

    await waitFor(() => {
      expect(control).toHaveAttribute('title', 'Worker returned 504');
    });
  });

  // ─── SCRUM-5044: per-source freshness under each control ────────────────

  it('renders "No records yet" under a source control when the source has no rows', async () => {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    await screen.findByText('Records Anchored');
    fireEvent.click(screen.getByText('Pipeline Controls'));

    const freshness = await screen.findByTestId('pipeline-job-freshness-fetch-edgar');
    expect(freshness).toHaveTextContent('No records yet');
  });

  it('renders "Last: … · n rows / 30d" under a source control once freshness data resolves', async () => {
    const recentIso = new Date(Date.now() - 60_000).toISOString();
    (supabase.from as unknown as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table !== 'public_records') {
        return { select: vi.fn().mockReturnValue({
          not: vi.fn().mockResolvedValue({ count: 40, data: null, error: null }),
          is: vi.fn().mockResolvedValue({ count: 10, data: null, error: null }),
          limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          range: vi.fn().mockResolvedValue({ data: [], count: 0, error: null }),
          gte: vi.fn().mockResolvedValue({ count: 0, error: null }),
        }) };
      }
      const chain = {
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [{ created_at: recentIso }], error: null }),
        gte: vi.fn().mockResolvedValue({ count: 7, error: null }),
      };
      return { select: vi.fn().mockReturnValue(chain) };
    });

    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    await screen.findByText('Records Anchored');
    fireEvent.click(screen.getByText('Pipeline Controls'));

    const freshness = await screen.findByTestId('pipeline-job-freshness-fetch-edgar');
    await waitFor(() => {
      expect(freshness).toHaveTextContent(/Last: .* · 7 rows \/ 30d/);
    });
  });

  it('does not render a freshness caption for controls with no source (fetch-certifications, fetch-sos)', async () => {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    await screen.findByText('Records Anchored');
    fireEvent.click(screen.getByText('Pipeline Controls'));
    await screen.findByTestId('pipeline-job-fetch-certifications');

    expect(screen.queryByTestId('pipeline-job-freshness-fetch-certifications')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pipeline-job-freshness-fetch-sos')).not.toBeInTheDocument();
  });

  // ─── Coordinator follow-up: gate the freshness fetch behind the section's
  // open state and a 5-minute throttle, instead of firing on every 30s poll
  // regardless of whether anyone can see the captions. ───────────────────

  it('does not issue any public_records freshness queries while Pipeline Controls is collapsed', async () => {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    await screen.findByText('Records Anchored');

    // Pipeline Controls defaults closed and is never clicked in this test —
    // the mount-time poll must not have queried public_records at all.
    const fromCalls = (supabase.from as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(fromCalls.some((call) => call[0] === 'public_records')).toBe(false);
  });

  it('fetches per-source freshness once on expand, and not again on a second expand within the 5-minute window', async () => {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    await screen.findByText('Records Anchored');

    const header = screen.getByText('Pipeline Controls');
    fireEvent.click(header); // expand
    await screen.findByTestId('pipeline-job-freshness-fetch-edgar');

    const countPublicRecordsCalls = () =>
      (supabase.from as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((call: unknown[]) => call[0] === 'public_records').length;

    const callsAfterFirstExpand = countPublicRecordsCalls();
    expect(callsAfterFirstExpand).toBeGreaterThan(0);

    // Collapse and re-expand immediately — still well inside the 5-minute
    // throttle window, so this must NOT issue a second round of queries.
    await act(async () => {
      fireEvent.click(header); // collapse
      fireEvent.click(header); // expand again
      await Promise.resolve();
    });

    expect(countPublicRecordsCalls()).toBe(callsAfterFirstExpand);
  });
});

// ─── SCRUM-2245 (HARDEN-1-B): get_distinct_record_types thenable .catch crash ──
//
// FRONTEND-1/4/5 in Sentry: the record-type filter effect called `.catch()` on a
// Supabase RPC *builder* — a thenable, not a Promise. A PostgREST builder has
// `.then` but no `.catch`, so `dbAny.rpc('get_distinct_record_types').catch(...)`
// threw "rpc(...).catch is not a function" inside the async IIFE, surfacing as an
// unhandled rejection and leaving the type filter permanently empty with no path
// to recover. The fix (PipelineAdminPage.tsx ~L666) uses the two-arg
// `.then(onOk, onErr)` form, which every thenable supports.
//
// These tests mock `get_distinct_record_types` to return a builder *without*
// `.catch` (a plain thenable). Against the old `.catch()` code this throws;
// against the fix it resolves cleanly. We also fail the test if any unhandled
// rejection escapes during the render.
describe('PipelineAdminPage — record-type filter RPC is a thenable, not a Promise (SCRUM-2245)', () => {
  /**
   * A PostgREST-style builder: it is thenable (has `.then(onOk, onErr)`) but has
   * NO `.catch` method — exactly the shape that broke `.rpc(...).catch(...)`.
   */
  function thenableBuilder(result: { data: unknown; error: unknown }) {
    return {
      then(onFulfilled: (r: { data: unknown; error: unknown }) => unknown) { // NOSONAR - intentional Supabase RPC thenable test double without catch
        // Resolve asynchronously like the real client.
        return Promise.resolve(result).then(onFulfilled);
      },
      // Deliberately NO `catch` — calling `.catch` on this throws TypeError,
      // reproducing FRONTEND-1/4/5.
    };
  }

  /** Wire supabase.rpc so get_distinct_record_types returns a thenable builder. */
  function mockDistinctTypesAsThenable(result: { data: unknown; error: unknown }) {
    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'get_distinct_record_types') {
        return thenableBuilder(result);
      }
      if (name === 'get_public_records_page') {
        return Promise.resolve({ data: defaultRecordPage, error: null });
      }
      if (name === 'get_pipeline_stats') {
        return Promise.resolve({
          data: {
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
      return Promise.resolve({ data: [], error: null });
    });
  }

  let unhandled: unknown[] = [];
  const onUnhandled = (e: PromiseRejectionEvent) => {
    unhandled.push(e.reason);
    // Prevent the rejection from failing the whole vitest worker.
    e.preventDefault?.();
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    unhandled = [];
    window.addEventListener('unhandledrejection', onUnhandled);
    const { useAuth } = await import('@/hooks/useAuth');
    vi.mocked(useAuth).mockReturnValue(mockAuthState('carson@arkova.ai', 'user-1'));
  });

  afterEach(() => {
    window.removeEventListener('unhandledrejection', onUnhandled);
  });

  it('does not throw "catch is not a function" and populates the type filter when the builder resolves with data', async () => {
    mockDistinctTypesAsThenable({
      data: [{ record_type: 'filing' }, { record_type: 'charity' }],
      error: null,
    });

    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );

    await screen.findByText('Records Anchored');

    // The mocked Select renders each record_type value as a visible <option>.
    // With the .catch() bug the effect threw before setAvailableTypes ran, so
    // these options never appeared.
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'filing' })).toBeInTheDocument();
    });
    expect(screen.getByRole('option', { name: 'charity' })).toBeInTheDocument();

    // No "catch is not a function" (or any other) unhandled rejection escaped.
    await act(async () => {
      await Promise.resolve();
    });
    expect(unhandled).toEqual([]);
  });

  it('yields an empty type list (no crash) when the RPC resolves with an error', async () => {
    mockDistinctTypesAsThenable({
      data: null,
      error: { message: 'RLS denied' },
    });

    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );

    await screen.findByText('Records Anchored');

    // The fix's onError path / null-data guard collapses to availableTypes: [] —
    // only the static "all types" option remains, no per-type options, and crucially
    // no unhandled rejection from a missing `.catch`.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('option', { name: 'filing' })).not.toBeInTheDocument();
    expect(unhandled).toEqual([]);
  });

  it('guards a builder with no .catch — calling .catch on it would throw (red against the old code)', () => {
    // This documents the exact failure mode: the builder is a thenable but
    // .catch is not a function. The production code must therefore never call
    // .rpc(...).catch(...).
    const builder = thenableBuilder({ data: [], error: null }) as {
      then: unknown;
      catch?: unknown;
    };
    expect(typeof builder.then).toBe('function');
    expect(builder.catch).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => (builder as any).catch(() => undefined)).toThrow(TypeError);
  });
});

// ─── SCRUM-2006: Pipeline pagination — go-to-page + page-size selector ───────
describe('PipelineAdminPage — records pagination (SCRUM-2006)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // 250 records @ default page size 25 → 10 pages of headroom to jump within.
    mockSupabaseRpc({ recordPage: multiPageRecordPage(250) });
    const { useAuth } = await import('@/hooks/useAuth');
    vi.mocked(useAuth).mockReturnValue(mockAuthState('carson@arkova.ai', 'user-1'));
  });

  async function renderAndWaitForRecords() {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );
    // Wait for the records table (and therefore the pagination controls) to render.
    await screen.findByTestId('pipeline-page-jump-input');
  }

  async function expectPageIndicator(text: string) {
    await waitFor(() => {
      expect(screen.getByTestId('pipeline-page-indicator')).toHaveTextContent(text);
    });
  }

  it('jumps directly to a valid page and re-queries that page (1-based RPC)', async () => {
    await renderAndWaitForRecords();

    const input = screen.getByTestId('pipeline-page-jump-input');
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.click(screen.getByTestId('pipeline-page-jump-go'));

    // RPC p_page is 1-based; UI page 7 → p_page 7.
    await waitFor(() => {
      expect(lastRecordsPageCall()).toMatchObject({ p_page: 7, p_page_size: 25 });
    });
    // Indicator reflects the new current page.
    await expectPageIndicator('7 / 10');
  });

  it('supports Enter to jump from the go-to-page input', async () => {
    await renderAndWaitForRecords();

    const input = screen.getByTestId('pipeline-page-jump-input');
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(lastRecordsPageCall()).toMatchObject({ p_page: 4 });
    });
  });

  it('clamps an above-range jump to the last page', async () => {
    await renderAndWaitForRecords();

    const input = screen.getByTestId('pipeline-page-jump-input');
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.click(screen.getByTestId('pipeline-page-jump-go'));

    await waitFor(() => {
      // 250 / 25 = 10 pages → clamp to page 10 → p_page 10.
      expect(lastRecordsPageCall()).toMatchObject({ p_page: 10 });
    });
    await expectPageIndicator('10 / 10');
  });

  it('clamps a below-range jump (0 or negative) to the first page', async () => {
    await renderAndWaitForRecords();

    // Move off page 1 first so a clamp-to-1 is observable as a real change.
    fireEvent.change(screen.getByTestId('pipeline-page-jump-input'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('pipeline-page-jump-go'));
    await waitFor(() => expect(lastRecordsPageCall()).toMatchObject({ p_page: 5 }));
    await expectPageIndicator('5 / 10');

    fireEvent.change(screen.getByTestId('pipeline-page-jump-input'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('pipeline-page-jump-go'));
    await waitFor(() => expect(lastRecordsPageCall()).toMatchObject({ p_page: 1 }));
    await expectPageIndicator('1 / 10');
  });

  it('rejects a non-numeric / empty jump without changing the page', async () => {
    await renderAndWaitForRecords();

    // Go to page 3 first.
    fireEvent.change(screen.getByTestId('pipeline-page-jump-input'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('pipeline-page-jump-go'));
    await waitFor(() => expect(lastRecordsPageCall()).toMatchObject({ p_page: 3 }));
    await expectPageIndicator('3 / 10');

    const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
    const callsBefore = rpc.mock.calls.filter((c) => c[0] === 'get_public_records_page').length;

    // Garbage + empty inputs must be no-ops (no new fetch, page stays at 3).
    fireEvent.change(screen.getByTestId('pipeline-page-jump-input'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('pipeline-page-jump-go'));
    fireEvent.change(screen.getByTestId('pipeline-page-jump-input'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('pipeline-page-jump-go'));

    const callsAfter = rpc.mock.calls.filter((c) => c[0] === 'get_public_records_page').length;
    expect(callsAfter).toBe(callsBefore);
    await expectPageIndicator('3 / 10');
  });

  it('changing page size re-queries with the new size and resets to page 1', async () => {
    await renderAndWaitForRecords();

    // Navigate to page 6 first so the reset-to-1 is observable.
    fireEvent.change(screen.getByTestId('pipeline-page-jump-input'), { target: { value: '6' } });
    fireEvent.click(screen.getByTestId('pipeline-page-jump-go'));
    await waitFor(() => expect(lastRecordsPageCall()).toMatchObject({ p_page: 6, p_page_size: 25 }));
    await expectPageIndicator('6 / 10');

    // Bump page size to 100.
    fireEvent.change(screen.getByTestId('pipeline-page-size'), { target: { value: '100' } });

    await waitFor(() => {
      // Re-query with new size AND reset to first page.
      expect(lastRecordsPageCall()).toMatchObject({ p_page: 1, p_page_size: 100 });
    });
    // 250 / 100 = 3 pages now.
    await expectPageIndicator('1 / 3');
  });

  it('disables Previous on the first page and Next on the last page', async () => {
    await renderAndWaitForRecords();

    // First page: Previous disabled, Next enabled.
    expect(screen.getByTestId('pipeline-page-prev')).toBeDisabled();
    expect(screen.getByTestId('pipeline-page-next')).not.toBeDisabled();

    // Jump to last page: Next disabled, Previous enabled.
    fireEvent.change(screen.getByTestId('pipeline-page-jump-input'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('pipeline-page-jump-go'));
    await waitFor(() => expect(lastRecordsPageCall()).toMatchObject({ p_page: 10 }));

    await waitFor(() => expect(screen.getByTestId('pipeline-page-next')).toBeDisabled());
    expect(screen.getByTestId('pipeline-page-prev')).not.toBeDisabled();
  });

  it('preserves existing Previous/Next behavior', async () => {
    await renderAndWaitForRecords();

    fireEvent.click(screen.getByTestId('pipeline-page-next'));
    await waitFor(() => expect(lastRecordsPageCall()).toMatchObject({ p_page: 2 }));
    await expectPageIndicator('2 / 10');

    fireEvent.click(screen.getByTestId('pipeline-page-prev'));
    await waitFor(() => expect(lastRecordsPageCall()).toMatchObject({ p_page: 1 }));
  });

  // SCRUM-2006 (Codex P2): the backend RPC get_public_records_page caps p_page at
  // v_max_page = 10000 (supabase/migrations/0305_pipeline_operational_status_filters.sql).
  // The client-side totalPages math (recordsTotal / pageSize) can exceed 10000 at
  // small page sizes, so an unclamped jump to e.g. page 50000 used to set the page
  // indicator + prev/next to 50000 while the RPC silently served page 10000 — a
  // page-state↔served-data desync. The client must never claim a page the backend
  // won't serve, so any jump/indicator past 10000 is capped at 10000.
  describe('caps the client page at the backend RPC page ceiling (10000)', () => {
    beforeEach(async () => {
      vi.clearAllMocks();
      // 300,000 records @ default page size 25 → 12,000 client pages, well past the
      // RPC's 10,000-page ceiling. This is the reachable-at-small-page-size case.
      mockSupabaseRpc({ recordPage: multiPageRecordPage(300_000) });
      const { useAuth } = await import('@/hooks/useAuth');
      vi.mocked(useAuth).mockReturnValue(mockAuthState('carson@arkova.ai', 'user-1'));
    });

    it('clamps a go-to-page beyond 10000 to page 10000 (matching the served page)', async () => {
      await renderAndWaitForRecords();

      const input = screen.getByTestId('pipeline-page-jump-input');
      fireEvent.change(input, { target: { value: '50000' } });
      fireEvent.click(screen.getByTestId('pipeline-page-jump-go'));

      await waitFor(() => {
        // Without the cap this would be p_page: 50000, but the RPC only serves up
        // to page 10000 — the client must request exactly the page it will get.
        expect(lastRecordsPageCall()).toMatchObject({ p_page: 10000, p_page_size: 25 });
      });
      // The indicator denominator is the served ceiling (10000), not 12000, and the
      // current page is the clamped 10000 — no 50000 desync.
      await expectPageIndicator('10000 / 10000');
    });

    it('caps the Next button so prev/next cannot walk the client past page 10000', async () => {
      await renderAndWaitForRecords();

      // Jump exactly to the ceiling; Next must be disabled there even though the raw
      // totalPages (12000) would otherwise leave 1,999 pages of headroom.
      fireEvent.change(screen.getByTestId('pipeline-page-jump-input'), { target: { value: '10000' } });
      fireEvent.click(screen.getByTestId('pipeline-page-jump-go'));
      await waitFor(() => expect(lastRecordsPageCall()).toMatchObject({ p_page: 10000 }));

      await waitFor(() => expect(screen.getByTestId('pipeline-page-next')).toBeDisabled());
      expect(screen.getByTestId('pipeline-page-prev')).not.toBeDisabled();
      await expectPageIndicator('10000 / 10000');
    });
  });
});

// BUG-2026-07-17-010 (SCRUM-2910, P0 follow-up from PR #1569 cross-review):
// the admin record-detail metadata panel used an ad-hoc denylist that did not
// cover fraud_* keys — fraud metadata must never render on any display surface.
describe('PipelineAdminPage — fraud metadata never renders in record detail (BUG-2026-07-17-010)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockSupabaseRpc({
      recordPage: {
        total: 1,
        data: [{
          id: 'record-fraud-meta',
          source: 'edgar',
          source_id: 'SRC-9',
          source_url: null,
          record_type: 'filing',
          title: 'Filing with legacy risk metadata',
          content_hash: 'a'.repeat(64),
          anchor_id: null,
          metadata: {
            field_of_study: 'Computer Science',
            fraud_score: 0.87,
            fraud_risk_level: 'high',
            fraud_signals: [{ signal_type: 'future_date', score: 0.35 }],
            fraudSignals: '["Font inconsistency detected"]',
          },
          created_at: '2026-05-12T10:00:00Z',
          updated_at: '2026-05-12T10:00:00Z',
          anchor_status: null,
          chain_tx_id: null,
        }],
      },
    });
    const { useAuth } = await import('@/hooks/useAuth');
    vi.mocked(useAuth).mockReturnValue(mockAuthState('carson@arkova.ai', 'user-1'));
  });

  it('filters fraud_* keys from the selected-record metadata panel', async () => {
    render(
      <MemoryRouter>
        <PipelineAdminPage />
      </MemoryRouter>,
    );

    // Open the record detail panel.
    fireEvent.click(await screen.findByText('Filing with legacy risk metadata'));
    await waitFor(() => {
      expect(document.getElementById('pipeline-record-detail')).not.toBeNull();
    });

    // Legitimate metadata renders; fraud-derived keys/values never do.
    expect(screen.getByText(/field of study/i)).toBeInTheDocument();
    expect(screen.getByText('Computer Science')).toBeInTheDocument();
    expect(screen.queryByText(/fraud/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/0\.87/)).not.toBeInTheDocument();
    expect(document.body.textContent?.toLowerCase()).not.toContain('fraud');
  });
});
