import { describe, it, expect } from 'vitest';
import {
  AUDIT_EVENT_CATEGORIES,
  auditEventCategorySchema,
  type AuditEventCategory,
} from './audit-event-category.js';

const DB_CONSTRAINT_CATEGORIES = [
  'AUTH', 'ANCHOR', 'PROFILE', 'ORG', 'ADMIN', 'SYSTEM',
  'ORGANIZATION', 'WEBHOOK', 'API', 'AI', 'BILLING', 'VERIFICATION', 'USER',
  'SECURITY', 'COMPLIANCE', 'NOTIFICATION', 'PLATFORM',
] as const;

describe('AUDIT_EVENT_CATEGORIES', () => {
  it('contains every value allowed by the DB CHECK constraint', () => {
    for (const cat of DB_CONSTRAINT_CATEGORIES) {
      expect(AUDIT_EVENT_CATEGORIES).toContain(cat);
    }
  });

  it('does not contain values outside the DB CHECK constraint', () => {
    for (const cat of AUDIT_EVENT_CATEGORIES) {
      expect(DB_CONSTRAINT_CATEGORIES).toContain(cat);
    }
  });

  it('has no duplicates', () => {
    const unique = new Set(AUDIT_EVENT_CATEGORIES);
    expect(unique.size).toBe(AUDIT_EVENT_CATEGORIES.length);
  });
});

describe('auditEventCategorySchema (Zod)', () => {
  it.each(DB_CONSTRAINT_CATEGORIES.map((c) => [c]))('accepts %s', (category) => {
    expect(auditEventCategorySchema.safeParse(category).success).toBe(true);
  });

  it('rejects values outside the constraint', () => {
    expect(auditEventCategorySchema.safeParse('BOGUS').success).toBe(false);
    expect(auditEventCategorySchema.safeParse('api_key').success).toBe(false);
    expect(auditEventCategorySchema.safeParse('').success).toBe(false);
  });
});

describe('AuditEventCategory type', () => {
  it('is assignable from every const member (compile-time check)', () => {
    const values: AuditEventCategory[] = [...AUDIT_EVENT_CATEGORIES];
    expect(values.length).toBe(DB_CONSTRAINT_CATEGORIES.length);
  });
});
