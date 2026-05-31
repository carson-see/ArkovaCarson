/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * Tests for ReportsList component.
 *
 * @see SCRUM-1999 — explicit empty / loading / error / permission state matrix.
 *   Previously a `reports` fetch failure was only `console.error`-d, so the list
 *   silently fell through to the "No reports generated yet" empty state, hiding
 *   the failure. Permission is handled separately via `hasReportsEntitlement`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ReportsList } from './ReportsList';

interface QueryResult {
  data: unknown[] | null;
  error: { code?: string; message?: string } | null;
}

let listResult: QueryResult = { data: [], error: null };
function setListResult(next: QueryResult) {
  listResult = next;
}

// Controllable Supabase mock. `.from('reports').select().order().limit()` is
// awaited directly; the builder is a thenable resolving to `listResult`.
vi.mock('@/lib/supabase', () => {
  const builder: Record<string, unknown> = {};
  const passthrough = () => builder;
  for (const method of ['select', 'order', 'limit', 'eq', 'insert', 'single']) {
    builder[method] = passthrough;
  }
  builder.then = (
    resolve: (value: QueryResult) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(listResult).then(resolve, reject);
  return {
    supabase: {
      from: () => builder,
      auth: {
        getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } } }),
      },
    },
  };
});

describe('ReportsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setListResult({ data: [], error: null });
  });

  it('shows the empty state when the fetch succeeds with no reports', async () => {
    setListResult({ data: [], error: null });
    render(<ReportsList />);
    await waitFor(() => {
      expect(screen.getByText(/no reports generated yet/i)).toBeTruthy();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an explicit error state (not the empty state) when the fetch fails', async () => {
    setListResult({ data: null, error: { code: '500', message: 'boom' } });
    render(<ReportsList />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/couldn.?t load|unable to load|something went wrong/i);

    // The misleading empty state must NOT be shown.
    expect(screen.queryByText(/no reports generated yet/i)).toBeNull();

    // A retry affordance is offered.
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeTruthy();
  });

  it('shows the permission/entitlement notice when the plan lacks reports', async () => {
    setListResult({ data: [], error: null });
    render(<ReportsList hasReportsEntitlement={false} />);
    await waitFor(() => {
      expect(screen.getByText(/requires a professional or organization plan/i)).toBeTruthy();
    });
  });
});
