import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockClaimJob,
  mockCompleteJob,
  mockFailJob,
  mockDbFrom,
  mockProvider,
  mockLogger,
  state,
} = vi.hoisted(() => {
  const state = {
    anchorError: null as { message: string } | null,
    anchorUpdates: [] as Record<string, unknown>[],
    auditEvents: [] as Record<string, unknown>[],
  };
  return {
    state,
    mockClaimJob: vi.fn(),
    mockCompleteJob: vi.fn(),
    mockFailJob: vi.fn(),
    mockDbFrom: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn((_column: string, value: unknown) => ({
          maybeSingle: vi.fn(async () => {
            if (table === 'anchors') {
              return {
                data: state.anchorError ? null : {
                  id: value,
                  public_id: 'ARK-2026-CPEJOB',
                  credential_type: 'CPE',
                  fingerprint: 'a'.repeat(64),
                  org_id: '550e8400-e29b-41d4-a716-446655440010',
                  user_id: '550e8400-e29b-41d4-a716-446655440011',
                  metadata: {
                    source_url: 'https://udemy.com/certificate/UC-123',
                    credential_title: 'Advanced Tax Planning CPE',
                    credential_issuer: 'Udemy',
                  },
                  cpe_metadata: null,
                  cle_metadata: null,
                },
                error: state.anchorError,
              };
            }
            return {
              data: {
                provider_name: 'Udemy',
                nasba_sponsor_id: null,
                nasba_status: 'confirmed',
                last_verified_date: '2026-05-14',
              },
              error: null,
            };
          }),
        })),
      })),
      update: vi.fn((payload: Record<string, unknown>) => ({
        eq: vi.fn(async () => {
          state.anchorUpdates.push(payload);
          return { data: null, error: null };
        }),
      })),
      insert: vi.fn(async (payload: Record<string, unknown>) => {
        state.auditEvents.push(payload);
        return { data: null, error: null };
      }),
    })),
    mockProvider: {
      name: 'test-provider',
      extractMetadata: vi.fn(async () => ({
        fields: {
          credit_hours: 8,
          field_of_study: 'Taxes',
          delivery_method: 'QAS Self-Study',
          extraction_confidence: 0.94,
          requires_manual_review: false,
        },
        confidence: 0.94,
        provider: 'test-provider',
      })),
    },
    mockLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('../utils/db.js', () => ({ db: { from: mockDbFrom } }));
vi.mock('../utils/jobQueue.js', () => ({
  claimJob: (...args: unknown[]) => mockClaimJob(...args),
  completeJob: (...args: unknown[]) => mockCompleteJob(...args),
  failJob: (...args: unknown[]) => mockFailJob(...args),
}));
vi.mock('../ai/factory.js', () => ({
  createExtractionProvider: () => mockProvider,
}));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));

import { processProfessionalEducationExtractionJobs } from './professional-education-extraction.js';

const JOB = {
  id: 'job-1',
  type: 'professional_education.metadata_extraction',
  payload: {
    anchorId: '550e8400-e29b-41d4-a716-446655440000',
    educationKind: 'CPE',
    evidence: {
      source_url: 'https://udemy.com/certificate/UC-123',
      credential_title: 'Advanced Tax Planning CPE',
      credential_issuer: 'Udemy',
    },
  },
  status: 'processing',
  priority: 0,
  attempts: 1,
  max_attempts: 5,
  last_error: null,
  created_at: '2026-05-20T00:00:00.000Z',
  updated_at: '2026-05-20T00:00:00.000Z',
  scheduled_for: null,
};

describe('professional education extraction job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClaimJob.mockReset();
    mockCompleteJob.mockReset();
    mockFailJob.mockReset();
    mockProvider.extractMetadata.mockClear();
    state.anchorError = null;
    state.anchorUpdates = [];
    state.auditEvents = [];
    mockClaimJob.mockResolvedValueOnce(JOB).mockResolvedValueOnce(null);
  });

  it('claims queued work, persists metadata, audits, and completes the job', async () => {
    const result = await processProfessionalEducationExtractionJobs(5);

    expect(result).toEqual({ claimed: 1, processed: 1, failed: 0, manualReview: 0 });
    expect(state.anchorUpdates[0]).toHaveProperty('cpe_metadata');
    expect(state.auditEvents[0]).toMatchObject({ event_type: 'cpe_metadata.extracted' });
    expect(mockCompleteJob).toHaveBeenCalledWith('job-1');
    expect(mockFailJob).not.toHaveBeenCalled();
  });

  it('marks the job failed when the anchor cannot be fetched', async () => {
    state.anchorError = { message: 'database unavailable' };

    const result = await processProfessionalEducationExtractionJobs(5);

    expect(result).toEqual({ claimed: 1, processed: 0, failed: 1, manualReview: 0 });
    expect(mockFailJob).toHaveBeenCalledWith(
      'job-1',
      expect.stringContaining('database unavailable'),
      1,
      5,
    );
    expect(mockCompleteJob).not.toHaveBeenCalled();
  });
});
