/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping (same as useAnchor.test.ts) */
/**
 * RecordDetailPage Tests — BUG-2026-08-13-017
 *
 * The defect: /records/:id transiently painted the "Record Not Found" state
 * while auth/data were still resolving (measured live: heading present at
 * 783ms, gone at 806ms, real content at 942ms — for a record the user OWNS).
 * Consequences: (a) user-facing flicker that reads as data loss; (b) it made
 * e2e/cross-tenant.spec.ts's `evaluateRecordBlocked()` satisfiable by a
 * loading state, re-opening the hollow-pass class PR #2213 closed.
 *
 * These tests keep the REAL useAuth + useAnchor wiring (the interplay IS the
 * bug) and mock only the supabase module underneath, so the auth-resolves →
 * query-in-flight window is reproduced deterministically. A MutationObserver
 * records every DOM commit, because the flash frame is overwritten within the
 * same act() flush — a post-await queryByText can never see it, but the
 * committed insertion is still captured as a mutation record.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

// Must match e2e/helpers/cross-tenant-assertions.ts RECORD_BLOCKED_HEADING —
// the exact heading `evaluateRecordBlocked()` treats as the terminal blocked
// state for the SOC 2 UI-isolation legs.
const RECORD_BLOCKED_HEADING = 'Record Not Found';

const mockGetSession = vi.hoisted(() => vi.fn());
const mockFrom = vi.hoisted(() => vi.fn());
const mockChannel = vi.hoisted(() =>
  vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
  })),
);

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mockFrom,
    channel: mockChannel,
    removeChannel: vi.fn(),
    auth: {
      getSession: mockGetSession,
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
  },
}));
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: { role: 'INDIVIDUAL', org_id: null }, loading: false }),
}));
vi.mock('@/hooks/useHasCredentialImportEntitlement', () => ({
  useHasCredentialImportEntitlement: () => false,
}));
vi.mock('@/components/layout', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AppShell: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@/components/anchor', () => ({
  AssetDetailView: () => <div data-testid="asset-detail-view">Record Details</div>,
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'anchor-1' }),
  useNavigate: () => vi.fn(),
}));

const ownedAnchor = {
  id: 'anchor-1',
  public_id: 'pub_anchor_1',
  filename: 'my-owned-record.pdf',
  fingerprint: 'f'.repeat(64),
  status: 'SECURED',
  created_at: '2026-08-01T00:00:00Z',
  chain_timestamp: null,
  issued_at: null,
  revoked_at: null,
  revocation_reason: null,
  expires_at: null,
  file_size: 1234,
  file_mime: 'application/pdf',
  credential_type: null,
  chain_tx_id: null,
  chain_block_height: null,
  metadata: null,
  cpe_metadata: null,
  description: null,
  org_id: null,
  user_id: 'user-1',
  version_number: 1,
  parent_anchor_id: null,
  deleted_at: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function mockAnchorQuery(result: Promise<unknown>) {
  mockFrom.mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        is: vi.fn().mockReturnValue({
          single: vi.fn().mockReturnValue(result),
        }),
      }),
    }),
  });
}

describe('RecordDetailPage — not-found renders only after the fetch settles (BUG-2026-08-13-017)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never commits the not-found state to the DOM while auth and the record query are resolving, for an owned record', async () => {
    // Auth resolves AFTER mount; the record query resolves later still —
    // reproducing the measured 783ms→942ms window.
    const session = deferred<{ data: { session: unknown }; error: null }>();
    mockGetSession.mockReturnValue(session.promise);
    const query = deferred<{ data: unknown; error: null }>();
    mockAnchorQuery(query.promise);

    const { RecordDetailPage } = await import('./RecordDetailPage');
    const { container } = render(<RecordDetailPage />);

    // Record every DOM commit from here on. The flash frame is inserted and
    // replaced inside a single act() flush, so only the mutation records can
    // prove whether it was ever committed.
    const committedText: string[] = [];
    const collect = (records: MutationRecord[]) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          committedText.push(node.textContent ?? '');
        }
      }
    };
    const observer = new MutationObserver(collect);
    observer.observe(container, { childList: true, subtree: true });

    // Auth settles — the record query is still in flight. This is the exact
    // window in which the live page painted "Record Not Found".
    await act(async () => {
      session.resolve({
        data: { session: { user: { id: 'user-1', email: 'owner@test.dev' } } },
        error: null,
      });
    });
    expect(screen.queryByText(RECORD_BLOCKED_HEADING)).not.toBeInTheDocument();

    // Query settles — the owned record renders.
    await act(async () => {
      query.resolve({ data: ownedAnchor, error: null });
    });
    expect(await screen.findByTestId('asset-detail-view')).toBeInTheDocument();

    collect(observer.takeRecords());
    observer.disconnect();

    // THE assertion: at no committed frame did the blocked heading enter the
    // DOM. A transient commit here is what let `evaluateRecordBlocked()` be
    // satisfied by a loading state.
    expect(committedText.join('\n')).not.toContain(RECORD_BLOCKED_HEADING);
  });

  it('still renders the not-found state once the query has genuinely settled absent (terminal contract for evaluateRecordBlocked)', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: 'user-1', email: 'owner@test.dev' } } },
      error: null,
    });
    mockAnchorQuery(
      Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'Row not found' } }),
    );

    const { RecordDetailPage } = await import('./RecordDetailPage');
    render(<RecordDetailPage />);

    // Auth resolved + query completed + confirmed absent/denied → the blocked
    // state is the correct, terminal render (this is what the cross-tenant
    // spec's blocked legs rely on).
    expect(await screen.findByRole('heading', { name: RECORD_BLOCKED_HEADING })).toBeInTheDocument();
    expect(screen.queryByTestId('asset-detail-view')).not.toBeInTheDocument();
  });
});
