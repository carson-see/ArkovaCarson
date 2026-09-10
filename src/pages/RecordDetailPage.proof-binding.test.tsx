import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { buildProofPacket } from '@/lib/generateAuditReport';

const mocks = vi.hoisted(() => ({ anchor: vi.fn(), from: vi.fn(), eq: vi.fn(), report: vi.fn(), download: null as null | (() => Promise<void>) }));
const mockFrom = mocks.from;
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'owner-1' }, signOut: vi.fn() }) }));
vi.mock('@/hooks/useProfile', () => ({ useProfile: () => ({ profile: { role: 'INDIVIDUAL' }, loading: false }) }));
vi.mock('@/hooks/useHasCredentialImportEntitlement', () => ({ useHasCredentialImportEntitlement: () => false }));
vi.mock('@/hooks/useAnchor', () => ({ useAnchor: mocks.anchor }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: mocks.from } }));
vi.mock('@/components/layout', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/anchor', () => ({ AssetDetailView: ({ onDownloadProof }: { onDownloadProof: () => Promise<void> }) => {
  mocks.download = onDownloadProof;
  return null;
} }));
vi.mock('react-router-dom', () => ({ useParams: () => ({ id: 'anchor-1' }), useNavigate: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/generateAuditReport', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/generateAuditReport')>(), generateAuditReport: mocks.report,
}));

const proof = {
  merkle_root: 'a'.repeat(64), proof_path: [], merkle_index: 0, batch_id: null,
  block_hash: 'f'.repeat(64), block_header: '0'.repeat(160), block_height: 100,
  block_timestamp: '2026-09-02T01:00:00Z', receipt_id: 'd'.repeat(64),
};
const anchor = {
  id: 'anchor-1', user_id: 'owner-1', org_id: null, public_id: 'ARK-TEST-1', filename: 'proof.txt',
  fingerprint: 'a'.repeat(64), status: 'SECURED', version_number: 1, parent_anchor_id: null,
  chain_tx_id: 'd'.repeat(64), chain_block_hash: 'f'.repeat(64), chain_block_height: 104,
  chain_timestamp: '2026-09-02T02:00:00Z', created_at: '2026-09-01T01:00:00Z',
};

describe('RecordDetailPage — proof download block identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.download = null;
    mockFrom.mockImplementation(() => {
      const query = { select: vi.fn(), eq: mocks.eq, maybeSingle: vi.fn().mockResolvedValue({ data: proof, error: null }) };
      query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
      return query;
    });
  });

  for (const mismatch of [false, true]) {
    it(mismatch ? 'withholds an embedded packet for a mismatched block' : 'passes matching block identity through both real proof builders', async () => {
      const current = { ...anchor, chain_block_hash: (mismatch ? 'e' : 'f').repeat(64) };
      mocks.anchor.mockReturnValue({ anchor: current, loading: false, error: null, refreshAnchor: vi.fn() });
      const { RecordDetailPage } = await import('./RecordDetailPage');
      render(<RecordDetailPage />);
      expect(mocks.download).toBeTypeOf('function');
      await act(async () => { await mocks.download!(); });
      // The browser client relies on RLS for viewer access and selects this record only.
      expect(mockFrom).toHaveBeenCalledExactlyOnceWith('anchor_proofs');
      expect(mocks.eq).toHaveBeenCalledExactlyOnceWith('anchor_id', 'anchor-1');
      expect(mocks.report).toHaveBeenCalledTimes(1);
      const report = mocks.report.mock.calls[0][0];
      expect(report.blockHash).toBe(current.chain_block_hash);
      expect(report.proofComplete).toBe(!mismatch);
      if (mismatch) {
        expect(report.proof).toBeUndefined();
        expect(buildProofPacket(report)).toBeNull();
      } else {
        expect(buildProofPacket(report)).toMatchObject({ block_hash: proof.block_hash, block_height: 104, block_timestamp: current.chain_timestamp });
      }
    });
  }

  it('does not query or embed proof rows for an unsecured record', async () => {
    mocks.anchor.mockReturnValue({ anchor: { ...anchor, status: 'PENDING' }, loading: false, error: null, refreshAnchor: vi.fn() });
    const { RecordDetailPage } = await import('./RecordDetailPage');
    render(<RecordDetailPage />);
    await act(async () => { await mocks.download!(); });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mocks.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      proof: undefined, proofComplete: false,
    }));
  });
});
