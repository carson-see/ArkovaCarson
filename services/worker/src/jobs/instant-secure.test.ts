import { beforeEach, describe, expect, it, vi } from 'vitest';
const { mockProcessBatchAnchors, mockRpc, intentReads, anchorRead } = vi.hoisted(() => ({
  mockProcessBatchAnchors: vi.fn(), mockRpc: vi.fn(), intentReads: [] as Array<Record<string, unknown>>,
  anchorRead: { current: { id: 'anchor-1', status: 'SUBMITTED', chain_tx_id: 'tx-1' } as Record<string, unknown> },
}));
vi.mock('../config.js', () => ({ config: { enableInstantSecure: true } }));
vi.mock('./batch-anchor.js', () => ({ processBatchAnchors: mockProcessBatchAnchors }));
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../utils/jobQueue.js', () => ({ processNextJob: vi.fn() }));
vi.mock('../utils/db.js', () => ({ db: { rpc: mockRpc, from: vi.fn((table: string) => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({
  maybeSingle: vi.fn(async () => ({ data: intentReads.shift(), error: null })),
  single: vi.fn(async () => ({ data: table === 'anchors' ? anchorRead.current : intentReads.shift(), error: null })),
})) })) })) } }));
import { processInstantSecureIntent } from './instant-secure.js';
const INTENT_ID = '550e8400-e29b-41d4-a716-446655440000';
function seed(afterStatus = 'PROCESSING', attempt = 1) { intentReads.push(
  { id: INTENT_ID, anchor_id: 'anchor-1', status: 'QUEUED', attempt: 0, rearm_generation: 0 },
  { id: INTENT_ID, anchor_id: 'anchor-1', status: afterStatus, attempt, rearm_generation: 0 },
); }
describe('durable instant-secure consumer', () => {
  beforeEach(() => { vi.clearAllMocks(); intentReads.length = 0; mockProcessBatchAnchors.mockResolvedValue({ processed: 1, txId: 'tx-1' }); mockRpc.mockResolvedValue({ data: { success: true }, error: null }); });
  it('dispatches only the exact intent through the canonical journaled batch path', async () => {
    seed(); anchorRead.current = { id: 'anchor-1', status: 'SUBMITTED', chain_tx_id: 'tx-1' };
    await processInstantSecureIntent({ intent_id: INTENT_ID });
    expect(mockProcessBatchAnchors).toHaveBeenCalledWith({ force: true, instantIntentId: INTENT_ID });
    expect(mockRpc).toHaveBeenCalledWith('settle_anchor_instant_intent', { p_intent_id: INTENT_ID, p_outcome: 'SUBMITTED', p_expected_attempt: 1, p_error_code: null });
  });
  it('holds ambiguous broadcast evidence and never requests a refund', async () => {
    seed(); anchorRead.current = { id: 'anchor-1', status: 'BROADCASTING', chain_tx_id: 'tx-ambiguous' };
    await processInstantSecureIntent({ intent_id: INTENT_ID });
    expect(mockRpc).toHaveBeenCalledWith('settle_anchor_instant_intent', expect.objectContaining({ p_outcome: 'HELD' }));
    expect(mockRpc).not.toHaveBeenCalledWith(expect.stringMatching(/refund/i), expect.anything());
  });
  it('marks only a persisted prebroadcast reset as safely refundable', async () => {
    seed(); anchorRead.current = { id: 'anchor-1', status: 'PENDING', chain_tx_id: null };
    await processInstantSecureIntent({ intent_id: INTENT_ID });
    expect(mockRpc).toHaveBeenCalledWith('settle_anchor_instant_intent', expect.objectContaining({ p_outcome: 'FAILED_SAFE', p_expected_attempt: 1 }));
  });
  it('reconciles a held attempt after canonical recovery adopts it', async () => {
    intentReads.push(
      { id: INTENT_ID, anchor_id: 'anchor-1', status: 'HELD', attempt: 1, rearm_generation: 0 },
      { id: INTENT_ID, anchor_id: 'anchor-1', status: 'HELD', attempt: 1, rearm_generation: 0 },
    );
    anchorRead.current = { id: 'anchor-1', status: 'SECURED', chain_tx_id: 'tx-adopted' };
    await processInstantSecureIntent({ intent_id: INTENT_ID });
    expect(mockRpc).toHaveBeenCalledWith('settle_anchor_instant_intent', expect.objectContaining({
      p_outcome: 'SUBMITTED', p_expected_attempt: 1,
    }));
  });

  it('completes a stale old job without touching a newer explicit rearm generation', async () => {
    intentReads.push(
      { id: INTENT_ID, anchor_id: 'anchor-1', status: 'QUEUED', attempt: 0, rearm_generation: 0 },
      { id: INTENT_ID, anchor_id: 'anchor-1', status: 'QUEUED', attempt: 0, rearm_generation: 1 },
    );
    anchorRead.current = { id: 'anchor-1', status: 'PENDING', chain_tx_id: null };
    mockProcessBatchAnchors.mockResolvedValue({ processed: 0, txId: null });

    await processInstantSecureIntent({ intent_id: INTENT_ID, generation: 0 });

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('ignores a stale queued job before it can claim or debit', async () => {
    intentReads.push({ id: INTENT_ID, anchor_id: 'anchor-1', status: 'QUEUED', attempt: 0, rearm_generation: 2 });

    await processInstantSecureIntent({ intent_id: INTENT_ID, generation: 1 });

    expect(mockProcessBatchAnchors).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
