/* eslint-disable arkova/no-unscoped-service-test -- This suite never exercises a
   query: the fixture is `version_number: 1` with no parent, so the lineage
   effect takes its early return and the mocked client is never called. The
   `@/lib/supabase` mock exists solely so RecordDetailPage's module-level import
   resolves. Scoping is asserted where a query actually runs (see
   RecordDetailPage.honest-rename.test.tsx). */
/**
 * RecordDetailPage — CLE metadata pass-through (SCRUM-1869 / CLE-R1)
 *
 * `AssetDetailView` has declared `cleMetadata` since SCRUM-1869 and feeds it to
 * `extractCleMetadataView` → `CleMetadataSection`, but nothing on the owner
 * detail path ever populated it: `RecordDetailPage` passed `cpeMetadata` and
 * silently dropped `cle_metadata`. The prop was wired and waiting, so the CLE
 * section rendered nothing for every record — a Done story with no user-visible
 * outcome. (`src/components/credentials/agents.md` listed this exact line as the
 * remaining prereq.)
 *
 * These tests capture the props `RecordDetailPage` hands `AssetDetailView` and
 * assert the column arrives, mirroring the CPE assertion so a future edit cannot
 * drop one while keeping the other. The public verification path is unaffected —
 * `PublicVerification.tsx` already reads `cle_metadata` off the RPC.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const mockUseAnchor = vi.hoisted(() => vi.fn());
const capturedProps = vi.hoisted(
  () => ({ current: null as Record<string, unknown> | null }),
);

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'owner-1', email: 'owner@test.dev' }, signOut: vi.fn() }),
}));
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: { role: 'INDIVIDUAL', org_id: null }, loading: false }),
}));
vi.mock('@/hooks/useHasCredentialImportEntitlement', () => ({
  useHasCredentialImportEntitlement: () => true,
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
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'anchor-1' }),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }));

/** A realistic CLE blob as the worker's `CleMetadataSchema` stores it. */
const CLE_METADATA = {
  course_title: 'Legal Ethics and Professional Responsibility',
  credit_hours: 3,
  ethics_hours: 1,
  jurisdiction: 'NY',
  provider_approval_status: 'approved',
};

const CPE_METADATA = { credit_hours: 2, field_of_study: 'Auditing' };

/**
 * `version_number: 1` with no parent keeps the lineage effect on its early
 * return, so this fixture never reaches the mocked supabase client.
 */
const baseAnchor = {
  id: 'anchor-1',
  user_id: 'owner-1',
  org_id: null,
  public_id: 'ARK-2026-00001',
  filename: 'cle-certificate.pdf',
  fingerprint: 'a'.repeat(64),
  status: 'SECURED',
  created_at: '2026-01-01T00:00:00Z',
  chain_timestamp: null,
  issued_at: null,
  revoked_at: null,
  revocation_reason: null,
  expires_at: null,
  file_size: 1024,
  file_mime: 'application/pdf',
  credential_type: 'CLE_CERTIFICATE',
  chain_tx_id: null,
  chain_block_height: null,
  metadata: null,
  cpe_metadata: null,
  cle_metadata: null,
  description: null,
  version_number: 1,
  parent_anchor_id: null,
  deleted_at: null,
};

async function renderWith(anchor: Record<string, unknown>) {
  mockUseAnchor.mockReturnValue({
    anchor,
    loading: false,
    error: null,
    refreshAnchor: vi.fn(),
  });
  const { RecordDetailPage } = await import('./RecordDetailPage');
  render(<RecordDetailPage />);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (capturedProps.current?.anchor ?? null) as any;
}

describe('RecordDetailPage — compliance metadata pass-through', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedProps.current = null;
  });

  it('passes cle_metadata through to AssetDetailView as cleMetadata', async () => {
    const anchor = await renderWith({ ...baseAnchor, cle_metadata: CLE_METADATA });

    expect(anchor).not.toBeNull();
    expect(anchor.cleMetadata).toEqual(CLE_METADATA);
  });

  /**
   * Non-vacuity guard for the assertion above: CPE was already wired, so if this
   * fails the harness itself (not the CLE line) is broken.
   */
  it('still passes cpe_metadata through as cpeMetadata', async () => {
    const anchor = await renderWith({ ...baseAnchor, cpe_metadata: CPE_METADATA });

    expect(anchor.cpeMetadata).toEqual(CPE_METADATA);
  });

  it('carries both columns on one record without either shadowing the other', async () => {
    const anchor = await renderWith({
      ...baseAnchor,
      cpe_metadata: CPE_METADATA,
      cle_metadata: CLE_METADATA,
    });

    expect(anchor.cpeMetadata).toEqual(CPE_METADATA);
    expect(anchor.cleMetadata).toEqual(CLE_METADATA);
  });

  /**
   * A null column must arrive as `undefined`, not `null`: `extractCleMetadataView`
   * is called unconditionally in AssetDetailView and the section self-hides on an
   * empty view, matching how `cpeMetadata` normalizes.
   */
  it('normalizes a null cle_metadata column to undefined', async () => {
    const anchor = await renderWith({ ...baseAnchor, cle_metadata: null });

    expect(anchor.cleMetadata).toBeUndefined();
  });

  /** The entitlement gate stays a separate, page-level concern. */
  it('passes the import entitlement alongside the metadata', async () => {
    await renderWith({ ...baseAnchor, cle_metadata: CLE_METADATA });

    expect(capturedProps.current?.hasImportEntitlement).toBe(true);
  });
});
