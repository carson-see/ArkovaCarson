/**
 * Passport ↔ agent binding and the pure event-transition decision.
 *
 * v1 stores the binding in `agents.metadata.computeid` (no migration; PR-B
 * SCRUM-4497 promotes it to columns + a unique index + a nonce table).
 *
 * Replay / ordering safety without a nonce table:
 *  - A floor: an event is stale if it is OLDER than the last applied event, or
 *    — before any event was applied — older than the receipt that admitted the
 *    passport (`receipt_issued_at`, falling back to `bound_at`). A pre-admission
 *    `passport.revoked` replay therefore cannot revoke a freshly admitted agent.
 *  - Exact replays (same timestamp AND same event as the last applied one) are
 *    stale; a DIFFERENT event carrying the same timestamp is not.
 *  - `revoked` is terminal (forward-only). Every non-stale event for a bound
 *    agent advances the clock, even when it changes nothing, so a late replay
 *    can never slip in behind it.
 *  - Ownership: only a suspension WE applied (`suspended_by = 'computeid'`) can
 *    be lifted by `passport.reinstated`; an org admin's own suspension stays.
 *
 * Key enforcement is a separate output because the auth path reads only
 * `api_keys.is_active` (never `agents.status`): revoke/suspend → deactivate,
 * reinstate → reactivate, and repeat events re-assert it so a partial failure
 * heals on retry. Proven in machines/agentPassport.machine.ts.
 */
import { DB_UUID_RE } from '../../utils/db-row-validation.js';
import { COMPUTEID_ISSUER, isRecord, type ComputeIdPassportEvent } from './schemas.js';

export const BINDING_METADATA_KEY = 'computeid';

export interface ComputeIdBinding {
  issuer: typeof COMPUTEID_ISSUER;
  passport_id: string;
  bound_at: string;
  receipt_expires_at: string;
  /** Signed `issued_at` of the admitting receipt — the ordering floor before any event. */
  receipt_issued_at?: string;
  last_event?: string;
  last_event_at?: string;
  /** Set when a `passport.suspended` WE applied caused the current suspension. */
  suspended_by?: 'computeid';
}

export type AgentStatus = 'active' | 'suspended' | 'revoked';
export interface AgentState {
  status: AgentStatus;
  metadata: unknown;
}
export interface PassportEventInput {
  event: ComputeIdPassportEvent;
  timestamp: string;
}
export type PassportAction = 'revoke' | 'suspend' | 'reinstate' | 'noop';
export type PassportDecisionReason =
  | 'applied'
  | 'unbound'
  | 'stale_event'
  | 'already_revoked'
  | 'already_in_state'
  | 'suspended_by_org';
export interface PassportEventDecision {
  action: PassportAction;
  reason: PassportDecisionReason;
}
export type KeyEnforcement = 'deactivate' | 'reactivate' | 'none';

function finiteIso(v: unknown): string | undefined {
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : undefined;
}

export function readBinding(metadata: unknown): ComputeIdBinding | null {
  if (!isRecord(metadata)) return null;
  const raw = metadata[BINDING_METADATA_KEY];
  if (!isRecord(raw)) return null;
  if (raw.issuer !== COMPUTEID_ISSUER) return null;
  if (typeof raw.passport_id !== 'string' || !DB_UUID_RE.test(raw.passport_id)) return null;
  const lastEventAt = finiteIso(raw.last_event_at);
  const receiptIssuedAt = finiteIso(raw.receipt_issued_at);
  return {
    issuer: COMPUTEID_ISSUER,
    passport_id: raw.passport_id.toLowerCase(),
    bound_at: finiteIso(raw.bound_at) ?? '',
    receipt_expires_at: finiteIso(raw.receipt_expires_at) ?? '',
    ...(receiptIssuedAt ? { receipt_issued_at: receiptIssuedAt } : {}),
    ...(typeof raw.last_event === 'string' ? { last_event: raw.last_event } : {}),
    ...(lastEventAt ? { last_event_at: lastEventAt } : {}),
    ...(raw.suspended_by === 'computeid' ? { suspended_by: 'computeid' as const } : {}),
  };
}

export function writeBinding(metadata: unknown, binding: ComputeIdBinding): Record<string, unknown> {
  const base = isRecord(metadata) ? { ...metadata } : {};
  return { ...base, [BINDING_METADATA_KEY]: { ...binding } };
}

/** The timestamp (ms) an event must be newer than: last applied → receipt issue → bound_at. */
export function orderingFloor(binding: ComputeIdBinding): number | undefined {
  for (const v of [binding.last_event_at, binding.receipt_issued_at, binding.bound_at]) {
    const t = v ? Date.parse(v) : Number.NaN;
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

const noop = (reason: PassportDecisionReason): PassportEventDecision => ({ action: 'noop', reason });

export function decidePassportEvent(agent: AgentState, event: PassportEventInput): PassportEventDecision {
  const binding = readBinding(agent.metadata);
  if (!binding) return noop('unbound');
  const ts = Date.parse(event.timestamp);
  if (!Number.isFinite(ts)) return noop('stale_event');
  const floor = orderingFloor(binding);
  if (floor !== undefined) {
    if (ts < floor) return noop('stale_event');
    if (ts === floor && binding.last_event === event.event) return noop('stale_event');
  }
  if (agent.status === 'revoked') return noop('already_revoked');
  switch (event.event) {
    case 'passport.revoked':
      return { action: 'revoke', reason: 'applied' };
    case 'passport.suspended':
      return agent.status === 'suspended' ? noop('already_in_state') : { action: 'suspend', reason: 'applied' };
    case 'passport.reinstated':
      if (agent.status === 'active') return noop('already_in_state');
      return binding.suspended_by === 'computeid' ? { action: 'reinstate', reason: 'applied' } : noop('suspended_by_org');
  }
}

export interface PassportEventOutcome {
  decision: PassportEventDecision;
  /** `agents` row patch, or null when nothing at all should be written (unbound / stale). */
  update: Record<string, unknown> | null;
  keyEnforcement: KeyEnforcement;
}

/**
 * Decision + the `agents` row update + the key enforcement to apply. Every
 * non-stale event for a bound agent advances the binding clock (a metadata
 * write even when the status does not change); `update` is null only for
 * unbound or stale events.
 */
export function applyPassportEvent(agent: AgentState, event: PassportEventInput): PassportEventOutcome {
  const decision = decidePassportEvent(agent, event);
  if (decision.reason === 'unbound' || decision.reason === 'stale_event') {
    return { decision, update: null, keyEnforcement: 'none' };
  }
  const binding = readBinding(agent.metadata) as ComputeIdBinding;
  const next: ComputeIdBinding = { ...binding, last_event: event.event, last_event_at: event.timestamp };

  switch (decision.action) {
    case 'revoke': {
      delete next.suspended_by;
      const metadata = writeBinding(agent.metadata, next);
      return { decision, update: { status: 'revoked', revoked_at: event.timestamp, metadata }, keyEnforcement: 'deactivate' };
    }
    case 'suspend': {
      next.suspended_by = 'computeid';
      const metadata = writeBinding(agent.metadata, next);
      return { decision, update: { status: 'suspended', suspended_at: event.timestamp, metadata }, keyEnforcement: 'deactivate' };
    }
    case 'reinstate': {
      delete next.suspended_by;
      const metadata = writeBinding(agent.metadata, next);
      return { decision, update: { status: 'active', suspended_at: null, metadata }, keyEnforcement: 'reactivate' };
    }
    default: {
      const metadata = writeBinding(agent.metadata, next);
      let keyEnforcement: KeyEnforcement = 'none';
      if (decision.reason === 'already_revoked') keyEnforcement = 'deactivate';
      else if (decision.reason === 'already_in_state') {
        keyEnforcement = event.event === 'passport.reinstated' ? 'reactivate' : 'deactivate';
      }
      return { decision, update: { metadata }, keyEnforcement };
    }
  }
}
