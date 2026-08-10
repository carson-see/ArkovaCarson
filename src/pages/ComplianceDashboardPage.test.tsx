/**
 * SCRUM-1862 ComplianceDashboardPage — org CPE dashboard panel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ComplianceDashboardPage } from './ComplianceDashboardPage';

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// NOTE: the Nessie intelligence panel is deliberately NOT stubbed here. It used
// to be, which is precisely how it stayed mounted unnoticed — the stub made the
// page suite green whether or not the page rendered it. See the
// "Nessie stays OFF" describe block at the bottom of this file.

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'admin-1', email: 'admin@example.test' }, signOut: vi.fn() }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: { org_id: 'org-1', role: 'ORG_ADMIN', email: 'admin@example.test' },
    loading: false,
  }),
}));

vi.mock('@/lib/platform', () => ({
  isPlatformAdmin: () => false,
}));

// CPE-02 (SCRUM-2380): the per-member dashboard card is React-Query backed and
// has its own unit tests (OrgCpeMemberDashboard.test.tsx +
// useOrgCpeMemberSummary.test.ts); stub the hook here so this page suite does
// not need a QueryClientProvider.
vi.mock('@/hooks/useOrgCpeMemberSummary', () => ({
  useOrgCpeMemberSummary: () => ({ summary: null, loading: false, error: null, refresh: vi.fn() }),
}));

vi.mock('@/hooks/useComplianceScore', () => ({
  useJurisdictionRules: () => ({ jurisdictions: ['US-CA'], industries: ['accounting'] }),
  useComplianceScore: () => ({
    scoreData: {
      score: 90,
      grade: 'A',
      total_present: 9,
      total_required: 10,
      missing_documents: [],
      expiring_documents: [],
    },
    gapData: { missing_required: [], missing_recommended: [], summary: 'No major gaps.' },
    loading: false,
  }),
}));

type CpeTestRow = {
  id: string;
  public_id: string;
  status: string;
  issued_at: string;
  // Canonical snake_case keys — the shape the worker actually writes into
  // cpe_metadata (see services/worker/src/exports/cpe-log-export.ts and
  // src/components/credentials/cpeMetadataView.ts). participant_name /
  // license_number are member PII and must never reach the rendered aggregates.
  cpe_metadata: {
    provider?: string;
    field_of_study?: string;
    credit_hours?: number;
    completion_date?: string;
    status?: string;
    participant_name?: string;
    license_number?: string;
  };
};

const cpeRows = vi.hoisted((): { current: CpeTestRow[] } => ({
  current: [
    {
      id: 'anchor-cpe-1',
      public_id: 'pub-cpe-1',
      status: 'SECURED',
      issued_at: '2026-01-15T12:00:00Z',
      cpe_metadata: {
        provider: 'AICPA',
        field_of_study: 'Accounting',
        credit_hours: 4,
        completion_date: '2026-01-15',
        status: 'eligible',
        participant_name: 'Pat Private',
        license_number: 'CPA-12345',
      },
    },
    {
      id: 'anchor-cpe-2',
      public_id: 'pub-cpe-2',
      status: 'PENDING',
      issued_at: '2026-02-10T12:00:00Z',
      cpe_metadata: {
        provider: 'NASBA Registry',
        field_of_study: 'Ethics',
        credit_hours: 2.5,
        completion_date: '2026-02-10',
        status: 'needs_review',
      },
    },
    {
      id: 'anchor-cpe-3',
      public_id: 'pub-cpe-3',
      status: 'SECURED',
      issued_at: '2025-11-01T12:00:00Z',
      cpe_metadata: {
        provider: 'AICPA',
        field_of_study: 'Taxes',
        credit_hours: 8,
        completion_date: '2025-11-01',
        status: 'eligible',
      },
    },
  ],
}));
const cpeQueryState = vi.hoisted(() => ({ failCpeRecords: false }));
const initialCpeRows = cpeRows.current.map((row) => ({
  ...row,
  cpe_metadata: { ...row.cpe_metadata },
}));

function makeQueryResult(table: string, selectClause: string | undefined) {
  if (table === 'anchors' && selectClause?.includes('cpe_metadata')) {
    if (cpeQueryState.failCpeRecords) {
      return { data: null, error: { message: 'Network error' } };
    }
    return { data: cpeRows.current, error: null };
  }

  if (table === 'anchors') {
    return {
      data: [{ credential_type: 'CPE', compliance_controls: ['SOC2-CC6.1'] }],
      error: null,
    };
  }

  if (table === 'review_queue_items') {
    return { data: null, count: 0, error: null };
  }

  return { data: [], count: 0, error: null };
}

function createSupabaseBuilder(table: string) {
  let selectClause: string | undefined;
  const resolveResult = () => Promise.resolve(makeQueryResult(table, selectClause));
  const builder = {
    select: vi.fn((clause?: string) => {
      selectClause = clause;
      if (clause !== undefined) supabaseSelectCalls.push(clause);
      return builder;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      mockEq(column, value);
      supabaseEqCalls.push([column, value]);
      return builder;
    }),
    not: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    lte: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(resolveResult),
  };
  return builder;
}

const mockEq = vi.hoisted(() => vi.fn());
const supabaseEqCalls = vi.hoisted(() => [] as Array<[string, unknown]>);
const supabaseSelectCalls = vi.hoisted(() => [] as string[]);
const supabaseFromMock = vi.hoisted(() => vi.fn((table: string) => createSupabaseBuilder(table)));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: supabaseFromMock,
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: 'token' } } })),
    },
  },
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <ComplianceDashboardPage />
    </MemoryRouter>,
  );
}

describe('SCRUM-1862 org CPE dashboard', () => {
  beforeEach(() => {
    // Pin "now" so the default `year-to-date` reporting window is deterministic.
    // The fixtures are dated Jan/Feb 2026 (in-window) + Nov 2025 (out-of-window);
    // without a fixed clock these assertions rot once the real date leaves 2026.
    // `shouldAdvanceTime` keeps RTL's findBy/waitFor polling working under fake
    // timers.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-06-21T00:00:00Z'));

    supabaseFromMock.mockClear();
    mockEq.mockClear();
    supabaseEqCalls.length = 0;
    supabaseSelectCalls.length = 0;
    cpeQueryState.failCpeRecords = false;
    cpeRows.current = initialCpeRows.map((row) => ({
      ...row,
      cpe_metadata: { ...row.cpe_metadata },
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('summarizes org CPE records for a reporting period without exposing member PII', async () => {
    renderPage();

    const panel = await screen.findByTestId('org-cpe-dashboard');

    expect(within(panel).getByRole('heading', { name: /CPE Dashboard/i })).toBeInTheDocument();
    expect(within(panel).getByLabelText(/Reporting period/i)).toHaveValue('year-to-date');
    expect(within(panel).getAllByText('2').length).toBeGreaterThanOrEqual(1);
    expect(within(panel).getByText('6.5')).toBeInTheDocument();
    expect(within(panel).getByText('Secured')).toBeInTheDocument();
    expect(within(panel).getByText('Needs Review')).toBeInTheDocument();
    expect(within(panel).getByText('Accounting')).toBeInTheDocument();
    expect(within(panel).getByText('Ethics')).toBeInTheDocument();
    expect(within(panel).getByText('AICPA')).toBeInTheDocument();
    expect(within(panel).getByText('NASBA Registry')).toBeInTheDocument();

    await waitFor(() => {
      expect(supabaseFromMock).toHaveBeenCalledWith('anchors');
    });
    expect(mockEq).toHaveBeenCalledWith('org_id', 'org-1');
    expect(supabaseEqCalls).toContainEqual(['org_id', 'org-1']);
    expect(supabaseEqCalls).toContainEqual(['credential_type', 'CPE']);

    expect(panel).not.toHaveTextContent('Pat Private');
    expect(panel).not.toHaveTextContent('CPA-12345');

    // PII boundary (§1.6): the org CPE query must PROJECT only the aggregate
    // jsonb keys — it must NOT pull the whole `cpe_metadata` blob (which carries
    // member PII like participantName / licenseNumber).
    const cpeSelect = supabaseSelectCalls.find(
      (clause) => clause.includes('cpe_metadata') && clause.includes('field_of_study'),
    );
    expect(cpeSelect).toBeDefined();
    // No bare full-column request for cpe_metadata.
    expect(cpeSelect).not.toMatch(/(^|,)\s*cpe_metadata\s*(,|$)/);
    // Only the allowlisted aggregate keys are projected.
    expect(cpeSelect).toContain('cpe_metadata->>field_of_study');
    expect(cpeSelect).toContain('cpe_metadata->>credit_hours');
    expect(cpeSelect).toContain('cpe_metadata->>provider');
    expect(cpeSelect).not.toContain('participant');
    expect(cpeSelect).not.toContain('license');
  });

  it('shows an error state without exposing member PII when CPE records fail to load', async () => {
    cpeQueryState.failCpeRecords = true;

    renderPage();

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent('Unable to load CPE records.');
    expect(screen.queryByText('Pat Private')).not.toBeInTheDocument();
    expect(screen.queryByText('CPA-12345')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(supabaseFromMock).toHaveBeenCalledWith('anchors');
    });
    expect(mockEq).toHaveBeenCalledWith('org_id', 'org-1');
  });

  it('shows an empty state without exposing member PII when no records match', async () => {
    cpeRows.current = [];

    renderPage();

    expect(await screen.findByText('No CPE records in this period')).toBeInTheDocument();
    expect(screen.getByText('CPE summaries appear after secured CPE records are available for the selected period.')).toBeInTheDocument();
    expect(screen.queryByText('Pat Private')).not.toBeInTheDocument();
    expect(screen.queryByText('CPA-12345')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(supabaseFromMock).toHaveBeenCalledWith('anchors');
    });
    expect(mockEq).toHaveBeenCalledWith('credential_type', 'CPE');
  });

  it('renders a loading state while the org CPE query is pending', () => {
    renderPage();

    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

/**
 * Nessie stays OFF (founder directive, 2026-08-01) + no confidence scores in
 * the UI (SCRUM-2914, 2026-07-22).
 *
 * `/organization/compliance` is guarded by `AuthGuard` + `RouteGuard` only —
 * NOT `PlatformAdminRoute` — so this page is reachable by URL by any
 * authenticated customer. It mounted `<NessieIntelligencePanel />` with no flag
 * gate of any kind, putting a query box and a confidence-percentage readout in
 * front of customers, backed by a service that is switched off.
 *
 * These assertions use the panel's literal former copy rather than a
 * `NESSIE_LABELS` key, on purpose: the keys are gone, and pinning the literals
 * means re-introducing the same UI under a NEW key still fails here.
 */
describe('Nessie stays OFF — the compliance dashboard renders no Nessie UI', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-06-21T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not render the document-intelligence query panel', async () => {
    renderPage();

    // The page itself must have rendered — otherwise these are vacuous.
    await screen.findByTestId('org-cpe-dashboard');

    expect(screen.queryByText('Document Intelligence')).toBeNull();
    expect(
      screen.queryByText('Ask compliance questions. Answers cite verified, anchored documents.'),
    ).toBeNull();
    expect(screen.queryByPlaceholderText('Ask a compliance question...')).toBeNull();
    expect(
      screen.queryByText('Ask a question to get answers backed by verified evidence.'),
    ).toBeNull();
  });

  it('does not render the task-type selector that fronted the Nessie query API', async () => {
    renderPage();
    await screen.findByTestId('org-cpe-dashboard');

    for (const taskLabel of [
      'Compliance Q&A',
      'Risk Analysis',
      'Document Summary',
      'Cross-Reference',
    ]) {
      expect(screen.queryByText(taskLabel)).toBeNull();
    }
  });

  it('renders no confidence readout or confidence decomposition (SCRUM-2914)', async () => {
    renderPage();
    await screen.findByTestId('org-cpe-dashboard');

    expect(screen.queryByText('confidence')).toBeNull();
    for (const detailLabel of [
      /Documents cited/,
      /Anchored citations/,
      /Corroborating sources/,
      /Source authority/,
    ]) {
      expect(screen.queryByText(detailLabel)).toBeNull();
    }
  });
});
