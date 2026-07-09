/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * Platform Controls Page Tests
 *
 * Focus: ENABLE_BATCH_ANCHORING must never be offered as an admin control.
 *
 * The flag is a no-op — the batch drain (processBatchAnchors) never reads it;
 * anchoring is gated by pending-anchor presence + ENABLE_PROD_NETWORK_ANCHORING.
 * A live toggle for it under "Network & Chain" is an operator footgun: flipping
 * it does nothing to the drain, but an operator could believe it halts anchoring
 * during an incident. So even if a stale switchboard_flags row exists, the page
 * must not surface a toggle for it (it belongs to no flag category).
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

// Two rows: a real network flag that DOES belong to a category (proves the
// render path works) and the dead ENABLE_BATCH_ANCHORING row (must be filtered
// out because it belongs to no category → never surfaced as a control).
const FLAG_ROWS = [
  {
    id: 'flag-prod-anchoring',
    flag_key: 'ENABLE_PROD_NETWORK_ANCHORING',
    enabled: true,
    description: 'Gate production Bitcoin anchoring',
    updated_at: '2026-05-12T10:00:00Z',
  },
  {
    id: 'flag-batch-anchoring',
    flag_key: 'ENABLE_BATCH_ANCHORING',
    enabled: true,
    description: 'Dead no-op flag — must not be an admin control',
    updated_at: '2026-05-12T10:00:00Z',
  },
];

/**
 * A PostgREST-style query builder that is thenable (resolves to `result`) and
 * also exposes `.order` / `.limit`. The flags query awaits `.select().order()`;
 * the history query awaits `.select().order().limit()`. Both terminate on this
 * same thenable, so one shape serves both.
 */
function thenableBuilder(result: { data: unknown; error: unknown }) {
  const builder = {
    select: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => Promise.resolve(result)),
    then: (onFulfilled: (r: { data: unknown; error: unknown }) => unknown) =>
      Promise.resolve(result).then(onFulfilled),
  };
  return builder;
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === 'switchboard_flags') {
        return thenableBuilder({ data: FLAG_ROWS, error: null });
      }
      // switchboard_flag_history (and anything else) → empty.
      return thenableBuilder({ data: [], error: null });
    }),
  },
}));

import { PlatformControlsPage } from './PlatformControlsPage';

describe('PlatformControlsPage — ENABLE_BATCH_ANCHORING is not an admin control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces a real categorized flag but never ENABLE_BATCH_ANCHORING', async () => {
    render(
      <MemoryRouter>
        <PlatformControlsPage />
      </MemoryRouter>,
    );

    // Sanity: a real flag that belongs to the "Network & Chain" category renders,
    // so the negative assertion below is meaningful (not a false pass from an
    // empty page).
    expect(await screen.findByText('ENABLE_PROD_NETWORK_ANCHORING')).toBeInTheDocument();

    // The footgun: even with a live switchboard_flags row present, the dead flag
    // must not be rendered as a toggle anywhere on the page.
    expect(screen.queryByText('ENABLE_BATCH_ANCHORING')).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('Toggle ENABLE_BATCH_ANCHORING'),
    ).not.toBeInTheDocument();
  });
});
