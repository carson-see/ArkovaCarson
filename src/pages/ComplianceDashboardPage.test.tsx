/**
 * SCRUM-1862 ComplianceDashboardPage — org CPE dashboard panel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ComplianceDashboardPage } from './ComplianceDashboardPage';

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/search/NessieIntelligencePanel', () => ({
  NessieIntelligencePanel: () => null,
}));

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
  cpe_metadata: {
    providerName?: string;
    fieldOfStudy?: string;
    creditHours?: number;
    completionDate?: string;
    status?: string;
    participantName?: string;
    licenseNumber?: string;
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
        providerName: 'AICPA',
        fieldOfStudy: 'Accounting',
        creditHours: 4,
        completionDate: '2026-01-15',
        status: 'eligible',
        participantName: 'Pat Private',
        licenseNumber: 'CPA-12345',
      },
    },
    {
      id: 'anchor-cpe-2',
      public_id: 'pub-cpe-2',
      status: 'PENDING',
      issued_at: '2026-02-10T12:00:00Z',
      cpe_metadata: {
        providerName: 'NASBA Registry',
        fieldOfStudy: 'Ethics',
        creditHours: 2.5,
        completionDate: '2026-02-10',
        status: 'needs_review',
      },
    },
    {
      id: 'anchor-cpe-3',
      public_id: 'pub-cpe-3',
      status: 'SECURED',
      issued_at: '2025-11-01T12:00:00Z',
      cpe_metadata: {
        providerName: 'AICPA',
        fieldOfStudy: 'Taxes',
        creditHours: 8,
        completionDate: '2025-11-01',
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
    supabaseFromMock.mockClear();
    mockEq.mockClear();
    supabaseEqCalls.length = 0;
    cpeQueryState.failCpeRecords = false;
    cpeRows.current = initialCpeRows.map((row) => ({
      ...row,
      cpe_metadata: { ...row.cpe_metadata },
    }));
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
