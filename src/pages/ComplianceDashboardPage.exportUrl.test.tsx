/**
 * ComplianceDashboardPage — export-URL origin-pinning regression test.
 *
 * Scoped narrowly to `handleExport`'s fetch call (SSRF/reuse review finding):
 * it must go through `resolveWorkerBaseUrl` + `resolveSafeWorkerEndpoint`,
 * the same two-step contract every other worker-calling component in this
 * PR uses, not a hand-built `${workerUrl}/path` template string.
 *
 * This file deliberately does NOT attempt full behavioral coverage of
 * ComplianceDashboardPage (compliance scoring, CPE aggregation, activity
 * feed, etc.) — those are unrelated to this fix. Every child component and
 * data hook not needed to reach a clickable Export button is mocked out to
 * keep this test isolated to the one behavior it verifies.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ComplianceDashboardPage } from './ComplianceDashboardPage';
import { COMPLIANCE_LABELS } from '@/lib/copy';

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

vi.mock('@/hooks/useComplianceScore', () => ({
  useComplianceScore: () => ({ scoreData: null, gapData: null, loading: false, error: null, refetch: vi.fn() }),
  useJurisdictionRules: () => ({ jurisdictions: [], industries: [], loading: false }),
}));

// Child components unrelated to the export-URL behavior under test.
vi.mock('@/components/compliance/ComplianceScoreGauge', () => ({ ComplianceScoreGauge: () => null }));
vi.mock('@/components/compliance/GradeBadge', () => ({ GradeBadge: () => null }));
vi.mock('@/components/compliance/MissingDocumentsCard', () => ({ MissingDocumentsCard: () => null }));
vi.mock('@/components/compliance/ExpiringDocumentsCard', () => ({ ExpiringDocumentsCard: () => null }));
vi.mock('@/components/compliance/RecommendationsCard', () => ({ RecommendationsCard: () => null }));
vi.mock('@/components/compliance/ProfessionalEducationExportPanel', () => ({ ProfessionalEducationExportPanel: () => null }));
vi.mock('@/components/compliance/OrgCpeMemberDashboard', () => ({ OrgCpeMemberDashboard: () => null }));
// (No Nessie stub: the panel was removed from this page and the component
// deleted. Guards: ComplianceDashboardPage.test.tsx + nessie-surfaces-offline.test.ts.)
vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const mockGetSession = vi.hoisted(() => vi.fn());

/** Spy on every `.eq(col, val)` call across every mocked query — lets the
 *  test assert RLS-style org scoping instead of just stubbing it away
 *  (arkova/no-unscoped-service-test: `expect(mockEq).toHaveBeenCalledWith(...)`
 *  below is the pattern that rule looks for). */
const mockEq = vi.hoisted(() => vi.fn());

/** A minimal Supabase query-builder stand-in: every chain method returns
 *  itself, and the object is "thenable" so `await chain` resolves it. */
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

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function renderPage() {
  return render(
    <MemoryRouter>
      <ComplianceDashboardPage />
    </MemoryRouter>,
  );
}

describe('ComplianceDashboardPage export URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it("pins the export request to the configured worker origin via resolveSafeWorkerEndpoint, not a hand-built template string", async () => {
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
    // One non-empty row ONLY for the coverage query (`credential_type,
    // compliance_controls` select) — that's what un-disables the Export
    // buttons (`coverageData.securedCount > 0`). Every other `anchors`/
    // `attestations`/`review_queue_items` query resolves empty, which every
    // downstream `.map()` in fetchData/fetchCpeRecords handles safely.
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'anchors') return makeChainable({ data: [], error: null, count: 0 });
      const chainable = makeChainable({ data: [], error: null, count: 0 });
      const originalSelect = chainable.select;
      chainable.select = (cols: string) => {
        if (typeof cols === 'string' && cols.includes('compliance_controls')) {
          return makeChainable({
            data: [{ credential_type: 'DIPLOMA', compliance_controls: null }],
            error: null,
            count: 1,
          });
        }
        return originalSelect();
      };
      return chainable;
    });

    const customWorkerOrigin = 'https://custom-worker.example.test';
    vi.stubEnv('VITE_WORKER_URL', customWorkerOrigin);

    // jsdom doesn't implement these — stub for the blob-download side effect.
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    URL.revokeObjectURL = vi.fn();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      blob: () => Promise.resolve(new Blob(['csv,data'])),
    });

    renderPage();

    const csvButton = await waitFor(() => {
      const btn = screen.getByRole('button', { name: COMPLIANCE_LABELS.EXPORT_CSV });
      expect(btn).not.toBeDisabled();
      return btn;
    });

    // The coverage query (the one gating the Export buttons) is org-scoped in
    // production (`.eq('org_id', orgId)`) — assert the mock actually saw that
    // scoping, not just that it returned data. A production regression that
    // dropped the org filter (an RLS-adjacent data leak) would leave the mock
    // still "working" but this assertion would fail.
    expect(mockEq).toHaveBeenCalledWith('org_id', 'org-1');

    fireEvent.click(csvButton);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    // The whole point of resolveSafeWorkerEndpoint: the request's origin is
    // EXACTLY the configured worker base, not something a naive
    // `${workerUrl}/path` template string could silently drift away from.
    expect(new URL(calledUrl).origin).toBe(customWorkerOrigin);
    expect(new URL(calledUrl).pathname).toBe('/api/v1/audit-export/batch');

    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });
});
