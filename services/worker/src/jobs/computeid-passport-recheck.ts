/**
 * Scheduled ComputeID passport re-check (SCRUM-4495).
 *
 * WHY THIS EXISTS. ComputeID has no webhook retry: a non-2xx from us is
 * swallowed, and our own receiver answers 409 to the loser of a compare-and-set
 * race *expecting* a redelivery that will never come. So a revocation can be
 * lost outright, leaving a revoked passport's Arkova API keys live forever.
 * Carson committed to Praveen (2026-09-07) that Arkova would re-check every
 * bound passport on a schedule so a lost delivery is caught within the hour.
 * This is that job.
 *
 * WHAT IT IS NOT. It is not a second lifecycle implementation. It observes the
 * partner's current state, turns a DIVERGENCE from our state into exactly the
 * `passport.*` event a webhook would have carried, and hands it to the SAME
 * `applyPassportEventToAgent` path the receiver uses — same decision function,
 * same locked RPC, same compare-and-set, same key enforcement. Every lifecycle
 * rule (forward-only transitions, `revoked` terminal, `suspended_by` ownership,
 * key enforcement) is therefore enforced in one place only.
 *
 * ORDERING. The synthesized event carries the receipt's SIGNED `issued_at`, so
 * it is ordered against `binding.last_event_at` by the existing floor in
 * `binding.ts`. A re-check whose receipt predates a webhook we already applied
 * is dropped as stale — an older observation can never overwrite a newer one.
 *
 * EVIDENCE ASYMMETRY (deliberate, and the security-relevant design decision).
 * Reinstating an agent REACTIVATES its API keys, so it is only ever done on a
 * signature-verified receipt from the pinned CA. Suspending or revoking is the
 * fail-safe direction, so it is also accepted on the unsigned `status` /
 * `revoked_at` of a TLS + API-key authenticated response when the partner
 * returns no receipt — the alternative is missing the exact revocation this job
 * was built to catch. The asymmetry is enforced in `decideEvent` below.
 *
 * STEADY STATE IS A NO-OP. An event is synthesized only when the observed
 * status differs from the agent's own status, so a healthy fleet performs zero
 * writes and never advances the ordering floor.
 *
 * Per-org isolation: agents are read across organizations (one passport may be
 * admitted by several), and every write re-scopes by that agent's own `org_id`
 * inside `apply_computeid_agent_transition`.
 *
 * Privacy: no partner response body — and no `reason` free text — reaches the
 * logger, Sentry, an `Error`, or the DLQ. Counts and fixed reason codes only.
 */
import { config } from '../config.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { loadPinnedCa, type PinnedCa } from '../integrations/computeid/ca-cert.js';
import { readSignedReceiptStatus } from '../integrations/computeid/receipt-verifier.js';
import {
  applyPassportEventToAgent,
  recordPassportFailure,
  recordPassportRevocationAuthority,
  type BoundAgentRow,
  type PassportDelivery,
  type TransitionOutcome,
} from '../integrations/computeid/passport-transition.js';
import {
  fetchPassportVerification,
  isVerifyClientConfigured,
  type VerifyOutcome,
} from '../integrations/computeid/verify-client.js';
import { readBinding } from '../integrations/computeid/binding.js';
import type { ComputeIdPassportEvent } from '../integrations/computeid/schemas.js';

/** Rows read per page from `agents`. */
export const RECHECK_PAGE_SIZE = 100;
/** Hard ceiling on agents examined in one run — an hourly job must never become unbounded. */
export const RECHECK_MAX_AGENTS_PER_RUN = 500;
/** Hard ceiling on outbound partner calls in one run. Distinct passports only; results are memoized. */
export const RECHECK_MAX_VERIFY_CALLS = 200;

export type RecheckSkipReason = 'flag_off' | 'api_key_unconfigured' | 'ca_pin_unusable';

export interface RecheckResult {
  /** Present (and true) only when the job did nothing at all. */
  skipped?: true;
  reason?: RecheckSkipReason;
  /** Agents examined. */
  checked: number;
  /** Distinct passports for which the partner was called. */
  passportsVerified: number;
  /** Divergences successfully reconciled. */
  applied: number;
  /** Divergences whose synthesized event the lifecycle rules declined (stale, org-owned suspension, …). */
  declined: number;
  /** Compare-and-set races — the agent row moved under us. */
  conflicts: number;
  /** Partner call or transition failures. */
  failures: number;
  /** Agents whose state could not be established with evidence good enough to act on. */
  unresolved: number;
  /** True when a cap stopped the run before every bound agent was examined. */
  truncated: boolean;
}

export interface RecheckPorts {
  listBoundAgents(cursor: string | undefined, limit: number): Promise<BoundAgentRow[]>;
  verifyPassport(passportId: string): Promise<VerifyOutcome>;
  applyEvent(agent: BoundAgentRow, d: PassportDelivery): Promise<TransitionOutcome>;
  recordRevocationAuthority(d: PassportDelivery): Promise<boolean>;
  recordFailure(args: { reason: string; externalId: string | null; payloadHash: string }): Promise<void>;
  loadCa(): PinnedCa | null;
  now(): Date;
}

let cachedCa: { pem: string; ca: PinnedCa } | null = null;

export function defaultRecheckPorts(): RecheckPorts {
  return {
    async listBoundAgents(cursor, limit) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query = (db as any).from('agents')
        .select('id, org_id, name, status, metadata')
        .not('metadata->computeid', 'is', null)
        .order('id', { ascending: true })
        .limit(limit);
      if (cursor) query = query.gt('id', cursor);
      const { data, error } = await query;
      if (error) throw new Error('bound_agent_lookup_failed');
      return (data as BoundAgentRow[] | null) ?? [];
    },
    verifyPassport: (passportId) => fetchPassportVerification(passportId),
    applyEvent: applyPassportEventToAgent,
    recordRevocationAuthority: recordPassportRevocationAuthority,
    recordFailure: recordPassportFailure,
    loadCa() {
      const pem = config.computeidCaCertPem ?? '';
      if (!pem.trim()) return null;
      if (cachedCa && cachedCa.pem === pem) return cachedCa.ca;
      try {
        const ca = loadPinnedCa(pem);
        cachedCa = { pem, ca };
        return ca;
      } catch (err) {
        logger.error({ error: err }, 'ComputeID re-check: COMPUTEID_CA_CERT_PEM is not a usable CA pin');
        return null;
      }
    },
    now: () => new Date(),
  };
}

/** What we believe the partner currently says, and how strongly. */
export type Observation =
  | { kind: 'signed'; status: string; at: string; passportSignatureValid: boolean | null }
  | { kind: 'unsigned'; status: string }
  | { kind: 'unresolved'; reason: string };

function observe(outcome: VerifyOutcome, passportId: string, ca: PinnedCa, now: Date): Observation {
  if (!outcome.ok) {
    return { kind: 'unresolved', reason: `verify_${outcome.reason}${outcome.status ? `:${outcome.status}` : ''}` };
  }
  const { response } = outcome;
  if (response.passport_id !== passportId) return { kind: 'unresolved', reason: 'verify_passport_id_mismatch' };

  const receipt = response.verification_receipt;
  if (receipt) {
    const signed = readSignedReceiptStatus({ receipt, ca, expectedPassportId: passportId, now });
    if (signed.ok) {
      return {
        kind: 'signed',
        status: signed.status,
        // The SIGNED issue time is what the ordering floor compares against.
        // Fall back to `now` only when the partner omits it entirely.
        at: (signed.issuedAt ?? now).toISOString(),
        passportSignatureValid: signed.passportSignatureValid,
      };
    }
    // A receipt that is present but does not verify is not evidence of
    // anything. Do not quietly fall through to the unsigned status: that would
    // let a broken or forged receipt be laundered into a weaker trust level.
    return { kind: 'unresolved', reason: `receipt_${signed.reason}` };
  }

  const revoked = response.revoked_at != null && String(response.revoked_at).length > 0;
  return { kind: 'unsigned', status: revoked ? 'revoked' : response.status };
}

const STATUS_EVENT: Record<string, ComputeIdPassportEvent> = {
  revoked: 'passport.revoked',
  suspended: 'passport.suspended',
  active: 'passport.reinstated',
};

/**
 * The divergence → event mapping, and the place the evidence asymmetry is
 * enforced. Returns null when nothing should happen.
 */
export function decideEvent(
  agent: Pick<BoundAgentRow, 'status'>,
  observation: Observation,
  now: Date,
): { event: ComputeIdPassportEvent; timestamp: string } | null {
  if (observation.kind === 'unresolved') return null;

  const observed = observation.status.toLowerCase();
  const event = STATUS_EVENT[observed];
  // An unrecognized partner status is not a licence to change anything.
  if (!event) return null;
  // Steady state: the partner agrees with us. No event, no write, no clock move.
  if (observed === agent.status) return null;

  if (event === 'passport.reinstated') {
    // Reactivating API keys demands the strongest evidence we can get.
    if (observation.kind !== 'signed') return null;
    if (observation.passportSignatureValid === false) return null;
    return { event, timestamp: observation.at };
  }

  // Fail-safe direction: a signed observation carries its signed time; an
  // unsigned one is stamped at observation time, which is newer than any
  // existing floor and so cannot be mistaken for old news.
  return { event, timestamp: observation.kind === 'signed' ? observation.at : now.toISOString() };
}

export async function runComputeIdPassportRecheck(
  ports: RecheckPorts = defaultRecheckPorts(),
): Promise<RecheckResult> {
  const empty: RecheckResult = {
    checked: 0, passportsVerified: 0, applied: 0, declined: 0,
    conflicts: 0, failures: 0, unresolved: 0, truncated: false,
  };

  if (!config.enableComputeidIntegration) return { ...empty, skipped: true, reason: 'flag_off' };
  if (!isVerifyClientConfigured()) return { ...empty, skipped: true, reason: 'api_key_unconfigured' };
  const ca = ports.loadCa();
  if (!ca) return { ...empty, skipped: true, reason: 'ca_pin_unusable' };

  const result: RecheckResult = { ...empty };
  const now = ports.now();
  const runMarker = `recheck:${now.toISOString()}`;
  const observations = new Map<string, Observation>();
  /** Passports already given their terminal tombstone in THIS run. */
  const tombstoned = new Set<string>();

  let cursor: string | undefined;
  scan: for (;;) {
    let page: BoundAgentRow[];
    try {
      page = await ports.listBoundAgents(cursor, RECHECK_PAGE_SIZE);
    } catch (error) {
      logger.error({ error }, 'ComputeID re-check: bound-agent lookup failed');
      result.failures += 1;
      break;
    }
    if (page.length === 0) break;
    const next = page[page.length - 1].id;
    if (cursor && next <= cursor) {
      logger.error('ComputeID re-check: bound-agent cursor did not advance');
      result.failures += 1;
      break;
    }
    cursor = next;

    for (const agent of page) {
      if (result.checked >= RECHECK_MAX_AGENTS_PER_RUN) { result.truncated = true; break scan; }
      result.checked += 1;

      const binding = readBinding(agent.metadata);
      if (!binding) continue; // Not actually bound (or a malformed binding) — nothing to reconcile.
      const passportId = binding.passport_id;

      let observation = observations.get(passportId);
      if (!observation) {
        if (result.passportsVerified >= RECHECK_MAX_VERIFY_CALLS) { result.truncated = true; break scan; }
        result.passportsVerified += 1;
        observation = observe(await ports.verifyPassport(passportId), passportId, ca, now);
        observations.set(passportId, observation);
      }
      if (observation.kind === 'unresolved') {
        result.unresolved += 1;
        logger.warn({ passportId, reason: observation.reason }, 'ComputeID re-check: passport state could not be established');
        continue;
      }

      const decided = decideEvent(agent, observation, now);
      if (!decided) continue;

      const delivery: PassportDelivery = {
        event: decided.event,
        passportId,
        timestamp: decided.timestamp,
        payloadHash: runMarker,
      };

      if (delivery.event === 'passport.revoked' && !tombstoned.has(passportId)) {
        if (!(await ports.recordRevocationAuthority(delivery))) {
          result.failures += 1;
          continue;
        }
        tombstoned.add(passportId);
      }

      const outcome = await ports.applyEvent(agent, delivery);
      switch (outcome.outcome) {
        case 'applied':
          result.applied += 1;
          logger.warn(
            { orgId: agent.org_id, agentId: agent.id, passportId, event: delivery.event, evidence: observation.kind },
            'ComputeID re-check: reconciled a passport state the webhook never delivered',
          );
          break;
        case 'skipped': result.declined += 1; break;
        case 'conflict': result.conflicts += 1; break;
        default:
          result.failures += 1;
          await ports.recordFailure({ reason: `recheck_transition_failed:${delivery.event}`, externalId: passportId, payloadHash: runMarker });
          break;
      }
    }
    // Deliberately NOT `if (page.length < RECHECK_PAGE_SIZE) break`: a hosted
    // PostgREST cap can sit below our requested limit, so a short page does not
    // mean the last page. Termination is an EMPTY page, exactly as in
    // `findBoundAgents`. The cost is one extra empty query per run.
  }

  logger.info({ ...result }, 'ComputeID re-check complete');
  return result;
}
