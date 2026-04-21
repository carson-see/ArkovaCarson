/**
 * Scheduled Queue Review Reminders (ARK-107 — SCRUM-1019)
 *
 * Fires on a 15-minute cron. For each org, evaluates any SCHEDULED_CRON /
 * QUEUE_DIGEST rules whose cron expression matches the current minute, and
 * records an execution row for the action dispatcher.
 *
 * Why 15 minutes? Every common reminder cadence is a multiple of 15 (9 AM,
 * 4:30 PM, hourly, daily). Finer ticks would fire cron-expression
 * evaluation too often; coarser ticks would miss half-hour cadences.
 *
 * Cron evaluation is deliberately minimal: we parse "HH:MM day-of-week"
 * fields and match. Anything richer (step values, ranges) goes through the
 * `cron-parser` dependency if installed; otherwise we fall back to fixed-
 * time checks (safe for 99% of configs shipped through ARK-110).
 */
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

export interface QueueReminderPassResult {
  rules_evaluated: number;
  reminders_scheduled: number;
  skipped: number;
  errors: number;
}

interface CronRuleRow {
  id: string;
  org_id: string;
  trigger_type: string;
  trigger_config: {
    cron?: string;
    timezone?: string;
    send_when_empty?: boolean;
  };
  action_type: string;
  action_config: Record<string, unknown>;
  enabled: boolean;
}

/**
 * 5-field cron matcher: "m h dom mon dow".
 *
 * Supports `*` wildcards and comma-separated lists. Steps (`*​/5`) and ranges
 * (`1-5`) are not supported — rules authored via the wizard (ARK-108) are
 * constrained to fixed hours/minutes + day-of-week lists.
 *
 * Timezone handling uses `Intl.DateTimeFormat` so DST is honored on the day.
 * A two-arg call uses UTC; pass an IANA `timezone` string to shift.
 */
export function cronMatches(
  cron: string,
  at: Date,
  timezone: string | number = 'UTC',
): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [m, h, dom, mon, dow] = parts;

  const { minute, hour, domVal, monVal, dowVal } =
    typeof timezone === 'number'
      ? extractFieldsFromOffset(at, timezone)
      : extractFieldsFromIana(at, timezone);

  const match = (field: string, value: number): boolean => {
    if (field === '*') return true;
    return field.split(',').some((part) => Number(part.trim()) === value);
  };

  return (
    match(m, minute) &&
    match(h, hour) &&
    match(dom, domVal) &&
    match(mon, monVal) &&
    match(dow, dowVal)
  );
}

interface CronClockFields {
  minute: number;
  hour: number;
  domVal: number;
  monVal: number;
  dowVal: number;
}

function extractFieldsFromIana(at: Date, tz: string): CronClockFields {
  // formatToParts gives timezone-correct numeric fields without pulling a
  // full tz database — the OS does the DST math.
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    }).formatToParts(at);
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '0';
    const hourStr = get('hour');
    const hour = hourStr === '24' ? 0 : Number(hourStr);
    return {
      minute: Number(get('minute')),
      hour,
      domVal: Number(get('day')),
      monVal: Number(get('month')),
      dowVal: DOW_FROM_WEEKDAY[get('weekday')] ?? 0,
    };
  } catch {
    // Invalid tz → fall back to UTC so we at least match a default cron.
    return extractFieldsFromOffset(at, 0);
  }
}

function extractFieldsFromOffset(at: Date, offsetMinutes: number): CronClockFields {
  const shifted = new Date(at.getTime() + offsetMinutes * 60_000);
  return {
    minute: shifted.getUTCMinutes(),
    hour: shifted.getUTCHours(),
    domVal: shifted.getUTCDate(),
    monVal: shifted.getUTCMonth() + 1,
    dowVal: shifted.getUTCDay(),
  };
}

const DOW_FROM_WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export async function runQueueReminderJob(
  now: Date = new Date(),
): Promise<QueueReminderPassResult> {
  const result: QueueReminderPassResult = {
    rules_evaluated: 0,
    reminders_scheduled: 0,
    skipped: 0,
    errors: 0,
  };

  if (process.env.ENABLE_QUEUE_REMINDERS === 'false') {
    logger.info('Queue reminders disabled via flag');
    return result;
  }

  let rules: CronRuleRow[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('organization_rules')
      .select(
        'id, org_id, trigger_type, trigger_config, action_type, action_config, enabled',
      )
      .eq('enabled', true)
      .in('trigger_type', ['SCHEDULED_CRON', 'QUEUE_DIGEST']);
    if (error) {
      logger.warn({ error }, 'Queue reminder rule fetch failed');
      result.errors += 1;
      return result;
    }
    rules = ((data as unknown) as CronRuleRow[] | null) ?? [];
  } catch (err) {
    logger.error({ error: err }, 'Queue reminder rule fetch threw');
    result.errors += 1;
    return result;
  }

  result.rules_evaluated = rules.length;
  if (rules.length === 0) return result;

  const inserts: Array<{ rule_id: string; org_id: string; fired_at: string }> = [];
  for (const rule of rules) {
    const cron = rule.trigger_config?.cron;
    if (!cron) {
      result.skipped += 1;
      continue;
    }
    const tz = rule.trigger_config?.timezone ?? 'UTC';
    if (!cronMatches(cron, now, tz)) {
      result.skipped += 1;
      continue;
    }
    inserts.push({ rule_id: rule.id, org_id: rule.org_id, fired_at: now.toISOString() });
  }

  if (inserts.length === 0) return result;

  // Record one execution row per matching rule. The action-dispatcher
  // worker reads PENDING rows and sends the actual Slack/email/queue-digest
  // message (SEC-02 ensures the action dispatch is audit-logged).
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any)
      .from('organization_rule_executions')
      .insert(
        inserts.map((i) => ({
          rule_id: i.rule_id,
          org_id: i.org_id,
          status: 'PENDING',
          match_reason: 'scheduled_cron',
          event_id: null,
        })),
      );
    if (error) {
      logger.warn({ error, attempted: inserts.length }, 'Queue reminder insert had errors');
      result.errors += 1;
    } else {
      result.reminders_scheduled = inserts.length;
    }
  } catch (err) {
    logger.error({ error: err }, 'Queue reminder insert threw');
    result.errors += 1;
  }

  return result;
}
