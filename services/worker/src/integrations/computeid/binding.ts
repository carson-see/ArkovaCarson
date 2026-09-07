/**
 * Passport ↔ agent binding and the pure event-transition decision.
 *
 * v1 stores the binding in `agents.metadata.computeid` (no migration; PR-B
 * promotes it to real columns + a unique index + a nonce table). Replay and
 * ordering safety come from the SIGNED event timestamp, not a nonce: an event
 * at or before the last applied one is a no-op, and `revoked` is terminal
 * (forward-only — a revocation never rewrites history and is never undone by
 * a late `reinstated`).
 */
import { COMPUTEID_ISSUER, type ComputeIdPassportEvent } from './schemas.js';

export const BINDING_METADATA_KEY = 'computeid';

export interface ComputeIdBinding {
  issuer: typeof COMPUTEID_ISSUER;
  passport_id: string;
  bound_at: string;
  receipt_expires_at: string;
  last_event?: string;
  last_event_at?: string;
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
export type PassportDecisionReason = 'applied' | 'unbound' | 'stale_event' | 'already_revoked' | 'already_in_state';
export interface PassportEventDecision {
  action: PassportAction;
  reason: PassportDecisionReason;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function readBinding(metadata: unknown): ComputeIdBinding | null {
  if (!isRecord(metadata)) return null;
  const raw = metadata[BINDING_METADATA_KEY];
  if (!isRecord(raw)) return null;
  if (raw.issuer !== COMPUTEID_ISSUER) return null;
  if (typeof raw.passport_id !== 'string' || !UUID_RE.test(raw.passport_id)) return null;
  return {
    issuer: COMPUTEID_ISSUER,
    passport_id: raw.passport_id,
    bound_at: typeof raw.bound_at === 'string' ? raw.bound_at : '',
    receipt_expires_at: typeof raw.receipt_expires_at === 'string' ? raw.receipt_expires_at : '',
    ...(typeof raw.last_event === 'string' ? { last_event: raw.last_event } : {}),
    ...(typeof raw.last_event_at === 'string' ? { last_event_at: raw.last_event_at } : {}),
  };
}

export function writeBinding(metadata: unknown, binding: ComputeIdBinding): Record<string, unknown> {
  const base = isRecord(metadata) ? { ...metadata } : {};
  return { ...base, [BINDING_METADATA_KEY]: { ...binding } };
}

const noop = (reason: PassportDecisionReason): PassportEventDecision => ({ action: 'noop', reason });

export function decidePassportEvent(agent: AgentState, event: PassportEventInput): PassportEventDecision {
  const binding = readBinding(agent.metadata);
  if (!binding) return noop('unbound');
  if (agent.status === 'revoked') return noop('already_revoked');
  if (binding.last_event_at && Date.parse(event.timestamp) <= Date.parse(binding.last_event_at)) {
    return noop('stale_event');
  }
  switch (event.event) {
    case 'passport.revoked':
      return { action: 'revoke', reason: 'applied' };
    case 'passport.suspended':
      return agent.status === 'suspended' ? noop('already_in_state') : { action: 'suspend', reason: 'applied' };
    case 'passport.reinstated':
      return agent.status === 'active' ? noop('already_in_state') : { action: 'reinstate', reason: 'applied' };
  }
}

/**
 * Decision + the `agents` row update to apply. `already_in_state` still
 * advances the binding clock (metadata-only write) so a later out-of-order
 * event cannot slip in behind it; every other noop writes nothing.
 */
export function applyPassportEvent(
  agent: AgentState,
  event: PassportEventInput,
  now: Date = new Date(),
): { decision: PassportEventDecision; update: Record<string, unknown> | null } {
  const decision = decidePassportEvent(agent, event);
  if (decision.action === 'noop' && decision.reason !== 'already_in_state') return { decision, update: null };

  const binding = readBinding(agent.metadata) as ComputeIdBinding;
  const metadata = writeBinding(agent.metadata, { ...binding, last_event: event.event, last_event_at: event.timestamp });
  const updated_at = now.toISOString();

  switch (decision.action) {
    case 'revoke':
      return { decision, update: { status: 'revoked', revoked_at: event.timestamp, metadata, updated_at } };
    case 'suspend':
      return { decision, update: { status: 'suspended', suspended_at: event.timestamp, metadata, updated_at } };
    case 'reinstate':
      return { decision, update: { status: 'active', suspended_at: null, metadata, updated_at } };
    default:
      return { decision, update: { metadata, updated_at } };
  }
}
