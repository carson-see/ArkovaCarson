/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping (same as useAnchor.test.ts) */
/**
 * RecordDetailPage — pipeline-anchored public record template (SCRUM-5105)
 *
 * A pipeline anchor's own `anchors.metadata` carries only
 * {pipeline_source, source_id, source_url, record_type} plus merkle keys
 * (services/worker/src/jobs/publicRecordAnchor.ts's buildPipelineAnchorInsert)
 * — not enough to render a labelled credential card. This exercises the
 * full real pipeline end to end (no AssetDetailView/CredentialRenderer
 * mocking): RecordDetailPage fetches the linked public_records row,
 * projects it via publicRecordTemplate.ts, useCredentialTemplate's
 * platform-template fallback finds the PUBLICATION template (org_id IS
 * NULL), and CredentialRenderer renders the labelled fields.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import openalexFixture from '@/lib/__fixtures__/public-record-openalex.json';
import { RecordDetailPage } from './RecordDetailPage';

// Self-referencing chain objects: every chainable method returns the same
// object, and terminal resolution is controlled purely by mockResolvedValue
// ordering — see src/hooks/useCredentialTemplate.test.ts for the same
// pattern, used here for TWO independent tables.
const mockPublicRecordsMaybeSingle = vi.hoisted(() => vi.fn());
const publicRecordsChain = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = {};
  c.select = vi.fn(() => c);
  c.eq = vi.fn(() => c);
  c.limit = vi.fn(() => c);
  c.maybeSingle = mockPublicRecordsMaybeSingle;
  return c;
});

const mockTemplateMaybeSingle = vi.hoisted(() => vi.fn());
const templateChain = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = {};
  c.select = vi.fn(() => c);
  c.eq = vi.fn(() => c);
  c.is = vi.fn(() => c);
  c.limit = vi.fn(() => c);
  c.maybeSingle = mockTemplateMaybeSingle;
  return c;
});

const mockFrom = vi.hoisted(() =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.fn((table: string): any => {
    if (table === 'public_records') return publicRecordsChain;
    if (table === 'credential_templates') return templateChain;
    // Not expected to be hit — useAnchor/lineage are mocked/inert below.
    return {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
  }),
);

const mockUseAnchor = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: { from: mockFrom },
}));
vi.mock('@/hooks/useAnchor', () => ({
  useAnchor: mockUseAnchor,
}));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'owner@test.dev' }, signOut: vi.fn() }),
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
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'anchor-pipeline-1' }),
  useNavigate: () => vi.fn(),
}));

const PLATFORM_PUBLICATION_TEMPLATE = {
  name: 'Publication',
  default_metadata: {
    fields: [
      { key: 'issuerName', label: 'Publisher / Journal' },
      { key: 'recipientIdentifier', label: 'Author(s)' },
      { key: 'fieldOfStudy', label: 'Title' },
      { key: 'issuedDate', label: 'Publication Date' },
      { key: 'licenseNumber', label: 'DOI / ISSN' },
    ],
  },
};

const pipelineAnchorRow = {
  id: 'anchor-pipeline-1',
  public_id: 'pub_anchor_pipeline_1',
  filename: 'openalex-w123.pdf',
  fingerprint: 'f'.repeat(64),
  fingerprint_source: null,
  status: 'SECURED',
  created_at: '2026-02-14T00:00:00Z',
  chain_timestamp: '2026-02-15T00:00:00Z',
  issued_at: null,
  revoked_at: null,
  revocation_reason: null,
  expires_at: null,
  file_size: 0,
  file_mime: null,
  credential_type: 'PUBLICATION',
  chain_tx_id: null,
  chain_block_height: null,
  chain_block_hash: null,
  metadata: { pipeline_source: 'openalex', source_id: 'W123', source_url: 'https://openalex.org/W123', record_type: 'article' },
  cpe_metadata: null,
  cle_metadata: null,
  description: null,
  org_id: 'org-pipeline-owner',
  user_id: 'user-pipeline-owner',
  version_number: 1,
  parent_anchor_id: null,
  deleted_at: null,
};

const nonPipelineAnchorRow = {
  ...pipelineAnchorRow,
  id: 'anchor-non-pipeline-1',
  credential_type: null,
  metadata: null,
  org_id: null,
};

describe('RecordDetailPage — pipeline-anchored public record template (SCRUM-5105)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the platform template\'s labelled fields for a pipeline anchor, and the authors metadata row', async () => {
    mockUseAnchor.mockReturnValue({ anchor: pipelineAnchorRow, loading: false, error: null, refreshAnchor: vi.fn() });
    mockPublicRecordsMaybeSingle.mockResolvedValue({ data: openalexFixture, error: null });
    // Org-scoped lookup finds nothing, platform (org_id IS NULL) lookup finds the row.
    mockTemplateMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: PLATFORM_PUBLICATION_TEMPLATE, error: null });

    render(<RecordDetailPage />);

    await waitFor(() => expect(screen.getByText('Publisher / Journal')).toBeInTheDocument());
    expect(screen.getAllByText('Journal of Open Machine Learning Research').length).toBeGreaterThan(0);
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getAllByText(openalexFixture.title).length).toBeGreaterThan(0);
    expect(screen.getByText('Publication Date')).toBeInTheDocument();
    expect(screen.getAllByText('2026-02-14').length).toBeGreaterThan(0);
    expect(screen.getByText('DOI / ISSN')).toBeInTheDocument();
    expect(screen.getAllByText('10.1234/arkova.example.5105').length).toBeGreaterThan(0);

    // recipientIdentifier ("Author(s)") is never faked — the template row
    // has no value for it and does not render at all in the labelled card.
    expect(screen.queryByText('Author(s)')).not.toBeInTheDocument();

    // authors instead render via the generic Metadata dump's narrow
    // authors formatter (AssetDetailView's MetadataRow).
    expect(screen.getByTestId('metadata-authors-value')).toHaveTextContent('Jane Q. Researcher, Alex Chen');

    expect(mockFrom).toHaveBeenCalledWith('public_records');
    expect(publicRecordsChain.eq).toHaveBeenCalledWith('anchor_id', 'anchor-pipeline-1');
  });

  it('issues no public_records query for a non-pipeline anchor', async () => {
    mockUseAnchor.mockReturnValue({ anchor: nonPipelineAnchorRow, loading: false, error: null, refreshAnchor: vi.fn() });

    render(<RecordDetailPage />);

    await waitFor(() => expect(screen.getByText('openalex-w123.pdf')).toBeInTheDocument());
    expect(mockFrom).not.toHaveBeenCalledWith('public_records');
  });
});
