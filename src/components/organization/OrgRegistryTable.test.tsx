/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * Tests for OrgRegistryTable component.
 *
 * @see UAT2-13 — recipient in mobile card layout
 * @see UAT3-04 — QR/copy URL uses verifyUrl (not localhost)
 * @see SCRUM-1999 — explicit empty / loading / error / permission state matrix:
 *   previously a fetch failure was only `console.error`-d, leaving the table
 *   silently showing the "No records found" empty state and masking the error.
 */

import type React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OrgRegistryTable } from './OrgRegistryTable';

// Controllable Supabase mock: every query-builder method returns the same
// thenable builder, so regardless of which filter branches run
// (`.or()` / `.gte()` / `.lte()` etc.) the awaited query resolves to the
// result configured via `setQueryResult`.
interface QueryResult {
  data: unknown[] | null;
  count: number | null;
  error: { code?: string; message?: string } | null;
}

let queryResult: QueryResult = { data: [], count: 0, error: null };
function setQueryResult(next: QueryResult) {
  queryResult = next;
}

// A minimal anchor row that renders without crashing (needs a known status so
// `statusConfig[status]` resolves). Used by the Export-delegation tests.
const validRow = {
  id: '1',
  filename: 'test.pdf',
  fingerprint: 'abc123',
  status: 'SECURED',
  credential_type: null,
  label: null,
  public_id: 'pub-1',
  file_size: 1024,
  created_at: '2024-01-15T00:00:00Z',
  updated_at: '2024-01-15T00:00:00Z',
  chain_timestamp: null,
  chain_tx_id: null,
  chain_block_height: null,
  metadata: null,
};

// When set, `await query` REJECTS (thrown error / network failure / abort /
// client throw) instead of resolving with an `{ error }` object. This is the
// distinct failure mode SCRUM-1999's resolved-with-error branch does NOT cover.
let queryRejection: unknown = null;
function setQueryRejection(reason: unknown) {
  queryRejection = reason;
}

// SCRUM-3010: record every `.eq(column, value)` the component issues so tests
// can assert the row-scoping applied for admins vs non-admin members.
const eqCalls: Array<[string, unknown]> = [];
function resetEqCalls() {
  eqCalls.length = 0;
}

vi.mock('@/lib/supabase', () => {
  const builder: Record<string, unknown> = {};
  const passthrough = () => builder;
  for (const method of ['select', 'is', 'filter', 'order', 'range', 'or', 'gte', 'lte']) {
    builder[method] = passthrough;
  }
  // `eq` records its arguments, then behaves like every other passthrough.
  builder.eq = (column: string, value: unknown) => {
    eqCalls.push([column, value]);
    return builder;
  };
  // Make the builder awaitable — `await query` resolves to the current result,
  // or rejects when `queryRejection` is set.
  builder.then = (
    resolve: (value: QueryResult) => unknown,
    reject?: (reason: unknown) => unknown,
  ) =>
    (queryRejection !== null
      ? Promise.reject(queryRejection)
      : Promise.resolve(queryResult)
    ).then(resolve, reject);
  return {
    supabase: {
      from: () => builder,
    },
  };
});

// Mock useExportAnchors — shared spy so tests can assert the scope the table
// delegates with (SCRUM-3010: admin org-wide vs non-admin member-scoped).
const mockExportAnchors = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('@/hooks/useExportAnchors', () => ({
  useExportAnchors: () => ({ exportAnchors: mockExportAnchors, loading: false }),
}));

// Mock navigator.clipboard
const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
Object.assign(navigator, { clipboard: mockClipboard });

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderTable(
  props: Partial<React.ComponentProps<typeof OrgRegistryTable>> = {},
) {
  return render(
    <MemoryRouter>
      <OrgRegistryTable orgId="org-1" isAdmin currentUserId="user-1" {...props} />
    </MemoryRouter>,
  );
}

describe('OrgRegistryTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setQueryResult({ data: [], count: 0, error: null });
    setQueryRejection(null);
    resetEqCalls();
  });

  // SCRUM-3010 STEP 1 (frontend gate): the org-wide registry is the cross-member
  // privacy leak. An admin sees the whole org; a non-admin member must only ever
  // query their OWN rows (scoped by user_id), never by org_id.
  it('scopes the query to org_id for an admin', async () => {
    setQueryResult({ data: [], count: 0, error: null });
    renderTable({ isAdmin: true, currentUserId: 'user-1' });
    await waitFor(() => {
      expect(eqCalls).toContainEqual(['org_id', 'org-1']);
    });
    expect(eqCalls).not.toContainEqual(['user_id', 'user-1']);
  });

  it('scopes the query to user_id (never org_id) for a non-admin member', async () => {
    setQueryResult({ data: [], count: 0, error: null });
    renderTable({ isAdmin: false, currentUserId: 'user-1' });
    await waitFor(() => {
      expect(eqCalls).toContainEqual(['user_id', 'user-1']);
    });
    // The whole-org query must never be issued for a non-admin.
    expect(eqCalls).not.toContainEqual(['org_id', 'org-1']);
  });

  it('issues no org-wide query for a non-admin with no user id (fail closed)', async () => {
    setQueryResult({ data: [], count: 0, error: null });
    renderTable({ isAdmin: false, currentUserId: undefined });
    // Give any effect a chance to run, then assert nothing org-wide was queried.
    await waitFor(() => {
      expect(screen.getAllByText(/no records found/i).length).toBeGreaterThan(0);
    });
    expect(eqCalls).not.toContainEqual(['org_id', 'org-1']);
  });

  // The Export CSV path must be gated the same way as the table: a non-admin's
  // export is delegated with its own-scope, never an org-wide pull.
  it('delegates export with the member scope for a non-admin', async () => {
    setQueryResult({ data: [validRow], count: 1, error: null });
    renderTable({ isAdmin: false, currentUserId: 'user-1' });
    // Wait for ENABLED, not merely present: a disabled button still has
    // role="button" and a raw .click() on it is a silent no-op — the export
    // mock is never called and the assertion times out (CI-only flake).
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /export csv/i })[0]).toBeEnabled();
    });
    fireEvent.click(screen.getAllByRole('button', { name: /export csv/i })[0]);
    await waitFor(() => {
      expect(mockExportAnchors).toHaveBeenCalledWith('org-1', {
        isAdmin: false,
        userId: 'user-1',
      });
    });
  });

  it('delegates export org-wide for an admin', async () => {
    setQueryResult({ data: [validRow], count: 1, error: null });
    renderTable({ isAdmin: true, currentUserId: 'user-1' });
    // Same enabled-wait + fireEvent treatment as the member-scope test above.
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /export csv/i })[0]).toBeEnabled();
    });
    fireEvent.click(screen.getAllByRole('button', { name: /export csv/i })[0]);
    await waitFor(() => {
      expect(mockExportAnchors).toHaveBeenCalledWith('org-1', {
        isAdmin: true,
        userId: 'user-1',
      });
    });
  });

  it('renders without crashing', () => {
    renderTable();
    // Should show search input
    expect(screen.getByPlaceholderText(/search by filename/i)).toBeDefined();
  });

  it('shows the empty state when the fetch succeeds with no rows', async () => {
    setQueryResult({ data: [], count: 0, error: null });
    renderTable();
    await waitFor(() => {
      expect(screen.getAllByText(/no records found/i).length).toBeGreaterThan(0);
    });
    // Empty state is distinct from the error state.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // The component renders both a mobile (sm:hidden) and a desktop (hidden
  // sm:block) layout simultaneously; jsdom does not apply the responsive
  // display utilities, so state UI appears in both. Assert against the set.
  it('shows an explicit error state (not the empty state) when the fetch fails', async () => {
    setQueryResult({
      data: null,
      count: null,
      error: { code: '500', message: 'network unreachable' },
    });
    renderTable();

    // An error alert is shown (one per responsive layout)...
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].textContent ?? '').toMatch(/couldn.?t load|unable to load|something went wrong/i);

    // ...and the misleading "No records found" empty state is NOT shown.
    expect(screen.queryByText(/no records found/i)).toBeNull();

    // A retry affordance is offered.
    expect(screen.getAllByRole('button', { name: /try again|retry/i }).length).toBeGreaterThan(0);
  });

  // Regression — CodeRabbit Critical / Carson P1: the resolved-with-`{error}`
  // branch only covers errors Supabase *returns*. A THROWN/REJECTED promise
  // (network failure, abort, client throw) bypassed every error setter AND the
  // trailing `setLoading(false)`, so the table was stuck in the loading
  // skeleton forever — the exact failure this state matrix is meant to kill.
  it('shows the error state and clears the loading skeleton when the fetch REJECTS', async () => {
    setQueryRejection(new TypeError('Failed to fetch'));
    const { container } = renderTable();

    // The error alert is rendered (proves `loading` was set false — the banner
    // is gated behind `!loading`).
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].textContent ?? '').toMatch(/couldn.?t load|unable to load|something went wrong/i);

    // The loading skeleton has cleared — no skeleton placeholders remain.
    expect(container.querySelectorAll('.animate-pulse').length).toBe(0);

    // The misleading empty state must NOT be shown.
    expect(screen.queryByText(/no records found/i)).toBeNull();

    // A thrown error defaults to the retryable 'load' kind, so Retry is offered.
    expect(screen.getAllByRole('button', { name: /try again|retry/i }).length).toBeGreaterThan(0);
  });

  it('shows a permission-denied state for a 42501 / insufficient_privilege error', async () => {
    setQueryResult({
      data: null,
      count: null,
      error: { code: '42501', message: 'permission denied for table anchors' },
    });
    renderTable();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0].textContent ?? '').toMatch(/permission|access/i);
    // Permission denial is not a transient failure — no retry button.
    expect(screen.queryByText(/no records found/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /try again|retry/i })).toBeNull();
  });
});
