/**
 * Anchor Queue Dashboard — UX-02 (SCRUM-1028) tests.
 *
 * Covers:
 *   - empty state
 *   - grouped collision list
 *   - open dialog → pick version → POST /api/queue/resolve with correct
 *     external_file_id + selected_public_id
 *   - error path surfaces a friendly message
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, useNavigate } from 'react-router-dom';
import { AnchorQueuePage } from './AnchorQueuePage';

const workerFetchMock = vi.fn();
const supabaseFromMock = vi.fn();
const profileState = vi.hoisted(() => ({ orgId: 'org-1' as string | null }));
vi.mock('@/lib/workerClient', () => ({
  workerFetch: (...args: unknown[]) => workerFetchMock(...args),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => supabaseFromMock(...args),
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u-1' }, signOut: vi.fn() }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: { id: 'u-1', org_id: profileState.orgId, role: 'ORG_ADMIN' },
    loading: false,
  }),
}));

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function renderPage() {
  return render(
    <BrowserRouter>
      <AnchorQueuePage />
    </BrowserRouter>,
  );
}

function QueueWithRouteSwitch({ destination }: { destination: string }) {
  const navigate = useNavigate();
  return <><button onClick={() => navigate(destination)}>switch org</button><AnchorQueuePage /></>;
}

function mockOrgRole(role: string | null = 'admin') {
  const chain: {
    eq: ReturnType<typeof vi.fn>;
    maybeSingle: ReturnType<typeof vi.fn>;
  } = {
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: role ? { role } : null,
      error: null,
    }),
  };
  chain.eq.mockReturnValue(chain);
  return { select: vi.fn().mockReturnValue(chain), chain };
}

describe('AnchorQueuePage', () => {
  let orgRoleMock: ReturnType<typeof mockOrgRole>;

  beforeEach(() => {
    profileState.orgId = 'org-1';
    window.history.pushState({}, '', '/organization/queue');
    workerFetchMock.mockReset();
    supabaseFromMock.mockReset();
    orgRoleMock = mockOrgRole('admin');
    supabaseFromMock.mockReturnValue(orgRoleMock);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows empty state when queue is clear', async () => {
    workerFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/You're all caught up/)).toBeInTheDocument();
    });
    expect(supabaseFromMock).toHaveBeenCalledWith('org_members');
    expect(orgRoleMock.chain.eq).toHaveBeenCalledWith('user_id', 'u-1');
    expect(orgRoleMock.chain.eq).toHaveBeenCalledWith('org_id', 'org-1');
  });

  it('allows an explicit exact organization when the profile has no primary organization', async () => {
    profileState.orgId = null;
    const selectedOrg = '22222222-2222-4222-8222-222222222222';
    window.history.pushState({}, '', `/organization/queue?org_id=${selectedOrg}`);
    workerFetchMock.mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));

    renderPage();

    await waitFor(() => expect(workerFetchMock).toHaveBeenCalledWith(
      `/api/queue/pending?limit=100&org_id=${selectedOrg}`,
      { method: 'GET' },
    ));
    expect(screen.queryByText('Organization required')).not.toBeInTheDocument();
  });

  it('keeps the organization-required gate when no primary or explicit organization exists', async () => {
    profileState.orgId = null;
    renderPage();
    expect(await screen.findByText('Queue needs an organization')).toBeInTheDocument();
    expect(workerFetchMock).not.toHaveBeenCalled();
  });

  it('groups pending anchors by external_file_id', async () => {
    workerFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            {
              public_id: 'pid_a1',
              external_file_id: 'file-X',
              filename: 'msa.pdf',
              fingerprint: 'f1',
              created_at: '2026-04-22T00:00:00Z',
              sibling_count: 1,
            },
            {
              public_id: 'pid_a2',
              external_file_id: 'file-X',
              filename: 'msa.pdf',
              fingerprint: 'f2',
              created_at: '2026-04-22T01:00:00Z',
              sibling_count: 1,
            },
            {
              public_id: 'pid_a3',
              external_file_id: 'file-Y',
              filename: 'sla.pdf',
              fingerprint: 'f3',
              created_at: '2026-04-22T02:00:00Z',
              sibling_count: 0,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('queue-group-file-X')).toBeInTheDocument();
      expect(screen.getByTestId('queue-group-file-Y')).toBeInTheDocument();
    });
    expect(screen.getByText(/2 versions/)).toBeInTheDocument();
  });

  it('resolves a collision: dialog → pick → POST /api/queue/resolve', async () => {
    const selectedOrg = '22222222-2222-4222-8222-222222222222';
    window.history.pushState({}, '', `/organization/queue?org_id=${selectedOrg}`);
    workerFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                public_id: 'pid_a1',
                external_file_id: 'file-X',
                filename: 'msa.pdf',
                fingerprint: 'f1',
                created_at: '2026-04-22T00:00:00Z',
                sibling_count: 1,
              },
              {
                public_id: 'pid_a2',
                external_file_id: 'file-X',
                filename: 'msa.pdf',
                fingerprint: 'f2',
                created_at: '2026-04-22T01:00:00Z',
                sibling_count: 1,
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ resolution_id: 'r-1' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      );

    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('queue-review-file-X')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('queue-review-file-X'));
    await waitFor(() => {
      expect(screen.getByText(/Pick the version to keep/)).toBeInTheDocument();
    });

    // Pick the second (non-default) version
    const radios = screen.getAllByRole('radio');
    fireEvent.click(radios[1]);
    fireEvent.click(screen.getByTestId('queue-resolve-submit'));

    await waitFor(() => {
      expect(workerFetchMock).toHaveBeenCalledTimes(3);
    });
    const resolveCall = workerFetchMock.mock.calls[1] as [string, RequestInit];
    expect(resolveCall[0]).toBe('/api/queue/resolve');
    const body = JSON.parse(resolveCall[1].body as string);
    expect(body.external_file_id).toBe('file-X');
    expect(body.selected_public_id).toBe('pid_a2');
    expect(body.org_id).toBe(selectedOrg);
  });

  it('surfaces server errors on resolve', async () => {
    workerFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                public_id: 'pid_a1',
                external_file_id: 'file-X',
                filename: 'msa.pdf',
                fingerprint: 'f1',
                created_at: '2026-04-22T00:00:00Z',
                sibling_count: 0,
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'Anchor not found' } }),
          { status: 404 },
        ),
      );

    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('queue-review-file-X')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('queue-review-file-X'));
    fireEvent.click(screen.getByTestId('queue-resolve-submit'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Anchor not found');
    });
  });

  it('lets org admins run their anchoring queue and refreshes pending items', async () => {
    workerFetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            processed: 12,
            batchId: 'batch_1_12',
            merkleRoot: 'a'.repeat(64),
            txId: 'tx-1',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      );

    renderPage();
    const runButton = await screen.findByTestId('queue-run');
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(workerFetchMock).toHaveBeenCalledTimes(3);
    });
    expect(workerFetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/queue/run',
      { method: 'POST' },
      120_000,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Run complete. 12 anchors submitted in batch_1_12.',
    );
    expect(runButton).toBeEnabled();
  });

  it('keeps a valid run completion when a list poll finishes during the mutation', async () => {
    let finishRun!: (response: Response) => void;
    const runResponse = new Promise<Response>((resolve) => { finishRun = resolve; });
    workerFetchMock.mockImplementation((path: string) => {
      if (path === '/api/queue/run') return runResponse;
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    });

    renderPage();
    const runButton = await screen.findByTestId('queue-run');
    fireEvent.click(runButton);
    expect(runButton).toBeDisabled();

    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(workerFetchMock.mock.calls.filter(([path]) =>
      String(path).startsWith('/api/queue/pending')).length).toBeGreaterThanOrEqual(2));

    finishRun(new Response(JSON.stringify({ ok: true, processed: 1 }), { status: 200 }));
    await waitFor(() => expect(runButton).toBeEnabled());
    expect(screen.getByRole('alert')).toHaveTextContent('Run complete. 1 anchor submitted.');
  });

  it('carries an explicitly selected organization through list, role, and run requests', async () => {
    const selectedOrg = '22222222-2222-4222-8222-222222222222';
    window.history.pushState({}, '', `/organization/queue?org_id=${selectedOrg}`);
    workerFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, processed: 0 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));

    renderPage();
    fireEvent.click(await screen.findByTestId('queue-run'));

    await waitFor(() => expect(workerFetchMock).toHaveBeenCalledTimes(3));
    expect(workerFetchMock).toHaveBeenNthCalledWith(
      1, `/api/queue/pending?limit=100&org_id=${encodeURIComponent(selectedOrg)}`, { method: 'GET' },
    );
    expect(orgRoleMock.chain.eq).toHaveBeenCalledWith('org_id', selectedOrg);
    expect(workerFetchMock).toHaveBeenNthCalledWith(
      2, '/api/queue/run',
      { method: 'POST', body: JSON.stringify({ org_id: selectedOrg }) },
      120_000,
    );
  });

  it('ignores a delayed response from the previously selected organization', async () => {
    const orgA = '11111111-1111-4111-8111-111111111111';
    const orgB = '22222222-2222-4222-8222-222222222222';
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    workerFetchMock
      .mockReturnValueOnce(oldResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{
        public_id: 'new-item', external_file_id: 'new-file', filename: 'new.pdf',
        fingerprint: 'new', created_at: '2026-09-19T00:00:00Z', sibling_count: 0,
      }] }), { status: 200 }));

    render(
      <MemoryRouter initialEntries={[`/organization/queue?org_id=${orgA}`]}>
        <QueueWithRouteSwitch destination={`/organization/queue?org_id=${orgB}`} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(workerFetchMock).toHaveBeenCalledTimes(1));
    act(() => fireEvent.click(screen.getByRole('button', { name: 'switch org' })));
    await waitFor(() => expect(workerFetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('queue-group-new-file')).toBeInTheDocument();

    resolveOld(new Response(JSON.stringify({ items: [{
      public_id: 'old-item', external_file_id: 'old-file', filename: 'old.pdf',
      fingerprint: 'old', created_at: '2026-09-18T00:00:00Z', sibling_count: 0,
    }] }), { status: 200 }));
    await Promise.resolve();
    expect(screen.queryByTestId('queue-group-old-file')).not.toBeInTheDocument();
    expect(screen.getByTestId('queue-group-new-file')).toBeInTheDocument();
  });
});
