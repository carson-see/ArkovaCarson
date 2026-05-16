/**
 * SCRUM-1969 — Version Resolution Zod Schema Tests
 *
 * Validates insert/update payloads for external_document_versions
 * and version_reviews tables.
 */

import { describe, it, expect } from 'vitest';
import {
  ExternalDocumentVersionInsert,
  ExternalDocumentVersionUpdate,
  VersionReviewInsert,
  VersionReviewUpdate,
  VersionStatus,
  ReviewDecision,
} from './version-resolution-schemas.js';

describe('ExternalDocumentVersionInsert schema', () => {
  const validInsert = {
    org_id: '11111111-1111-4111-8111-111111111111',
    external_file_id: 'gdrive:1234567890abc',
    fingerprint: 'a'.repeat(64),
    source: 'google_drive',
    version_number: 2,
    filename: 'contract-v2.pdf',
    detected_at: '2026-05-16T00:00:00Z',
    trigger_event_id: '22222222-2222-4222-8222-222222222222',
  };

  it('accepts a valid insert payload', () => {
    const result = ExternalDocumentVersionInsert.safeParse(validInsert);
    expect(result.success).toBe(true);
  });

  it('requires org_id as UUID', () => {
    const result = ExternalDocumentVersionInsert.safeParse({
      ...validInsert,
      org_id: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('requires fingerprint to be exactly 64 hex chars', () => {
    const tooShort = ExternalDocumentVersionInsert.safeParse({
      ...validInsert,
      fingerprint: 'abc123',
    });
    expect(tooShort.success).toBe(false);

    const nonHex = ExternalDocumentVersionInsert.safeParse({
      ...validInsert,
      fingerprint: 'g'.repeat(64),
    });
    expect(nonHex.success).toBe(false);
  });

  it('requires external_file_id between 1-500 chars', () => {
    const empty = ExternalDocumentVersionInsert.safeParse({
      ...validInsert,
      external_file_id: '',
    });
    expect(empty.success).toBe(false);

    const tooLong = ExternalDocumentVersionInsert.safeParse({
      ...validInsert,
      external_file_id: 'x'.repeat(501),
    });
    expect(tooLong.success).toBe(false);
  });

  it('requires source to be a valid connector type', () => {
    const result = ExternalDocumentVersionInsert.safeParse({
      ...validInsert,
      source: 'unknown_source',
    });
    expect(result.success).toBe(false);
  });

  it('defaults status to pending_review', () => {
    const result = ExternalDocumentVersionInsert.safeParse(validInsert);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('pending_review');
    }
  });

  it('requires version_number >= 1', () => {
    const zero = ExternalDocumentVersionInsert.safeParse({
      ...validInsert,
      version_number: 0,
    });
    expect(zero.success).toBe(false);
  });

  it('allows optional metadata as object', () => {
    const result = ExternalDocumentVersionInsert.safeParse({
      ...validInsert,
      metadata: { original_name: 'foo.pdf', size: 12345 },
    });
    expect(result.success).toBe(true);
  });
});

describe('ExternalDocumentVersionUpdate schema', () => {
  it('accepts valid status transitions', () => {
    const result = ExternalDocumentVersionUpdate.safeParse({
      status: 'approved',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid status values', () => {
    const result = ExternalDocumentVersionUpdate.safeParse({
      status: 'invalid',
    });
    expect(result.success).toBe(false);
  });
});

describe('VersionReviewInsert schema', () => {
  const validReview = {
    version_id: '33333333-3333-4333-8333-333333333333',
    org_id: '11111111-1111-4111-8111-111111111111',
    reviewer_id: '44444444-4444-4444-8444-444444444444',
    decision: 'approve' as const,
  };

  it('accepts a valid review insert', () => {
    const result = VersionReviewInsert.safeParse(validReview);
    expect(result.success).toBe(true);
  });

  it('requires version_id as UUID', () => {
    const result = VersionReviewInsert.safeParse({
      ...validReview,
      version_id: 'bad',
    });
    expect(result.success).toBe(false);
  });

  it('requires decision to be approve/skip/flag', () => {
    const bad = VersionReviewInsert.safeParse({
      ...validReview,
      decision: 'reject',
    });
    expect(bad.success).toBe(false);
  });

  it('allows optional notes up to 2000 chars', () => {
    const withNotes = VersionReviewInsert.safeParse({
      ...validReview,
      notes: 'Approved after verifying with legal team.',
    });
    expect(withNotes.success).toBe(true);

    const tooLong = VersionReviewInsert.safeParse({
      ...validReview,
      notes: 'x'.repeat(2001),
    });
    expect(tooLong.success).toBe(false);
  });
});

describe('VersionReviewUpdate schema', () => {
  it('allows updating notes only', () => {
    const result = VersionReviewUpdate.safeParse({
      notes: 'Updated rationale.',
    });
    expect(result.success).toBe(true);
  });
});

describe('VersionStatus enum', () => {
  it('contains all expected values', () => {
    expect(VersionStatus.options).toEqual([
      'pending_review',
      'approved',
      'skipped',
      'flagged',
    ]);
  });
});

describe('ReviewDecision enum', () => {
  it('contains all expected values', () => {
    expect(ReviewDecision.options).toEqual(['approve', 'skip', 'flag']);
  });
});
