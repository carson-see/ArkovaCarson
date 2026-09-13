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
import { Sentry } from '../utils/sentry.js';
import { runWithConcurrency } from '../utils/concurrency.js';
import { loadPinnedCa, type PinnedCa } from '../integrations/computeid/ca-cert.js';
import { readSignedReceiptStatus } from '../integrations/computeid/receipt-verifier.js';
import {
  applyPassportEventToAgent,
  payloadHashOf,
  recordPassportFailure,
  recordPassportRevocationAuthority,
  type BoundAgentRow,
  type PassportDelivery,
  type TransitionOutcome,
} from '../integrations/computeid/passport-transition.js';
import { MAX_PROVIDER_EVENT_CLOCK_SKEW_MS } from '../integrations/computeid/binding.js';
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
/**
 * Distinct passports verified in parallel per page. Sequential 5 s calls put
 * 200 verifications at ~1000 s — past Cloud Run's 600 s request deadline and
 * past the 10-minute Sentry `maxRuntime`, so a DEGRADED partner would page ops
 * every hour while the job was simply too slow. Six at a time puts the same
 * worst case near ~170 s. Deliberately small: this is a safety net, not a
 * reason to hammer the partner.
 */
export const RECHECK_VERIFY_CONCURRENCY = 6;
/** `job_queue` singleton row carrying the scan cursor between runs. */
export const RECHECK_CURSOR_ROW_ID = '00000000-0000-4000-8000-00000004495c';
export const RECHECK_CURSOR_ROW_TYPE = 'computeid_recheck_cursor';
/**
 * The schedule this job is meant to be bound on, in ONE place. It is the
 * `withCronMonitoring` slug's declared crontab AND the schedule quoted in
 * `scripts/gcp-setup/cloud-scheduler.sh`'s NOT_SCHEDULED reason, and a test
 * asserts the two agree — nothing else bound the literal, so Sentry's monitor
 * could have drifted from the gcloud binding silently.
 *
 * Hourly but deliberately OFF the top of the hour: every `/jobs/*` route
 * shares one per-IP burst guard, so spreading hourly jobs away from `:00`
 * keeps one job's burst from eating another's headroom.
 */
export const COMPUTEID_RECHECK_CRON = '17 * * * *';

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
  /**
   * Distinct passports the partner refused to answer for on AUTHENTICATION
   * grounds (401/403, or no key at all). Broken out because a rotated partner
   * key makes every passport `unresolved` — a run that checks nothing and
   * still reports a clean 200 is the exact shape of an unnoticed outage.
   */
  unresolvedAuth: number;
  /** Observed partner statuses outside `STATUS_EVENT` — vocabulary drift, not a no-op. */
  unknownStatus: number;
  /** True when a cap stopped the run before every bound agent was examined. */
  truncated: boolean;
  /** Where the next run resumes, or null when this run completed a full pass. */
  nextCursor?: string | null;
}

export interface RecheckPorts {
  listBoundAgents(cursor: string | undefined, limit: number): Promise<BoundAgentRow[]>;
  verifyPassport(passportId: string): Promise<VerifyOutcome>;
  applyEvent(agent: BoundAgentRow, d: PassportDelivery): Promise<TransitionOutcome>;
  recordRevocationAuthority(d: PassportDelivery): Promise<boolean>;
  recordFailure(args: { reason: string; externalId: string | null; payloadHash: string }): Promise<void>;
  loadCa(): PinnedCa | null;
  /** Where the last run stopped. `undefined` starts a fresh pass at the lowest agent id. */
  readCursor(): Promise<string | undefined>;
  /** `null` records that a full pass completed and the next run restarts from the beginning. */
  writeCursor(cursor: string | null): Promise<void>;
  /**
   * Sampled PER OBSERVATION, not once per run. Receipts live 300 s and a run
   * can span longer than that, so a single run-level clock would let a receipt
   * that expired mid-run still verify as `signed` — and the reinstate path
   * reactivates API keys on exactly that evidence.
   */
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
    async readCursor() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (db as any)
        .from('job_queue')
        .select('payload')
        .eq('id', RECHECK_CURSOR_ROW_ID)
        .maybeSingle();
      // Fail FORWARD, not closed: an unreadable cursor restarts the pass from
      // the beginning, which re-checks more than it needs to. The opposite
      // default — refusing to run — would disable the safety net outright.
      if (error) {
        logger.warn({ error }, 'ComputeID re-check: cursor read failed — restarting the pass');
        return undefined;
      }
      const cursor = (data as { payload?: { cursor?: unknown } } | null)?.payload?.cursor;
      return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined;
    },
    async writeCursor(cursor) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (db as any).from('job_queue').upsert(
        {
          id: RECHECK_CURSOR_ROW_ID,
          type: RECHECK_CURSOR_ROW_TYPE,
          status: 'completed',
          scheduled_for: null,
          payload: { cursor },
        },
        { onConflict: 'id' },
      );
      if (error) logger.warn({ error }, 'ComputeID re-check: cursor write failed — the next run repeats this page');
    },
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

/**
 * What we believe the partner currently says, and how strongly.
 *
 * `expiresAt` is carried so a MEMOIZED observation cannot outlive the receipt
 * it came from: a run that spans more than the 300 s receipt lifetime must
 * re-verify rather than reuse a verdict that has since expired.
 */
export type Observation =
  | { kind: 'signed'; status: string; at: string; passportSignatureValid: boolean | null; expiresAt: number }
  | { kind: 'unsigned'; status: string }
  | { kind: 'unresolved'; reason: string };

/** Authentication-class failures — the partner refused US, not this passport. */
const AUTH_FAILURE_REASONS = new Set(['verify_not_configured', 'verify_http_error:401', 'verify_http_error:403']);

export function isAuthFailure(observation: Observation): boolean {
  return observation.kind === 'unresolved' && AUTH_FAILURE_REASONS.has(observation.reason);
}

/** The restrictive statuses the unsigned body can assert. Ordered most → least severe. */
function unsignedStatusOf(response: { status: string; revoked_at?: string | null }): string {
  const revoked = response.revoked_at != null && String(response.revoked_at).length > 0;
  return revoked ? 'revoked' : response.status.toLowerCase();
}

function observe(outcome: VerifyOutcome, passportId: string, ca: PinnedCa, now: Date): Observation {
  if (!outcome.ok) {
    return { kind: 'unresolved', reason: `verify_${outcome.reason}${outcome.status ? `:${outcome.status}` : ''}` };
  }
  const { response } = outcome;
  if (response.passport_id !== passportId) return { kind: 'unresolved', reason: 'verify_passport_id_mismatch' };

  const unsignedStatus = unsignedStatusOf(response);
  const receipt = response.verification_receipt;
  if (receipt) {
    const signed = readSignedReceiptStatus({ receipt, ca, expectedPassportId: passportId, now });
    if (!signed.ok) {
      // A receipt that is present but does not verify is not evidence of
      // anything. Do not quietly fall through to the unsigned status: that
      // would let a broken or forged receipt be laundered into a weaker trust
      // level.
      return { kind: 'unresolved', reason: `receipt_${signed.reason}` };
    }
    // A receipt minted in the future would be accepted by the verifier (it
    // enforces expiry, not issue-time skew) and then silently dropped by
    // `binding.ts`'s `future_event` guard — a divergence we would neither act
    // on nor notice. Refuse it here, where it is counted.
    if (signed.issuedAt && signed.issuedAt.getTime() > now.getTime() + MAX_PROVIDER_EVENT_CLOCK_SKEW_MS) {
      return { kind: 'unresolved', reason: 'receipt_not_yet_valid' };
    }
    // A receipt may CORROBORATE the body, never override it upward. The two
    // travel together in the same response and a receipt is minted before it
    // is read: an `active` receipt attached to a body that already says
    // `revoked`/`suspended` is the partner telling us both "this was active
    // five minutes ago" and "it is not now". Taking the receipt would silently
    // miss the revocation — or, on an agent we had suspended, REACTIVATE its
    // API keys. Fall back to the restrictive unsigned status instead.
    if (signed.status.toLowerCase() === 'active' && unsignedStatus !== 'active') {
      logger.warn(
        { passportId, receiptStatus: signed.status, bodyStatus: unsignedStatus },
        'ComputeID re-check: receipt and response body disagree — taking the restrictive status',
      );
      return { kind: 'unsigned', status: unsignedStatus };
    }
    return {
      kind: 'signed',
      status: signed.status,
      // The SIGNED issue time is what the ordering floor compares against.
      // Fall back to `now` only when the partner omits it entirely.
      at: (signed.issuedAt ?? now).toISOString(),
      passportSignatureValid: signed.passportSignatureValid,
      expiresAt: signed.expiresAt.getTime(),
    };
  }

  return { kind: 'unsigned', status: unsignedStatus };
}

/**
 * Partner status → the event a webhook would have carried. Every KEY must be
 * a real `AgentStatus`: `decideEvent` compares the key against `agent.status`,
 * so a key outside the enum can never equal one and the divergence it exists
 * to catch would read as `unknown_status` forever. Test-pinned.
 */
export const STATUS_EVENT: Record<string, ComputeIdPassportEvent> = {
  revoked: 'passport.revoked',
  suspended: 'passport.suspended',
  active: 'passport.reinstated',
};

export type RecheckDecision =
  | { event: ComputeIdPassportEvent; timestamp: string; tombstone: boolean }
  /** Nothing to do, and why — so a permanent divergence is counted rather than silent. */
  | { event: null; reason: 'agreed' | 'unknown_status' | 'insufficient_evidence' | 'locally_terminal' | 'suspended_by_org' };

const AGREED = { event: null, reason: 'agreed' } as const;

/**
 * The divergence → event mapping, and the place the evidence asymmetry is
 * enforced.
 *
 * TOMBSTONE is the second axis, and it is the security-relevant one.
 * `record_computeid_passport_revocation` (migration 0448) is a CROSS-ORG,
 * TERMINAL write with no clearing path: once written, that passport can never
 * be readmitted by anyone. The webhook producer earns it with an HMAC
 * signature over the delivery bytes. An unsigned re-check observation is only
 * TLS plus our own API key against a config-tunable base URL — strictly weaker
 * evidence for a strictly irreversible write. So unsigned evidence may
 * SUSPEND (reversible, `suspended_by: 'computeid'`, so a later signed `active`
 * lifts it) and nothing more; the tombstone requires a signature-verified
 * `revoked` receipt. Suspension already deactivates the API keys, which is the
 * outcome this job exists to guarantee — the tombstone is about permanence,
 * not about stopping the keys.
 */
export function decideEvent(
  agent: Pick<BoundAgentRow, 'status' | 'metadata'>,
  observation: Observation,
  now: Date,
): RecheckDecision {
  if (observation.kind === 'unresolved') return { event: null, reason: 'insufficient_evidence' };

  const observed = observation.status.toLowerCase();
  const event = STATUS_EVENT[observed];
  // An unrecognized partner status is not a licence to change anything — but
  // it IS partner vocabulary drift, which is worth noticing.
  if (!event) return { event: null, reason: 'unknown_status' };
  // Steady state: the partner agrees with us. No event, no write, no clock move.
  if (observed === agent.status.toLowerCase()) return AGREED;
  // Local revocation is terminal (binding.ts + the 0448 trigger): every event
  // would be declined. Say so instead of submitting one every hour forever.
  if (agent.status.toLowerCase() === 'revoked') return { event: null, reason: 'locally_terminal' };

  if (event === 'passport.reinstated') {
    // Only a suspension WE applied can be lifted by a partner event —
    // `binding.ts` answers `suspended_by_org` otherwise. Mirror that here or
    // the job submits the same doomed event every hour: binding's noop branch
    // still returns a metadata `update`, so each run takes the row lock,
    // writes a falsified `last_event: 'passport.reinstated'`, ratchets the
    // ordering floor and adds a permanent `declined`. The guard is
    // REINSTATE-ONLY — an org-suspended agent must stay suspendable, so this
    // can never fail open in the restrictive direction.
    if (readBinding(agent.metadata)?.suspended_by !== 'computeid') {
      return { event: null, reason: 'suspended_by_org' };
    }
    // Reactivating API keys demands the strongest evidence we can get.
    if (observation.kind !== 'signed') return { event: null, reason: 'insufficient_evidence' };
    if (observation.passportSignatureValid === false) return { event: null, reason: 'insufficient_evidence' };
    return { event, timestamp: observation.at, tombstone: false };
  }

  // Fail-safe direction: a signed observation carries its signed time; an
  // unsigned one is stamped at observation time, which is newer than any
  // existing floor and so cannot be mistaken for old news.
  if (observation.kind === 'signed') {
    return { event, timestamp: observation.at, tombstone: event === 'passport.revoked' };
  }
  // Unsigned: downgrade a revocation to a suspension. Same key deactivation,
  // no irreversible cross-org tombstone on evidence that cannot carry it.
  return { event: 'passport.suspended', timestamp: now.toISOString(), tombstone: false };
}

export async function runComputeIdPassportRecheck(
  ports: RecheckPorts = defaultRecheckPorts(),
): Promise<RecheckResult> {
  const empty: RecheckResult = {
    checked: 0, passportsVerified: 0, applied: 0, declined: 0,
    conflicts: 0, failures: 0, unresolved: 0, unresolvedAuth: 0,
    unknownStatus: 0, truncated: false,
  };

  if (!config.enableComputeidIntegration) return { ...empty, skipped: true, reason: 'flag_off' };
  if (!isVerifyClientConfigured()) {
    // The flag is ON, so operators believe the safety net is running. It is
    // not: without an API key this job cannot call the partner at all, and a
    // quiet `200 {skipped:true}` renders a healthy Sentry check-in. Say so.
    logger.error(
      'ComputeID re-check: ENABLE_COMPUTEID_INTEGRATION is on but COMPUTEID_API_KEY is unset — no passport is being re-checked',
    );
    Sentry.captureMessage('ComputeID re-check disabled: COMPUTEID_API_KEY unconfigured', {
      level: 'error',
      fingerprint: ['computeid-recheck-unconfigured'],
    });
    return { ...empty, skipped: true, reason: 'api_key_unconfigured' };
  }
  const ca = ports.loadCa();
  if (!ca) {
    Sentry.captureMessage('ComputeID re-check disabled: CA pin unusable', {
      level: 'error',
      fingerprint: ['computeid-recheck-unconfigured'],
    });
    return { ...empty, skipped: true, reason: 'ca_pin_unusable' };
  }

  const result: RecheckResult = { ...empty };
  const runMarker = `recheck:${ports.now().toISOString()}`;
  /** Per-passport, 64-hex, and stable within a run: the DLQ dedupes on (hash, reason). */
  const hashFor = (passportId: string) => payloadHashOf(`${passportId}:${runMarker}`);
  const observations = new Map<string, Observation>();
  /** Passports already given their terminal tombstone in THIS run. */
  const tombstoned = new Set<string>();

  let cursor = await ports.readCursor();
  const startedAt = cursor;
  let completedPass = false;

  scan: for (;;) {
    let page: BoundAgentRow[];
    try {
      page = await ports.listBoundAgents(cursor, RECHECK_PAGE_SIZE);
    } catch (error) {
      logger.error({ error }, 'ComputeID re-check: bound-agent lookup failed');
      result.failures += 1;
      // The lookup is the job. Losing it silently is how an hour of coverage
      // disappears with a 200 attached, so it gets a durable row too.
      await ports.recordFailure({
        reason: 'recheck_bound_agent_lookup_failed',
        externalId: null,
        payloadHash: payloadHashOf(`lookup:${runMarker}`),
      });
      break;
    }
    if (page.length === 0) { completedPass = true; break; }
    const next = page[page.length - 1].id;
    if (cursor && next <= cursor) {
      logger.error('ComputeID re-check: bound-agent cursor did not advance');
      result.failures += 1;
      break;
    }

    // Resolve this page's DISTINCT unmemoized passports with a bounded fan-out
    // before walking the agents. Sequentially, 200 verifications at the 5 s
    // request timeout is ~1000 s — past Cloud Run's 600 s deadline, so a slow
    // partner turned a working job into an hourly page.
    const pending: string[] = [];
    for (const agent of page) {
      const b = readBinding(agent.metadata);
      if (!b || observations.has(b.passport_id) || pending.includes(b.passport_id)) continue;
      if (result.passportsVerified + pending.length >= RECHECK_MAX_VERIFY_CALLS) break;
      pending.push(b.passport_id);
    }
    if (pending.length > 0) {
      result.passportsVerified += pending.length;
      await runWithConcurrency(
        pending.map((passportId) => async () => {
          // ONE CLOCK PER OBSERVATION. A receipt is valid for 300 s and a run
          // can outlast that; a run-level `now` would let a receipt that has
          // since expired still verify as `signed`, and the reinstate path
          // reactivates API keys on exactly that evidence.
          const at = ports.now();
          observations.set(passportId, observe(await ports.verifyPassport(passportId), passportId, ca, at));
        }),
        RECHECK_VERIFY_CONCURRENCY,
      );
    }
    cursor = next;

    for (const agent of page) {
      if (result.checked >= RECHECK_MAX_AGENTS_PER_RUN) { result.truncated = true; break scan; }
      result.checked += 1;

      const binding = readBinding(agent.metadata);
      if (!binding) continue; // Not actually bound (or a malformed binding) — nothing to reconcile.
      const passportId = binding.passport_id;

      const now = ports.now();
      let observation = observations.get(passportId);
      // A memoized SIGNED verdict expires with its receipt. Past that point it
      // is no longer a statement about the present, so it must not be reused.
      if (observation?.kind === 'signed' && now.getTime() >= observation.expiresAt) observation = undefined;
      if (!observation) {
        if (result.passportsVerified >= RECHECK_MAX_VERIFY_CALLS) { result.truncated = true; break scan; }
        result.passportsVerified += 1;
        observation = observe(await ports.verifyPassport(passportId), passportId, ca, now);
        observations.set(passportId, observation);
      }
      if (observation.kind === 'unresolved') {
        result.unresolved += 1;
        if (isAuthFailure(observation)) result.unresolvedAuth += 1;
        logger.warn({ passportId, reason: observation.reason }, 'ComputeID re-check: passport state could not be established');
        continue;
      }

      const decided = decideEvent(agent, observation, now);
      if (decided.event === null) {
        if (decided.reason === 'unknown_status') {
          result.unknownStatus += 1;
          logger.warn({ passportId, status: observation.status }, 'ComputeID re-check: unrecognized partner status');
        }
        continue;
      }

      const delivery: PassportDelivery = {
        event: decided.event,
        passportId,
        timestamp: decided.timestamp,
        payloadHash: hashFor(passportId),
      };

      if (decided.tombstone && !tombstoned.has(passportId)) {
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
          await ports.recordFailure({ reason: `recheck_transition_failed:${delivery.event}`, externalId: passportId, payloadHash: delivery.payloadHash });
          break;
      }
    }
    // Deliberately NOT `if (page.length < RECHECK_PAGE_SIZE) break`: a hosted
    // PostgREST cap can sit below our requested limit, so a short page does not
    // mean the last page. Termination is an EMPTY page, exactly as in
    // `findBoundAgents`. The cost is one extra empty query per run.
  }

  // The cursor is what makes the caps a RATE LIMIT rather than a ceiling: a
  // fleet larger than RECHECK_MAX_VERIFY_CALLS is covered across consecutive
  // runs instead of the first 200 agents being re-checked forever while the
  // rest are never checked at all. A completed pass restarts from the top.
  result.nextCursor = completedPass ? null : (cursor ?? null);
  if (result.nextCursor !== startedAt) await ports.writeCursor(result.nextCursor);

  // A run in which EVERY partner call was refused for authentication has
  // verified nothing — the classic shape of a rotated partner key. It must not
  // read as a healthy run, and a Sentry *message* alone is not enough: the
  // route answers 200 and `withCronMonitoring` then reports an OK check-in, so
  // the cron monitor would say the safety net is healthy while it is doing
  // nothing at all. THROW instead (CTO ruling 2026-09-12) — the route's catch
  // turns this into a 500, the check-in goes to `error`, and the monitor pages.
  // Partial auth failures do not qualify: one bad passport is not a rotated key.
  if (result.unresolvedAuth > 0 && result.unresolvedAuth === result.passportsVerified) {
    logger.error({ ...result }, 'ComputeID re-check: every partner call was rejected — the API key is likely rotated or revoked');
    Sentry.captureMessage('ComputeID re-check: all partner calls rejected (auth)', {
      level: 'error',
      fingerprint: ['computeid-recheck-auth-failure'],
      extra: { passportsVerified: result.passportsVerified },
    });
    throw new Error(
      `ComputeID re-check verified nothing: all ${result.passportsVerified} partner call(s) failed authentication`,
    );
  }
  if (result.truncated) {
    logger.warn({ ...result }, 'ComputeID re-check: capped before a full pass — coverage resumes next run');
    Sentry.captureMessage('ComputeID re-check truncated by run cap', {
      level: 'warning',
      fingerprint: ['computeid-recheck-truncated'],
      extra: { checked: result.checked, passportsVerified: result.passportsVerified },
    });
  }

  logger.info({ ...result }, 'ComputeID re-check complete');
  return result;
}
