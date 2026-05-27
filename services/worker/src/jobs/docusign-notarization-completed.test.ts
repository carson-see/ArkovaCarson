/**
 * SCRUM-1872: DocuSign notarization completed job handler tests.
 *
 * TDD Red → Green: tests written first against the expected contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----
const {
  mockDbFrom,
  mockLogger,
  mockProcessNextJob,
} = vi.hoisted(() => {
  const mockDbFrom = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockProcessNextJob = vi.fn();

  return { mockDbFrom, mockLogger, mockProcessNextJob };
});

vi.mock('../utils/db.js', () => ({
  db: { from: mockDbFrom, rpc: vi.fn() },
}));

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('../utils/jobQueue.js', () => ({
  processNextJob: mockProcessNextJob,
}));

import {
  DOCUSIGN_NOTARIZATION_COMPLETED_JOB_TYPE,
  processDocusignNotarizationCompletedJob,
  DocusignNotarizationCompletedJobPayload,
  runDocusignNotarizationCompletedJobs,
} from './docusign-notarization-completed.js';

// ── Zod payload schema tests ────────────────────────────────────────

describe('DocusignNotarizationCompletedJobPayload', () => {
  it('parses a valid payload', () => {
    const input = {
      org_id: '11111111-1111-4111-8111-111111111111',
      integration_id: 'int-1',
      account_id: 'acct-1',
      envelope_id: 'env-1',
      rule_event_id: 'evt-1',
      notary_name: 'Jane Public',
      notary_commission_state: 'CA',
      notary_commission_number: '2468135',
      notarization_completed_at: '2026-05-27T12:00:00Z',
    };
    const result = DocusignNotarizationCompletedJobPayload.parse(input);
    expect(result.org_id).toBe(input.org_id);
    expect(result.notary_name).toBe('Jane Public');
    expect(result.notary_commission_state).toBe('CA');
  });

  it('allows optional notary fields to be null', () => {
    const input = {
      org_id: '11111111-1111-4111-8111-111111111111',
      integration_id: 'int-1',
      account_id: 'acct-1',
      envelope_id: 'env-1',
      rule_event_id: 'evt-1',
      notary_name: null,
      notary_commission_state: null,
      notary_commission_number: null,
      notarization_completed_at: '2026-05-27T12:00:00Z',
    };
    const result = DocusignNotarizationCompletedJobPayload.parse(input);
    expect(result.notary_name).toBeNull();
    expect(result.notary_commission_state).toBeNull();
  });

  it('rejects invalid org_id', () => {
    expect(() =>
      DocusignNotarizationCompletedJobPayload.parse({
        org_id: 'not-a-uuid',
        integration_id: 'int-1',
        account_id: 'acct-1',
        envelope_id: 'env-1',
        rule_event_id: 'evt-1',
        notarization_completed_at: '2026-05-27T12:00:00Z',
      }),
    ).toThrow();
  });

  it('rejects missing envelope_id', () => {
    expect(() =>
      DocusignNotarizationCompletedJobPayload.parse({
        org_id: '11111111-1111-4111-8111-111111111111',
        integration_id: 'int-1',
        account_id: 'acct-1',
        rule_event_id: 'evt-1',
        notarization_completed_at: '2026-05-27T12:00:00Z',
      }),
    ).toThrow();
  });
});

// ── Job type constant ───────────────────────────────────────────────

describe('DOCUSIGN_NOTARIZATION_COMPLETED_JOB_TYPE', () => {
  it('matches expected job type string', () => {
    expect(DOCUSIGN_NOTARIZATION_COMPLETED_JOB_TYPE).toBe('docusign.notarization_completed');
  });
});

// ── processDocusignNotarizationCompletedJob ─────────────────────────

describe('processDocusignNotarizationCompletedJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const validPayload = {
    org_id: '11111111-1111-4111-8111-111111111111',
    integration_id: 'int-1',
    account_id: 'acct-1',
    envelope_id: 'env-notarized-1',
    rule_event_id: 'evt-1',
    notary_name: 'Jane Public',
    notary_commission_state: 'CA',
    notary_commission_number: '2468135',
    notarization_completed_at: '2026-05-27T12:00:00Z',
  };

  it('updates existing LBA row from pending_notarization to notarized', async () => {
    // Mock: find existing LBA by docusign_envelope_id
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'lba-1',
          attestation_id: 'ARK-ATT-001',
          status: 'pending_notarization',
          docusign_envelope_id: 'env-notarized-1',
          attesting_org_id: '11111111-1111-4111-8111-111111111111',
        },
        error: null,
      }),
    };

    const updateChain = {
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            select: vi.fn().mockResolvedValue({
              data: [{ id: 'lba-1' }],
              error: null,
            }),
          }),
        }),
      }),
    };

    const auditInsertChain = {
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    let callCount = 0;
    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'legally_binding_attestations') {
        callCount++;
        if (callCount === 1) return selectChain;
        return updateChain;
      }
      if (table === 'audit_events') return auditInsertChain;
      return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
    });

    const result = await processDocusignNotarizationCompletedJob(validPayload);

    expect(result.success).toBe(true);
    expect(result.lbaId).toBe('lba-1');
    expect(result.previousStatus).toBe('pending_notarization');
    expect(result.newStatus).toBe('notarized');

    // Verify the update was called with notary metadata
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'notarized',
        notary_name: 'Jane Public',
        notary_commission_state: 'CA',
        notary_commission_number: '2468135',
        notarization_completed_at: '2026-05-27T12:00:00Z',
      }),
    );
  });

  it('returns not_found when no LBA matches the envelope_id', async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'legally_binding_attestations') return selectChain;
      return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
    });

    const result = await processDocusignNotarizationCompletedJob(validPayload);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('lba_not_found');
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('returns wrong_status when LBA is not in pending_notarization', async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'lba-1',
          attestation_id: 'ARK-ATT-001',
          status: 'draft',
          docusign_envelope_id: 'env-notarized-1',
          attesting_org_id: '11111111-1111-4111-8111-111111111111',
        },
        error: null,
      }),
    };

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'legally_binding_attestations') return selectChain;
      return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
    });

    const result = await processDocusignNotarizationCompletedJob(validPayload);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('wrong_status');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ currentStatus: 'draft' }),
      expect.any(String),
    );
  });

  it('returns org_mismatch when LBA org does not match payload org', async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'lba-1',
          attestation_id: 'ARK-ATT-001',
          status: 'pending_notarization',
          docusign_envelope_id: 'env-notarized-1',
          attesting_org_id: '99999999-9999-4999-8999-999999999999',
        },
        error: null,
      }),
    };

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'legally_binding_attestations') return selectChain;
      return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
    });

    const result = await processDocusignNotarizationCompletedJob(validPayload);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('org_mismatch');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ envelopeId: 'env-notarized-1' }),
      expect.stringContaining('cross-tenant'),
    );
  });

  it('handles DB lookup error gracefully', async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'connection failed' },
      }),
    };

    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'legally_binding_attestations') return selectChain;
      return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
    });

    const result = await processDocusignNotarizationCompletedJob(validPayload);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('lookup_failed');
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('handles DB update error gracefully', async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'lba-1',
          attestation_id: 'ARK-ATT-001',
          status: 'pending_notarization',
          docusign_envelope_id: 'env-notarized-1',
          attesting_org_id: '11111111-1111-4111-8111-111111111111',
        },
        error: null,
      }),
    };

    const updateChain = {
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            select: vi.fn().mockResolvedValue({
              data: null,
              error: { message: 'update failed' },
            }),
          }),
        }),
      }),
    };

    let callCount = 0;
    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'legally_binding_attestations') {
        callCount++;
        if (callCount === 1) return selectChain;
        return updateChain;
      }
      if (table === 'audit_events') {
        return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
      }
      return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
    });

    const result = await processDocusignNotarizationCompletedJob(validPayload);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('update_failed');
  });

  it('writes an audit event on success', async () => {
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'lba-1',
          attestation_id: 'ARK-ATT-001',
          status: 'pending_notarization',
          docusign_envelope_id: 'env-notarized-1',
          attesting_org_id: '11111111-1111-4111-8111-111111111111',
        },
        error: null,
      }),
    };

    const updateChain = {
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            select: vi.fn().mockResolvedValue({
              data: [{ id: 'lba-1' }],
              error: null,
            }),
          }),
        }),
      }),
    };

    const auditInsertMock = vi.fn().mockResolvedValue({ data: null, error: null });

    let callCount = 0;
    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'legally_binding_attestations') {
        callCount++;
        if (callCount === 1) return selectChain;
        return updateChain;
      }
      if (table === 'audit_events') {
        return { insert: auditInsertMock };
      }
      return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
    });

    await processDocusignNotarizationCompletedJob(validPayload);

    expect(auditInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'NOTARIZATION_COMPLETED',
        event_category: 'COMPLIANCE',
        target_type: 'legally_binding_attestation',
        target_id: 'lba-1',
        org_id: '11111111-1111-4111-8111-111111111111',
      }),
    );
  });

  it('rejects payload with invalid Zod schema', async () => {
    const badPayload = {
      org_id: 'not-a-uuid',
      integration_id: '',
    };

    const result = await processDocusignNotarizationCompletedJob(badPayload);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('invalid_payload');
  });
});

// ── runDocusignNotarizationCompletedJobs ─────────────────────────────

describe('runDocusignNotarizationCompletedJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes jobs from the queue up to the limit', async () => {
    // First two jobs succeed, third has nothing
    mockProcessNextJob
      .mockResolvedValueOnce({ claimed: true, status: 'completed', jobId: 'j-1' })
      .mockResolvedValueOnce({ claimed: true, status: 'completed', jobId: 'j-2' })
      .mockResolvedValueOnce({ claimed: false, status: 'idle' });

    const result = await runDocusignNotarizationCompletedJobs({ limit: 5 });

    expect(result.claimed).toBe(2);
    expect(result.completed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.jobIds).toEqual(['j-1', 'j-2']);
    expect(mockProcessNextJob).toHaveBeenCalledTimes(3);
    expect(mockProcessNextJob).toHaveBeenCalledWith(
      'docusign.notarization_completed',
      expect.any(Function),
    );
  });

  it('tracks failed and dead jobs separately', async () => {
    mockProcessNextJob
      .mockResolvedValueOnce({ claimed: true, status: 'failed', jobId: 'j-fail' })
      .mockResolvedValueOnce({ claimed: true, status: 'dead', jobId: 'j-dead' })
      .mockResolvedValueOnce({ claimed: false, status: 'idle' });

    const result = await runDocusignNotarizationCompletedJobs();

    expect(result.claimed).toBe(2);
    expect(result.completed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.dead).toBe(1);
  });

  it('returns empty result when no jobs available', async () => {
    mockProcessNextJob.mockResolvedValueOnce({ claimed: false, status: 'idle' });

    const result = await runDocusignNotarizationCompletedJobs();

    expect(result.claimed).toBe(0);
    expect(result.completed).toBe(0);
    expect(result.jobIds).toEqual([]);
  });

  it('clamps limit to maximum', async () => {
    mockProcessNextJob.mockResolvedValue({ claimed: false, status: 'idle' });

    await runDocusignNotarizationCompletedJobs({ limit: 500 });

    // Should only loop up to max 100
    expect(mockProcessNextJob).toHaveBeenCalledTimes(1); // stops after first idle
  });
});
