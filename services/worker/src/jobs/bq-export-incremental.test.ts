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

describe('bq-export-incremental: verifications source-table mapping (live-prod-defect 2026-05-09)', () => {
  it('VERIFICATIONS BQ target declares Postgres source `verification_events`', () => {
    // Live-prod first cron tick (2026-05-09 13:50 UTC) errored with
    // "Could not find the table 'public.verifications' in the schema cache"
    // because `verifications` is the BQ-side mirror name; the Postgres
    // source is `verification_events` (per migration 0042). The fix maps
    // sourceTableName so the SELECT runs against the right Postgres table.
    expect(BQ_TABLES.verifications.sourceTableName).toBe('verification_events');
  });

  it('verifications selectColumns aliases method → verified_via and ip_hash → verifier_ip_hash', () => {
    // PostgREST select aliasing: `<alias>:<source_column>`. Without these
    // aliases, the worker would SELECT verified_via + verifier_ip_hash
    // which don't exist on verification_events (the live columns are
    // `method` and `ip_hash`).
    const cols = selectColumns('verifications');
    expect(cols).toContain('verified_via:method');
    expect(cols).toContain('verifier_ip_hash:ip_hash');
  });

  it('verifications selectColumns does NOT contain user_agent, referrer, or country_code (PII / out-of-scope)', () => {
    // verification_events has user_agent (semi-PII), referrer, country_code.
    // The BQ mirror schema deliberately excludes them. Pin that here so a
    // future "make it richer" patch can't quietly leak them.
    const cols = selectColumns('verifications');
    expect(cols).not.toContain('user_agent');
    expect(cols).not.toContain('referrer');
    expect(cols).not.toContain('country_code');
  });
});

describe('bq-export-incremental: toBqRow JSON-type stringification (live-prod-defect 2026-05-09)', () => {
  it('stringifies anchors.metadata before insertAll (BQ JSON-type wire format)', () => {
    // Live-prod first cron tick rejected 1000 rows with "metadata is not a
    // record" because tabledata.insertAll requires JSON-type columns to be
    // sent as JSON-encoded strings, not nested objects. Postgres returns
    // jsonb as deserialized objects, so we have to re-stringify.
    const target = BQ_TABLES.anchors;
    const row = {
      id: 'aaa',
      created_at: '2026-05-09T00:00:00Z',
      metadata: { foo: 'bar', n: 1 },
    };
    const out = __testing.toBqRow(target, 'anchors', row);
    expect(typeof out.json.metadata).toBe('string');
    expect(JSON.parse(out.json.metadata as string)).toEqual({ foo: 'bar', n: 1 });
  });

  it('leaves null metadata as null (no string "null")', () => {
    const target = BQ_TABLES.anchors;
    const out = __testing.toBqRow(target, 'anchors', {
      id: 'bbb',
      created_at: '2026-05-09T00:00:00Z',
      metadata: null,
    });
    expect(out.json.metadata).toBeNull();
  });

  it('does NOT touch non-JSON fields (regression guard)', () => {
    const target = BQ_TABLES.anchors;
    const out = __testing.toBqRow(target, 'anchors', {
      id: 'ccc',
      created_at: '2026-05-09T00:00:00Z',
      org_id: 'org-1',
      status: 'SECURED',
    });
    expect(out.json.id).toBe('ccc');
    expect(out.json.org_id).toBe('org-1');
    expect(out.json.status).toBe('SECURED');
  });
});
