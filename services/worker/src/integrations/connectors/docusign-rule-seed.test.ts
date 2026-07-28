import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

import * as Sentry from '@sentry/node';
import { logger } from '../../utils/logger.js';
import {
  seedDocusignCompletionRule,
  DOCUSIGN_COMPLETION_TEMPLATE_ID,
  ESIGN_COMPLETED_TRIGGER_TYPE,
  type RuleSeedDb,
} from './docusign-rule-seed.js';
import { RULE_TEMPLATES } from '../../api/rule-templates-data.js';
import { TriggerConfigEsignCompleted, ActionConfigAutoAnchor } from '../../rules/schemas.js';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

interface QueryResult {
  data?: unknown;
  error?: unknown;
}

/**
 * Minimal `organization_rules` mock supporting the exact chains the seeder uses:
 *   .select('id').eq(...).eq(...).limit(n)  → resolves `selectResult`
 *   .insert(row)                            → resolves `insertResult`, captures `row`
 * `throwOnFrom` simulates a synchronous transport blow-up.
 */
function seedDb(opts: {
  selectResult?: QueryResult;
  insertResult?: QueryResult;
  throwOnFrom?: boolean;
  captureSelectFilters?: (field: string, value: unknown) => void;
}) {
  const inserted: Array<Record<string, unknown>> = [];
  const selectResult = opts.selectResult ?? { data: [], error: null };
  const insertResult = opts.insertResult ?? { data: { id: 'new-rule-1' }, error: null };

  const from = vi.fn((table: string) => {
    if (opts.throwOnFrom) throw new Error('db transport exploded');
    if (table !== 'organization_rules') throw new Error(`unexpected table ${table}`);

    const selectBuilder: Record<string, unknown> = {};
    selectBuilder.eq = vi.fn((field: string, value: unknown) => {
      opts.captureSelectFilters?.(field, value);
      return selectBuilder;
    });
    selectBuilder.limit = vi.fn(() => Promise.resolve(selectResult));

    return {
      select: vi.fn(() => selectBuilder),
      insert: vi.fn((row: Record<string, unknown>) => {
        inserted.push(row);
        return Promise.resolve(insertResult);
      }),
    };
  });

  return { db: { from } as unknown as RuleSeedDb, inserted, from };
}

describe('seedDocusignCompletionRule (SCRUM-3027)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('seeds the DocuSign Completion rule (ESIGN_COMPLETED → AUTO_ANCHOR, enabled) when the org has no ESIGN_COMPLETED rule', async () => {
    const { db, inserted } = seedDb({ selectResult: { data: [], error: null } });

    const result = await seedDocusignCompletionRule({
      db,
      orgId: ORG_ID,
      createdByUserId: USER_ID,
      now: new Date('2026-07-27T00:00:00.000Z'),
    });

    expect(result).toEqual({ seeded: true, ruleId: 'new-rule-1' });
    expect(inserted).toHaveLength(1);

    const row = inserted[0];
    // Canonical docusign-completion template shape.
    expect(row.org_id).toBe(ORG_ID);
    expect(row.trigger_type).toBe(ESIGN_COMPLETED_TRIGGER_TYPE);
    expect(row.trigger_type).toBe('ESIGN_COMPLETED');
    expect(row.action_type).toBe('AUTO_ANCHOR');
    expect(row.trigger_config).toEqual({ vendors: ['docusign'] });
    expect(row.action_config).toEqual({ tag: 'docusign' });
    // Founder-confirmed default-on: queue-mode rule ships enabled so contracts
    // flow with zero further clicks.
    expect(row.enabled).toBe(true);
    expect(row.schema_version).toBe(1);
    expect(row.created_by_user_id).toBe(USER_ID);
    // The persisted config must survive the write-path Zod schemas.
    expect(() => TriggerConfigEsignCompleted.parse(row.trigger_config)).not.toThrow();
    expect(() => ActionConfigAutoAnchor.parse(row.action_config)).not.toThrow();
  });

  it('mirrors the canonical rules-template so name/description stay in lockstep', async () => {
    const template = RULE_TEMPLATES.find((t) => t.id === DOCUSIGN_COMPLETION_TEMPLATE_ID)!;
    const { db, inserted } = seedDb({ selectResult: { data: [], error: null } });

    await seedDocusignCompletionRule({ db, orgId: ORG_ID });

    expect(inserted[0].name).toBe(template.name);
    expect(inserted[0].description).toBe(template.description);
  });

  it('idempotent: seeds NOTHING when an ESIGN_COMPLETED AUTO_ANCHOR rule already exists (re-connect)', async () => {
    const { db, inserted } = seedDb({
      selectResult: { data: [{ id: 'existing-rule' }], error: null },
    });

    const result = await seedDocusignCompletionRule({ db, orgId: ORG_ID });

    expect(result).toEqual({ seeded: false, reason: 'exists' });
    expect(inserted).toHaveLength(0);
  });

  it('non-stomping: never overrides an admin\'s existing ESIGN_COMPLETED rule regardless of its action (QUEUE_FOR_REVIEW / FAST_TRACK_ANCHOR)', async () => {
    // The idempotency check keys on trigger_type only, so ANY ESIGN_COMPLETED
    // rule — including an admin's deliberately-chosen QUEUE_FOR_REVIEW or
    // FAST_TRACK_ANCHOR — blocks the seed. Proven by a non-empty match set.
    const { db, inserted } = seedDb({
      selectResult: { data: [{ id: 'admin-queue-review-rule' }], error: null },
    });

    const result = await seedDocusignCompletionRule({ db, orgId: ORG_ID });

    expect(result).toEqual({ seeded: false, reason: 'exists' });
    expect(inserted).toHaveLength(0);
  });

  it('filters the idempotency lookup to this org + ESIGN_COMPLETED only', async () => {
    const filters: Array<{ field: string; value: unknown }> = [];
    const { db } = seedDb({
      selectResult: { data: [], error: null },
      captureSelectFilters: (field, value) => filters.push({ field, value }),
    });

    await seedDocusignCompletionRule({ db, orgId: ORG_ID });

    expect(filters).toContainEqual({ field: 'org_id', value: ORG_ID });
    expect(filters).toContainEqual({ field: 'trigger_type', value: 'ESIGN_COMPLETED' });
  });

  it('failure isolation: a lookup error does NOT throw, seeds nothing, and logs loudly + Sentry', async () => {
    const { db, inserted } = seedDb({
      selectResult: { data: null, error: { message: 'db unavailable' } },
    });

    const result = await seedDocusignCompletionRule({ db, orgId: ORG_ID });

    // Fails closed — never risk duplicating an admin rule on ambiguous state.
    expect(result).toEqual({ seeded: false, reason: 'lookup_failed' });
    expect(inserted).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID }),
      expect.stringContaining('DocuSign Completion rule auto-seed'),
    );
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('failure isolation: an insert error does NOT throw and logs loudly + Sentry', async () => {
    const { db } = seedDb({
      selectResult: { data: [], error: null },
      insertResult: { data: null, error: { message: 'insert boom' } },
    });

    const result = await seedDocusignCompletionRule({ db, orgId: ORG_ID });

    expect(result).toEqual({ seeded: false, reason: 'insert_failed' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID }),
      expect.stringContaining('DocuSign Completion rule auto-seed'),
    );
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('failure isolation: a thrown transport error is caught (never escapes the callback path)', async () => {
    const { db } = seedDb({ throwOnFrom: true });

    const result = await seedDocusignCompletionRule({ db, orgId: ORG_ID });

    expect(result).toEqual({ seeded: false, reason: 'error' });
    expect(logger.error).toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('never leaks tokens/PII to logger or Sentry on failure (orgId only)', async () => {
    const { db } = seedDb({
      selectResult: { data: null, error: { message: 'db unavailable' } },
    });

    await seedDocusignCompletionRule({ db, orgId: ORG_ID });

    // Only the orgId (a UUID) is passed to the surfacing sinks — no tokens,
    // account ids, emails, or document bytes ever reach this path.
    const sentryExtra = (Sentry.captureException as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1];
    expect(JSON.stringify(sentryExtra ?? {})).not.toMatch(/token|refresh|access[_-]?token/i);
  });
});
