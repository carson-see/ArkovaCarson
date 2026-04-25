/**
 * Anchor Queue Dashboard — UX-02 (SCRUM-1028) tests.
 *
 * Covers:
 *   - empty state
 *   - grouped collision list
 *   - open dialog → pick version → POST /api/queue/resolve with correct
 *     external_file_id + selected_public_id (ARK-112 / SCRUM-1121)
 *   - error path surfaces a friendly message
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { AnchorQueuePage } from './AnchorQueuePage';

const workerFetchMock = vi.fn();
const supabaseFromMock = vi.fn();
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
    profile: { id: 'u-1', org_id: 'org-1', role: 'ORG_ADMIN' },
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

  it('groups pending anchors by external_file_id', async () => {
    workerFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            {
              public_id: 'ARK-DEMO-CRD-A1',
              external_file_id: 'file-X',
              filename: 'msa.pdf',
              fingerprint: 'f1',
              created_at: '2026-04-22T00:00:00Z',
              sibling_count: 1,
            },
            {
              public_id: 'ARK-DEMO-CRD-A2',
              external_file_id: 'file-X',
              filename: 'msa.pdf',
              fingerprint: 'f2',
              created_at: '2026-04-22T01:00:00Z',
              sibling_count: 1,
            },
            {
              public_id: 'ARK-DEMO-CRD-A3',
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

  it('resolves a collision: dialog → pick → POST /api/queue/resolve with public_id', async () => {
    workerFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                public_id: 'ARK-DEMO-CRD-A1',
                external_file_id: 'file-X',
                filename: 'msa.pdf',
                fingerprint: 'f1',
                created_at: '2026-04-22T00:00:00Z',
                sibling_count: 1,
              },
              {
                public_id: 'ARK-DEMO-CRD-A2',
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
    expect(body.selected_public_id).toBe('ARK-DEMO-CRD-A2');
    expect(body).not.toHaveProperty('selected_anchor_id');
  });

  it('surfaces server errors on resolve', async () => {
    workerFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                public_id: 'ARK-DEMO-CRD-A1',
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
  });
});
