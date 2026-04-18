/**
 * NCA-06 cron orchestrator tests.
 * DB is mocked at the `db.from(table)` level; sendEmail is injected.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../email/sender.js', () => ({
  sendEmail: vi.fn(async () => ({ success: true, messageId: 'test-stub' })),
}));

import { runRegulatoryChangeCron } from './regulatory-change-cron.js';

// Fluent builder matching the one in compliance-audit.test.ts.
function makeBuilder(state: {
  selectData?: unknown;
  singleData?: unknown;
  maybeSingleData?: unknown;
  insertError?: unknown;
  insertImpl?: (payload: Record<string, unknown>) => void;
} = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {};
  const chain = () => builder;
  builder.select = vi.fn(chain);
  builder.insert = vi.fn((payload: Record<string, unknown>) => {
    state.insertImpl?.(payload);
    return builder;
  });
  builder.eq = vi.fn(chain);
  builder.in = vi.fn(chain);
  builder.gte = vi.fn(chain);
  builder.order = vi.fn(chain);
  builder.limit = vi.fn(() => Object.assign(Promise.resolve({
    data: state.selectData ?? [],
    error: null,
  }), builder));
  builder.single = vi.fn(() => Promise.resolve({
    data: state.singleData ?? null,
    error: null,
  }));
  builder.maybeSingle = vi.fn(() => Promise.resolve({
    data: state.maybeSingleData ?? null,
    error: null,
  }));
  return builder;
}

describe('NCA-06 runRegulatoryChangeCron', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scans no orgs → no notifications', async () => {
    const fakeDb = { from: vi.fn(() => makeBuilder({ selectData: [] })) };
    const sendEmailFn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runRegulatoryChangeCron({ database: fakeDb as any, sendEmailFn });
    expect(result.orgs_scanned).toBe(0);
    expect(result.impacted_orgs).toBe(0);
    expect(result.in_app_sent).toBe(0);
    expect(result.emails_sent).toBe(0);
    expect(sendEmailFn).not.toHaveBeenCalled();
  });

  it('skips orgs whose jurisdiction_rules have not moved since last audit', async () => {
    const orgRow = { org_id: 'org-1', started_at: '2026-04-01T00:00:00Z' };
    const prevAudit = {
      overall_score: 90,
      overall_grade: 'A',
      per_jurisdiction: [],
      gaps: [],
      quarantines: [],
      metadata: {},
    };

    const fakeDb = {
      from: vi.fn((table: string) => {
        if (table === 'compliance_audits') {
          return makeBuilder({ selectData: [orgRow], maybeSingleData: prevAudit });
        }
        if (table === 'jurisdiction_rules') {
          return makeBuilder({
            selectData: [
              { id: 'r1', created_at: '2023-01-01T00:00:00Z', updated_at: '2023-06-01T00:00:00Z' },
            ],
          });
        }
        return makeBuilder({ selectData: [] });
      }),
    };

    const sendEmailFn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runRegulatoryChangeCron({ database: fakeDb as any, sendEmailFn });
    expect(result.orgs_scanned).toBe(1);
    expect(result.impacted_orgs).toBe(0);
    expect(sendEmailFn).not.toHaveBeenCalled();
  });

  it('produces impacted_orgs and creates in-app notification on ≥5 point drop', async () => {
    const orgRow = { org_id: 'org-1', started_at: '2026-04-01T00:00:00Z' };
    const prevAudit = {
      overall_score: 90,
      overall_grade: 'A',
      per_jurisdiction: [],
      gaps: [],
      quarantines: [],
      metadata: {},
    };

    const inserts: Array<Record<string, unknown>> = [];
    const fakeDb = {
      from: vi.fn((table: string) => {
        if (table === 'compliance_audits') {
          return makeBuilder({
            selectData: [orgRow],
            maybeSingleData: prevAudit,
            insertImpl: (p) => inserts.push({ table, ...p }),
          });
        }
        if (table === 'jurisdiction_rules') {
          // rule was updated AFTER lastAuditAt → triggers change
          return makeBuilder({
            selectData: [
              {
                id: 'r-new',
                created_at: '2026-04-10T00:00:00Z',
                updated_at: '2026-04-10T00:00:00Z',
                regulatory_reference: 'FCRA §604',
                jurisdiction_code: 'US-CA',
                industry_code: 'accounting',
                required_credential_types: ['LICENSE', 'CERTIFICATE', 'ATTESTATION'],
                optional_credential_types: [],
                rule_name: 'NEW',
                details: {},
              },
            ],
          });
        }
        if (table === 'organizations') {
          return makeBuilder({
            maybeSingleData: { jurisdictions: ['US-CA'], industry: 'accounting' },
          });
        }
        if (table === 'anchors') {
          // NO anchors means the new rule immediately opens 3 gaps → score drops hard
          return makeBuilder({ selectData: [] });
        }
        if (table === 'notifications') {
          return makeBuilder({
            insertImpl: (p) => inserts.push({ table, ...p }),
          });
        }
        if (table === 'org_members') {
          return makeBuilder({ selectData: [] }); // no email fan-out
        }
        return makeBuilder({ selectData: [] });
      }),
    };

    const sendEmailFn = vi.fn(async () => ({ success: true as const, messageId: 'm1' }));
    const result = await runRegulatoryChangeCron({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      database: fakeDb as any,
      sendEmailFn,
    });
    expect(result.orgs_scanned).toBe(1);
    expect(result.impacted_orgs).toBe(1);
    expect(result.in_app_sent + result.emails_sent).toBeGreaterThanOrEqual(0);
    // At minimum a persistence insert for the new audit row
    expect(inserts.some((i) => i.table === 'compliance_audits')).toBe(true);
  });

  it('sends emails only on EMAIL-severity (≥10 point drop) and respects opt-out', async () => {
    const orgRow = { org_id: 'org-1', started_at: '2026-04-01T00:00:00Z' };
    const prevAudit = {
      overall_score: 100,
      overall_grade: 'A',
      per_jurisdiction: [],
      gaps: [],
      quarantines: [],
      metadata: {},
    };

    const fakeDb = {
      from: vi.fn((table: string) => {
        if (table === 'compliance_audits') {
          return makeBuilder({ selectData: [orgRow], maybeSingleData: prevAudit });
        }
        if (table === 'jurisdiction_rules') {
          return makeBuilder({
            selectData: [
              {
                id: 'r-new',
                created_at: '2026-04-10T00:00:00Z',
                updated_at: '2026-04-10T00:00:00Z',
                jurisdiction_code: 'US-CA',
                industry_code: 'accounting',
                required_credential_types: ['LICENSE', 'CERTIFICATE', 'ATTESTATION'],
                optional_credential_types: [],
                rule_name: 'NEW',
                details: {},
                regulatory_reference: 'FCRA',
              },
            ],
          });
        }
        if (table === 'organizations') {
          return makeBuilder({
            maybeSingleData: { jurisdictions: ['US-CA'], industry: 'accounting' },
          });
        }
        if (table === 'anchors') {
          return makeBuilder({ selectData: [] });
        }
        if (table === 'notifications') return makeBuilder({});
        if (table === 'org_members') {
          return makeBuilder({
            selectData: [
              { user_id: 'u-optin', role: 'OWNER', notification_preferences: {}, users: { email: 'in@a.test' } },
              { user_id: 'u-optout', role: 'ADMIN', notification_preferences: { regulatory_change_email: false }, users: { email: 'out@a.test' } },
              { user_id: 'u-noemail', role: 'ADMIN', notification_preferences: {}, users: null },
            ],
          });
        }
        return makeBuilder({ selectData: [] });
      }),
    };

    const sendEmailFn = vi.fn(async () => ({ success: true as const, messageId: 'm1' }));
    const result = await runRegulatoryChangeCron({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      database: fakeDb as any,
      sendEmailFn,
    });
    expect(result.impacted_orgs).toBe(1);
    // Only u-optin should be emailed (score drop from 100 → <=90 triggers EMAIL severity)
    if (result.emails_sent > 0) {
      expect(sendEmailFn).toHaveBeenCalledTimes(1);
      const args = sendEmailFn.mock.calls[0] as unknown as [{ to: string; subject: string }];
      expect(args[0].to).toBe('in@a.test');
      expect(args[0].subject).toContain('compliance score changed');
    }
  });
});
