/* eslint-disable arkova/require-error-code-assertion -- UI-layer tests: useJurisdictionRules is mocked, so there is no HTTP status/code at this layer; the specific contract asserted is the exact rendered banner copy (hook-level codes are pinned in useComplianceScore.test.tsx) */
/**
 * ComplianceDashboardPage — jurisdiction-rules fetch-error surfacing (SCRUM-3670).
 *
 * `useJurisdictionRules()` used to swallow fetch errors (bare `catch {}`, no
 * else on `!res.ok`), so a failed public rules fetch left the jurisdiction /
 * industry pickers silently empty. The hook now exposes `error` + `refetch`;
 * this file pins the page-side consumption: a retryable `DataErrorBanner`
 * renders next to the pickers when the rules fetch fails, and the pickers
 * themselves stay mounted (the default US-CA/accounting fallback still lets
 * the score card function).
 *
 * Like ComplianceDashboardPage.exportUrl.test.tsx, this file deliberately
 * does NOT attempt full behavioral coverage of the page — everything not
 * needed to reach the selectors row is mocked out.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ComplianceDashboardPage } from './ComplianceDashboardPage';
import { DATA_ERROR_LABELS } from '@/lib/copy';

const rulesState = vi.hoisted(() => ({ error: null as string | null }));
const mockRefetchRules = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useComplianceScore', () => ({
  useComplianceScore: () => ({ scoreData: null, gapData: null, loading: false, error: null, refetch: vi.fn() }),
  useJurisdictionRules: () => ({
    rules: [],
    jurisdictions: [],
    industries: [],
    loading: false,
    error: rulesState.error,
    refetch: mockRefetchRules,
  }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ session: { access_token: 'tok' }, user: { id: 'user-1', email: 'admin@example.test' }, loading: false, signOut: vi.fn() }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: { org_id: 'org-1', role: 'ORG_ADMIN' },
    loading: false,
    destination: '/dashboard',
  }),
}));

// Child components unrelated to the rules-error behavior under test.
vi.mock('@/components/compliance/ComplianceScoreGauge', () => ({ ComplianceScoreGauge: () => null }));
vi.mock('@/components/compliance/GradeBadge', () => ({ GradeBadge: () => null }));
vi.mock('@/components/compliance/MissingDocumentsCard', () => ({ MissingDocumentsCard: () => null }));
vi.mock('@/components/compliance/ExpiringDocumentsCard', () => ({ ExpiringDocumentsCard: () => null }));
vi.mock('@/components/compliance/RecommendationsCard', () => ({ RecommendationsCard: () => null }));
vi.mock('@/components/compliance/ProfessionalEducationExportPanel', () => ({ ProfessionalEducationExportPanel: () => null }));
vi.mock('@/components/compliance/OrgCpeMemberDashboard', () => ({ OrgCpeMemberDashboard: () => null }));
vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const mockGetSession = vi.hoisted(() => vi.fn());

/** Spy on every `.eq(col, val)` call across every mocked query — lets the
 *  test assert RLS-style org scoping instead of just stubbing it away
 *  (arkova/no-unscoped-service-test pattern, same as the exportUrl suite). */
const mockEq = vi.hoisted(() => vi.fn());

/** Minimal Supabase query-builder stand-in (same shape as the exportUrl suite):
 *  every chain method returns itself and the object is thenable. */
function makeChainable(resolvedValue: { data: unknown[]; error: null; count: number }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chainable: any = {};
  const self = () => chainable;
  chainable.select = self;
  chainable.eq = (col: string, val: unknown) => {
    mockEq(col, val);
    return chainable;
  };
  chainable.not = self;
  chainable.gte = self;
  chainable.lte = self;
  chainable.order = self;
  chainable.limit = self;
  chainable.then = (resolve: (v: typeof resolvedValue) => void) => resolve(resolvedValue);
  return chainable;
}

const mockFrom = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: mockGetSession }, from: mockFrom },
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <ComplianceDashboardPage />
    </MemoryRouter>,
  );
}

describe('ComplianceDashboardPage jurisdiction-rules error surfacing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rulesState.error = null;
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    mockFrom.mockImplementation(() => makeChainable({ data: [], error: null, count: 0 }));
  });

  it('renders a retryable DataErrorBanner when the rules fetch failed, keeping the pickers mounted', async () => {
    rulesState.error = 'Failed to fetch';

    renderPage();

    const banner = await screen.findByTestId('compliance-rules-error-banner');
    expect(banner).toHaveTextContent("Couldn't load compliance options");
    // Generic copy only — the hook's raw fetch error is never rendered.
    expect(banner).not.toHaveTextContent('Failed to fetch');
    // Pickers stay mounted: the US-CA / accounting fallback options still
    // drive the score card while the failure is surfaced.
    expect(screen.getByDisplayValue('US-CA')).toBeInTheDocument();
    expect(screen.getByDisplayValue('accounting')).toBeInTheDocument();
    // The page's attestation/CPE queries stay org-scoped (`.eq('org_id', …)`)
    // while the error state renders — the banner must not short-circuit them.
    expect(mockEq).toHaveBeenCalledWith('org_id', 'org-1');
  });

  it('wires the banner Retry button to the hook refetch', async () => {
    rulesState.error = 'Failed to fetch';

    renderPage();

    const banner = await screen.findByTestId('compliance-rules-error-banner');
    const retry = within(banner).getByRole('button', { name: DATA_ERROR_LABELS.RETRY });
    fireEvent.click(retry);
    expect(mockRefetchRules).toHaveBeenCalledTimes(1);
  });

  it('renders no banner when the rules fetch succeeded', async () => {
    renderPage();

    expect(await screen.findByDisplayValue('US-CA')).toBeInTheDocument();
    expect(screen.queryByTestId('compliance-rules-error-banner')).not.toBeInTheDocument();
  });
});
