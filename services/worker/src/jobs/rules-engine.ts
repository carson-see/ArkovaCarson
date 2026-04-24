/**
 * Rules Engine Execution Worker (ARK-106 — SCRUM-1018)
 *
 * Called by the `/jobs/rules-engine` cron. Claims queued pending-evaluation
 * events, looks up matching rules for the event's org, runs the pure
 * `evaluateRules` check, and emits an organization_rule_executions row per
 * matched (rule, event) pair.
 *
 * This pass is idempotent-by-construction:
 *   - The SQL INSERT uses ON CONFLICT DO NOTHING on (rule_id, trigger_event_id)
 *     (enforced by migration 0224, unique index
 *     idx_organization_rule_executions_idempotency).
 *   - A partial failure mid-batch leaves the remaining rows for the next pass.
 *
 * Action dispatch (AUTO_ANCHOR / NOTIFY / ...) is a *separate* worker —
 * this runner only records "matched". A follow-up cron pass reads executions
 * in state PENDING and dispatches, so dispatch retries are independent from
 * evaluation retries.
 *
 * Queue lifecycle:
 *   - claim_pending_rule_events() flips PENDING → CLAIMED.
 *   - This worker persists any rule matches.
 *   - complete_claimed_rule_events() flips CLAIMED → PROCESSED only after the
 *     match write succeeds.
 *   - release_claimed_rule_events() flips CLAIMED → PENDING/FAILED on worker
 *     errors so custom-rule events are not stranded forever.
 */
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import {
  evaluateRules,
  type RuleRow,
  type TriggerEvent,
  type TriggerType,
} from '../rules/evaluator.js';
import { emitOrgAdminNotifications } from '../notifications/dispatcher.js';

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

interface MatchInsert {
  rule_id: string;
  event_id: string;
  org_id: string;
  match_reason: string;
  needs_semantic_match: boolean;
}

async function claimPendingEvents(): Promise<EventRow[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db.rpc as any)('claim_pending_rule_events', {
      p_limit: EVENTS_PER_TICK,
    });
    if (error) {
      // RPC may not exist yet in earlier environments — no-op pass.
      logger.debug({ error }, 'claim_pending_rule_events unavailable — no-op pass');
      return [];
    }
    return (data as EventRow[] | null) ?? [];
  } catch (err) {
    logger.warn({ error: err }, 'claim_pending_rule_events threw — treating as empty');
    return [];
  }
}

async function completeClaimedEvents(eventIds: string[]): Promise<boolean> {
  if (eventIds.length === 0) return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db.rpc as any)('complete_claimed_rule_events', {
      p_event_ids: eventIds,
    });
    if (error) {
      logger.warn({ error, count: eventIds.length }, 'complete_claimed_rule_events failed');
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ error: err, count: eventIds.length }, 'complete_claimed_rule_events threw');
    return false;
  }
}

async function releaseClaimedEvents(eventIds: string[], message: string): Promise<boolean> {
  if (eventIds.length === 0) return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db.rpc as any)('release_claimed_rule_events', {
      p_event_ids: eventIds,
      p_error: message,
    });
    if (error) {
      logger.warn({ error, count: eventIds.length }, 'release_claimed_rule_events failed');
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ error: err, count: eventIds.length }, 'release_claimed_rule_events threw');
    return false;
  }
}

function groupEventsByOrg(events: EventRow[]): Map<string, EventRow[]> {
  const byOrg = new Map<string, EventRow[]>();
  for (const ev of events) {
    const arr = byOrg.get(ev.org_id) ?? [];
    arr.push(ev);
    byOrg.set(ev.org_id, arr);
  }
  return byOrg;
}

/**
 * ONE SELECT covering every org in this tick — previous per-org loop was N
 * round-trips at Supabase latency. `in(...)` on a uuid list is index-friendly;
 * RLS + `enabled=true` narrow to the ruleset we care about.
 */
async function fetchRulesByOrg(orgIds: string[]): Promise<Map<string, RuleRow[]> | null> {
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
      return null;
    }
    const rulesByOrg = new Map<string, RuleRow[]>();
    for (const row of ((data as unknown) as RuleRow[] | null) ?? []) {
      const bucket = rulesByOrg.get(row.org_id) ?? [];
      bucket.push(row);
      rulesByOrg.set(row.org_id, bucket);
    }
    return rulesByOrg;
  } catch (err) {
    logger.error({ error: err }, 'organization_rules bulk fetch threw');
    return null;
  }
}

function toTriggerEvent(ev: EventRow): TriggerEvent {
  return {
    trigger_type: ev.trigger_type,
    org_id: ev.org_id,
    vendor: ev.vendor ?? undefined,
    filename: ev.filename ?? undefined,
    folder_path: ev.folder_path ?? undefined,
    sender_email: ev.sender_email ?? undefined,
    subject: ev.subject ?? undefined,
  };
}

/**
 * Persist matches as execution rows. Single upsert — DO NOTHING on conflict
 * preserves idempotency across retries. `PENDING` rows are picked up by the
 * action-dispatch worker in a follow-up pass.
 *
 * Schema alignment (migration 0224):
 *   - `trigger_event_id` is the idempotency key (TEXT, unique within rule).
 *     The claimed EventRow.id is a UUID string — safe to serialize.
 *   - `match_reason` is not a top-level column; it lives under
 *     `input_payload` as structured JSON. Keeping it nested means auditors
 *     can extend the payload without schema churn.
 *   - onConflict target matches idx_organization_rule_executions_idempotency.
 */
async function persistMatches(inserts: MatchInsert[]): Promise<{ recorded: number; errored: boolean }> {
  if (inserts.length === 0) return { recorded: 0, errored: false };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any)
      .from('organization_rule_executions')
      .upsert(
        inserts.map((i) => ({
          rule_id: i.rule_id,
          trigger_event_id: i.event_id,
          org_id: i.org_id,
          status: i.needs_semantic_match ? 'AWAITING_SEMANTIC_MATCH' : 'PENDING',
          input_payload: {
            match_reason: i.match_reason,
            needs_semantic_match: i.needs_semantic_match,
          },
        })),
        { onConflict: 'rule_id,trigger_event_id', ignoreDuplicates: true },
      );
    if (error) {
      logger.warn({ error, attempted: inserts.length }, 'rule executions upsert had errors');
      return { recorded: 0, errored: true };
    }
    return { recorded: inserts.length, errored: false };
  } catch (err) {
    logger.error({ error: err }, 'rule executions upsert threw');
    return { recorded: 0, errored: true };
  }
}

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

  const events = await claimPendingEvents();
  if (events.length === 0) return result;
  result.events_processed = events.length;
  const eventIds = events.map((ev) => ev.id);

  const byOrg = groupEventsByOrg(events);
  const rulesByOrg = await fetchRulesByOrg([...byOrg.keys()]);
  if (!rulesByOrg) {
    result.errors += events.length;
    const released = await releaseClaimedEvents(eventIds, 'Rules fetch failed');
    if (!released) result.errors += 1;
    return result;
  }

  const inserts: MatchInsert[] = [];
  for (const [orgId, orgEvents] of byOrg) {
    const rules = rulesByOrg.get(orgId) ?? [];
    if (rules.length === 0) {
      result.skipped += orgEvents.length;
      continue;
    }
    for (const ev of orgEvents) {
      const matches = evaluateRules(rules, toTriggerEvent(ev));
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

  const persist = await persistMatches(inserts);
  result.matches_recorded = persist.recorded;
  if (persist.errored) {
    result.errors += 1;
    const released = await releaseClaimedEvents(eventIds, 'Rule execution persistence failed');
    if (!released) result.errors += 1;
    return result;
  }

  const completed = await completeClaimedEvents(eventIds);
  if (!completed) result.errors += 1;
  if (persist.recorded > 0) {
    const byNotificationOrg = new Map<string, number>();
    for (const insert of inserts) {
      byNotificationOrg.set(insert.org_id, (byNotificationOrg.get(insert.org_id) ?? 0) + 1);
    }
    await Promise.all([...byNotificationOrg.entries()].map(([orgId, matchesRecorded]) =>
      emitOrgAdminNotifications({
        type: 'rule_fired',
        organizationId: orgId,
        payload: { matchesRecorded },
      }),
    ));
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
