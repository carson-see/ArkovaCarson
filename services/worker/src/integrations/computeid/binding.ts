/**
 * Passport ↔ agent binding and the pure event-transition decision.
 *
 * Bindings remain in tenant metadata pending SCRUM-4497. Migration 0448 keeps
 * terminal provider authority in a separate service-owned passport table.
 *
 * Suspension/reinstatement obey the last-event/receipt/binding timestamp floor.
 * Reinstatement must be strictly newer than the floor; equal-time delivery
 * cannot relax a suspension. Authenticated revocation is terminal regardless
 * of that floor. Future timestamps beyond five minutes are rejected; accepted
 * clock skew is clamped to receipt time before it can become an ordering floor.
 * Only a suspension applied by ComputeID can be lifted by reinstatement.
 *
 * Key enforcement is a separate output because the auth path reads only
 * `api_keys.is_active` (never `agents.status`): revoke/suspend → deactivate,
 * reinstate → reactivate. Migration 0448 commits that output together with the
 * agent update under one row lock; a failed key write rolls both back, so exact
 * retries cannot skip an incomplete transition. The bounded concurrency model
 * is machines/agentPassportAtomic.machine.ts; lifecycle decisions remain in
 * machines/agentPassport.machine.ts.
 */
import { DB_UUID_RE } from '../../utils/db-row-validation.js';
import { COMPUTEID_ISSUER, isRecord, type ComputeIdPassportEvent } from './schemas.js';

export const BINDING_METADATA_KEY = 'computeid';
export const MAX_PROVIDER_EVENT_CLOCK_SKEW_MS = 300_000;

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
  /** True while the latest authenticated provider state is suspended, even if the org already owned suspension. */
  provider_suspended?: true;
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
  | 'future_event'
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
    ...(raw.provider_suspended === true ? { provider_suspended: true as const } : {}),
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

/** Older than the floor, or the exact (timestamp, event) pair already applied. */
function isStaleEvent(binding: ComputeIdBinding, event: PassportEventInput, ts: number): boolean {
  const floor = orderingFloor(binding);
  if (floor === undefined) return false;
  return ts < floor || (ts === floor && (binding.last_event === event.event || event.event === 'passport.reinstated'));
}


export function decidePassportEvent(agent: AgentState, event: PassportEventInput, now = Date.now()): PassportEventDecision {
  const binding = readBinding(agent.metadata);
  if (!binding) return noop('unbound');
  const ts = Date.parse(event.timestamp);
  if (!Number.isFinite(ts)) return noop('stale_event');
  if (ts > now + MAX_PROVIDER_EVENT_CLOCK_SKEW_MS) return noop('future_event');
  // Revocation is terminal provider authority, including a delayed delivery.
  // Receipt age or tenant metadata cannot authorize reissuing this passport.
  if (event.event === 'passport.revoked' && agent.status !== 'revoked') return { action: 'revoke', reason: 'applied' };
  if (isStaleEvent(binding, event, ts)) return noop('stale_event');
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
export function applyPassportEvent(agent: AgentState, event: PassportEventInput, now = Date.now()): PassportEventOutcome {
  const decision = decidePassportEvent(agent, event, now);
  if (decision.reason === 'unbound' || decision.reason === 'stale_event' || decision.reason === 'future_event') {
    return { decision, update: null, keyEnforcement: 'none' };
  }
  // Canonical SQL timestamps; an accepted small partner skew cannot advance
  // the stored floor beyond our receipt time. Signature verification used the
  // original bytes before this normalization.
  const timestamp = new Date(Math.min(Date.parse(event.timestamp), now)).toISOString();
  const binding = readBinding(agent.metadata) as ComputeIdBinding;
  const next: ComputeIdBinding = { ...binding, last_event: event.event, last_event_at: timestamp };

  switch (decision.action) {
    case 'revoke': {
      delete next.suspended_by;
      delete next.provider_suspended;
      const metadata = writeBinding(agent.metadata, next);
      return { decision, update: { status: 'revoked', revoked_at: timestamp, metadata }, keyEnforcement: 'deactivate' };
    }
    case 'suspend': {
      next.suspended_by = 'computeid';
      next.provider_suspended = true;
      const metadata = writeBinding(agent.metadata, next);
      return { decision, update: { status: 'suspended', suspended_at: timestamp, metadata }, keyEnforcement: 'deactivate' };
    }
    case 'reinstate': {
      delete next.suspended_by;
      delete next.provider_suspended;
      const metadata = writeBinding(agent.metadata, next);
      return { decision, update: { status: 'active', suspended_at: null, metadata }, keyEnforcement: 'reactivate' };
    }
    default: {
      if (event.event === 'passport.suspended') next.provider_suspended = true;
      if (event.event === 'passport.reinstated') delete next.provider_suspended;
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
