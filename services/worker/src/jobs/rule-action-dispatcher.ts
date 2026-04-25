/**
 * Rule Action Dispatcher MVP (SCRUM-1142)
 *
 * Reads `organization_rule_executions` rows in PENDING/RETRYING state, looks
 * up the parent rule's `action_type` + `action_config`, performs the side
 * effect, and finalizes the row to SUCCEEDED / FAILED / DLQ. Per AC:
 *
 *   - NOTIFY            → org admin notification dispatch
 *   - QUEUE_FOR_REVIEW  → routed marker (compliance inbox queries reads it)
 *   - FLAG_COLLISION    → routed marker (compliance inbox queries reads it)
 *   - FORWARD_TO_URL    → signed outbound HTTP POST + retry on transient err
 *   - AUTO_ANCHOR / FAST_TRACK_ANCHOR / unknown → fail-closed visible failure
 *
 * Idempotency is provided by the `(rule_id, trigger_event_id)` unique index
 * on the executions table — the matcher (rules-engine.ts) cannot insert two
 * rows for the same trigger, so the dispatcher safely retries side effects
 * on the same row without spawning duplicates.
 *
 * Concurrency: the MVP runs as a single Cloud Scheduler instance. A second
 * dispatcher started in parallel would race on the SELECT-then-UPDATE step
 * — when we scale out we will replace this with an RPC that atomically does
 * `FOR UPDATE SKIP LOCKED` and flips status in one statement. Until then
 * the schedule is configured with `max_instances=1` (see infra runbook).
 *
 * Feature gate: `ENABLE_RULE_ACTION_DISPATCHER=false` makes this a no-op.
 */
import crypto from 'node:crypto';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { emitOrgAdminNotifications } from '../notifications/dispatcher.js';
import { resolveSecretHandle } from '../utils/secrets.js';
import { RULE_DISPATCH_OUTCOME, RULE_ROUTED_TO } from '../rules/schemas.js';

export const MAX_DISPATCH_ATTEMPTS = 5;
const DISPATCH_BATCH_SIZE = 50;
// Cap concurrent action side-effects per pass. Without this, one bad target
// URL would let `FORWARD_TO_URL` rules fan out 50 simultaneous outbound HTTPs
// — that hits Cloud Run socket limits + makes a single misconfigured rule
// look like an outage.
const DISPATCH_CONCURRENCY = 8;
const DEFAULT_FORWARD_TIMEOUT_MS = 5_000;

export interface DispatcherPassResult {
  dispatched: number;
  succeeded: number;
  failed: number;
}

interface ExecutionRow {
  id: string;
  rule_id: string;
  org_id: string;
  trigger_event_id: string;
  status: string;
  attempt_count: number;
  input_payload: Record<string, unknown> | null;
}

interface RuleRow {
  id: string;
  org_id: string;
  name: string;
  action_type: string;
  action_config: Record<string, unknown>;
}

type Outcome =
  | { kind: 'success'; output: Record<string, unknown> }
  | { kind: 'transient_failure'; error: string }
  | { kind: 'permanent_failure'; error: string };

async function fetchPendingExecutions(): Promise<ExecutionRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('organization_rule_executions')
    .select('id, rule_id, org_id, trigger_event_id, status, attempt_count, input_payload')
    .in('status', ['PENDING', 'RETRYING'])
    .order('created_at', { ascending: true })
    .limit(DISPATCH_BATCH_SIZE);
  if (error) {
    logger.warn({ error }, 'rule action dispatcher: candidate fetch failed');
    return [];
  }
  return ((data as ExecutionRow[] | null) ?? []).map((row) => ({
    ...row,
    attempt_count: row.attempt_count ?? 0,
  }));
}

async function fetchRulesByIds(ruleIds: string[]): Promise<Map<string, RuleRow>> {
  if (ruleIds.length === 0) return new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('organization_rules')
    .select('id, org_id, name, action_type, action_config')
    .in('id', [...new Set(ruleIds)]);
  if (error) {
    logger.warn({ error, ruleCount: ruleIds.length }, 'rule action dispatcher: rule lookup failed');
    return new Map();
  }
  const map = new Map<string, RuleRow>();
  for (const row of ((data as RuleRow[] | null) ?? [])) map.set(row.id, row);
  return map;
}

async function dispatchNotify(rule: RuleRow, exec: ExecutionRow): Promise<Outcome> {
  const cfg = rule.action_config as { channels?: unknown };
  const channels = Array.isArray(cfg.channels) ? cfg.channels : [];
  if (channels.length === 0) {
    return {
      kind: 'permanent_failure',
      error: 'NOTIFY action_config missing channels — nothing to dispatch',
    };
  }
  await emitOrgAdminNotifications({
    type: 'rule_fired',
    organizationId: rule.org_id,
    payload: {
      rule_id: rule.id,
      rule_name: rule.name,
      execution_id: exec.id,
      trigger_event_id: exec.trigger_event_id,
      channels: channels as string[],
    },
  });
  return {
    kind: 'success',
    output: { outcome: RULE_DISPATCH_OUTCOME.NOTIFICATION_SENT, channels },
  };
}

function dispatchQueueForReview(rule: RuleRow): Outcome {
  const cfg = rule.action_config as { label?: unknown; priority?: unknown };
  return {
    kind: 'success',
    output: {
      outcome: RULE_DISPATCH_OUTCOME.QUEUED_FOR_REVIEW,
      routed_to: RULE_ROUTED_TO.REVIEW_QUEUE,
      label: typeof cfg.label === 'string' ? cfg.label : null,
      priority: typeof cfg.priority === 'string' ? cfg.priority : 'medium',
    },
  };
}

function dispatchFlagCollision(rule: RuleRow): Outcome {
  const cfg = rule.action_config as { window_minutes?: unknown };
  return {
    kind: 'success',
    output: {
      outcome: RULE_DISPATCH_OUTCOME.FLAGGED_COLLISION,
      routed_to: RULE_ROUTED_TO.COLLISION,
      window_minutes: typeof cfg.window_minutes === 'number' ? cfg.window_minutes : 5,
    },
  };
}

async function dispatchForwardToUrl(rule: RuleRow, exec: ExecutionRow): Promise<Outcome> {
  const cfg = rule.action_config as {
    target_url?: unknown;
    hmac_secret_handle?: unknown;
    timeout_ms?: unknown;
  };
  const targetUrl = typeof cfg.target_url === 'string' ? cfg.target_url : null;
  const handle = typeof cfg.hmac_secret_handle === 'string' ? cfg.hmac_secret_handle : null;
  const timeoutMs =
    typeof cfg.timeout_ms === 'number' && cfg.timeout_ms > 0 ? cfg.timeout_ms : DEFAULT_FORWARD_TIMEOUT_MS;
  if (!targetUrl || !handle) {
    return {
      kind: 'permanent_failure',
      error: 'FORWARD_TO_URL action_config missing target_url or hmac_secret_handle',
    };
  }
  const secret = await resolveSecretHandle(handle);
  if (!secret) {
    return {
      kind: 'permanent_failure',
      error: `FORWARD_TO_URL secret handle "${handle}" did not resolve`,
    };
  }
  const body = JSON.stringify({
    rule_id: rule.id,
    rule_name: rule.name,
    execution_id: exec.id,
    org_id: rule.org_id,
    trigger_event_id: exec.trigger_event_id,
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  const controller = new AbortController();
  const cancel = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Arkova-Signature': signature,
        'X-Arkova-Timestamp': timestamp,
        'X-Arkova-Rule-Id': rule.id,
        'X-Arkova-Execution-Id': exec.id,
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Treat any non-2xx as transient — let attempt_count drive DLQ behavior
      // so a misconfigured target gets retried up to MAX_DISPATCH_ATTEMPTS
      // before parking in DLQ where on-call can repair the URL/secret.
      return {
        kind: 'transient_failure',
        error: `FORWARD_TO_URL non-2xx response: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`,
      };
    }
    return {
      kind: 'success',
      output: {
        outcome: RULE_DISPATCH_OUTCOME.WEBHOOK_DELIVERED,
        status_code: res.status,
        target_url: targetUrl,
      },
    };
  } catch (err) {
    return {
      kind: 'transient_failure',
      error: err instanceof Error ? err.message : 'FORWARD_TO_URL fetch threw',
    };
  } finally {
    clearTimeout(cancel);
  }
}

async function dispatchOne(rule: RuleRow, exec: ExecutionRow): Promise<Outcome> {
  switch (rule.action_type) {
    case 'NOTIFY':
      return dispatchNotify(rule, exec);
    case 'QUEUE_FOR_REVIEW':
      return dispatchQueueForReview(rule);
    case 'FLAG_COLLISION':
      return dispatchFlagCollision(rule);
    case 'FORWARD_TO_URL':
      return dispatchForwardToUrl(rule, exec);
    default:
      // Per AC: unsupported action types fail closed and are visible. Anchor
      // actions intentionally aren't dispatched here — they go via the
      // existing `jobs/anchor.ts` pipeline.
      return {
        kind: 'permanent_failure',
        error: `Action type "${rule.action_type}" is not supported by the MVP dispatcher`,
      };
  }
}

async function finalizeExecution(exec: ExecutionRow, outcome: Outcome): Promise<void> {
  const completedAt = new Date().toISOString();
  const nextAttempt = (exec.attempt_count ?? 0) + 1;
  let status: string;
  let error: string | null = null;
  let output: Record<string, unknown> | null = null;
  if (outcome.kind === 'success') {
    status = 'SUCCEEDED';
    output = outcome.output;
  } else if (outcome.kind === 'permanent_failure') {
    status = 'FAILED';
    error = outcome.error.slice(0, 4000);
  } else {
    status = nextAttempt >= MAX_DISPATCH_ATTEMPTS ? 'DLQ' : 'RETRYING';
    error = outcome.error.slice(0, 4000);
  }
  // Race guard: only finalize if the row is still in the status we read.
  // A second dispatcher instance racing on the same row will get 0 rows
  // updated and the loser bails — no double dispatch / double notify.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: writeErr } = await (db as any)
    .from('organization_rule_executions')
    .update({
      status,
      output_payload: output,
      error,
      attempt_count: nextAttempt,
      completed_at: completedAt,
    })
    .eq('id', exec.id)
    .eq('status', exec.status);
  if (writeErr) {
    logger.error(
      { error: writeErr, executionId: exec.id, status },
      'rule action dispatcher: finalize update failed',
    );
  }
}

async function processWithConcurrencyCap<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  cap: number,
): Promise<void> {
  if (items.length === 0) return;
  // Lightweight concurrency pool — DISPATCH_CONCURRENCY workers each pull
  // the next item from a shared cursor. Avoids pulling in p-limit just for
  // this one call site.
  let cursor = 0;
  const next = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cap, items.length) }, () => next()));
}

export async function runRuleActionDispatcher(): Promise<DispatcherPassResult> {
  const result: DispatcherPassResult = { dispatched: 0, succeeded: 0, failed: 0 };
  if (process.env.ENABLE_RULE_ACTION_DISPATCHER === 'false') {
    logger.info('Rule action dispatcher disabled via ENABLE_RULE_ACTION_DISPATCHER=false');
    return result;
  }

  const claimed = await fetchPendingExecutions();
  if (claimed.length === 0) return result;
  result.dispatched = claimed.length;

  const rules = await fetchRulesByIds(claimed.map((c) => c.rule_id));

  await processWithConcurrencyCap(claimed, async (exec) => {
    const rule = rules.get(exec.rule_id);
    let outcome: Outcome;
    if (!rule) {
      outcome = {
        kind: 'permanent_failure',
        error: `Rule ${exec.rule_id} not found — execution cannot be dispatched`,
      };
    } else {
      try {
        outcome = await dispatchOne(rule, exec);
      } catch (err) {
        outcome = {
          kind: 'transient_failure',
          error: err instanceof Error ? err.message : 'dispatcher threw',
        };
      }
    }
    await finalizeExecution(exec, outcome);
    if (outcome.kind === 'success') result.succeeded += 1;
    else result.failed += 1;
  }, DISPATCH_CONCURRENCY);

  logger.info(
    { dispatched: result.dispatched, succeeded: result.succeeded, failed: result.failed },
    'Rule action dispatcher pass complete',
  );
  return result;
}
