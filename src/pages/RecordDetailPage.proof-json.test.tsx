import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

/**
 * PROOF-06: the JSON "proof package" download must embed the SAME canonical,
 * position-preserving proof packet the PDF certificate embeds.
 *
 * Before this suite existed, `onDownloadProofJson` called
 * `generateProofPackage(anchorFields)` with NO proof argument, so
 * `proof_package.proof` was ALWAYS null — for every record, including ones with
 * a full per-document branch in `anchor_proofs`. The sibling suite
 * (`RecordDetailPage.proof-binding.test.tsx`) looked like it covered this: its
 * mock destructures only `onDownloadProof`, so "both real proof builders" meant
 * two PDF-side helpers, never the JSON path. The JSON path had zero coverage.
 */

const mocks = vi.hoisted(() => ({
  anchor: vi.fn(),
  from: vi.fn(),
  eq: vi.fn(),
  download: vi.fn(),
  downloadJson: null as null | (() => Promise<void>),
}));
const mockFrom = mocks.from;

const OWNER = '44444444-0000-0000-0000-000000000001';
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: '44444444-0000-0000-0000-000000000001' }, signOut: vi.fn() }) }));
vi.mock('@/hooks/useProfile', () => ({ useProfile: () => ({ profile: { role: 'INDIVIDUAL' }, loading: false }) }));
vi.mock('@/hooks/useHasCredentialImportEntitlement', () => ({ useHasCredentialImportEntitlement: () => false }));
vi.mock('@/hooks/useAnchor', () => ({ useAnchor: mocks.anchor }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: mocks.from } }));
vi.mock('@/components/layout', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/anchor', () => ({
  AssetDetailView: ({ onDownloadProofJson }: { onDownloadProofJson: () => Promise<void> }) => {
    mocks.downloadJson = onDownloadProofJson;
    return null;
  },
}));
vi.mock('react-router-dom', () => ({ useParams: () => ({ id: 'anchor-1' }), useNavigate: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
// Capture the emitted package without touching the DOM download path.
vi.mock('@/lib/proofPackage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/proofPackage')>()),
  downloadProofPackage: mocks.download,
}));

// A batch member: a real layer-1 app-tree branch WITH positions, plus the
// layer-2 bitcoin-tree branch from migration 0427.
const proofRow = {
  merkle_root: 'a'.repeat(64),
  proof_path: [{ hash: 'b'.repeat(64), position: 'right' }],
  merkle_index: 0,
  leaf_count: 2,
  batch_id: 'batch-1',
  block_hash: 'f'.repeat(64),
  block_header: '0'.repeat(160),
  block_height: 104,
  block_timestamp: '2026-09-02T02:00:00Z',
  receipt_id: 'd'.repeat(64),
};

const anchor = {
  id: 'anchor-1', user_id: OWNER, org_id: null, public_id: 'ARK-TEST-1',
  filename: 'proof.txt', fingerprint: 'a'.repeat(64), status: 'SECURED',
  version_number: 1, parent_anchor_id: null, file_size: 10, file_mime: 'text/plain',
  chain_tx_id: 'd'.repeat(64), chain_block_hash: 'f'.repeat(64), chain_block_height: 104,
  chain_timestamp: '2026-09-02T02:00:00Z', created_at: '2026-09-01T01:00:00Z',
};

describe('RecordDetailPage — JSON proof package embeds a verifiable bundle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.downloadJson = null;
    mockFrom.mockImplementation(() => {
      const query: Record<string, unknown> = {
        select: vi.fn(),
        eq: mocks.eq,
        maybeSingle: vi.fn().mockResolvedValue({ data: proofRow, error: null }),
        // The leaf_count derivation awaits the builder itself
        // (`.select('*', {count:'exact',head:true}).eq('batch_id', …)`), so the
        // builder has to be thenable. The row read calls .maybeSingle()
        // explicitly and never hits this.
        then: (resolve: (v: unknown) => unknown) => resolve({ count: 2, error: null }),
      };
      (query.select as ReturnType<typeof vi.fn>).mockReturnValue(query);
      (query.eq as ReturnType<typeof vi.fn>).mockReturnValue(query);
      return query;
    });
    mocks.anchor.mockReturnValue({ anchor, loading: false, error: null, refreshAnchor: vi.fn() });
  });

  it('embeds the canonical packet with sibling POSITIONS preserved', async () => {
    const { RecordDetailPage } = await import('./RecordDetailPage');
    render(<RecordDetailPage />);
    expect(mocks.downloadJson).toBeTypeOf('function');
    await act(async () => { await mocks.downloadJson!(); });

    expect(mocks.download).toHaveBeenCalledTimes(1);
    const pkg = mocks.download.mock.calls[0][0];

    // The legacy v1.0 `proof` object must no longer be silently null.
    expect(pkg.proof).not.toBeNull();
    expect(pkg.proof.verification_tree_root).toBe(proofRow.merkle_root);

    // The canonical bundle must be present AND keep `{hash, position}` —
    // a bare string[] cannot be folded back into a root.
    expect(pkg.proof_bundle).toBeTruthy();
    expect(pkg.proof_bundle.merkle_proof).toEqual([{ hash: 'b'.repeat(64), position: 'right' }]);
    expect(pkg.proof_bundle.leaf_count).toBe(2);
    expect(pkg.proof_bundle.merkle_index).toBe(0);
    expect(pkg.proof_bundle.block_header).toBe('0'.repeat(160));
    expect(pkg.proof_bundle.proof_schema_version).toBe(1);
  });

  it('emits a null bundle for an unsecured record and never queries proofs', async () => {
    mocks.anchor.mockReturnValue({
      anchor: { ...anchor, status: 'PENDING' }, loading: false, error: null, refreshAnchor: vi.fn(),
    });
    const { RecordDetailPage } = await import('./RecordDetailPage');
    render(<RecordDetailPage />);
    await act(async () => { await mocks.downloadJson!(); });

    expect(mockFrom).not.toHaveBeenCalled();
    const pkg = mocks.download.mock.calls[0][0];
    expect(pkg.proof).toBeNull();
    expect(pkg.proof_bundle ?? null).toBeNull();
  });
});
