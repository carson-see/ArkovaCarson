/**
 * Version Resolution Zod Schemas (SCRUM-1969 / SCRUM-1126)
 *
 * Validates insert/update payloads for:
 * - external_document_versions: tracks each version of a connector-sourced document
 * - version_reviews: admin decisions on version conflicts
 */

import { z } from 'zod';

export const VersionStatus = z.enum([
  'pending_review',
  'approved',
  'skipped',
  'flagged',
]);
export type VersionStatusType = z.infer<typeof VersionStatus>;

export const ReviewDecision = z.enum(['approve', 'skip', 'flag']);
export type ReviewDecisionType = z.infer<typeof ReviewDecision>;

const ConnectorSource = z.enum([
  'google_drive',
  'sharepoint',
  'onedrive',
  'docusign',
  'adobe_sign',
  'veremark',
  'checkr',
  'hireright',
  'goodhire',
  'generic',
]);

const Fingerprint = z
  .string()
  .length(64)
  .regex(/^[A-Fa-f0-9]{64}$/);

export const ExternalDocumentVersionInsert = z.object({
  org_id: z.string().uuid(),
  external_file_id: z.string().min(1).max(500),
  fingerprint: Fingerprint,
  source: ConnectorSource,
  version_number: z.number().int().min(1),
  filename: z.string().min(1).max(500).optional(),
  detected_at: z.string().datetime().optional(),
  status: VersionStatus.default('pending_review'),
  trigger_event_id: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ExternalDocumentVersionInsertType = z.infer<typeof ExternalDocumentVersionInsert>;

export const ExternalDocumentVersionUpdate = z.object({
  status: VersionStatus.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });
export type ExternalDocumentVersionUpdateType = z.infer<typeof ExternalDocumentVersionUpdate>;

export const VersionReviewInsert = z.object({
  version_id: z.string().uuid(),
  org_id: z.string().uuid(),
  reviewer_id: z.string().uuid(),
  decision: ReviewDecision,
  notes: z.string().max(2000).optional(),
});
export type VersionReviewInsertType = z.infer<typeof VersionReviewInsert>;

export const VersionReviewUpdate = z.object({
  notes: z.string().max(2000).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });
export type VersionReviewUpdateType = z.infer<typeof VersionReviewUpdate>;
