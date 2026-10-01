/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * RecordDetailPage.stale-lineage.test.tsx
 *
 * PR #3190 review finding 3: navigating from record A to record B on this
 * page (a route param change, e.g. clicking a version-history link — no
 * remount, since RecordDetailPage stays mounted across a react-router param
 * change) must never render A's version banner/links/history while showing
 * B. Uses the REAL `useAnchorVersions` hook (only `@/lib/supabase` is
 * mocked) so the actual race-condition fix in that hook is exercised
 * end-to-end, not just at the hook's own unit-test level (see
 * `src/hooks/useAnchorVersions.test.ts` for the hook-level race coverage).
 *
 * A has a REAL two-version lineage (A, A2) so this actually exercises the
 * bug: before the fix, `RecordDetailPage` would keep passing A's two-entry
 * `lineage` array to `AssetDetailView` for a window after navigating to B
 * (a record with no lineage of its own), which is exactly the "B renders A's
 * banner/links" defect. A lineage of length 1 for both records would pass
 * this test even without the fix, since `versions.length > 1 ? versions :
 * undefined` already hides a self-only chain either way.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const mockFrom = vi.hoisted(() => vi.fn());
const mockUseAnchor = vi.hoisted(() => vi.fn());
const mockUseParams = vi.hoisted(() => vi.fn());
const capturedProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('@/lib/supabase', () => ({ supabase: { from: mockFrom } }));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'owner-1', email: 'owner@test.dev' }, signOut: vi.fn() }),
}));
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: { role: 'INDIVIDUAL', org_id: null }, loading: false }),
}));
vi.mock('@/hooks/useHasCredentialImportEntitlement', () => ({
  useHasCredentialImportEntitlement: () => false,
}));
vi.mock('@/hooks/useAnchor', () => ({ useAnchor: mockUseAnchor }));
vi.mock('@/components/layout', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AppShell: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@/components/anchor', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AssetDetailView: (props: any) => {
    capturedProps.current = props;
    return null;
  },
}));
vi.mock('react-router-dom', () => ({
  useParams: () => mockUseParams(),
  useNavigate: () => vi.fn(),
}));

function baseAnchor(overrides: Record<string, unknown>) {
  return {
    id: 'anchor-A',
    user_id: 'owner-1',
    org_id: null,
    public_id: 'ARK-A',
    filename: 'a.pdf',
    fingerprint: 'a'.repeat(64),
    status: 'SUPERSEDED',
    created_at: '2026-01-01T00:00:00Z',
    chain_timestamp: null,
    issued_at: null,
    revoked_at: null,
    revocation_reason: null,
    expires_at: null,
    file_size: 1024,
    file_mime: 'application/pdf',
    credential_type: null,
    chain_tx_id: null,
    chain_block_height: null,
    metadata: null,
    version_number: 1,
    parent_anchor_id: null,
    ...overrides,
  };
}

const rowA = {
  id: 'anchor-A',
  public_id: 'ARK-A',
  version_number: 1,
  status: 'SUPERSEDED',
  created_at: '2026-01-01T00:00:00Z',
  filename: 'a.pdf',
  fingerprint: 'a'.repeat(64),
};
const rowA2 = {
  id: 'anchor-A2',
  public_id: 'ARK-A2',
  version_number: 2,
  status: 'SECURED',
  created_at: '2026-01-15T00:00:00Z',
  filename: 'a-v2.pdf',
  fingerprint: 'd'.repeat(64),
};
const rowB = {
  id: 'anchor-B',
  public_id: 'ARK-B',
  version_number: 1,
  status: 'SECURED',
  created_at: '2026-02-01T00:00:00Z',
  filename: 'b.pdf',
  fingerprint: 'b'.repeat(64),
};

/**
 * A `.from('anchors').select().eq().is()` chain whose root-row `.single()`
 * result for a given id is resolved by calling `resolvers[id]` — the test
 * controls exactly when each id's fetch settles, to reproduce out-of-order
 * resolution. Children (`.order().limit()`) resolve immediately per
 * `childrenByParent`, since the resolution-ORDER of the root-row lookups is
 * the race this test targets, not the descendant walk.
 */
function controllableChain(
  resolvers: Record<string, (value: unknown) => void>,
  childrenByParent: Record<string, unknown[]>,
) {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn((col: string, val: string) => ({
        is: vi.fn().mockReturnValue({
          single: vi.fn(
            () => new Promise((resolve) => {
              resolvers[val] = resolve;
            }),
          ),
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: col === 'parent_anchor_id' ? (childrenByParent[val] ?? []) : [],
              error: null,
            }),
          }),
        }),
      })),
    }),
  };
}

async function loadPage() {
  const { RecordDetailPage } = await import('./RecordDetailPage');
  return RecordDetailPage;
}

describe('RecordDetailPage — stale lineage across a route change without remount (PR #3190 finding 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never renders record A\'s (real, 2-entry) version banner/links while displaying record B, even if A\'s request resolves late', async () => {
    const resolvers: Record<string, (value: unknown) => void> = {};
    mockFrom.mockImplementation(() => controllableChain(resolvers, {
      'anchor-A': [rowA2],
      'anchor-A2': [],
      'anchor-B': [],
    }));

    mockUseParams.mockReturnValue({ id: 'anchor-A' });
    mockUseAnchor.mockReturnValue({
      anchor: baseAnchor({ id: 'anchor-A', public_id: 'ARK-A', status: 'SUPERSEDED' }),
      loading: false,
      error: null,
      refreshAnchor: vi.fn(),
    });

    const RecordDetailPage = await loadPage();
    const { rerender } = render(<RecordDetailPage />);

    // Resolve A's own root-row lookup — its child (A2) resolves synchronously
    // via childrenByParent, so A ends up with a real 2-entry lineage.
    resolvers['anchor-A']({ data: rowA, error: null });
    await waitFor(() => {
      const props = capturedProps.current?.anchor as { id: string; lineage?: unknown[] } | undefined;
      expect(props?.id).toBe('anchor-A');
      expect(props?.lineage?.length).toBe(2);
    });

    // Navigate to B WITHOUT remounting — same page instance; route param and
    // useAnchor's result change together, exactly like react-router swapping
    // :id while RecordDetailPage stays mounted (e.g. clicking a version link).
    mockUseParams.mockReturnValue({ id: 'anchor-B' });
    mockUseAnchor.mockReturnValue({
      anchor: baseAnchor({ id: 'anchor-B', public_id: 'ARK-B', status: 'SECURED', filename: 'b.pdf' }),
      loading: false,
      error: null,
      refreshAnchor: vi.fn(),
    });
    rerender(<RecordDetailPage />);

    // Immediately after the navigation — before B's own fetch has resolved —
    // B's props must not still carry A's 2-entry lineage (the synchronous
    // half of the fix; this is the exact assertion that fails pre-fix).
    const midFlightProps = capturedProps.current?.anchor as { id: string; lineage?: unknown[] } | undefined;
    expect(midFlightProps?.id).toBe('anchor-B');
    expect(midFlightProps?.lineage).toBeUndefined();

    // A's request resolves LATE (out of order) — must not retroactively
    // overwrite what is now B's page with A's lineage.
    resolvers['anchor-A']?.({ data: rowA, error: null });
    resolvers['anchor-B']({ data: rowB, error: null });
    await waitFor(() => {
      const props = capturedProps.current?.anchor as { id: string } | undefined;
      expect(props?.id).toBe('anchor-B');
    });

    const finalProps = capturedProps.current?.anchor as { id: string; lineage?: unknown[] } | undefined;
    expect(finalProps?.id).toBe('anchor-B');
    // B has no lineage of its own (single record, no children) — must never
    // show A's.
    expect(finalProps?.lineage).toBeUndefined();
  });
});
