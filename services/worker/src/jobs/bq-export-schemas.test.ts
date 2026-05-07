/**
 * Build-time invariants for the BigQuery export schema definitions.
 *
 * SCRUM-1722 (parent SCRUM-1062 GCP-MAX-02). These tests are the structural
 * gate that prevents:
 *   - api_keys raw key column ever leaking into BQ (CLAUDE.md §1.4 + SOC 2).
 *   - audit_events losing its 7-year partition expiration (DC 200 Criterion #5).
 *   - schemas drifting away from the partition/cluster strategies the AC
 *     called for.
 *   - dataset location/region drift (US-only AC).
 *
 * These run as part of the worker test suite — `npm test` from
 * services/worker/.
 */

import { describe, it, expect } from 'vitest';

import {
  API_KEYS_COLUMN_ALLOWLIST,
  API_KEYS_FORBIDDEN_COLUMNS,
  BQ_TABLES,
  DATASET_ID,
  DATASET_LOCATION,
  PROJECT_ID,
  SOC2_AUDIT_RETENTION_DAYS,
  SOC2_AUDIT_RETENTION_MS,
  type BqField,
  type BqTableTarget,
} from './bq-export-schemas.js';

describe('bq-export-schemas: dataset constants', () => {
  it('pins project to arkova1', () => {
    expect(PROJECT_ID).toBe('arkova1');
  });

  it('pins dataset id to arkova_analytics', () => {
    expect(DATASET_ID).toBe('arkova_analytics');
  });

  it('pins dataset location to US (per SCRUM-1062 AC)', () => {
    expect(DATASET_LOCATION).toBe('US');
  });
});

describe('bq-export-schemas: 5 expected tables', () => {
  const expected = ['anchors', 'verifications', 'audit_events', 'organizations', 'api_keys'];

  it.each(expected)('declares table %s', (name) => {
    expect(BQ_TABLES[name]).toBeDefined();
  });

  it('declares no other tables (prevents accidental scope creep)', () => {
    const byLocale = (a: string, b: string): number => a.localeCompare(b);
    expect([...Object.keys(BQ_TABLES)].sort(byLocale)).toEqual([...expected].sort(byLocale));
  });

  it('every table has a tableId matching its key', () => {
    for (const [key, table] of Object.entries(BQ_TABLES)) {
      expect(table.tableId).toBe(key);
    }
  });
});

describe('bq-export-schemas: write-mode invariants', () => {
  const appendOnly = ['anchors', 'verifications', 'audit_events'];
  const snapshot = ['organizations', 'api_keys'];

  it.each(appendOnly)('%s is append-only', (name) => {
    expect(BQ_TABLES[name].mode).toBe('append');
  });

  it.each(snapshot)('%s is snapshot', (name) => {
    expect(BQ_TABLES[name].mode).toBe('snapshot');
  });
});

describe('bq-export-schemas: partition + cluster strategy', () => {
  it.each(['anchors', 'verifications', 'audit_events'])(
    '%s partitions by created_at',
    (name) => {
      expect(BQ_TABLES[name].timePartitioning.field).toBe('created_at');
      expect(BQ_TABLES[name].timePartitioning.type).toBe('DAY');
    },
  );

  it.each(['organizations', 'api_keys'])(
    '%s partitions by snapshot_date',
    (name) => {
      expect(BQ_TABLES[name].timePartitioning.field).toBe('snapshot_date');
      expect(BQ_TABLES[name].timePartitioning.type).toBe('DAY');
    },
  );

  it('every table declares a clustering strategy', () => {
    for (const [name, table] of Object.entries(BQ_TABLES)) {
      expect(table.clustering, `${name} missing clustering`).toBeDefined();
      expect(table.clustering!.fields.length).toBeGreaterThan(0);
    }
  });

  it('anchors clusters on org_id + status', () => {
    expect(BQ_TABLES.anchors.clustering!.fields).toEqual(['org_id', 'status']);
  });

  it('audit_events clusters on org_id + actor_type + category', () => {
    expect(BQ_TABLES.audit_events.clustering!.fields).toEqual([
      'org_id',
      'actor_type',
      'category',
    ]);
  });
});

describe('bq-export-schemas: SOC 2 audit retention', () => {
  it('audit_events partition expiration is 2555 days (7 years)', () => {
    expect(SOC2_AUDIT_RETENTION_DAYS).toBe(2555);
    const expectedMs = String(2555 * 24 * 60 * 60 * 1000);
    expect(SOC2_AUDIT_RETENTION_MS).toBe(expectedMs);
    expect(BQ_TABLES.audit_events.timePartitioning.expirationMs).toBe(expectedMs);
  });

  it('non-audit_events tables have NO partition expiration (retain indefinitely)', () => {
    for (const name of ['anchors', 'verifications', 'organizations', 'api_keys']) {
      expect(
        BQ_TABLES[name].timePartitioning.expirationMs,
        `${name} unexpectedly has partition expiration`,
      ).toBeUndefined();
    }
  });
});

describe('bq-export-schemas: api_keys PII guards (CLAUDE.md §1.4 + SOC 2)', () => {
  const apiKeysFieldNames = BQ_TABLES.api_keys.schema.fields.map((f) => f.name);

  it.each([...API_KEYS_FORBIDDEN_COLUMNS])(
    'api_keys schema does NOT contain forbidden column "%s"',
    (forbidden) => {
      expect(apiKeysFieldNames).not.toContain(forbidden);
    },
  );

  it.each([...API_KEYS_FORBIDDEN_COLUMNS])(
    'API_KEYS_COLUMN_ALLOWLIST does NOT contain forbidden column "%s"',
    (forbidden) => {
      expect(API_KEYS_COLUMN_ALLOWLIST).not.toContain(forbidden);
    },
  );

  it('every api_keys schema field is either bq_synced_at, snapshot_date, or in the source allowlist', () => {
    const exportColumns = new Set([...API_KEYS_COLUMN_ALLOWLIST, 'bq_synced_at', 'snapshot_date']);
    const stray = apiKeysFieldNames.filter((name) => !exportColumns.has(name));
    expect(stray, `api_keys schema has fields not in allowlist: ${stray.join(', ')}`).toEqual([]);
  });

  it('every API_KEYS_COLUMN_ALLOWLIST entry has a corresponding api_keys schema field', () => {
    for (const allowed of API_KEYS_COLUMN_ALLOWLIST) {
      expect(apiKeysFieldNames, `api_keys schema missing allowlisted column "${allowed}"`).toContain(allowed);
    }
  });

  it('forbidden columns and allowlist are disjoint', () => {
    const intersection = API_KEYS_COLUMN_ALLOWLIST.filter((c) =>
      API_KEYS_FORBIDDEN_COLUMNS.includes(c),
    );
    expect(intersection).toEqual([]);
  });
});

function flatFields(t: BqTableTarget): readonly BqField[] {
  return t.schema.fields;
}

describe('bq-export-schemas: required-field invariants', () => {
  it('every table has an id field of type STRING', () => {
    for (const [name, table] of Object.entries(BQ_TABLES)) {
      const id = flatFields(table).find((f) => f.name === 'id');
      expect(id, `${name} missing id field`).toBeDefined();
      expect(id!.type).toBe('STRING');
      expect(id!.mode).toBe('REQUIRED');
    }
  });

  it('every table has a bq_synced_at TIMESTAMP REQUIRED field for freshness SLO checks', () => {
    for (const [name, table] of Object.entries(BQ_TABLES)) {
      const synced = flatFields(table).find((f) => f.name === 'bq_synced_at');
      expect(synced, `${name} missing bq_synced_at`).toBeDefined();
      expect(synced!.type).toBe('TIMESTAMP');
      expect(synced!.mode).toBe('REQUIRED');
    }
  });

  it('append-only tables have a created_at TIMESTAMP REQUIRED field (used as partition key)', () => {
    for (const name of ['anchors', 'verifications', 'audit_events']) {
      const created = flatFields(BQ_TABLES[name]).find((f) => f.name === 'created_at');
      expect(created, `${name} missing created_at`).toBeDefined();
      expect(created!.type).toBe('TIMESTAMP');
      expect(created!.mode).toBe('REQUIRED');
    }
  });

  it('snapshot tables have a snapshot_date DATE REQUIRED field (used as partition key)', () => {
    for (const name of ['organizations', 'api_keys']) {
      const snap = flatFields(BQ_TABLES[name]).find((f) => f.name === 'snapshot_date');
      expect(snap, `${name} missing snapshot_date`).toBeDefined();
      expect(snap!.type).toBe('DATE');
      expect(snap!.mode).toBe('REQUIRED');
    }
  });
});

describe('bq-export-schemas: structural integrity', () => {
  it('no field name appears more than once in any table schema', () => {
    for (const [tableName, table] of Object.entries(BQ_TABLES)) {
      const names = table.schema.fields.map((f) => f.name);
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      expect(dupes, `${tableName} has duplicate field names: ${dupes.join(', ')}`).toEqual([]);
    }
  });

  it('clustering fields all reference fields that exist in the schema', () => {
    for (const [name, table] of Object.entries(BQ_TABLES)) {
      const fieldNames = new Set(table.schema.fields.map((f) => f.name));
      for (const cf of table.clustering?.fields ?? []) {
        expect(fieldNames.has(cf), `${name} clusters on missing field "${cf}"`).toBe(true);
      }
    }
  });

  it('partition field exists in the schema', () => {
    for (const [name, table] of Object.entries(BQ_TABLES)) {
      const fieldNames = new Set(table.schema.fields.map((f) => f.name));
      const pf = table.timePartitioning.field;
      expect(fieldNames.has(pf), `${name} partitions on missing field "${pf}"`).toBe(true);
    }
  });
});
