/**
 * QUEUE-06 (SCRUM-2352) — connector_artifact drain consumer (THE LOOP-CLOSER).
 *
 * `connector_artifact` (mig 0343) is the inbox connectors write into via the
 * idempotent `enqueue_connector_artifact` RPC. Enqueue NEVER debits credits;
 * the debit lands here, at SECURING, via the live `debit_and_enqueue_anchor`
 * RPC (mig 0341). This module is the missing consumer that drains those rows.
 *
 * Lifecycle (per row): pending|queued → processing → materialized → anchored,
 * or → failed. Skipped rows are out of scope here (the producer sets them).
 *
 * CONCURRENCY AND PUBLICATION (migration 0445):
 *   The claim uses an org-scoped status CAS and returns its own fresh content.
 *   The service-role materialize_connector_artifact_anchor RPC locks that row,
 *   validates the captured timestamp, fingerprint and complete metadata, and
 *   publishes the anchor and artifact link in ONE transaction. A concurrent
 *   provenance heal either commits before validation (no publication), or
 *   waits until the link is set and its anchor_id IS NULL guard fails.
 *
 *   Never split creation from linking: claim_pending_anchors can observe any
 *   committed PENDING anchor, including one a later link CAS would reject.
 *   A compensating delete cannot close that broadcast window. The model's
 *   broadcastRequiresFreshLinkedAnchor invariant includes that observer.
 *
 *   Stale/uncertain RPC replies cause no compensating artifact writes: an old
 *   client cannot identify a newer processing lease, and a missing response
 *   can follow a successful commit. The existing reaper/confirmation paths
 *   recover either case, retaining anchor_id for idempotent debit retries.
 *   Credits move only through debit_and_enqueue_anchor, keyed on anchor id.
 *
 * §1.6A: this module handles ONLY the server-computed fingerprint + bounded,
 * PII-scrubbed metadata that already live on the row. It never reads, fetches,
 * logs, or alerts raw document bytes. Alerts carry ids + a bounded reason only.
 *
 * §-credit: the charge is `debitAndEnqueueAnchor` AT SECURING and nowhere else.
 */
import { z } from 'zod';
import { dbUuid } from '../utils/db-row-validation.js';
import { db as defaultDb } from '../utils/db.js';
import { logger as defaultLogger } from '../utils/logger.js';
import { processBatchAnchors, type BatchAnchorResult } from './batch-anchor.js';
import { callRpc } from '../utils/rpc.js';
import { Sentry } from '../utils/sentry.js';
import { config } from '../config.js';
import { findExistingEnvelopeAnchor } from './docusign-anchor-reconciliation.js';
import { boundedErrorDetail } from '../utils/byte-safety.js';

/**
 * The ONE way a failure string becomes safe to persist, alert on, or log as a
 * scalar on this path: length-capped (~500 post-scrub), byte-runs collapsed,
 * PII scrubbed. Never persist or alert on an unbounded vendor/DB string.
 *
 * NOTE: `boundedErrorDetail` emits lowercase placeholder tokens
 * (`[fingerprint]`, `[uuid]`, `[email]`) where `utils/pii-scrub.ts` emits
 * uppercase. Harmless today — nothing parses these — but do not build a
 * consumer that pattern-matches one casing.
 */
function boundedReason(raw: string): string {
  return boundedErrorDetail(raw) ?? 'drain row failed';
}

/**
 * Strict Zod schema for the `anchors` insert this job persists (CLAUDE.md §1.2:
 * Zod on every write path). The `metadata` carries semi-external artifact fields,
 * so validate the whole row shape before insert — a malformed fingerprint /
 * empty filename / wrong status is rejected before it reaches Postgres. The
 * status-update writes (claim/markStatus/markFailed/markRequeued) persist
 * server-controlled status LITERALS only, so they don't need a schema.
 *
 * EXPORTED for the SCRUM-2486 AC-4 importer-cannot-set-SECURED guard test —
 * `status: z.literal('PENDING')` + `.strict()` is the app-level proof that the
 * connector/importer path can never construct a SECURED (or chain-carrying)
 * anchor insert. Do not relax the literal or drop `.strict()`.
 */
export const AnchorInsertPayload = z
  .object({
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/, 'fingerprint must be 64-hex sha256'),
    status: z.literal('PENDING'),
    org_id: dbUuid('org_id'),
    user_id: dbUuid('user_id'),
    filename: z.string().min(1).max(255),
    // BUG-2026-09-29 defect 4: every connector artifact used to be published
    // as CONTRACT_POSTSIGNING unconditionally — truthful for DocuSign, a
    // hardcoded lie for Google Drive (a spreadsheet, a doc, anything a user
    // filed for safekeeping showed on the record page as "Contract —
    // Signed"). `OTHER` is an existing credential_type enum value (no new
    // one added) that `defaultMaterializeAnchor` now selects for
    // `source === 'google_drive'`; every other connector keeps
    // CONTRACT_POSTSIGNING, unchanged.
    credential_type: z.enum(['CONTRACT_POSTSIGNING', 'OTHER']),
    // BUG-2026-09-29 defect 4: `anchors.file_size`, populated from
    // `connector_artifact.byte_length` (already measured server-side at
    // fetch time, §1.6A) instead of being left NULL forever — the record
    // page showed "0 B" for every connector-sourced anchor. Nullable:
    // `anchors_file_size_positive` CHECKs `file_size IS NULL OR file_size >
    // 0`, so a missing/non-positive byte_length must stay NULL, never 0.
    file_size: z.number().int().positive().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    // Evidence class of the fingerprint on every row this drain materializes
    // (migration 0376/0384; CHECK-constrained on `anchors.fingerprint_source`).
    // BOTH connector paths materialize here: outbound fingerprints were measured
    // upstream from fetched bytes, inbound fingerprints are declared — so an
    // explicit evidence class is REQUIRED on every newly materialized row, never
    // omitted. R2 (CTO Decision Record, docusign-bilateral-2026-08) settled that
    // this drain must always classify what it persists rather than leaving NULL
    // "unclassified".
    //
    // 'document_bytes' is the R2 default and covers every pre-existing
    // connector path (DocuSign outbound, Google Drive): those fingerprints are
    // server-side hashes of bytes fetched from a connected third party under
    // the §1.6A carve-out (DS-03 `enqueueSignedDocument` and its twins).
    //
    // 'issuer_record_attestation' has exactly ONE producer — the inbound
    // declared-hash branch of `defaultMaterializeAnchor` below, where the
    // fingerprint was declared by the issuer and never measured from bytes
    // Arkova fetched (§1.5). That is why this is an enum and not a literal.
    fingerprint_source: z.enum(['document_bytes', 'issuer_record_attestation']),
  })
  .strict()
  .refine(
    value => value.fingerprint_source === (value.metadata['_direction'] === 'inbound'
      ? 'issuer_record_attestation' : 'document_bytes'),
    { message: 'fingerprint source must match connector provenance', path: ['fingerprint_source'] },
  );

const AtomicMaterializationReply = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('linked'), anchor_id: dbUuid('anchor_id'),
    public_id: z.string().nullable(), created: z.boolean() }),
  z.object({ outcome: z.literal('superseded') }),
  z.object({ outcome: z.literal('lost_lease') }),
]);

/** Page size per drain pass per org — bounded so one org can't starve the cycle. */
const DRAIN_LIMIT_DEFAULT = 50;
const DRAIN_LIMIT_MAX = 200;

/** The two pre-claim statuses a row can be drained from. */
const DRAINABLE_STATUSES = ['pending', 'queued'] as const;

/**
 * Founder decision 2026-09-25: when a document in a connected Drive/DocuSign
 * folder is UPDATED, the previously anchored version must stay
 * cryptographically valid and be marked SUPERSEDED — never duplicated as an
 * unrelated second anchor, and NEVER `REVOKED` (conflating a routine content
 * edit with a genuine withdrawal of validity would read to an auditor exactly
 * like a deliberate credential revocation).
 *
 * Sources in this set get the supersession check below; every other source
 * keeps today's plain-insert behavior unchanged.
 *
 * GATED TO 'google_drive' ONLY. `connector_artifact.external_revision` is the
 * per-source revision signal a redelivery/update is correlated on, and in
 * prod it is populated on 8/8 `google_drive` rows but 0/27 `docusign` rows
 * (verified via the connector_artifact table before this change) — DocuSign
 * has no revision handle to detect "this is a newer version of the same
 * document" from today. Widening this set to `docusign` without first wiring
 * a revision signal for it would silently change DocuSign's (already
 * double-anchoring) behavior in an unreviewed way — out of scope here.
 */
const SUPERSESSION_ENABLED_SOURCES: ReadonlySet<string> = new Set(['google_drive']);

/** Shape of a connector_artifact row we read (0343 columns; not yet in head types). */
export interface ConnectorArtifactRow {
  id: string;
  org_id: string;
  status: string;
  fingerprint_sha256: string;
  byte_length: number | null;
  source: string;
  external_ref: string;
  metadata: Record<string, unknown> | null;
  anchor_id: string | null;
  credit_deduction_id: string | null;
  /** Captured at claim time; SQL checks it with fingerprint AND full metadata. */
  updated_at: string;
}

export interface MaterializedAnchor {
  outcome: 'linked';
  anchorId: string;
  anchorPublicId: string | null;
  created: boolean;
}

/**
 * Rejected/uncertain publication must not write a possibly newer lease.
 *
 * `prior_anchor_revoked` (founder decision 2026-09-25): the document's prior
 * anchor lineage head is already `REVOKED` — a genuine, terminal withdrawal
 * of validity, not a routine version bump. `supersede_anchor` itself refuses
 * to touch a REVOKED anchor (`check_violation`), and this drain deliberately
 * never calls it in that case either: the artifact is left `processing` for
 * the existing lease reaper / operator review rather than either resurrecting
 * the revoked lineage or silently minting an unrelated new anchor for it.
 */
export type MaterializationOutcome =
  | MaterializedAnchor
  | { outcome: 'superseded' | 'lost_lease' | 'prior_anchor_revoked' };

/**
 * The current head of a connector document's anchor lineage, as looked up by
 * `findPriorConnectorAnchorForSupersession`. `fingerprint` lets the caller
 * decide "identical content, no-op" vs "genuine update, supersede" without a
 * second round trip; `status` lets the caller fail closed on a REVOKED head.
 */
export interface PriorConnectorAnchor {
  id: string;
  status: string;
  fingerprint: string;
}

export interface DebitResult {
  success: boolean;
  error?: string;
  /** Transport or malformed replies do not establish whether a debit committed. */
  outcome?: 'uncertain';
}

/** Bounded, PII-scrubbed alert payload (§1.6A — never raw bytes/fingerprint). */
export interface ConnectorArtifactAlert {
  scope: 'row' | 'cycle';
  orgId: string;
  artifactId?: string;
  reason: string;
}

interface DrainLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface DrainDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc?: (...args: unknown[]) => any;
}

export interface ConnectorArtifactDrainDeps {
  db: DrainDb;
  logger: DrainLogger;
  /** Materialize a PENDING anchor from a claimed artifact (fingerprint-only). */
  materializeAnchor: (row: ConnectorArtifactRow) => Promise<MaterializationOutcome>;
  /** Charge AT SECURING via debit_and_enqueue_anchor (mig 0341). */
  debitAndEnqueueAnchor: (args: { orgId: string; anchorId: string }) => Promise<DebitResult>;
  /**
   * Design-C (mig 0353): reset this org's drain-charged-but-never-batch-claimed
   * connector anchors (BROADCASTING, null tx) back to PENDING so `batchAnchor`
   * claims + submits them promptly — closing the submission-latency gap without
   * touching the (already-landed, exactly-once) charge. Returns rows reset.
   */
  resetUnclaimedConnectorBroadcasts: (args: { orgId: string; limit?: number }) => Promise<number>;
  /** The single worker-owned anchoring path (org-scoped). */
  batchAnchor: (opts: { force: true; orgId: string }) => Promise<BatchAnchorResult>;
  /**
   * Re-read the SPECIFIC anchor (org-scoped) to confirm it advanced past PENDING
   * before marking the artifact `anchored`. Returns null if the anchor is gone.
   */
  readAnchorStatus: (args: { orgId: string; anchorId: string }) => Promise<AnchorStatusRow | null>;
  /**
   * List this org's `materialized` artifacts (with an anchor_id) for the
   * CONFIRMATION re-read pass. Bounded by `limit`.
   */
  listMaterializedArtifacts: (args: { orgId: string; limit: number }) => Promise<MaterializedArtifactRef[]>;
  /** Emit a bounded, PII-scrubbed alert. Never throws into the drain loop. */
  emitAlert: (alert: ConnectorArtifactAlert) => void;
  /**
   * BUG-2026-09-29 item D: retry `resolve_connector_destination_folder`
   * (0462) for this org's still-unfiled connector anchors, every pass —
   * closes the gap where an anchor inserted while its connector connection
   * was momentarily revoked never gets re-routed. See
   * `defaultRetryUnfiledConnectorFolderRouting`'s doc comment.
   */
  retryUnfiledConnectorFolderRouting: (args: { orgId: string }) => Promise<{ attempted: number; filed: number }>;
  /** Page size per pass. */
  limit?: number;
}

/** A materialized artifact + its anchor, for the confirmation re-read. */
export interface MaterializedArtifactRef {
  id: string;
  anchor_id: string | null;
}

/** Minimal anchor shape read back to confirm the specific anchor advanced. */
export interface AnchorStatusRow {
  id: string;
  status: string;
  chain_tx_id: string | null;
}

/**
 * An anchor is "advanced" — i.e. this artifact's anchoring has IRREVERSIBLY
 * progressed and the artifact may be marked terminally `anchored` — ONLY on a
 * submit/secure signal that the recovery path cannot undo:
 *   - a `chain_tx_id` is recorded (the tx has been broadcast), OR
 *   - status is `SUBMITTED` or `SECURED`.
 *
 * Crucially we do NOT accept bare `BROADCASTING` (with a null `chain_tx_id`).
 * `debit_and_enqueue_anchor` ITSELF moves the anchor PENDING → BROADCASTING, so
 * every successful debit would otherwise instantly satisfy "advanced" and mark
 * the artifact terminal — before the tx is ever broadcast. Worse,
 * `recover_stuck_broadcasts()` resets a stale `BROADCASTING`/null-tx anchor back
 * to PENDING, so BROADCASTING is a REVERSIBLE, not-yet-durable state. A
 * BROADCASTING/null-tx anchor must keep its artifact `materialized` (retryable),
 * to be promoted by the confirmation re-read once it gains a tx / SUBMITTED /
 * SECURED.
 */
const ADVANCED_ANCHOR_STATUSES = new Set(['SUBMITTED', 'SECURED']);
function isAnchorAdvanced(anchor: AnchorStatusRow | null): boolean {
  if (!anchor) return false;
  if (typeof anchor.chain_tx_id === 'string' && anchor.chain_tx_id.length > 0) return true;
  return ADVANCED_ANCHOR_STATUSES.has(anchor.status);
}

/**
 * Whether a `materialized` artifact's anchor is still legitimately IN FLIGHT
 * (debited, broadcasting, awaiting a tx) — so the row must be LEFT materialized
 * for the confirmation re-read, NOT re-queued (a re-queue → re-debit would hit
 * `debit_and_enqueue_anchor`'s `p_expected_status='PENDING'` rejection on an
 * already-BROADCASTING anchor). A null/PENDING anchor is NOT in-flight (it has
 * no forward progress, or was reset by recover_stuck_broadcasts) → it may be
 * re-queued to re-drive the debit.
 */
function isAnchorInFlight(anchor: AnchorStatusRow | null): boolean {
  if (!anchor) return false;
  if (isAnchorAdvanced(anchor)) return true;
  return anchor.status === 'BROADCASTING';
}

export interface ConnectorArtifactDrainResult {
  claimed: number;
  anchored: number;
  failed: number;
  /**
   * Rows promoted materialized → anchored by the CONFIRMATION re-read (an anchor
   * debited on a PRIOR pass that has now gained a tx / SUBMITTED / SECURED). A
   * subset of the work that produced `anchored`; tracked separately so a pass
   * that only confirmed in-flight rows (claimed:0, anchored>0) is legible.
   */
  confirmed: number;
  /**
   * Materialized rows whose anchor lost forward progress (PENDING again, or
   * gone) and were re-queued by the confirmation step to re-drive the debit.
   */
  reconfirmRequeued: number;
  /** Legacy response field retained as zero: rejected snapshots are not requeued by this caller. */
  supersededRequeued: number;
  /**
   * BUG-2026-09-29 item D: anchors filed this pass by the retry-routing
   * sweep (a connector anchor that was unfiled because its connection was
   * momentarily revoked at INSERT time). Zero on every pass with nothing to
   * retry — this is the common case, not a failure signal.
   */
  refiled: number;
}

/**
 * Default Sentry-backed alert. Bounded scalar fields only — no row object, no
 * fingerprint, no bytes (§1.6A). A failure to alert is swallowed so it never
 * aborts the drain.
 */
/** Hard cap on the alert reason length at the sink — reasons can originate from
 * raw DB/RPC/Error messages, so bound them defensively (single line, truncated)
 * before they reach Sentry. Never leak an unbounded upstream payload. */
const MAX_ALERT_REASON_LEN = 200;
function boundReason(reason: string): string {
  const oneLine = String(reason ?? '').replace(/\s+/g, ' ').trim();
  // Reserve one char for the ellipsis so the RETURNED string never exceeds
  // MAX_ALERT_REASON_LEN (a naive slice-then-append would return LEN+1 chars).
  return oneLine.length > MAX_ALERT_REASON_LEN
    ? `${oneLine.slice(0, MAX_ALERT_REASON_LEN - 1)}…`
    : oneLine;
}

/**
 * F-4 (SCRUM-2625 / QUEUE-10): redact sensitive-shaped substrings from a
 * `reason` string BEFORE it reaches any alert/log sink. §1.6A forbids
 * fingerprints or PII in logs/Sentry/alerts, but every `reason` on this
 * drain path can originate from a raw Postgres/RPC/Error `.message` — and
 * Postgres constraint-violation text routinely echoes back the literal
 * offending value (e.g. `Key (fingerprint)=(<64-hex>) already exists`).
 * `boundReason`'s truncation alone does NOT remove sensitive content that
 * fits within the 200-char cap, so this scrub runs FIRST and is structural,
 * not length-based:
 *
 *   - 64-hex-char runs (document fingerprint shape, sha256) → `[fingerprint]`
 *   - UUIDs (org_id / anchor_id / user_id / artifact_id shape)  → `[uuid]`
 *   - email addresses                                           → `[email]`
 *
 * Known-safe coarse category strings (the literal string constants this
 * module already emits, e.g. `insufficient_credits`) contain none of these
 * shapes and pass through unchanged — this is a redaction pass, not a
 * allowlist, so it never needs updating when a new coarse category is added.
 */
// NOTE: the `i` flag is LOAD-BEARING on all three patterns — the character
// classes are written lowercase but match CASE-INSENSITIVELY. User/provider
// values preserve casing (Carson@Arkova.io, uppercase UUIDs/hex in Postgres
// error text), and the §1.6A guarantee must be structural, not dependent on
// input normalization: over-redaction is harmless, under-redaction is a leak.
// Pinned by the mixed-case/uppercase tests in connector-artifact-drain.test.ts.
const FINGERPRINT_RE = /\b[0-9a-f]{64}\b/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;

export function scrubReason(reason: string): string {
  const redacted = String(reason ?? '')
    .replace(FINGERPRINT_RE, '[fingerprint]')
    .replace(UUID_RE, '[uuid]')
    .replace(EMAIL_RE, '[email]');
  return boundReason(redacted);
}

/**
 * Wrap ANY `emitAlert` sink (default or caller-injected, e.g. a production
 * monitoring override) so `scrubReason` runs centrally, once, regardless of
 * which call site built the `reason` string. This is deliberately NOT left to
 * individual call sites to remember — a future call site that forgets to
 * scrub would reopen the §1.6A leak this fix closes. Every one of the three
 * places this module resolves an `emitAlert` dependency (`getDeps` for the
 * per-org drain, the reaper, and the cron entrypoint) routes through this.
 */
function wrapEmitAlert(sink: (alert: ConnectorArtifactAlert) => void): (alert: ConnectorArtifactAlert) => void {
  return (alert: ConnectorArtifactAlert) => sink({ ...alert, reason: scrubReason(alert.reason) });
}

function defaultEmitAlert(alert: ConnectorArtifactAlert): void {
  try {
    Sentry.captureMessage(`connector-artifact-drain ${alert.scope} failure`, {
      level: 'error',
      tags: { job: 'connector-artifact-drain', scope: alert.scope },
      extra: {
        org_id: alert.orgId,
        artifact_id: alert.artifactId,
        reason: scrubReason(alert.reason),
      },
    });
  } catch {
    /* alerting is best-effort — never fail the drain on a telemetry hiccup */
  }
}

/** Safely read a string field from the artifact's bounded `metadata` JSON. */
function metadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  if (metadata && typeof metadata === 'object') {
    const v = metadata[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Resolve an org owner/admin actor user_id for the anchor's required `user_id`
 * column. Mirrors `rule-action-dispatcher.resolveAnchorActorUserId`: an anchor
 * must be owned by a real org member, and a connector row has no inherent user.
 * Owner-inclusive: prefers `owner`, then `admin`.
 */
async function resolveOrgActorUserId(
  deps: Pick<ConnectorArtifactDrainDeps, 'db'>,
  orgId: string,
): Promise<string> {
  const { data, error } = await deps.db
    .from('org_members')
    .select('user_id, role')
    .eq('org_id', orgId)
    .in('role', ['owner', 'admin'])
    .order('role', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`actor lookup failed: ${(error as { message?: string }).message ?? 'unknown'}`);
  }
  const userId = (data as { user_id?: string } | null)?.user_id;
  if (!userId) throw new Error('no org owner/admin actor for connector artifact');
  return userId;
}

/**
 * Look up the CURRENT HEAD of a connector document's anchor lineage — i.e.
 * the anchor with the highest `version_number` — so a later revision of the
 * SAME document can be correlated against it.
 *
 * CORRELATION KEY: `(org_id, source, external_ref)` — deliberately NOT
 * `integration_id`. This is exactly `connector_artifact`'s own dedupe/identity
 * key (migration 0343: "Dedup/idempotency key: (org_id, source, external_ref,
 * COALESCE(external_revision,''))", i.e. the SAME (org, source, external_ref)
 * across different `external_revision` values IS the same logical document by
 * the producer's own contract). `external_ref` is the connector-native id
 * (Drive fileId) and is stable across a reconnect; `integration_id` is the
 * per-connection row and WOULD rotate if the org re-authorizes Drive, which
 * would silently stop supersession from finding the prior version — so it is
 * excluded on purpose, not by oversight.
 *
 * Every anchor this drain ever materializes (see `AnchorInsertPayload` /
 * `insertPayload.metadata` below) always carries both `connector_source` and
 * `external_ref` in its `metadata`, so this is a real, always-present key —
 * not a best-effort heuristic.
 *
 * A SINGLE indexed `.eq().eq()` point lookup — never `.or()` (see
 * `findExistingEnvelopeAnchor` above for why an OR-shaped filter is a planner
 * cost trap on the 3M+-row `anchors` table; two ANDed equalities do not have
 * that failure mode, so one query suffices here).
 *
 * Deliberately does NOT exclude `REVOKED` (unlike `findExistingEnvelopeAnchor`):
 * the caller must be able to see a REVOKED head and fail closed on it, rather
 * than this lookup silently skipping past it to an older, already-superseded
 * ancestor and superseding the wrong anchor.
 */
export async function findPriorConnectorAnchorForSupersession(args: {
  db: Pick<ConnectorArtifactDrainDeps, 'db'>['db'];
  orgId: string;
  source: string;
  externalRef: string;
}): Promise<PriorConnectorAnchor | null> {
  const { data, error } = await args.db
    .from('anchors')
    .select('id, status, fingerprint, version_number')
    .eq('org_id', args.orgId)
    .eq('metadata->>connector_source', args.source)
    .eq('metadata->>external_ref', args.externalRef)
    .is('deleted_at', null)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`prior connector anchor lookup failed: ${(error as { message?: string }).message ?? 'unknown'}`);
  }
  if (!data) return null;
  const row = data as { id?: string; status?: string; fingerprint?: string };
  if (!row.id || !row.status || !row.fingerprint) return null;
  return { id: row.id, status: row.status, fingerprint: row.fingerprint };
}

/**
 * Supersede `oldAnchorId` with a fresh child anchor carrying `row`'s
 * fingerprint, via the ALREADY-SHIPPED `supersede_anchor` 4-arg RPC (migration
 * 0367) — never reimplemented here. That RPC, in ONE transaction: locks the
 * old anchor, flips it to `SUPERSEDED` (never `REVOKED`), inserts the child
 * `PENDING` anchor with `parent_anchor_id` set (a BEFORE INSERT trigger then
 * derives `version_number = parent.version_number + 1` — see
 * `set_anchor_version_number()` — so this drain never computes or writes
 * either column itself), and is idempotent on `(parent_anchor_id,
 * new_fingerprint)`: a replay with the SAME new fingerprint returns the SAME
 * child id rather than forking the lineage or raising.
 *
 * `p_caller_user_id` is `callerUserId` — the SAME org owner/admin actor this
 * module already resolves as the anchor's `user_id` (`resolveOrgActorUserId`
 * / the DS-04 member-owner branch above). `supersede_anchor` requires the
 * caller to be a `profiles.role = 'ORG_ADMIN'` org member (see
 * `services/worker/src/api/agents.md`, "RPCs that read auth.uid() fail when
 * called from the worker" / the 0367 migration header): the org CREATION flow
 * atomically sets `org_members.role = 'owner'` AND `profiles.role =
 * 'ORG_ADMIN'` together (baseline `create_organization`-equivalent onboarding
 * function), and `invite_member` refuses to invite anyone else AS 'ORG_ADMIN'
 * — so the owner this drain already resolves is, in the normal case, the
 * SAME identity that already holds ORG_ADMIN. There is no independent human
 * caller for an automated connector supersession, so reusing the anchor's own
 * authoring actor is the least-surprising choice available without adding a
 * new "system actor" concept (which would be new schema/columns — out of
 * scope per this task's instructions).
 *
 * `supersede_anchor` has no notion of `connector_artifact` — it only touches
 * `anchors`. So after it returns, THIS function does the link-back with a
 * plain, lease-guarded UPDATE: only a row that still matches this exact
 * claimed lease (`status='processing'` AND the captured `updated_at`) may be
 * marked `materialized` + linked, mirroring the freshness guard
 * `materialize_connector_artifact_anchor` applies internally in SQL. A stale
 * match (0 rows) reports `lost_lease`, same posture as the atomic RPC path
 * below — never a compensating write.
 */
async function supersedeConnectorAnchor(
  row: ConnectorArtifactRow,
  oldAnchorId: string,
  callerUserId: string,
  deps: Pick<ConnectorArtifactDrainDeps, 'db'>,
): Promise<MaterializationOutcome> {
  const { data, error } = await callRpc<string>(deps.db as Parameters<typeof callRpc>[0], 'supersede_anchor', {
    old_anchor_id: oldAnchorId,
    new_fingerprint: row.fingerprint_sha256,
    reason: 'Connector document update (google_drive revision)',
    p_caller_user_id: callerUserId,
  });
  // A transport error can follow a committed transaction (same posture as the
  // atomic materialize RPC below) — never compensate by assuming it failed.
  if (error) return { outcome: 'lost_lease' };
  // RPC result is a Postgres uuid read back from the DB: shape-only validation
  // (FD-15 / BUG-2026-08-12-003), never strict RFC .uuid() here.
  const parsedId = dbUuid('supersede_anchor result').safeParse(data);
  if (!parsedId.success) return { outcome: 'lost_lease' };
  const newAnchorId = parsedId.data;

  const { data: linkedRow, error: linkError } = await deps.db
    .from('connector_artifact')
    .update({ status: 'materialized', anchor_id: newAnchorId, updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('org_id', row.org_id)
    .eq('status', 'processing')
    .eq('updated_at', row.updated_at)
    .select('id')
    .maybeSingle();
  if (linkError || !linkedRow) return { outcome: 'lost_lease' };

  const { data: anchorRow } = await deps.db
    .from('anchors')
    .select('public_id')
    .eq('id', newAnchorId)
    .maybeSingle();
  const publicId = (anchorRow as { public_id?: string } | null)?.public_id ?? null;

  return { outcome: 'linked', anchorId: newAnchorId, anchorPublicId: publicId, created: true };
}

/**
 * Founder decision 2026-09-25 — connector document-update supersession.
 * Returns a terminal outcome when the artifact supersedes a live prior anchor
 * (or must fail closed), and `null` when the normal materialization path
 * should proceed: source not enabled, no prior anchor, or identical fingerprint.
 */
async function maybeSupersedePriorAnchor(
  row: ConnectorArtifactRow,
  deps: Pick<ConnectorArtifactDrainDeps, 'db'>,
): Promise<MaterializationOutcome | null> {
  if (!SUPERSESSION_ENABLED_SOURCES.has(row.source)) return null;
  // Founder decision 2026-09-25 — connector document-update supersession.
  // Gated to `SUPERSESSION_ENABLED_SOURCES` (google_drive only; see that
  // const's comment for why DocuSign is excluded). A fresh lookup on EVERY
  // call (never cached across retries) is what makes this replay-safe: if a
  // supersede committed but the link-back below lost its lease, a retry's
  // lookup finds the ALREADY-CREATED child as the new head with a MATCHING
  // fingerprint and falls through to the normal (idempotent, unique-index
  // reuse) path instead of superseding twice.
  const prior = await findPriorConnectorAnchorForSupersession({
    db: deps.db,
    orgId: row.org_id,
    source: row.source,
    externalRef: row.external_ref,
  });
  if (prior && prior.fingerprint !== row.fingerprint_sha256) {
    if (prior.status === 'REVOKED') {
      // Fail closed (see the `prior_anchor_revoked` MaterializationOutcome
      // doc comment): never call supersede_anchor on a REVOKED head, never
      // mutate it, never mint an independent replacement automatically.
      return { outcome: 'prior_anchor_revoked' };
    }
    // SCRUM-5290 / DS-04: `userId` above may be a MEMBER owner — DS-04 exists
    // precisely so an ordinary, non-admin member can own their own personal
    // connector connection. But `supersede_anchor` (migration 0367) hard-
    // requires `caller_profile.role = 'ORG_ADMIN'` and raises otherwise, and
    // that raise is indistinguishable from a transient failure at this layer.
    // The row would be reaped back to `queued` every 15 minutes and retry
    // forever, so every update to a non-admin member's connected document
    // would be permanently, silently un-supersede-able.
    //
    // The supersede call therefore resolves its OWN org-admin actor. The
    // anchor's ownership is unaffected: `supersede_anchor` inherits `user_id`
    // from the prior anchor, so the member keeps their record.
    const supersedeActorId = await resolveOrgActorUserId(deps, row.org_id);
    if (!supersedeActorId) {
      // No org-admin actor resolvable: do NOT fall through to a plain insert,
      // which would silently reintroduce the duplicate-anchor defect this
      // change exists to remove. Fail closed and leave the row for retry.
      defaultLogger.warn(
        { artifactId: row.id, orgId: row.org_id },
        'connector supersession: no org-admin actor resolvable; leaving artifact queued',
      );
      return { outcome: 'lost_lease' as const };
    }
    return supersedeConnectorAnchor(row, prior.id, supersedeActorId, deps);
  }
  // No prior anchor (first-ever version of this file), or the fingerprint
  // is unchanged (identical content re-delivered) — fall through to the
  // normal path below unchanged. An identical fingerprint is handled for
  // free by the (user_id, fingerprint) unique-index reuse the atomic RPC
  // already performs: no new anchor, no supersession, `created: false`.


  return null;
}

/**
 * Default materializer: atomically publish and link a PENDING anchor from the artifact's
 * server-computed fingerprint (§1.6A — fingerprint only, never bytes). The
 * anchor schema requires `user_id` (resolved to an org owner/admin actor) and
 * `filename`; `credential_type` is CONTRACT_POSTSIGNING (the connector-sourced
 * credential type, matching the DocuSign rules-engine path). Idempotent on the
 * `(user_id, fingerprint) WHERE deleted_at IS NULL` unique index: a 23505 means
 * an earlier pass already created the anchor, so we resolve and reuse it rather
 * than failing the row.
 */
export async function defaultMaterializeAnchor(
  row: ConnectorArtifactRow,
  deps: Pick<ConnectorArtifactDrainDeps, 'db'>,
): Promise<MaterializationOutcome> {
  const memberOwnerId = metadataString(row.metadata, 'queue_scope') === 'member'
    ? metadataString(row.metadata, 'owner_user_id')
    : null;
  // DS-04 member artifacts are owned by the verified member connection owner.
  // Migration 0462 rechecks that ownership against the locked artifact, active
  // member_integrations row, and exact org membership before publication.
  const userId = memberOwnerId ?? await resolveOrgActorUserId(deps, row.org_id);

  // Founder decision 2026-09-25 — connector document-update supersession
  // (see maybeSupersedePriorAnchor for the replay-safety and actor rules).
  const superseded = await maybeSupersedePriorAnchor(row, deps);
  if (superseded) return superseded;

  // SCRUM-2904 envelope-level guard: if the declared-hash rules path already
  // created a live anchor for this same envelope (flag-flip-mid-flight race:
  // declared-hash ran while the connector flags were off, then they flipped on),
  // REUSE it instead of inserting a SECOND, distinct anchor. The
  // (user_id, fingerprint) unique index below only catches the equal-hash case;
  // this catches the DIFFERENT-hash case (asserted vs measured fingerprint).
  // Keyed on the envelope id (external_ref), org-scoped. Fail-closed: a lookup
  // error leaves the row recoverable for the lease reaper, rather
  // than risk a duplicate. §1.6A: reads coarse ids only — never bytes.
  const existingEnvelopeAnchor = await findExistingEnvelopeAnchor({
    db: deps.db,
    orgId: row.org_id,
    envelopeId: row.external_ref,
  });
  const filename =
    metadataString(row.metadata, 'filename') ??
    metadataString(row.metadata, 'external_filename') ??
    `${row.source}:${row.external_ref}`.slice(0, 255);

  // docusign-bilateral-2026-08: the INBOUND declared-hash webhook path
  // (services/worker/src/api/v1/webhooks/docusign.ts) writes `_direction:
  // 'inbound'` onto the connector_artifact's own metadata before this row is
  // ever drained — see that handler for the classification logic. Every
  // OTHER connector path (today: DocuSign outbound, Google Drive) never sets
  // `_direction`, so `isInboundDeclaredHash` is false for 100% of existing
  // traffic — this branch is additive and does not change any prior behavior.
  const isInboundDeclaredHash = metadataString(row.metadata, '_direction') === 'inbound';

  // BUG-2026-09-29 defect 4: CONTRACT_POSTSIGNING is truthful for DocuSign (a
  // signed contract) but not for Google Drive, where a file can be anything
  // a user filed for safekeeping — a spreadsheet, a policy doc, a photo.
  // `OTHER` is an existing enum value; every non-Drive source keeps today's
  // behavior unchanged.
  const credentialType: 'CONTRACT_POSTSIGNING' | 'OTHER' =
    row.source === 'google_drive' ? 'OTHER' : 'CONTRACT_POSTSIGNING';
  // BUG-2026-09-29 defect 4: mirrors the anchors_file_size_positive CHECK
  // (`file_size IS NULL OR file_size > 0`) so a zero/negative/absent
  // byte_length is never sent as 0 — it stays NULL, exactly like an anchor
  // whose size was never measured.
  const fileSize = typeof row.byte_length === 'number' && row.byte_length > 0
    ? row.byte_length
    : null;

  const insertPayload = {
    fingerprint: row.fingerprint_sha256,
    status: 'PENDING' as const,
    org_id: row.org_id,
    user_id: userId,
    filename,
    credential_type: credentialType,
    file_size: fileSize,
    // Spread the artifact's own metadata FIRST so the trusted connector fields
    // below always WIN — a (possibly attacker-influenced) metadata key named
    // `connector_source` / `connector_artifact_id` / `external_ref` can never
    // spoof the server-derived provenance fields.
    metadata: {
      ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
      connector_source: row.source,
      connector_artifact_id: row.id,
      external_ref: row.external_ref,
    },
    // The service-authored direction selects the evidence class; a declared
    // inbound fingerprint must never be represented as measured document bytes.
    // R2 default is 'document_bytes': the fingerprint is a server-computed hash
    // of fetched document bytes (DS-03 enqueueSignedDocument and its Drive /
    // other connector twins). The inbound declared-hash branch is the ONLY
    // producer of 'issuer_record_attestation' — there the fingerprint was
    // declared by the issuer, never measured from bytes Arkova fetched (§1.5).
    // Always set, never omitted. See the schema comment on AnchorInsertPayload.
    fingerprint_source: isInboundDeclaredHash
      ? ('issuer_record_attestation' as const)
      : ('document_bytes' as const),
  };

  // Validate the persisted row before insert (§1.2). Parse failures throw into
  // the per-row try/catch → publication is withheld and a bounded alert is raised.
  const validatedPayload = AnchorInsertPayload.parse(insertPayload);

  // The SQL transaction locks and validates the captured artifact before any
  // anchor can become visible to another worker. Never split this RPC back
  // into an INSERT followed by a compensating freshness/link statement.
  const { data, error } = await callRpc<unknown>(deps.db as Parameters<typeof callRpc>[0], 'materialize_connector_artifact_anchor', {
    p_artifact_id: row.id,
    p_org_id: row.org_id,
    p_expected_updated_at: row.updated_at,
    p_expected_fingerprint: row.fingerprint_sha256,
    p_expected_metadata: row.metadata,
    p_anchor_payload: validatedPayload,
    p_existing_anchor_id: row.anchor_id ?? existingEnvelopeAnchor?.id ?? null,
  });
  // A transport error can follow a committed transaction. Do not compensate
  // by clearing its link or overwriting a newly acquired processing lease.
  if (error) return { outcome: 'lost_lease' };
  const parsed = AtomicMaterializationReply.safeParse(data);
  if (!parsed.success) return { outcome: 'lost_lease' };
  if (parsed.data.outcome !== 'linked') return { outcome: parsed.data.outcome };
  return {
    outcome: 'linked', anchorId: parsed.data.anchor_id,
    anchorPublicId: parsed.data.public_id, created: parsed.data.created,
  };
}

/**
 * Default debit at SECURING via the live mig-0341 RPC. The RPC atomically
 * debits one credit AND transitions the anchor PENDING → BROADCASTING in one
 * txn; idempotent on the anchor id (a replay re-drives the same single charge).
 */
async function defaultDebitAndEnqueueAnchor(
  args: { orgId: string; anchorId: string },
  deps: Pick<ConnectorArtifactDrainDeps, 'db'>,
): Promise<DebitResult> {
  const { data, error } = await callRpc<{ success: boolean; error?: string }>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deps.db as any,
    'debit_and_enqueue_anchor',
    {
      p_org_id: args.orgId,
      p_anchor_id: args.anchorId,
      p_amount: 1,
      p_reason: 'anchor.secure',
      p_target_status: 'BROADCASTING',
      p_expected_status: 'PENDING',
    },
  );
  // A transport error may arrive after COMMIT. Only an explicit, validated
  // business rejection establishes that no debit landed; unknown replies must
  // leave the linked artifact available to confirmation/idempotent recovery.
  if (error) return { success: false, outcome: 'uncertain', error: boundedReason(error.message) };
  const parsed = z.discriminatedUnion('success', [
    z.object({ success: z.literal(true) }),
    z.object({ success: z.literal(false), error: z.enum([
      'invalid_amount', 'reference_id_required', 'org_not_initialized',
      'insufficient_credits', 'anchor_not_in_expected_status',
    ]) }),
  ]).safeParse(data);
  if (!parsed.success) return { success: false, outcome: 'uncertain', error: 'debit_reply_unrecognized' };
  if (!parsed.data.success) return { success: false, error: parsed.data.error };
  return { success: true };
}

/**
 * Default design-C reset via mig-0353 RPC. Resets this org's drain-charged,
 * never-batch-claimed connector anchors (BROADCASTING/null-tx) back to PENDING so
 * `batchAnchor` claims + submits them in the same pass. Best-effort: a failure just
 * leaves the anchors for the generic recover_stuck_broadcasts sweep (the original
 * latency behavior) — it NEVER blocks the drain and NEVER touches the charge.
 * Returns the number of anchors reset (0 on error).
 */
async function defaultResetUnclaimedConnectorBroadcasts(
  args: { orgId: string; limit?: number },
  deps: Pick<ConnectorArtifactDrainDeps, 'db'>,
): Promise<number> {
  const { data, error } = await callRpc<Array<{ id: string }>>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deps.db as any,
    'reset_unclaimed_connector_broadcasts',
    { p_org_id: args.orgId, p_limit: args.limit ?? 500 },
  );
  if (error) return 0;
  return Array.isArray(data) ? data.length : 0;
}

/**
 * Default anchor re-read: fetch the SPECIFIC anchor (org-scoped) so the drain
 * can confirm IT advanced past PENDING before marking the artifact `anchored`,
 * rather than trusting the aggregate batch count. Returns null if the row is
 * missing (or on error — the caller treats null as "not confirmed advanced",
 * keeping the artifact retryable rather than terminally-anchored on a flake).
 */
async function defaultReadAnchorStatus(
  args: { orgId: string; anchorId: string },
  deps: Pick<ConnectorArtifactDrainDeps, 'db'>,
): Promise<AnchorStatusRow | null> {
  const { data, error } = await deps.db
    .from('anchors')
    .select('id, status, chain_tx_id')
    .eq('id', args.anchorId)
    .eq('org_id', args.orgId)
    .maybeSingle();
  // SCRUM-3836: `null` meant both "query failed" and "anchor not found".
  if (error) {
    defaultLogger.error({ error, anchorId: args.anchorId }, 'Anchor status read failed — treating as not found');
    return null;
  }
  if (!data) return null;
  return {
    id: data.id as string,
    status: data.status as string,
    chain_tx_id: (data.chain_tx_id as string | null) ?? null,
  };
}

/**
 * Default `materialized` artifact enumerator (org-scoped) for the confirmation
 * re-read. Only rows with an anchor_id can be confirmed; a materialized row with
 * a null anchor_id is anomalous and left for the reaper/operator.
 */
async function defaultListMaterializedArtifacts(
  args: { orgId: string; limit: number },
  deps: Pick<ConnectorArtifactDrainDeps, 'db'>,
): Promise<MaterializedArtifactRef[]> {
  const { data, error } = await deps.db
    .from('connector_artifact')
    .select('id, anchor_id')
    .eq('org_id', args.orgId)
    .eq('status', 'materialized')
    .order('updated_at', { ascending: true })
    .limit(args.limit);
  if (error) {
    throw new Error(`materialized enumeration failed: ${(error as { message?: string }).message ?? 'unknown'}`);
  }
  return ((data ?? []) as Array<{ id?: string; anchor_id?: string | null }>)
    .filter((r): r is { id: string; anchor_id: string | null } => typeof r.id === 'string')
    .map((r) => ({ id: r.id, anchor_id: r.anchor_id ?? null }));
}

/** Connector sources `resolve_connector_destination_folder` (0462) knows how to route. */
const FOLDER_ROUTABLE_CONNECTOR_SOURCES: ReadonlySet<string> = new Set(['google_drive', 'docusign']);
/** Bounded so one org's unfiled backlog never dominates a drain pass. */
const RETRY_UNFILED_FOLDER_ROUTING_LIMIT = 25;

/**
 * BUG-2026-09-29 item D — routing is INSERT/UPDATE-time-only in SQL (0462's
 * `trg_00_route_connector_anchor_to_folder` / `trg_route_materialized_
 * connector_anchor_to_folder`), so an anchor inserted while its connector
 * connection is MOMENTARILY revoked (a disconnect-then-reconnect race) never
 * gets a second chance unless some UNRELATED later artifact update happens to
 * touch the same anchor and fire the AFTER UPDATE trigger. Confirmed against
 * prod (read-only, 2026-09-29T21:50Z): anchor ARK-DOC-7RFUVV was inserted at
 * 20:55:00Z with `folder_id` NULL because `org_integrations` row `2b47529f`
 * was `revoked_at` 20:51:19Z (reconnected 20:55:56Z), so
 * `resolve_connector_destination_folder`'s `v_connection_ok` check failed at
 * INSERT time — it was only filed later, at 21:20:02Z, when a DIFFERENT
 * artifact update for the same anchor incidentally fired the AFTER UPDATE
 * trigger. Without that incidental later write, the anchor stays unfiled
 * forever.
 *
 * Smallest safe fix: every drain pass for an org ALSO retries routing for
 * that org's still-unfiled connector anchors, reusing the EXISTING,
 * already-deployed, service-role-only `resolve_connector_destination_folder`
 * RPC (0462) — no new SQL, no migration. Worker-only.
 *
 * Bounded (`RETRY_UNFILED_FOLDER_ROUTING_LIMIT`), best-effort (never throws —
 * a failure here must never fail the artifact drain it rides along with),
 * and idempotent (`.is('folder_id', null)` on both the read and the write, so
 * a race with the SQL trigger filing the same anchor first is a harmless
 * no-op here).
 */
export async function defaultRetryUnfiledConnectorFolderRouting(
  args: { orgId: string },
  deps: Pick<ConnectorArtifactDrainDeps, 'db' | 'logger'>,
): Promise<{ attempted: number; filed: number }> {
  const result = { attempted: 0, filed: 0 };
  let candidates: Array<{ id: string; user_id: string; org_id: string; metadata: Record<string, unknown> | null }>;
  try {
    const { data, error } = await deps.db
      .from('anchors')
      .select('id, user_id, org_id, metadata')
      .eq('org_id', args.orgId)
      .is('folder_id', null)
      .limit(RETRY_UNFILED_FOLDER_ROUTING_LIMIT);
    if (error) {
      deps.logger.warn({ error, orgId: args.orgId }, 'retry unfiled connector folder routing: candidate select failed');
      return result;
    }
    candidates = (data ?? []) as typeof candidates;
  } catch (err) {
    deps.logger.warn({ err, orgId: args.orgId }, 'retry unfiled connector folder routing: candidate select threw');
    return result;
  }

  for (const anchor of candidates) {
    const metadata = anchor.metadata ?? {};
    const source = typeof metadata.connector_source === 'string' ? metadata.connector_source : null;
    const artifactId = typeof metadata.connector_artifact_id === 'string' ? metadata.connector_artifact_id : null;
    // Not a connector-routable anchor at all (manual/batch upload, or a
    // connector this RPC does not route) — nothing to retry.
    if (!source || !FOLDER_ROUTABLE_CONNECTOR_SOURCES.has(source) || !artifactId) continue;
    result.attempted += 1;
    try {
      const { data: folderId, error: rpcError } = await callRpc<string>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        deps.db as any,
        'resolve_connector_destination_folder',
        {
          p_artifact_id: artifactId,
          p_anchor_user_id: anchor.user_id,
          p_anchor_org_id: anchor.org_id,
        },
      );
      // NULL is a legitimate "still not routable" answer (connection still
      // revoked, no mirrored folder yet, etc.) — not a failure, nothing to log.
      if (rpcError || !folderId) continue;
      const { error: updateError } = await deps.db
        .from('anchors')
        .update({ folder_id: folderId })
        .eq('id', anchor.id)
        .is('folder_id', null);
      if (updateError) {
        deps.logger.warn(
          { error: updateError, orgId: args.orgId, anchorId: anchor.id },
          'retry unfiled connector folder routing: folder_id update failed',
        );
        continue;
      }
      result.filed += 1;
    } catch (err) {
      deps.logger.warn(
        { err, orgId: args.orgId, anchorId: anchor.id },
        'retry unfiled connector folder routing: per-anchor attempt failed',
      );
    }
  }
  return result;
}

function getDeps(injected: Partial<ConnectorArtifactDrainDeps>): ConnectorArtifactDrainDeps {
  const db = injected.db ?? (defaultDb as unknown as DrainDb);
  return {
    db,
    logger: injected.logger ?? (defaultLogger as unknown as DrainLogger),
    materializeAnchor: injected.materializeAnchor ?? ((row) => defaultMaterializeAnchor(row, { db })),
    debitAndEnqueueAnchor: injected.debitAndEnqueueAnchor ?? ((args) => defaultDebitAndEnqueueAnchor(args, { db })),
    resetUnclaimedConnectorBroadcasts:
      injected.resetUnclaimedConnectorBroadcasts ?? ((args) => defaultResetUnclaimedConnectorBroadcasts(args, { db })),
    batchAnchor: injected.batchAnchor ?? ((opts) => processBatchAnchors(opts)),
    readAnchorStatus: injected.readAnchorStatus ?? ((args) => defaultReadAnchorStatus(args, { db })),
    listMaterializedArtifacts:
      injected.listMaterializedArtifacts ?? ((args) => defaultListMaterializedArtifacts(args, { db })),
    emitAlert: wrapEmitAlert(injected.emitAlert ?? defaultEmitAlert),
    retryUnfiledConnectorFolderRouting:
      injected.retryUnfiledConnectorFolderRouting ??
      ((args) => defaultRetryUnfiledConnectorFolderRouting(args, { db, logger: injected.logger ?? (defaultLogger as unknown as DrainLogger) })),
    limit: injected.limit,
  };
}

/**
 * Claim a single row with a compare-and-set UPDATE. Returns the row's FRESH
 * content (via the UPDATE's own `RETURNING`) only if THIS call transitioned it
 * pending|queued → processing; `null` if a concurrent winner already claimed it
 * (the loser's UPDATE matches zero rows → skip, never double-anchor).
 *
 * SECURITY (code-review finding, 2026-09-01 — closes a TOCTOU that let a drain
 * mint an anchor from a FORGED fingerprint): this CAS UPDATE's `RETURNING` is
 * the ONE point of truth for what gets materialized. The caller's batch SELECT
 * a moment earlier is only a candidate-id list — its row content can go stale
 * before this row's turn: `findExistingEnvelopeAnchor`, `resolveOrgActorUserId`,
 * and every earlier row in the same batch (processed sequentially, each with
 * its own awaits) all cost real wall-clock time, during which
 * `docusign-envelope-completed.ts`'s provenance auto-heal can run and correctly
 * overwrite this row's `fingerprint_sha256`/`metadata` (its own `WHERE
 * anchor_id IS NULL` still matches an unclaimed row). Returning the row as of
 * THIS UPDATE — not the batch-read snapshot — means materialization always
 * sees whichever write (heal or claim) actually landed first, exactly as the
 * heal's own `EvalPlanQual` reasoning already assumes for the reverse
 * direction. Never widen this back to a boolean and re-introduce a second read
 * of the row.
 */
async function claimRow(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  id: string,
): Promise<ConnectorArtifactRow | null> {
  const { data, error } = await deps.db
    .from('connector_artifact')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', orgId)
    .in('status', DRAINABLE_STATUSES as unknown as string[])
    .select('id, org_id, status, fingerprint_sha256, byte_length, source, external_ref, metadata, anchor_id, credit_deduction_id, updated_at')
    .maybeSingle();

  if (error) {
    deps.logger.warn({ error, artifactId: id, orgId }, 'connector-artifact claim failed');
    return null;
  }
  return (data as ConnectorArtifactRow | null) ?? null;
}

/**
 * CONFIRMATION re-read over this org's `materialized` rows. For each, re-read
 * the SPECIFIC anchor and reconcile WITHOUT a re-debit (the anchor is already
 * past PENDING once debited, so a re-debit would be rejected):
 *
 *   - anchor ADVANCED (tx / SUBMITTED / SECURED, irreversible) → promote the
 *     artifact materialized → `anchored` (status-guarded). Counts anchored +
 *     confirmed.
 *   - anchor IN FLIGHT (BROADCASTING, null tx — debited, not yet broadcast) →
 *     LEAVE `materialized`. Re-queuing would force a re-debit the RPC rejects;
 *     the broadcast/recovery path owns advancing it, and the next confirmation
 *     pass promotes it once it gains a tx.
 *   - anchor PENDING (debit never landed, or `recover_stuck_broadcasts` reset a
 *     stale broadcast back to PENDING) or GONE → no forward progress, so
 *     re-queue materialized → `queued` to re-drive the debit (now PENDING-
 *     expected → accepted). Idempotent: materialize resolves the SAME anchor
 *     (fingerprint unique index), debit keys on the anchor id → no double-charge.
 *
 * Org-scoped, status-guarded, never throws into the caller (a confirmation
 * failure is logged/alerted; the new-row drain still proceeds).
 */
async function confirmMaterializedArtifacts(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  limit: number,
  result: ConnectorArtifactDrainResult,
): Promise<void> {
  let materialized: MaterializedArtifactRef[];
  try {
    materialized = await deps.listMaterializedArtifacts({ orgId, limit });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'materialized enumeration failed';
    deps.emitAlert({ scope: 'cycle', orgId, reason });
    deps.logger.error({ error: err, orgId }, 'connector-artifact confirmation enumeration failed');
    return; // don't abort the new-row drain on a confirmation read failure
  }

  for (const ref of materialized) {
    await confirmOneMaterializedArtifact(deps, orgId, ref, result);
  }
}

/**
 * Confirmation re-read for ONE materialized artifact. See
 * `confirmMaterializedArtifacts` for the advanced / in-flight / lost-progress
 * decision table. Never throws into the loop (per-row isolation).
 */
async function confirmOneMaterializedArtifact(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  ref: MaterializedArtifactRef,
  result: ConnectorArtifactDrainResult,
): Promise<void> {
  if (!ref.anchor_id) {
    // A materialized row with no anchor_id is anomalous (we always set it on
    // the processing→materialized transition). Leave it for the operator.
    deps.logger.warn({ orgId, artifactId: ref.id }, 'connector-artifact materialized row missing anchor_id — skipping confirmation');
    return;
  }
  const anchorId = ref.anchor_id;

  let anchor: AnchorStatusRow | null;
  try {
    anchor = await deps.readAnchorStatus({ orgId, anchorId });
  } catch (err) {
    // Per-row isolation: a read flake leaves the row materialized (retryable).
    deps.logger.warn({ error: err, orgId, artifactId: ref.id, anchorId }, 'connector-artifact confirmation re-read failed — left materialized');
    return;
  }

  if (isAnchorAdvanced(anchor)) {
    // Irreversibly advanced → promote to terminal anchored (status-guarded).
    if (await markAnchored(deps, orgId, ref.id, anchorId)) {
      result.anchored += 1;
      result.confirmed += 1;
      deps.logger.info({ orgId, artifactId: ref.id, anchorId, anchorStatus: anchor!.status }, 'connector-artifact confirmed anchored');
    } else {
      deps.logger.warn({ orgId, artifactId: ref.id }, 'connector-artifact lost lease at confirmation promote — stopping row');
    }
    return;
  }

  if (isAnchorInFlight(anchor)) {
    // BROADCASTING/null-tx: still in flight, NOT re-queueable (would re-debit).
    // Leave materialized; a later pass promotes it once it gains a tx.
    deps.logger.info({ orgId, artifactId: ref.id, anchorId }, 'connector-artifact anchor in flight (BROADCASTING) — left materialized for next confirmation');
    return;
  }

  // Anchor PENDING (reset/never-debited) or gone: no forward progress → re-queue
  // to re-drive the debit (now PENDING-expected). Status-guarded.
  if (await markRequeued(deps, orgId, ref.id)) {
    result.reconfirmRequeued += 1;
    deps.emitAlert({ scope: 'row', orgId, artifactId: ref.id, reason: 'anchor_not_advanced_requeued' });
    deps.logger.warn({ orgId, artifactId: ref.id, anchorId, anchorStatus: anchor?.status ?? 'missing' }, 'connector-artifact anchor lost progress — re-queued to re-debit');
  } else {
    deps.logger.warn({ orgId, artifactId: ref.id }, 'connector-artifact lost lease at confirmation re-queue — stopping row');
  }
}

/**
 * Drain `connector_artifact` rows for ONE org. Strictly org-scoped: every read,
 * claim, and write filters on `org_id`, so draining one org never touches
 * another's rows (cross-org isolation).
 */
export async function drainConnectorArtifactsForOrg(
  orgId: string,
  injected: Partial<ConnectorArtifactDrainDeps> = {},
): Promise<ConnectorArtifactDrainResult> {
  const deps = getDeps(injected);
  const limit = Math.max(1, Math.min(deps.limit ?? DRAIN_LIMIT_DEFAULT, DRAIN_LIMIT_MAX));
  const result: ConnectorArtifactDrainResult = {
    claimed: 0,
    anchored: 0,
    failed: 0,
    confirmed: 0,
    reconfirmRequeued: 0,
    supersededRequeued: 0,
    refiled: 0,
  };

  // CONFIRMATION PRE-STEP: promote/reconcile prior-pass `materialized` rows
  // BEFORE the new-row drain. An anchor debited last pass is now BROADCASTING;
  // it can only become terminal `anchored` by gaining a tx / SUBMITTED /
  // SECURED — a CONFIRMATION re-read, never a re-debit (the debit RPC expects
  // PENDING and would reject a BROADCASTING anchor).
  await confirmMaterializedArtifacts(deps, orgId, limit, result);

  // BUG-2026-09-29 item D: retry folder routing for this org's still-unfiled
  // connector anchors on EVERY pass, deliberately BEFORE the
  // candidateIds.length===0 early return below — an org can go passes at a
  // time with nothing new to claim while still carrying an anchor left
  // unfiled by a momentary connection-revoked race at INSERT time (see
  // `defaultRetryUnfiledConnectorFolderRouting`'s doc comment). Best-effort:
  // a failure here is logged by the dep itself and never blocks the drain.
  try {
    const retry = await deps.retryUnfiledConnectorFolderRouting({ orgId });
    result.refiled = retry.filed;
  } catch (err) {
    deps.logger.warn({ err, orgId }, 'connector-artifact drain: retry unfiled folder routing threw (best-effort, drain continues)');
  }

  // Candidate rows for THIS org only. DELIBERATELY id-only: this SELECT feeds
  // ONLY the claim loop below with WHICH rows to attempt, never their content.
  // Row CONTENT (fingerprint_sha256, metadata, anchor_id, ...) is read exactly
  // once, at claim time, from `claimRow`'s own CAS UPDATE `RETURNING` — see
  // that function's header for why a second, earlier read here would be a
  // stale-snapshot TOCTOU.
  const { data: candidates, error: selectError } = await deps.db
    .from('connector_artifact')
    .select('id')
    .eq('org_id', orgId)
    .in('status', DRAINABLE_STATUSES as unknown as string[])
    .order('created_at', { ascending: true })
    .limit(limit);

  if (selectError) {
    // Cycle-level failure: log + alert, then surface so the caller (cron route)
    // returns non-200 and Cloud Scheduler retries. NO silent drop.
    deps.emitAlert({ scope: 'cycle', orgId, reason: `select failed: ${(selectError as { message?: string }).message ?? 'unknown'}` });
    throw new Error(`connector-artifact select failed for org ${orgId}`);
  }

  const candidateIds = ((candidates ?? []) as Array<{ id?: string }>)
    .map((r) => r.id)
    .filter((id): id is string => typeof id === 'string');
  if (candidateIds.length === 0) return result;

  for (const id of candidateIds) {
    // Concurrency-safe claim. A loser (already 'processing') skips silently —
    // it is NOT a failure, it's the exactly-once guarantee working. The
    // returned `claimedRow` is the row's content AS OF THIS CAS UPDATE — the
    // only content ever passed into materialization (never the id-only
    // candidate list above).
    const claimedRow = await claimRow(deps, orgId, id);
    if (!claimedRow) continue;
    result.claimed += 1;
    await drainOneClaimedRow(deps, orgId, claimedRow, result);
  }

  deps.logger.info({ orgId, ...result }, 'connector-artifact drain pass complete');
  return result;
}

/**
 * Full pipeline for ONE claimed row: materialize → debit at SECURING →
 * submit + confirm. Never throws into the loop (per-row failure isolation);
 * unconfirmed publication leaves recovery to the reaper/confirmation path.
 * After a confirmed link, pre-debit errors may fail a materialized row;
 * post-debit errors retain it for confirmation because the charge landed.
 */
async function drainOneClaimedRow(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  row: ConnectorArtifactRow,
  result: ConnectorArtifactDrainResult,
): Promise<void> {
  // Track whether the (idempotent) debit already landed: if a LATER step
  // throws after a successful charge, we must NOT mark the artifact terminal
  // `failed` (that would represent a CHARGED anchor as a failed artifact).
  // Instead leave it RETRYABLE so the reaper re-resolves the SAME anchor
  // (debit idempotent on anchorId → no double-charge).
  let debitSucceeded = false;
  let publicationCommitted = false;

  try {
    // Creation/reuse and the guarded link are one database transaction.
    const materialized = await deps.materializeAnchor(row);
    if (materialized.outcome !== 'linked') {
      if (materialized.outcome === 'superseded') {
        deps.emitAlert({ scope: 'row', orgId, artifactId: row.id, reason: 'artifact_snapshot_rejected' });
      } else if (materialized.outcome === 'prior_anchor_revoked') {
        // A deliberate, definite decision — not a transport/uncertainty case —
        // so it gets its own alert reason rather than the generic uncertain
        // one. No compensating status update here either (see below): the
        // row is left `processing` for the reaper/an operator to resolve,
        // the SAME posture as every other non-`linked` outcome, so a human
        // notices a revoked document's update was NOT auto-anchored.
        deps.emitAlert({ scope: 'row', orgId, artifactId: row.id, reason: 'prior_anchor_revoked_fail_closed' });
      } else {
        deps.emitAlert({ scope: 'row', orgId, artifactId: row.id, reason: 'artifact_materialization_uncertain' });
      }
      // No compensating status update: the row may belong to a newer lease,
      // or the RPC may have committed before its response was lost. Existing
      // recovery retains the original anchor id for an idempotent paid retry.
      return;
    }
    publicationCommitted = true;
    const anchorId = materialized.anchorId;

    // 2) Charge AT SECURING — and ONLY here. Never at enqueue/claim.
    const debit = await deps.debitAndEnqueueAnchor({ orgId, anchorId });
    if (debit.outcome === 'uncertain') {
      reportUncertainDebit(deps, orgId, row.id, debit.error ?? 'debit_reply_unrecognized');
      return;
    }
    if (!debit.success) {
      await handleDebitFailure(deps, orgId, row, anchorId, debit.error, result);
      return;
    }
    debitSucceeded = true;

    await submitAndConfirmAnchor(deps, orgId, row, anchorId, result);
  } catch (err) {
    if (!publicationCommitted) {
      deps.emitAlert({ scope: 'row', orgId, artifactId: row.id, reason: 'artifact_materialization_uncertain' });
      deps.logger.error({ orgId, artifactId: row.id, reason: boundedReason(String(err)) },
        'connector artifact publication did not return a confirmed link; leaving recovery to the existing lease reaper');
      return;
    }
    if (!debitSucceeded) {
      reportUncertainDebit(deps, orgId, row.id,
        err instanceof Error ? err.message : 'debit_request_threw', err);
      return;
    }
    await handleRowDrainError(deps, orgId, row, err, debitSucceeded, result);
  }
}

/** Unknown debit outcomes must never strand a possibly charged artifact. */
function reportUncertainDebit(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  artifactId: string,
  rawReason: string,
  err?: unknown,
): void {
  const reason = boundedReason(rawReason);
  deps.emitAlert({ scope: 'row', orgId, artifactId, reason: 'debit_outcome_uncertain' });
  deps.logger.error({ err, reason, orgId, artifactId },
    'connector-artifact debit outcome uncertain; left materialized for recovery');
}

/**
 * Debit-failure triage for one row (the debit RPC returned `success:false` —
 * it rejects BEFORE charging, so no charge landed on any of these paths):
 *
 *   - `insufficient_credits` → TRANSIENT: re-queue (retryable), never terminal
 *     `failed` (which is not drainable — the row would be stranded forever).
 *     The anchor already materialized and the debit is idempotent on the
 *     anchor id, so the retry re-drives the SAME single charge (never a double).
 *   - `anchor_not_in_expected_status` → NOT terminal: a concurrent cycle
 *     already advanced THIS anchor past PENDING (the drain's own prior debit +
 *     broadcast/confirmation). Marking the row `failed` here strands a genuinely
 *     SECURED/SUBMITTED anchor as a failed artifact (data-integrity bug found
 *     under load: ~12k wrongly-failed rows whose anchors were SECURED/SUBMITTED).
 *     Re-read and reconcile via `reconcileRejectedDebitAnchor`; only an
 *     unexpected PENDING/missing anchor falls through to terminal.
 *   - anything else → terminal `failed` + bounded alert. No silent drop.
 *
 * All transitions are status-guarded: a zero-row match = LOST LEASE (the
 * reaper/another worker took the row) → stop without counting.
 */
async function handleDebitFailure(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  row: ConnectorArtifactRow,
  anchorId: string,
  debitError: string | undefined,
  result: ConnectorArtifactDrainResult,
): Promise<void> {
  if (debitError === 'insufficient_credits') {
    if (await markRequeued(deps, orgId, row.id)) {
      deps.emitAlert({ scope: 'row', orgId, artifactId: row.id, reason: 'insufficient_credits_requeued' });
      result.failed += 1;
    } else {
      deps.logger.warn({ orgId, artifactId: row.id }, 'connector-artifact lost lease at insufficient-credits requeue — stopping row');
    }
    return;
  }

  if (debitError === 'anchor_not_in_expected_status') {
    const outcome = await reconcileRejectedDebitAnchor(deps, orgId, row, anchorId, result);
    if (outcome === 'handled') return;
    // Anchor genuinely PENDING/missing despite the rejection is not expected
    // (the RPC only rejects a NON-PENDING anchor) → fall through to terminal.
  }

  // Truly-terminal debit failures → mark failed + bounded alert. No
  // batch-anchor, no silent drop. The row is reviewable. If the guarded
  // mark-failed matched zero rows the lease was lost — stop, don't count.
  if (await markFailed(deps, orgId, row, debitError ?? 'debit_failed')) {
    deps.emitAlert({ scope: 'row', orgId, artifactId: row.id, reason: debitError ?? 'debit_failed' });
    result.failed += 1;
  } else {
    deps.logger.warn({ orgId, artifactId: row.id }, 'connector-artifact lost lease at hard-debit-fail — stopping row');
  }
}

/**
 * The debit RPC rejected with `anchor_not_in_expected_status`: re-read the
 * SPECIFIC anchor and reconcile — mirroring the confirmation step — instead of
 * failing. Returns 'handled' when the row was resolved (promoted, left
 * materialized, or read-flaked → retryable); 'fallthrough' when the anchor is
 * unexpectedly PENDING/missing and the caller should apply the terminal path.
 */
async function reconcileRejectedDebitAnchor(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  row: ConnectorArtifactRow,
  anchorId: string,
  result: ConnectorArtifactDrainResult,
): Promise<'handled' | 'fallthrough'> {
  let advancedAnchor: AnchorStatusRow | null;
  try {
    advancedAnchor = await deps.readAnchorStatus({ orgId, anchorId });
  } catch (err) {
    // Read flake → leave materialized (retryable). Never fail on a transient
    // read after an already-advanced anchor.
    deps.logger.warn({ error: err, orgId, artifactId: row.id, anchorId }, 'connector-artifact advanced-anchor re-read failed — left materialized');
    return 'handled';
  }

  if (isAnchorAdvanced(advancedAnchor)) {
    // Irreversibly advanced → promote to terminal anchored (status-guarded).
    if (await markAnchored(deps, orgId, row.id, anchorId)) {
      result.anchored += 1;
      result.confirmed += 1;
      deps.logger.info({ orgId, artifactId: row.id, anchorId, anchorStatus: advancedAnchor!.status }, 'connector-artifact debit saw advanced anchor — promoted anchored (idempotent, no re-charge)');
    } else {
      deps.logger.warn({ orgId, artifactId: row.id }, 'connector-artifact lost lease at advanced-anchor promote — stopping row');
    }
    return 'handled';
  }

  if (isAnchorInFlight(advancedAnchor)) {
    // BROADCASTING/null-tx → still in flight; leave materialized for the
    // confirmation re-read to promote once it gains a tx. NOT failed.
    deps.logger.info({ orgId, artifactId: row.id, anchorId }, 'connector-artifact debit saw in-flight anchor — left materialized for confirmation');
    return 'handled';
  }

  return 'fallthrough';
}

/**
 * Post-debit steps for one row: design-C stuck-broadcast reset → org-scoped
 * batch-anchor → per-anchor confirmation re-read → (only if irreversibly
 * advanced) terminal `anchored`.
 */
async function submitAndConfirmAnchor(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  row: ConnectorArtifactRow,
  anchorId: string,
  result: ConnectorArtifactDrainResult,
): Promise<void> {
  // 3a) Design-C (mig 0353): the debit RPC just moved THIS anchor
  // PENDING → BROADCASTING (charged, exactly once). processBatchAnchors claims
  // ONLY status='PENDING', so it would skip the already-BROADCASTING anchor —
  // the submission-latency gap. Reset this org's drain-charged, never-batch-
  // claimed connector anchors back to PENDING so the batch below claims +
  // submits them NOW. The charge lives on the anchor id and PERSISTS across the
  // reset — never refunded, never re-debited — so exactly one charge stands.
  // Best-effort: on failure the anchors just wait for recover_stuck_broadcasts.
  const resetCount = await deps.resetUnclaimedConnectorBroadcasts({ orgId });
  if (resetCount > 0) {
    deps.logger.info({ orgId, resetCount }, 'connector-artifact reset stuck broadcasts → PENDING for prompt batch submit');
  }

  // 3b) Batch-anchor through the single worker-owned org-scoped path. It now
  // claims the just-reset PENDING connector anchors (leased via
  // claim_pending_anchors → no double-submit) and submits them. May still
  // return {processed:0} if a batch trigger/size gate defers — so the aggregate
  // count is NOT proof this artifact's anchor advanced (the confirm re-read is).
  const batch = await deps.batchAnchor({ force: true, orgId });

  // 4) Confirm the SPECIFIC anchor advanced IRREVERSIBLY (tx / SUBMITTED /
  // SECURED) by re-reading it — never the aggregate batch count, and never
  // bare BROADCASTING (which the debit itself produces and which
  // recover_stuck_broadcasts can reset to PENDING). Only then is the
  // artifact terminal.
  const anchor = await deps.readAnchorStatus({ orgId, anchorId });
  if (!isAnchorAdvanced(anchor)) {
    // Debit succeeded (anchor now BROADCASTING, charged) but it has not yet
    // irreversibly advanced. LEAVE the artifact `materialized` (retryable) —
    // do NOT re-queue (that would force a re-debit the RPC rejects on a
    // BROADCASTING anchor). The CONFIRMATION step on a later pass promotes it
    // once it gains a tx / SUBMITTED / SECURED (or re-queues it if the anchor
    // is reset to PENDING). Do NOT count anchored.
    deps.emitAlert({ scope: 'row', orgId, artifactId: row.id, reason: 'anchor_pending_confirmation' });
    deps.logger.info(
      { orgId, artifactId: row.id, anchorId, anchorStatus: anchor?.status ?? 'missing' },
      'connector-artifact debit ok, anchor not yet irreversibly advanced — left materialized for confirmation',
    );
    return;
  }

  // STATUS-GUARDED materialized → anchored. A zero-row match = LOST LEASE
  // (reaper/another worker took it) → stop, don't count anchored.
  if (!(await markAnchored(deps, orgId, row.id, anchorId))) {
    deps.logger.warn({ orgId, artifactId: row.id }, 'connector-artifact lost lease before mark-anchored — stopping row');
    return;
  }
  result.anchored += 1;
  deps.logger.info(
    { orgId, artifactId: row.id, anchorId, batchId: batch.batchId, processed: batch.processed, anchorStatus: anchor!.status },
    'connector-artifact anchored',
  );
}

/**
 * Per-row catch handler (failure isolation: this row fails, the loop
 * continues). Pre-debit → terminal `failed`; post-debit → left `materialized`
 * (the charge already landed — see `drainOneClaimedRow`'s debitSucceeded note).
 */
async function handleRowDrainError(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  row: ConnectorArtifactRow,
  err: unknown,
  debitSucceeded: boolean,
  result: ConnectorArtifactDrainResult,
): Promise<void> {
  // `reason` is the BOUNDED string that gets persisted and alerted on (§1.6A —
  // see markFailed). `err` is logged alongside it so the STACK survives: for the
  // DB statement-timeout that motivated this the two are equivalent, but for a
  // TypeError deeper in materialization the stack is the only thing that
  // localises the fault. Logger-side redaction of `err` is centralised in
  // utils/logger.ts (redactErrorSerializer + redactBinaryValues), so logging the
  // error object here is safe; what must never be unbounded is the string we
  // PERSIST and alert on.
  const reason = boundedReason(err instanceof Error ? err.message : 'drain row failed');
  deps.logger.error({ err, reason, orgId, artifactId: row.id }, 'connector-artifact row drain failed');

  if (debitSucceeded) {
    // The charge already landed and the anchor is BROADCASTING. A post-debit
    // throw (e.g. batch step) must NOT mark the artifact terminal `failed` (a
    // CHARGED anchor as failed), and must NOT re-queue it (a re-queue → re-
    // debit would hit the RPC's PENDING-expected rejection on a BROADCASTING
    // anchor). LEAVE it `materialized`: the CONFIRMATION step owns it from
    // here — it promotes to anchored once the anchor advances, or re-queues
    // only if the anchor is reset to PENDING. No re-write, no double-charge.
    deps.emitAlert({ scope: 'row', orgId, artifactId: row.id, reason: 'post_debit_error_left_materialized' });
    deps.logger.warn({ orgId, artifactId: row.id }, 'connector-artifact post-debit error — left materialized for confirmation');
    return;
  }

  // Pre-debit failure → terminal `failed`. The guarded mark-failed matching
  // zero rows = lost lease → stop, don't count.
  if (await markFailed(deps, orgId, row, reason)) {
    deps.emitAlert({ scope: 'row', orgId, artifactId: row.id, reason });
    result.failed += 1;
  } else {
    deps.logger.warn({ orgId, artifactId: row.id }, 'connector-artifact lost lease at catch-mark-failed — stopping row');
  }
}

/**
 * THE guarded artifact transition. One place implements the safety property
 * every status write in this module shares: org-scoped, guarded on the exact
 * `from` status, RETURNS whether a row actually matched, and fails CLOSED on a
 * DB error (`false`). A zero-row match means LOST LEASE — the reaper re-queued
 * the row, or another worker reclaimed it — so the caller must STOP rather
 * than press on with a stale lease.
 *
 * This replaced five hand-rolled copies of the same builder chain. The guard
 * set IS the safety property (see this file's header), so it lives once.
 *
 * Publication is deliberately absent from this helper: processing ->
 * materialized belongs exclusively to the atomic SQL transaction.
 */
async function transitionArtifact(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  id: string,
  from: 'materialized',
  to: 'queued' | 'anchored',
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), ...extra, status: to };

  const { data, error } = await deps.db
    .from('connector_artifact')
    .update(patch)
    .eq('id', id)
    .eq('org_id', orgId)
    .eq('status', from)
    .select('id')
    .maybeSingle();
  if (error) {
    deps.logger.warn({ error, orgId, artifactId: id, from, to }, `connector-artifact ${from}->${to} transition failed`);
    return false;
  }
  return data != null;
}

/** Terminal promote: `materialized -> anchored`, recording the anchor. */
async function markAnchored(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  id: string,
  anchorId: string,
): Promise<boolean> {
  return transitionArtifact(deps, orgId, id, 'materialized', 'anchored', { anchor_id: anchorId });
}

/**
 * RETRYABLE requeue for a MATERIALIZED row: back to 'queued' so the next daily
 * drain re-claims it. Used for `insufficient_credits` and by the confirmation
 * step — transient conditions, not hard failures. `failed` is NOT a drainable
 * status, so marking one of these failed would strand the row forever.
 */
async function markRequeued(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  id: string,
): Promise<boolean> {
  return transitionArtifact(deps, orgId, id, 'materialized', 'queued');
}

/**
 * Terminal failure is permitted only after confirmed publication, while the
 * row is still materialized. A late old-client error must never fail a newer
 * processing lease acquired after a requeue. Zero matched rows count nothing.
 */
async function markFailed(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  row: ConnectorArtifactRow,
  rawReason: string,
): Promise<boolean> {
  const id = row.id;
  // Bound HERE, not at the call sites. `handleDebitFailure` passes the raw
  // PostgREST/Postgres `error.message` straight through, and Postgres
  // constraint-violation text routinely echoes the offending VALUE. Migration
  // 0343 grants `SELECT ON connector_artifact TO authenticated` under
  // `connector_artifact_org_select`, so anything landing in this column is
  // readable by every member of the org — raw database error text must never
  // get there. Bounding inside the only writer makes that structural rather
  // than a rule each future caller has to remember.
  const reason = boundedReason(rawReason);
  // Persist the cause ON THE ROW. A terminal `failed` artifact is what an
  // operator triages, and until this existed the reason was accepted here and
  // silently dropped — the UPDATE set status only, so the sole surviving copy
  // was a Sentry alert.
  //
  // The atomic transaction validated this captured metadata before linking.
  // This path runs only after its successful reply, and the materialized-only
  // guard excludes prepublication processing leases. F1 heal cannot edit the
  // linked artifact because its own guard requires anchor_id IS NULL.
  const existingMetadata =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  const { data, error } = await deps.db
    .from('connector_artifact')
    .update({
      status: 'failed',
      metadata: { ...existingMetadata, drain_error: reason },
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('org_id', orgId)
    .eq('status', 'materialized')
    .select('id')
    .maybeSingle();
  if (error) {
    // A row stuck in-flight because we couldn't even mark it failed is the ONE
    // thing we must never hide — log loudly.
    // `reason` is already bounded above; `error` goes through logger.ts's
    // redacting serializer.
    deps.logger.error(
      { error, orgId, artifactId: id, reason },
      'connector-artifact mark-failed failed (row stuck in-flight)',
    );
    return false;
  }
  return data != null;
}

// ── F-1 stuck-row reaper (liveness) ──────────────────────────────────────────

/**
 * Lease / visibility-timeout for stranded `processing` rows. A row stuck in
 * `processing` past this lease is presumed STRANDED — the worker crashed between
 * the claim and the processing→materialized transition (the claim CAS gives
 * exactly-once but NOT liveness; nothing re-drains a `processing` row since only
 * pending|queued are drainable). Generous (>> any real drain pass) so a live
 * worker is never reaped.
 *
 * The reaper re-queues ONLY `processing` rows. A `processing` row has NOT been
 * debited (the debit only runs AFTER the processing→materialized transition), so
 * no unlinked anchor was published by the atomic materializer.
 * A re-drive is safe (materialize idempotent on the (user_id,fingerprint)
 * unique index; debit re-drives the SAME single charge — never a double).
 *
 * Crucially the reaper does NOT touch `materialized` rows: those may hold an
 * already-debited, in-flight BROADCASTING anchor, and re-queuing one would force
 * a re-debit the RPC rejects (`p_expected_status='PENDING'`). `materialized`
 * rows are owned by the anchor-aware CONFIRMATION step
 * (`confirmMaterializedArtifacts`), which promotes them once advanced or
 * re-queues them only when the anchor has lost forward progress (PENDING/gone).
 */
export const STALE_INFLIGHT_MS = 15 * 60 * 1000; // 15 min

export interface ReapStaleResult {
  reaped: number;
}

/**
 * Reset rows stranded in `processing` past the lease back to 'queued' so the
 * next drain pass re-claims them. This is the F-1 liveness guarantee the claim
 * CAS alone does not provide. Global (all orgs); runs at the head of each drain
 * pass. A reaper failure alerts but NEVER aborts the drain.
 */
export async function reapStaleInFlightArtifacts(
  injected: Partial<Pick<ConnectorArtifactDrainDeps, 'db' | 'logger' | 'emitAlert'>> & { thresholdMs?: number } = {},
): Promise<ReapStaleResult> {
  const db = injected.db ?? (defaultDb as unknown as DrainDb);
  const logger = injected.logger ?? (defaultLogger as unknown as DrainLogger);
  const emitAlert = wrapEmitAlert(injected.emitAlert ?? defaultEmitAlert);
  const cutoff = new Date(Date.now() - (injected.thresholdMs ?? STALE_INFLIGHT_MS)).toISOString();

  const { data, error } = await db
    .from('connector_artifact')
    .update({ status: 'queued', updated_at: new Date().toISOString() })
    .eq('status', 'processing')
    .lt('updated_at', cutoff)
    .select('id, org_id');

  if (error) {
    emitAlert({ scope: 'cycle', orgId: 'ALL', reason: `reaper failed: ${(error as { message?: string }).message ?? 'unknown'}` });
    logger.error({ error }, 'connector-artifact reaper failed');
    return { reaped: 0 };
  }

  const rows = (data ?? []) as Array<{ id: string; org_id: string }>;
  for (const r of rows) {
    // A stranded row is a real liveness incident — alert (bounded ids only, §1.6A).
    emitAlert({ scope: 'row', orgId: r.org_id, artifactId: r.id, reason: 'stale_inflight_requeued' });
  }
  if (rows.length > 0) {
    logger.warn({ reaped: rows.length }, 'connector-artifact reaper re-queued stranded in-flight rows');
  }
  return { reaped: rows.length };
}

// ── Cron entrypoint ──────────────────────────────────────────────────────────

export interface ConnectorArtifactDrainCronResult {
  skipped: boolean;
  reason?: string;
  orgsProcessed: number;
  orgsFailed: number;
  reaped: number;
  claimed: number;
  anchored: number;
  failed: number;
  /** Materialized rows promoted to anchored by the confirmation re-read. */
  confirmed: number;
  /** Materialized rows re-queued by confirmation (anchor lost forward progress). */
  reconfirmRequeued: number;
  /** Legacy field retained as zero; rejected snapshots are left for existing recovery. */
  supersededRequeued: number;
  /** BUG-2026-09-29 item D: anchors filed this cycle by the retry-routing sweep, summed across orgs. */
  refiled: number;
}

export interface ConnectorArtifactDrainCronDeps {
  /** Feature gate. Defaults to `config.enableConnectorArtifactDrain`. */
  enabled?: boolean;
  /** List distinct org_ids with WORK (pending|queued to drain OR materialized awaiting confirmation). */
  listDrainableOrgIds?: () => Promise<string[]>;
  /** Drain a single org (defaults to `drainConnectorArtifactsForOrg`). */
  drainForOrg?: (orgId: string) => Promise<ConnectorArtifactDrainResult>;
  /** Reap stranded in-flight rows (defaults to `reapStaleInFlightArtifacts`). */
  reapStale?: () => Promise<ReapStaleResult>;
  /** Bounded, PII-scrubbed alert sink. */
  emitAlert?: (alert: ConnectorArtifactAlert) => void;
  logger?: DrainLogger;
}

/**
 * WORK statuses for a cron pass: `pending|queued` (new rows to claim/anchor)
 * PLUS `materialized` (prior-pass rows awaiting the CONFIRMATION re-read by
 * `confirmMaterializedArtifacts`). An org with ONLY materialized rows (all
 * anchors in-flight, no new rows) must STILL be enumerated so its confirmation
 * runs — otherwise an in-flight anchor would never be promoted to `anchored`.
 * The QUEUE-09 enumeration RPC (`list_drainable_connector_orgs`, migration 0350)
 * is the single source of truth for this predicate: it enforces
 * `status IN ('pending','queued','materialized')` server-side, backed by the
 * partial index `idx_connector_artifact_drainable`. (There is intentionally no
 * `WORK_STATUSES` const here anymore — the predicate lives in the RPC/index, not
 * in app code, so the two can't drift.)
 *
 * Default cap on the number of ORGS enumerated per cron pass. This bounds the
 * fan-out (one `drainConnectorArtifactsForOrg` call per org) and matches the
 * RPC's own `LEAST(GREATEST(p_limit,1),1000)` clamp. It is a limit on ORGS, NOT
 * on rows — the QUEUE-09 fix.
 */
const ORG_ENUM_LIMIT_DEFAULT = 200;

/**
 * Default org enumerator (QUEUE-09 / SCRUM-2352 fair enumeration). Calls the
 * server-side `list_drainable_connector_orgs` RPC (migration 0350), which
 * returns DISTINCT org_ids that have at least one WORK row — `pending|queued`
 * (new rows to claim/anchor) OR `materialized` (prior-pass rows awaiting the
 * confirmation re-read) — ordered by oldest pending work first, capped on ORGS.
 * Surfacing materialized-only orgs is what lets #1366's `confirmMaterializedArtifacts`
 * promote an in-flight anchor to `anchored`; the per-org flow still drains ONLY
 * pending|queued (the CAS claim) and confirms ONLY materialized — the broadening
 * is at ORG DISCOVERY, not in those per-row predicates.
 *
 * This REPLACES the previous `SELECT org_id … LIMIT 5000` row scan + in-memory
 * dedup. That scan had a STARVATION bug: a single org with >5000 work rows
 * filled the entire 5000-row window, so every OTHER org with work was never
 * enumerated and never drained/confirmed. The RPC does the DISTINCT server-side,
 * so one noisy org contributes exactly ONE row and can never crowd out a quiet org.
 *
 * FAIL-LOUD (NOT fail-safe): an RPC error is a CYCLE-LEVEL failure — it emits a
 * `scope:'cycle'` alert (orgId 'ALL') and THROWS, mirroring
 * `drainConnectorArtifactsForOrg`'s select-failure path. This is the ONLY default
 * org-discovery path, so a broken/missing RPC (migration not applied, grant
 * missing, stale PostgREST schema cache) must NOT be swallowed as an empty green
 * list — that would make the cron report SUCCESS while draining/confirming ZERO
 * orgs, hiding the failure and stranding every artifact with no Scheduler retry.
 * The throw propagates to the `/jobs/drain-connector-artifacts` route's catch →
 * 500 → Cloud Scheduler retries (and pages). The stuck-row reaper has already run
 * before this point (idempotent), so re-running the pass is safe.
 */
export async function defaultListDrainableOrgIds(
  db: DrainDb,
  opts: { logger?: DrainLogger; limit?: number; emitAlert?: (alert: ConnectorArtifactAlert) => void } = {},
): Promise<string[]> {
  const logger = opts.logger ?? (defaultLogger as unknown as DrainLogger);
  const emitAlert = opts.emitAlert ?? defaultEmitAlert;
  const pLimit = Math.max(1, Math.min(opts.limit ?? ORG_ENUM_LIMIT_DEFAULT, 1000));

  if (typeof db.rpc !== 'function') {
    // A db with no rpc() is a misconfiguration, not a transient row error —
    // surface it as a cycle failure so the route returns non-2xx and retries.
    emitAlert({ scope: 'cycle', orgId: 'ALL', reason: 'org enumeration RPC unavailable (db.rpc not a function)' });
    logger.error({ job: 'connector-artifact-drain' }, 'connector-artifact org enumeration: db.rpc unavailable');
    throw new Error('connector-artifact org enumeration failed: db.rpc unavailable');
  }

  const { data, error } = (await db.rpc('list_drainable_connector_orgs', { p_limit: pLimit })) as {
    data: unknown;
    error: { message?: string } | null;
  };

  if (error) {
    // Fail LOUD: emit a cycle alert + THROW so the cron route returns 500 and
    // Cloud Scheduler retries. Returning an empty list here would report SUCCESS
    // while draining zero orgs — hiding a broken RPC and stranding every row.
    const reason = `org enumeration failed: ${error.message ?? 'unknown'}`;
    emitAlert({ scope: 'cycle', orgId: 'ALL', reason });
    logger.error(
      { error, job: 'connector-artifact-drain' },
      `connector-artifact org enumeration failed: ${error.message ?? 'unknown'}`,
    );
    throw new Error(`connector-artifact ${reason}`);
  }

  // The RPC returns SETOF uuid → an array of strings (supabase-js may also
  // surface SETOF scalars as `{ <fn_name>: value }` rows; tolerate both).
  const orgIds: string[] = [];
  for (const row of (data ?? []) as Array<string | { list_drainable_connector_orgs?: string; org_id?: string }>) {
    if (typeof row === 'string') {
      if (row) orgIds.push(row);
    } else if (row && typeof row === 'object') {
      const v = row.list_drainable_connector_orgs ?? row.org_id;
      if (typeof v === 'string' && v) orgIds.push(v);
    }
  }
  return orgIds;
}

/**
 * Cron entrypoint (QUEUE-06). Cloud Scheduler → `POST /jobs/drain-connector-artifacts`.
 *
 * Prod drives this via HTTP because Cloud Scheduler is the trigger with retries
 * and an attempt deadline; the in-process registration in routes/scheduled.ts is
 * a backup that also fires on every warm prod instance (SCRUM-3384), which the
 * per-row compare-and-set claim makes safe. No-ops (`skipped:true`) when the
 * flag is off. Per-org drains are isolated: one org throwing alerts (scope=cycle)
 * and the remaining orgs still drain — no silent drop.
 */
export async function runConnectorArtifactDrain(
  injected: ConnectorArtifactDrainCronDeps = {},
): Promise<ConnectorArtifactDrainCronResult> {
  const logger = injected.logger ?? (defaultLogger as unknown as DrainLogger);
  const enabled = injected.enabled ?? config.enableConnectorArtifactDrain;
  const base: ConnectorArtifactDrainCronResult = {
    skipped: false,
    orgsProcessed: 0,
    orgsFailed: 0,
    reaped: 0,
    claimed: 0,
    anchored: 0,
    failed: 0,
    confirmed: 0,
    reconfirmRequeued: 0,
    supersededRequeued: 0,
    refiled: 0,
  };

  if (!enabled) {
    return { ...base, skipped: true, reason: 'ENABLE_CONNECTOR_ARTIFACT_DRAIN is false' };
  }

  const db = defaultDb as unknown as DrainDb;
  const emitAlert = wrapEmitAlert(injected.emitAlert ?? defaultEmitAlert);
  const listDrainableOrgIds =
    injected.listDrainableOrgIds ?? (() => defaultListDrainableOrgIds(db, { logger, emitAlert }));
  const drainForOrg = injected.drainForOrg ?? ((orgId: string) => drainConnectorArtifactsForOrg(orgId));

  // F-1: reap stranded in-flight rows FIRST (presumed-crashed workers) so this
  // pass re-claims them. Then they reappear in the per-org drainable scan below.
  const reapStale = injected.reapStale ?? (() => reapStaleInFlightArtifacts({ db, logger, emitAlert }));
  base.reaped = (await reapStale()).reaped;

  const orgIds = await listDrainableOrgIds();
  for (const orgId of orgIds) {
    base.orgsProcessed += 1;
    try {
      const r = await drainForOrg(orgId);
      base.claimed += r.claimed;
      base.anchored += r.anchored;
      base.failed += r.failed;
      base.confirmed += r.confirmed;
      base.reconfirmRequeued += r.reconfirmRequeued;
      base.supersededRequeued += r.supersededRequeued;
      base.refiled += r.refiled;
    } catch (err) {
      // Per-org isolation: surface as a cycle alert, keep draining other orgs.
      base.orgsFailed += 1;
      const reason = err instanceof Error ? err.message : 'org drain failed';
      emitAlert({ scope: 'cycle', orgId, reason });
      logger.error({ error: err, orgId }, 'connector-artifact org drain failed');
    }
  }

  logger.info({ ...base }, 'connector-artifact drain cron pass complete');
  return base;
}
