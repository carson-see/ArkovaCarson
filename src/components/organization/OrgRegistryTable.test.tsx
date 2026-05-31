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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

// When set, `await query` REJECTS (thrown error / network failure / abort /
// client throw) instead of resolving with an `{ error }` object. This is the
// distinct failure mode SCRUM-1999's resolved-with-error branch does NOT cover.
let queryRejection: unknown = null;
function setQueryRejection(reason: unknown) {
  queryRejection = reason;
}

vi.mock('@/lib/supabase', () => {
  const builder: Record<string, unknown> = {};
  const passthrough = () => builder;
  for (const method of ['select', 'eq', 'is', 'filter', 'order', 'range', 'or', 'gte', 'lte']) {
    builder[method] = passthrough;
  }
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

// Mock useExportAnchors
vi.mock('@/hooks/useExportAnchors', () => ({
  useExportAnchors: () => ({ exportAnchors: vi.fn(), loading: false }),
}));

// Mock navigator.clipboard
const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
Object.assign(navigator, { clipboard: mockClipboard });

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderTable() {
  return render(
    <MemoryRouter>
      <OrgRegistryTable orgId="org-1" />
    </MemoryRouter>,
  );
}

describe('OrgRegistryTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setQueryResult({ data: [], count: 0, error: null });
    setQueryRejection(null);
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
