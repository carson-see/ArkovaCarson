import { z } from 'zod';

/**
 * Canonical list of audit_events.event_category values.
 * Must match the CHECK constraint `audit_events_event_category_valid`
 * (baseline + migration 0307).
 */
export const AUDIT_EVENT_CATEGORIES = [
  'AUTH',
  'ANCHOR',
  'PROFILE',
  'ORG',
  'ADMIN',
  'SYSTEM',
  'ORGANIZATION',
  'WEBHOOK',
  'API',
  'AI',
  'BILLING',
  'VERIFICATION',
  'USER',
  'SECURITY',
  'COMPLIANCE',
  'NOTIFICATION',
  'PLATFORM',
] as const;

export type AuditEventCategory = (typeof AUDIT_EVENT_CATEGORIES)[number];

export const auditEventCategorySchema = z.enum(AUDIT_EVENT_CATEGORIES);
