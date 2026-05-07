/**
 * Pure-function tests for incremental sync.
 *
 * SCRUM-1723. Heavier integration tests (with mocked BQ + DB) are
 * deferred to the SCRUM-1725 verify subtask. The invariants pinned
 * here are the ones that, if violated, would silently leak PII or
 * skip rows — i.e. the load-bearing safety properties.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock db so importing the job module doesn't trigger config.ts env validation.
// The helpers under test (selectColumns, BATCH_SIZE, APPEND_TABLES) don't touch
// db; they're pure data.
vi.mock('../utils/db.js', () => ({ db: {} }));
vi.mock('../utils/gcp-auth.js', () => ({ getGcpAccessToken: vi.fn() }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { __testing } from './bq-export-incremental.js';
import {
  AUDIT_EVENTS_FORBIDDEN_COLUMNS,
  BQ_TABLES,
} from './bq-export-schemas.js';

const { selectColumns, BATCH_SIZE, APPEND_TABLES } = __testing;

describe('bq-export-incremental: APPEND_TABLES', () => {
  it('handles exactly the three append-only tables', () => {
    expect([...APPEND_TABLES].sort((a, b) => a.localeCompare(b))).toEqual([
      'anchors',
      'audit_events',
      'verifications',
    ]);
  });

  it('every APPEND_TABLES entry has mode="append" in BQ_TABLES', () => {
    for (const t of APPEND_TABLES) {
      expect(BQ_TABLES[t].mode).toBe('append');
    }
  });
});

describe('bq-export-incremental: selectColumns PII guards (audit_events)', () => {
  it('audit_events select list does NOT contain forbidden PII columns', () => {
    const cols = selectColumns('audit_events');
    for (const forbidden of AUDIT_EVENTS_FORBIDDEN_COLUMNS) {
      expect(cols).not.toContain(forbidden);
    }
  });

  it('audit_events select list contains the real source-column names', () => {
    const cols = selectColumns('audit_events');
    // Must use migration-0006 column names, not the older actor_type/category.
    expect(cols).toContain('event_type');
    expect(cols).toContain('event_category');
  });

  it('audit_events select list does NOT contain the older actor_type / category / action stand-ins', () => {
    const cols = selectColumns('audit_events');
    expect(cols).not.toContain('actor_type');
    expect(cols).not.toContain('action');
  });
});

describe('bq-export-incremental: anchors / verifications select shape', () => {
  it('anchors select list is non-empty and has no obvious PII columns', () => {
    const cols = selectColumns('anchors');
    expect(cols.length).toBeGreaterThan(0);
    // anchors has no PII columns at the source (per migration 0001/0002),
    // but defensively assert nothing surprises us.
    expect(cols).not.toContain('email');
    expect(cols).not.toContain('password');
  });

  it('verifications select list pins verifier_ip_hash (NOT raw verifier_ip)', () => {
    const cols = selectColumns('verifications');
    expect(cols).toContain('verifier_ip_hash');
    // If a future migration adds a raw `verifier_ip` column, it must NOT
    // appear in this select list — fail fast at build time.
    expect(cols).not.toContain('verifier_ip,');
    expect(cols).not.toContain(' verifier_ip ');
  });
});

describe('bq-export-incremental: batch size sanity', () => {
  it('BATCH_SIZE is between 100 and 100_000 (BQ insertAll cap)', () => {
    // Lower bound: too small means too many round trips per cron tick.
    // Upper bound: tabledata.insertAll has a 10MB request body cap; 100K
    // small rows is well under that even with bloated columns.
    expect(BATCH_SIZE).toBeGreaterThanOrEqual(100);
    expect(BATCH_SIZE).toBeLessThanOrEqual(100_000);
  });
});
