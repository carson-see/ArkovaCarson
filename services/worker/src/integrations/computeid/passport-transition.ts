/**
 * The ONE way a ComputeID passport event changes an Arkova agent.
 *
 * Extracted verbatim from `api/v1/webhooks/computeid.ts` when the scheduled
 * re-check (SCRUM-4495) became a second producer of the same events. A lost
 * webhook delivery and an hourly re-check must reach byte-identical outcomes,
 * so they share this module rather than each owning a copy: the same
 * `applyPassportEvent` decision, the same `apply_computeid_agent_transition`
 * locked RPC, the same compare-and-set snapshot, the same DLQ rows. A second
 * implementation would drift, and the direction it drifts in is "keys stay
 * live on a revoked passport".
 *
 * Not moved here: HTTP shapes. Callers map `TransitionOutcome` to whatever
 * their surface answers with (the webhook returns 409 `conflict_retry` on a
 * lost race so ComputeID redelivers; the cron job just counts it).
 *
 * PURITY NOTE for this folder: `ca-cert.ts`, `secrets.ts` and `schemas.ts` stay
 * free of `config`/`db`/`logger` imports because `config.ts` imports them at
 * boot. This file is NOT in that set — nothing in the config boot path imports
 * it — so it may use `db` and `logger` like any other runtime module.
 */
import { createHash } from 'node:crypto';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { Sentry } from '../../utils/sentry.js';
import type { Json } from '../../types/database.types.js';
import { truncateUtf16Safe } from '../../utils/utf16-truncate.js';
import { applyPassportEvent, type AgentStatus, type KeyEnforcement } from './binding.js';
import type { ComputeIdPassportEvent } from './schemas.js';
import { hintAgentWebhookDrain } from '../../webhooks/agentEvents.js';

/** Page size for the bound-agent scan. Bounded so one passport cannot unbound-loop a request. */
export const BOUND_AGENT_PAGE_SIZE = 200;

/**
 * `enqueue_computeid_failure` (migration 0448) RAISEs `22023` unless
 * `p_payload_hash` matches this exactly. It is a contract, not a convention:
 * a producer that passes anything else gets EVERY DLQ row rejected, and since
 * `recordPassportFailure` cannot re-raise (the DLQ is the diagnostic of last
 * resort, not the operation), the loss is silent. Both producers therefore
 * mint their hash through `payloadHashOf` and nothing else.
 */
export const PAYLOAD_HASH_RE = /^[0-9a-f]{64}$/;

/** Lowercase hex SHA-256 — the one shape the DLQ accepts. */
export function payloadHashOf(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export interface BoundAgentRow {
  id: string;
  org_id: string;
  name: string;
  status: AgentStatus;
  metadata: unknown;
}

/** One passport event to apply, already authenticated/verified by the caller. */
export interface PassportDelivery {
  event: ComputeIdPassportEvent;
  passportId: string;
  /** Canonical ISO timestamp the ordering guard compares against. */
  timestamp: string;
  /** SHA-256 of the delivery bytes (webhook) or a synthetic run marker (re-check). Never the bytes themselves. */
  payloadHash: string;
}

export type TransitionOutcome =
  | { outcome: 'applied' }
  | { outcome: 'skipped' }
  /** The agent row changed underneath us; the caller should ask for redelivery. */
  | { outcome: 'conflict' }
  | { outcome: 'failed' };

/**
 * Record a failure for operator follow-up. Fixed reason strings only — the
 * partner's free-text `reason` and the raw body never reach the DLQ, the
 * logger, or Sentry.
 *
 * A rejected DLQ write is itself an incident: this row is the only durable
 * trace of a failed transition, so losing it means a revoked passport's keys
 * stay live with nothing to page on. It therefore logs at ERROR and raises a
 * Sentry event rather than the warn it used to — a malformed `payloadHash`
 * rejects EVERY row from that producer, so a warn buried in an otherwise
 * healthy 200 is exactly how this stays invisible.
 */
export async function recordPassportFailure(args: {
  reason: string;
  externalId: string | null;
  payloadHash: string;
}): Promise<void> {
  const reason = truncateUtf16Safe(args.reason, 500);
  try {
    const { error } = await db.rpc('enqueue_computeid_failure', {
      p_reason: reason,
      p_payload_hash: args.payloadHash,
      ...(args.externalId !== null ? { p_external_id: args.externalId } : {}),
    });
    if (error) reportDlqLoss(reason, error);
  } catch (err) {
    reportDlqLoss(reason, err);
  }
}

/** The DLQ row did not land. Loud, aggregated, and free of partner bytes. */
function reportDlqLoss(reason: string, error: unknown): void {
  logger.error({ error, reason }, 'ComputeID: DLQ insert REJECTED — this failure is now untracked');
  Sentry.captureMessage('ComputeID: DLQ insert rejected', {
    level: 'error',
    fingerprint: ['computeid-dlq-insert-rejected'],
    extra: { reason },
  });
}

/**
 * Every agent bound to `passportId`, streamed in bounded pages in stable
 * primary-key order. Cross-org by contract — a passport may be admitted by
 * more than one organization — and every mutation re-scopes by the agent's own
 * `org_id`. Do not infer completion from a short page: a hosted PostgREST cap
 * may sit below our requested limit.
 */
export async function* findBoundAgents(passportId: string): AsyncGenerator<BoundAgentRow> {
  let cursor: string | undefined;
  for (;;) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (db as any).from('agents')
      .select('id, org_id, name, status, metadata')
      .contains('metadata', { computeid: { passport_id: passportId } })
      .order('id', { ascending: true })
      .limit(BOUND_AGENT_PAGE_SIZE);
    if (cursor) query = query.gt('id', cursor);
    const { data, error } = await query;
    if (error) throw new Error('agent_lookup_failed');
    const rows = (data as BoundAgentRow[] | null) ?? [];
    if (rows.length === 0) return;
    const next = rows[rows.length - 1].id;
    if (cursor && next <= cursor) throw new Error('agent_lookup_cursor_not_advanced');
    for (const row of rows) yield row;
    cursor = next;
  }
}

/**
 * Write the service-owned terminal revocation tombstone for a passport, which
 * blocks readmission across every organization. Returns false when the write
 * failed (the caller must not proceed to per-agent enforcement claiming
 * success); a DLQ row is recorded either way.
 *
 * Deliberately NOT short-circuited on an existing tombstone: a prior attempt
 * may have died part-way through the cross-organization agent loop, so every
 * revocation re-runs per-agent enforcement.
 */
export async function recordPassportRevocationAuthority(d: PassportDelivery): Promise<boolean> {
  try {
    const { data, error } = await db.rpc('record_computeid_passport_revocation', {
      p_passport_id: d.passportId,
      p_event_at: d.timestamp,
    });
    if (error || data !== true) throw error ?? new Error('invalid_revocation_authority_result');
    return true;
  } catch (error) {
    logger.error({ error, passportId: d.passportId }, 'ComputeID: revocation authority write failed');
    await recordPassportFailure({ reason: 'revocation_authority_failed', externalId: d.passportId, payloadHash: d.payloadHash });
    return false;
  }
}

/** Commit the complete agent/key transition under one row lock, or leave both unchanged. */
async function commitAgentTransition(
  agent: BoundAgentRow,
  update: Record<string, unknown>,
  keyEnforcement: KeyEnforcement,
  d: PassportDelivery,
  emitEventType: 'agent.updated' | 'agent.revoked' | null,
): Promise<TransitionOutcome | null> {
  try {
    const { data: result, error } = await db.rpc('apply_computeid_agent_transition_with_outbox', {
      p_org_id: agent.org_id,
      p_agent_id: agent.id,
      p_passport_id: d.passportId,
      p_expected_status: agent.status,
      p_expected_metadata: agent.metadata as Json,
      p_update: update as Json,
      p_key_enforcement: keyEnforcement,
      p_event: d.event,
      p_event_at: d.timestamp,
      ...(emitEventType ? { p_emit_event_type: emitEventType } : {}),
    });
    if (error) throw error;
    const applied = typeof result === 'object' && result !== null
      ? (result as { applied?: unknown }).applied : undefined;
    if (applied === true) return null;
    if (applied !== false) throw new Error('invalid_agent_transition_result');
    logger.warn({ agentId: agent.id, event: d.event }, 'ComputeID: agent row changed underneath us — asking for redelivery');
    await recordPassportFailure({ reason: `agent_update_conflict:${d.event}`, externalId: d.passportId, payloadHash: d.payloadHash });
    return { outcome: 'conflict' };
  } catch (error) {
    logger.error({ error, agentId: agent.id, event: d.event }, 'ComputeID: atomic agent/key transition failed');
    await recordPassportFailure({ reason: `agent_transition_failed:${d.event}`, externalId: d.passportId, payloadHash: d.payloadHash });
    return { outcome: 'failed' };
  }
}

/**
 * One bound agent: pure decision → atomic locked agent/key transaction.
 * `applyPassportEvent` owns every lifecycle rule (forward-only transitions,
 * the signed-timestamp ordering floor, exact-replay detection, `suspended_by`
 * ownership, key enforcement), so an older event can never overwrite a newer
 * one no matter which producer submitted it.
 */
export async function applyPassportEventToAgent(
  agent: BoundAgentRow,
  d: PassportDelivery,
): Promise<TransitionOutcome> {
  const { decision, update, keyEnforcement } = applyPassportEvent(
    { status: agent.status, metadata: agent.metadata },
    { event: d.event, timestamp: d.timestamp },
  );
  if (!update) return { outcome: 'skipped' };

  const emitEventType = decision.action === 'noop' ? null
    : decision.action === 'revoke' ? 'agent.revoked' : 'agent.updated';
  const failed = await commitAgentTransition(agent, update, keyEnforcement, d, emitEventType);
  if (failed) return failed;
  if (decision.action === 'noop') return { outcome: 'skipped' };
  hintAgentWebhookDrain();
  return { outcome: 'applied' };
}
