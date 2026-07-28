/**
 * SCRUM-3027 — Auto-seed the "DocuSign Completion" rule on org DocuSign connect.
 *
 * Founder-confirmed default-on behavior: when an org admin connects their
 * organization's DocuSign account, the canonical DocuSign Completion rule
 * (`ESIGN_COMPLETED` → `AUTO_ANCHOR`, queue-mode) is auto-seeded for that org so
 * fully-executed contracts flow into the anchoring pipeline with zero further
 * clicks.
 *
 * Two invariants make this safe to run on every connect (including re-connects):
 *
 *   1. IDEMPOTENT + NON-STOMPING — if the org already has ANY `ESIGN_COMPLETED`
 *      rule (regardless of its action: `AUTO_ANCHOR`, `QUEUE_FOR_REVIEW`,
 *      `FAST_TRACK_ANCHOR`, …), this seeds NOTHING. An admin's existing choice is
 *      never overridden or duplicated. The lookup keys on `trigger_type` only,
 *      which is exactly "any e-sign rule already exists".
 *
 *   2. FAILURE ISOLATION — nothing here throws into the OAuth callback. Every
 *      failure path returns a discriminated result and is surfaced loudly
 *      (structured `logger.error` + Sentry, PII-safe: only the `orgId` UUID ever
 *      leaves this module — never tokens, account ids, emails, or bytes). On an
 *      ambiguous lookup failure we fail CLOSED (seed nothing) rather than risk
 *      duplicating an admin rule.
 *
 * Unlike the user/NL-authored rules CRUD path (`api/rules-crud.ts`), which forces
 * `enabled=false` as a SEC-02 prompt-injection defense, this seed is a fixed
 * canonical template triggered by an explicit human action (an org admin
 * completing the DocuSign OAuth connect). There is no untrusted authoring
 * surface, so shipping it `enabled=true` is the intended default-on behavior.
 */

import * as Sentry from '@sentry/node';
import { logger } from '../../utils/logger.js';
import { RULE_TEMPLATES, type RuleTemplate } from '../../api/rule-templates-data.js';
import {
  TriggerConfigEsignCompleted,
  ActionConfigAutoAnchor,
} from '../../rules/schemas.js';

/** Canonical template id in `api/rules-templates.ts`. */
export const DOCUSIGN_COMPLETION_TEMPLATE_ID = 'docusign-completion';

/** The e-sign trigger type the idempotency check keys on. */
export const ESIGN_COMPLETED_TRIGGER_TYPE = 'ESIGN_COMPLETED';

/** `organization_rules.schema_version` written for the seeded row. */
export const DOCUSIGN_COMPLETION_SCHEMA_VERSION = 1;

/**
 * Minimal structural view of the `organization_rules` writer, declared locally
 * (rather than reusing a router `DbClient`) so the DocuSign router and tests can
 * satisfy it without widening their own overloads — mirrors the
 * `ConnectorAlertStateDb` pattern in `docusign-connect-health.ts`.
 */
interface RuleSeedSelectBuilder {
  eq(field: string, value: unknown): RuleSeedSelectBuilder;
  limit(count: number): PromiseLike<{ data: Array<{ id: string }> | null; error: unknown }>;
}

export interface OrganizationRuleSeedInsert {
  org_id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  action_type: string;
  action_config: Record<string, unknown>;
  enabled: boolean;
  schema_version: number;
  created_by_user_id: string | null;
}

export interface RuleSeedDb {
  from(table: 'organization_rules'): {
    select(columns: string): RuleSeedSelectBuilder;
    insert(
      value: OrganizationRuleSeedInsert,
    ): PromiseLike<{ data: { id?: string } | null; error: unknown }>;
  };
}

export type SeedResult =
  | { seeded: true; ruleId: string | null }
  | { seeded: false; reason: 'exists' | 'lookup_failed' | 'insert_failed' | 'error' };

function resolveTemplate(): RuleTemplate {
  const template = RULE_TEMPLATES.find((t) => t.id === DOCUSIGN_COMPLETION_TEMPLATE_ID);
  if (!template) {
    // Defensive: the template is a static constant, so this only fires if the
    // template id was renamed/removed without updating this seeder.
    throw new Error(
      `DocuSign Completion template '${DOCUSIGN_COMPLETION_TEMPLATE_ID}' not found in RULE_TEMPLATES`,
    );
  }
  return template;
}

/**
 * Build the `organization_rules` insert row from the canonical template,
 * validating both config shapes against the write-path Zod schemas so a bad
 * template edit can never persist a config the rules engine would then skip.
 */
export function buildDocusignCompletionRuleRow(args: {
  orgId: string;
  createdByUserId?: string | null;
}): OrganizationRuleSeedInsert {
  const template = resolveTemplate();
  // Parse (not just assert) so the stored config is the validated/defaulted
  // shape — identical to how `validateRuleConfigs` guards the CRUD write path.
  const triggerConfig = TriggerConfigEsignCompleted.parse(template.default_trigger_config);
  const actionConfig = ActionConfigAutoAnchor.parse(template.default_action_config);

  return {
    org_id: args.orgId,
    name: template.name,
    description: template.description,
    trigger_type: template.trigger_type, // ESIGN_COMPLETED
    trigger_config: triggerConfig, // { vendors: ['docusign'] }
    action_type: template.action_type, // AUTO_ANCHOR (queue-mode)
    action_config: actionConfig, // { tag: 'docusign' }
    enabled: true, // founder-confirmed default-on (see module header)
    schema_version: DOCUSIGN_COMPLETION_SCHEMA_VERSION,
    created_by_user_id: args.createdByUserId ?? null,
  };
}

/**
 * Loudly + PII-safely surface a non-fatal seed failure. Only the `orgId` and a
 * short reason string reach the logger/Sentry — never tokens or bytes.
 */
function surfaceSeedFailure(
  reason: 'lookup_failed' | 'insert_failed' | 'error',
  orgId: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(
    { orgId, reason, message },
    'DocuSign Completion rule auto-seed failed (non-fatal — connect flow unaffected)',
  );
  try {
    Sentry.captureException(error instanceof Error ? error : new Error(message), {
      level: 'warning',
      tags: {
        connector_id: 'docusign',
        stage: 'rule_seed',
        seed_reason: reason,
      },
      // orgId only — deliberately no tokens/account ids/emails/bytes.
      extra: { org_id: orgId, reason },
    });
  } catch (sentryErr) {
    logger.warn(
      { message: sentryErr instanceof Error ? sentryErr.message : String(sentryErr) },
      'Failed to dispatch DocuSign Completion rule seed failure to Sentry',
    );
  }
}

/**
 * Idempotently seed the DocuSign Completion rule for `orgId`. NEVER throws.
 *
 * Returns a discriminated {@link SeedResult} so the caller can (optionally)
 * record an `integration_events` row without needing this module to know about
 * router-local db typing.
 */
export async function seedDocusignCompletionRule(args: {
  db: RuleSeedDb;
  orgId: string;
  createdByUserId?: string | null;
  now?: Date;
}): Promise<SeedResult> {
  const { db, orgId } = args;

  try {
    // (1) Idempotency + non-stomping guard: any existing ESIGN_COMPLETED rule
    // (any action) means the org already made a choice — seed nothing.
    const { data: existing, error: lookupError } = await db
      .from('organization_rules')
      .select('id')
      .eq('org_id', orgId)
      .eq('trigger_type', ESIGN_COMPLETED_TRIGGER_TYPE)
      .limit(1);

    if (lookupError) {
      // Fail CLOSED: without a reliable read we cannot prove absence, and
      // duplicating an admin's rule is worse than skipping the convenience seed.
      surfaceSeedFailure('lookup_failed', orgId, lookupError);
      return { seeded: false, reason: 'lookup_failed' };
    }
    if (existing && existing.length > 0) {
      logger.info(
        { orgId },
        'DocuSign Completion rule auto-seed skipped — org already has an ESIGN_COMPLETED rule',
      );
      return { seeded: false, reason: 'exists' };
    }

    // (2) Seed the canonical rule (enabled, queue-mode).
    const row = buildDocusignCompletionRuleRow({
      orgId,
      createdByUserId: args.createdByUserId,
    });
    // eslint-disable-next-line arkova/missing-org-filter -- write, not a read: the tenant scope is carried by row.org_id set above, not a leaking cross-tenant SELECT.
    const { data, error: insertError } = await db.from('organization_rules').insert(row);

    if (insertError) {
      surfaceSeedFailure('insert_failed', orgId, insertError);
      return { seeded: false, reason: 'insert_failed' };
    }

    const ruleId = data?.id ?? null;
    logger.info(
      { orgId, ruleId },
      'DocuSign Completion rule auto-seeded (ESIGN_COMPLETED → AUTO_ANCHOR, enabled)',
    );
    return { seeded: true, ruleId };
  } catch (error) {
    surfaceSeedFailure('error', orgId, error);
    return { seeded: false, reason: 'error' };
  }
}
