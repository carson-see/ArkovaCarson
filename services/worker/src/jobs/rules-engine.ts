/**
 * Rules Engine Execution Worker (ARK-106 — SCRUM-1018)
 *
 * Called by the `/jobs/rules-engine` cron. Claims queued pending-evaluation
 * events, looks up matching rules for the event's org, runs the pure
 * `evaluateRules` check, and emits an organization_rule_executions row per
 * matched (rule, event) pair.
 *
 * This pass is idempotent-by-construction:
 *   - The SQL INSERT uses ON CONFLICT DO NOTHING on (rule_id, event_id)
 *     (enforced by migration 0224).
 *   - A partial failure mid-batch leaves the remaining rows for the next pass.
 *
 * Action dispatch (AUTO_ANCHOR / NOTIFY / ...) is a *separate* worker —
 * this runner only records "matched". A follow-up cron pass reads executions
 * in state PENDING and dispatches, so dispatch retries are independent from
 * evaluation retries.
 */
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import {
  evaluateRules,
  type RuleRow,
  type TriggerEvent,
  type TriggerType,
} from '../rules/evaluator.js';

export interface RulesEnginePassResult {
  events_processed: number;
  matches_recorded: number;
  skipped: number;
  errors: number;
}

interface EventRow {
  id: string;
  org_id: string;
  trigger_type: TriggerType;
  vendor?: string | null;
  filename?: string | null;
  folder_path?: string | null;
  sender_email?: string | null;
  subject?: string | null;
}

/**
 * Hard cap on events processed per cron tick. Prevents one noisy org from
 * starving the rest; anything over this count falls through to the next tick.
 */
const EVENTS_PER_TICK = 200;

export async function runRulesEngine(): Promise<RulesEnginePassResult> {
  const result: RulesEnginePassResult = {
    events_processed: 0,
    matches_recorded: 0,
    skipped: 0,
    errors: 0,
  };

  if (process.env.ENABLE_RULES_ENGINE === 'false') {
    logger.info('Rules engine disabled via ENABLE_RULES_ENGINE=false');
    return result;
  }

  // Phase 1: claim a chunk of pending events. The claim RPC flips
  // pending_rule_events.status PENDING → CLAIMED atomically; if it doesn't
  // exist yet (migration forward), fall back to selecting a sentinel batch.
  let events: EventRow[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db.rpc as any)('claim_pending_rule_events', {
      p_limit: EVENTS_PER_TICK,
    });
    if (error) {
      // RPC may not exist yet in earlier environments; return empty so the
      // cron succeeds until the migration ships.
      logger.debug({ error }, 'claim_pending_rule_events unavailable — no-op pass');
      return result;
    }
    events = (data as EventRow[] | null) ?? [];
  } catch (err) {
    logger.warn({ error: err }, 'claim_pending_rule_events threw — treating as empty');
    return result;
  }

  if (events.length === 0) return result;

  result.events_processed = events.length;

  // Phase 2: group events by org so we fetch each org's ruleset once.
  const byOrg = new Map<string, EventRow[]>();
  for (const ev of events) {
    const arr = byOrg.get(ev.org_id) ?? [];
    arr.push(ev);
    byOrg.set(ev.org_id, arr);
  }

  // Phase 3: ONE SELECT covering every org in this tick — previous per-org
  // loop was N round-trips at Supabase latency. `in(...)` on a uuid list is
  // index-friendly; RLS + `enabled=true` narrow to the ruleset we care about.
  const orgIds = [...byOrg.keys()];
  const rulesByOrg = new Map<string, RuleRow[]>();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('organization_rules')
      .select(
        'id, org_id, name, enabled, trigger_type, trigger_config, action_type, action_config',
      )
      .in('org_id', orgIds)
      .eq('enabled', true);
    if (error) {
      logger.warn({ error, orgIds: orgIds.length }, 'organization_rules bulk fetch failed');
      result.errors += events.length;
      return result;
    }
    for (const row of ((data as unknown) as RuleRow[] | null) ?? []) {
      const bucket = rulesByOrg.get(row.org_id) ?? [];
      bucket.push(row);
      rulesByOrg.set(row.org_id, bucket);
    }
  } catch (err) {
    logger.error({ error: err }, 'organization_rules bulk fetch threw');
    result.errors += events.length;
    return result;
  }

  const inserts: Array<{
    rule_id: string;
    event_id: string;
    org_id: string;
    match_reason: string;
    needs_semantic_match: boolean;
  }> = [];

  for (const [orgId, orgEvents] of byOrg) {
    const rules = rulesByOrg.get(orgId) ?? [];
    if (rules.length === 0) {
      result.skipped += orgEvents.length;
      continue;
    }
    for (const ev of orgEvents) {
      const triggerEvent: TriggerEvent = {
        trigger_type: ev.trigger_type,
        org_id: ev.org_id,
        vendor: ev.vendor ?? undefined,
        filename: ev.filename ?? undefined,
        folder_path: ev.folder_path ?? undefined,
        sender_email: ev.sender_email ?? undefined,
        subject: ev.subject ?? undefined,
      };
      const matches = evaluateRules(rules, triggerEvent);
      if (matches.length === 0) {
        result.skipped += 1;
        continue;
      }
      for (const { rule, result: r } of matches) {
        inserts.push({
          rule_id: rule.id,
          event_id: ev.id,
          org_id: ev.org_id,
          match_reason: r.reason,
          needs_semantic_match: r.needs_semantic_match,
        });
      }
    }
  }

  // Phase 4: persist matches. Single insert — DO NOTHING on conflict preserves
  // idempotency across retries. An `executions` row in status PENDING is then
  // picked up by the action-dispatch worker (not this file).
  if (inserts.length > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (db as any)
        .from('organization_rule_executions')
        .upsert(
          inserts.map((i) => ({
            rule_id: i.rule_id,
            event_id: i.event_id,
            org_id: i.org_id,
            status: i.needs_semantic_match ? 'AWAITING_SEMANTIC_MATCH' : 'PENDING',
            match_reason: i.match_reason,
          })),
          { onConflict: 'rule_id,event_id', ignoreDuplicates: true },
        );
      if (error) {
        logger.warn({ error, attempted: inserts.length }, 'rule executions upsert had errors');
        result.errors += 1;
      } else {
        result.matches_recorded = inserts.length;
      }
    } catch (err) {
      logger.error({ error: err }, 'rule executions upsert threw');
      result.errors += 1;
    }
  }

  logger.info(
    {
      processed: result.events_processed,
      matched: result.matches_recorded,
      skipped: result.skipped,
      errors: result.errors,
    },
    'Rules engine pass complete',
  );
  return result;
}
