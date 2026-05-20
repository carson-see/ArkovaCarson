/**
 * SCRUM-1846 / SCRUM-1880: async professional-education metadata extraction.
 *
 * Anchor creation only queues work. This processor claims jobs later, calls the
 * AI/provider adapter with PII-stripped evidence, persists typed CPE/CLE
 * metadata, and emits audit events.
 */

import { createExtractionProvider } from '../ai/factory.js';
import {
  PROFESSIONAL_EDUCATION_EXTRACTION_JOB_TYPE,
  ProfessionalEducationExtractionJobPayloadSchema,
  extractAndPersistProfessionalEducationMetadata,
  type ProfessionalEducationAnchorRow,
  type ProfessionalEducationExtractionResult,
} from '../compliance/professional-education.js';
import { db } from '../utils/db.js';
import { claimJob, completeJob, failJob, type Job } from '../utils/jobQueue.js';
import { logger } from '../utils/logger.js';

export interface ProfessionalEducationExtractionJobRunResult {
  claimed: number;
  processed: number;
  failed: number;
  manualReview: number;
}

export async function processProfessionalEducationExtractionJobs(
  maxJobs = 10,
): Promise<ProfessionalEducationExtractionJobRunResult> {
  const provider = createExtractionProvider('pipeline');
  const result: ProfessionalEducationExtractionJobRunResult = {
    claimed: 0,
    processed: 0,
    failed: 0,
    manualReview: 0,
  };

  for (let i = 0; i < maxJobs; i++) {
    const job = await claimJob(PROFESSIONAL_EDUCATION_EXTRACTION_JOB_TYPE);
    if (!job) break;

    result.claimed += 1;
    try {
      const extraction = await processProfessionalEducationExtractionJob(job, provider);
      await completeJob(job.id);
      result.processed += 1;
      if (extraction.requiresManualReview) result.manualReview += 1;
    } catch (error) {
      result.failed += 1;
      const message = error instanceof Error ? error.message : 'unknown professional education extraction failure';
      await failJob(job.id, message, job.attempts, job.max_attempts);
      logger.warn({ error, jobId: job.id }, 'Professional education extraction job failed');
    }
  }

  return result;
}

export async function processProfessionalEducationExtractionJob(
  job: Job<unknown>,
  provider = createExtractionProvider('pipeline'),
): Promise<ProfessionalEducationExtractionResult> {
  const payload = ProfessionalEducationExtractionJobPayloadSchema.parse(job.payload);
  const { data, error } = await db
    .from('anchors')
    .select('id, public_id, credential_type, fingerprint, org_id, user_id, metadata, cpe_metadata, cle_metadata')
    .eq('id', payload.anchorId)
    .maybeSingle();

  if (error) {
    throw new Error(`failed to fetch anchor for professional education extraction: ${error.message}`);
  }
  if (!data) {
    throw new Error(`anchor not found for professional education extraction: ${payload.anchorId}`);
  }

  const anchor = data as ProfessionalEducationAnchorRow;
  const alreadyExtracted = payload.educationKind === 'CPE'
    ? anchor.cpe_metadata
    : anchor.cle_metadata;
  if (alreadyExtracted && Object.keys(alreadyExtracted).length > 0) {
    return {
      anchorId: payload.anchorId,
      educationKind: payload.educationKind,
      metadata: alreadyExtracted,
      requiresManualReview: Boolean(alreadyExtracted.requires_manual_review),
      auditEventType: payload.educationKind === 'CPE' ? 'cpe_metadata.extracted' : 'cle_metadata.extracted',
    } as ProfessionalEducationExtractionResult;
  }

  return extractAndPersistProfessionalEducationMetadata({
    db,
    provider,
    anchor,
    educationKind: payload.educationKind,
    evidence: payload.evidence ?? anchor.metadata ?? undefined,
  });
}
