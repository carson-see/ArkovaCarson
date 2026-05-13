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
import { z } from 'zod';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { emitOrgAdminNotifications } from '../notifications/dispatcher.js';
import { resolveSecretHandle } from '../utils/secrets.js';
import { submitJob } from '../utils/jobQueue.js';
import { deductOrgCredit, type DeductionResult } from '../utils/orgCredits.js';
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

interface AnchorQueueMaterialization {
  anchorPublicId: string | null;
  materialized: boolean;
  duplicate: boolean;
}

interface AnchorQueueSource {
  fingerprint: string;
  filename: string;
  externalFileId: string;
  connectorSource: string;
  sourceEnvelopeId: string | null;
  senderEmailSha256: string | null;
  accountIdSha256: string | null;
  fingerprintSource: string;
}

function hasControlChars(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

const AnchorInsertSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.literal('PENDING'),
  org_id: z.string().uuid(),
  user_id: z.string().uuid(),
  filename: z.string().min(1).max(255).refine(
    (value) => !hasControlChars(value),
    'filename cannot contain control characters',
  ),
  credential_type: z.literal('CONTRACT_POSTSIGNING'),
  metadata: z.record(z.string(), z.unknown()),
});

type AnchorInsertPayload = z.infer<typeof AnchorInsertSchema>;

type Outcome =
  | { kind: 'success'; output: Record<string, unknown> }
  | { kind: 'transient_failure'; error: string }
  | { kind: 'permanent_failure'; error: string };

class DeterministicDispatchError extends Error {
  name = 'DeterministicDispatchError';
}

function sanitizedZodIssues(issues: z.ZodIssue[]): Array<{ code: string; path: string[] }> {
  return issues.map((issue) => ({
    code: issue.code,
    path: issue.path.map(String),
  }));
}

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

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sha256Lower(value: string): string {
  return crypto.createHash('sha256').update(value.trim().toLowerCase(), 'utf8').digest('hex');
}

function normalizeHex64(value: unknown): string | null {
  const candidate = readString(value);
  return candidate && /^[a-f0-9]{64}$/i.test(candidate) ? candidate.toLowerCase() : null;
}

function firstDocumentHash(payload: Record<string, unknown>): string | null {
  const hashes = payload.document_hashes;
  if (!Array.isArray(hashes) || hashes.length !== 1) return null;
  return normalizeHex64(hashes[0]);
}

function extractAnchorFingerprint(
  input: Record<string, unknown>,
  payload: Record<string, unknown>,
): { fingerprint: string; source: string } | null {
  const candidates: Array<[unknown, string]> = [
    [payload.document_sha256, 'payload.document_sha256'],
    [payload.combined_document_sha256, 'payload.combined_document_sha256'],
    [payload.sha256, 'payload.sha256'],
    [input.fingerprint, 'input_payload.fingerprint'],
    [firstDocumentHash(payload), 'payload.document_hashes[0]'],
  ];
  for (const [value, source] of candidates) {
    const fingerprint = normalizeHex64(value);
    if (fingerprint) return { fingerprint, source };
  }
  return null;
}

function sanitizeAnchorFilename(filename: string | null, fallback: string): string {
  const safe = (filename ?? fallback)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/[\\/]+/g, '-')
    .trim()
    .slice(0, 220);
  return `docusign/${safe || 'completed-envelope'}`.slice(0, 255);
}

function extractAnchorQueueSource(exec: ExecutionRow): AnchorQueueSource | null {
  const input = readRecord(exec.input_payload);
  const payload = readRecord(input.payload);
  const fingerprint = extractAnchorFingerprint(input, payload);
  if (!fingerprint) return null;

  const vendor = readString(input.vendor) ?? readString(payload.source) ?? 'connector';
  const externalFileId =
    readString(input.external_file_id) ??
    readString(payload.envelope_id) ??
    readString(payload.file_id) ??
    exec.trigger_event_id;
  const filename = sanitizeAnchorFilename(readString(input.filename), externalFileId);
  const rawSenderEmail = readString(input.sender_email);
  const senderEmailCandidate = normalizeHex64(input.sender_email_sha256);
  const senderEmailSha256 =
    senderEmailCandidate ?? (rawSenderEmail ? sha256Lower(rawSenderEmail) : null);
  const accountId = readString(payload.account_id);

  return {
    fingerprint: fingerprint.fingerprint,
    filename,
    externalFileId,
    connectorSource: vendor,
    sourceEnvelopeId: readString(payload.envelope_id),
    senderEmailSha256,
    accountIdSha256: accountId ? sha256Lower(accountId) : null,
    fingerprintSource: fingerprint.source,
  };
}

async function resolveAnchorActorUserId(rule: RuleRow, exec: ExecutionRow): Promise<string | null> {
  const actorUserId = readString(readRecord(exec.input_payload).actor_user_id);
  if (actorUserId) return actorUserId;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('org_members')
    .select('user_id, role')
    .eq('org_id', rule.org_id)
    .in('role', ['owner', 'admin'])
    .order('role', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`anchor actor lookup failed: ${(error as { message?: string }).message ?? 'unknown'}`);
  }
  return readString((data as { user_id?: unknown } | null)?.user_id);
}

async function findExistingAnchor(args: {
  orgId: string;
  userId: string;
  fingerprint: string;
}): Promise<AnchorQueueMaterialization | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('anchors')
    .select('public_id, status')
    .eq('org_id', args.orgId)
    .eq('user_id', args.userId)
    .eq('fingerprint', args.fingerprint)
    .is('deleted_at', null)
    .neq('status', 'REVOKED')
    .maybeSingle();
  if (error) throw new Error(`anchor duplicate lookup failed: ${(error as { message?: string }).message ?? 'unknown'}`);
  if (!data) return null;
  return {
    anchorPublicId: readString((data as { public_id?: unknown }).public_id),
    materialized: true,
    duplicate: true,
  };
}

async function buildAnchorInsertPayload(args: {
  rule: RuleRow;
  exec: ExecutionRow;
  creditDenialReason: string | null;
}): Promise<AnchorInsertPayload> {
  if (args.rule.org_id !== args.exec.org_id) {
    throw new DeterministicDispatchError('rule org_id does not match execution org_id');
  }

  const source = extractAnchorQueueSource(args.exec);
  if (!source) {
    throw new DeterministicDispatchError('anchor queue materialization requires a document SHA-256 fingerprint');
  }

  const userId = await resolveAnchorActorUserId(args.rule, args.exec);
  if (!userId) {
    throw new DeterministicDispatchError('anchor queue materialization requires an org owner/admin actor');
  }

  const tag = readString(args.rule.action_config?.tag);
  const metadata: Record<string, unknown> = {
    connector_source: source.connectorSource,
    external_file_id: source.externalFileId,
    source_envelope_id: source.sourceEnvelopeId,
    rule_action_type: args.rule.action_type,
    rule_tag: tag,
    credit_denial_reason: args.creditDenialReason,
    fingerprint_source: source.fingerprintSource,
    sender_email_sha256: source.senderEmailSha256,
    account_id_sha256: source.accountIdSha256,
  };

  const insertPayload = {
    fingerprint: source.fingerprint,
    status: 'PENDING' as const,
    org_id: args.rule.org_id,
    user_id: userId,
    filename: source.filename,
    credential_type: 'CONTRACT_POSTSIGNING' as const,
    metadata,
  };

  const parsed = AnchorInsertSchema.safeParse(insertPayload);
  if (!parsed.success) {
    logger.warn(
      { issues: sanitizedZodIssues(parsed.error.issues), ruleId: args.rule.id, executionId: args.exec.id },
      'anchor queue materialization payload failed validation',
    );
    throw new DeterministicDispatchError('anchor queue materialization payload failed validation');
  }

  return parsed.data;
}

function withCreditDenialReason(
  insertPayload: AnchorInsertPayload,
  creditDenialReason: string,
): AnchorInsertPayload {
  return AnchorInsertSchema.parse({
    ...insertPayload,
    metadata: {
      ...insertPayload.metadata,
      credit_denial_reason: creditDenialReason,
    },
  });
}

async function insertAnchorQueueItem(insertPayload: AnchorInsertPayload): Promise<AnchorQueueMaterialization> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('anchors')
    .insert(insertPayload)
    .select('public_id, fingerprint, status, created_at')
    .single();

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      const existing = await findExistingAnchor({
        orgId: insertPayload.org_id,
        userId: insertPayload.user_id,
        fingerprint: insertPayload.fingerprint,
      });
      if (existing) return existing;
    }
    throw new Error(`anchor queue materialization insert failed: ${(error as { message?: string }).message ?? 'unknown'}`);
  }

  return {
    anchorPublicId: readString((data as { public_id?: unknown } | null)?.public_id),
    materialized: true,
    duplicate: false,
  };
}

async function materializeAnchorQueueItem(args: {
  rule: RuleRow;
  exec: ExecutionRow;
  creditDenialReason: string | null;
}): Promise<AnchorQueueMaterialization> {
  return insertAnchorQueueItem(await buildAnchorInsertPayload(args));
}

// SCRUM-1649 DS-AUTO-02 — Anchor action routing.
// Two outcome shapes share `routed_to=anchor_queue`: (a) AUTO_ANCHOR (DS-07,
// queue mode) emits one with credit_denial_reason=null, no credit movement;
// (b) FAST_TRACK_ANCHOR (DS-06, instant secure) falls back here when
// `deduct_org_credit` returns insufficient_credits, with an explicit reason.
function buildAnchorQueueOutcome(opts: {
  creditDenialReason: string | null;
  balance?: number | null;
  required?: number | null;
  materialization?: AnchorQueueMaterialization;
}): Outcome {
  return {
    kind: 'success',
    output: {
      outcome: RULE_DISPATCH_OUTCOME.QUEUED_FOR_ANCHOR,
      routed_to: RULE_ROUTED_TO.ANCHOR_QUEUE,
      credit_denial_reason: opts.creditDenialReason,
      anchor_materialized: opts.materialization?.materialized ?? false,
      anchor_public_id: opts.materialization?.anchorPublicId ?? null,
      duplicate_anchor: opts.materialization?.duplicate ?? false,
      ...(opts.balance != null ? { balance: opts.balance } : {}),
      ...(opts.required != null ? { required: opts.required } : {}),
    },
  };
}

async function dispatchAutoAnchor(rule: RuleRow, exec: ExecutionRow): Promise<Outcome> {
  // DS-07 queue mode: route to the org anchor queue without consuming credits.
  const materialization = await materializeAnchorQueueItem({
    rule,
    exec,
    creditDenialReason: null,
  });
  return buildAnchorQueueOutcome({ creditDenialReason: null, materialization });
}

async function compensateFastTrackCreditFailure(args: {
  rule: RuleRow;
  exec: ExecutionRow;
  deduction: DeductionResult;
  failure: string;
  error?: unknown;
}): Promise<Outcome> {
  const logContext = {
    error: args.error,
    ruleId: args.rule.id,
    executionId: args.exec.id,
    orgId: args.rule.org_id,
  };

  if (args.deduction.reason === 'feature_disabled') {
    logger.error(logContext, `FAST_TRACK_ANCHOR: ${args.failure} — retrying without credit compensation`);
    return {
      kind: 'transient_failure',
      error: `${args.failure}; credit enforcement disabled, retrying`,
    };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any).rpc('refund_org_credit', {
      p_org_id: args.rule.org_id,
      p_amount: 1,
      p_reason: 'rule.fast_track_anchor_compensation',
      p_reference_id: args.exec.id,
    });
    const refunded = !error && (data as { success?: unknown } | null)?.success === true;
    if (refunded) {
      logger.warn(logContext, `FAST_TRACK_ANCHOR: ${args.failure} after credit deduction — refunded and retrying`);
      return {
        kind: 'transient_failure',
        error: `${args.failure} AFTER credit deduction; credit refunded; retrying`,
      };
    }
    logger.error(
      {
        ...logContext,
        refundError: error,
        refundResult: (data as { error?: unknown } | null)?.error ?? 'unexpected_refund_shape',
      },
      `FAST_TRACK_ANCHOR: ${args.failure} after credit deduction and refund failed — marking FAILED`,
    );
  } catch (refundErr) {
    logger.error(
      { ...logContext, refundError: refundErr },
      `FAST_TRACK_ANCHOR: ${args.failure} after credit deduction and refund threw — marking FAILED`,
    );
  }

  return {
    kind: 'permanent_failure',
    error: `${args.failure} AFTER credit deduction; refund failed (manual refund + manual retry required)`,
  };
}

async function dispatchFastTrackAnchor(rule: RuleRow, exec: ExecutionRow): Promise<Outcome> {
  // DS-06 instant secure: validate the future queue row before reserving
  // credit, then insert only for allowed or explicitly queued denial paths.
  // Uses the shared `deductOrgCredit` helper (SCRUM-1170-B) so
  // `config.enableOrgCreditEnforcement=false` short-circuits cleanly in
  // environments without org-credit setup, and so RPC-shape errors are
  // normalized identically to the existing /api/v1/anchor route.
  const preparedAnchor = await buildAnchorInsertPayload({
    rule,
    exec,
    creditDenialReason: null,
  });

  const result = await deductOrgCredit(db, rule.org_id, 1, 'rule.fast_track_anchor', exec.id);

  if (result.allowed) {
    let materialization: AnchorQueueMaterialization;
    try {
      materialization = await insertAnchorQueueItem(preparedAnchor);
    } catch (err) {
      return compensateFastTrackCreditFailure({
        rule,
        exec,
        deduction: result,
        failure: `anchor queue materialization insert failed: ${err instanceof Error ? err.message : 'unknown'}`,
        error: err,
      });
    }
    const jobId = await submitJob({
      type: 'anchor.fast_track',
      max_attempts: 5,
      priority: 5,
      payload: {
        org_id: rule.org_id,
        rule_id: rule.id,
        execution_id: exec.id,
        trigger_event_id: exec.trigger_event_id,
        anchor_public_id: materialization.anchorPublicId,
        duplicate_anchor: materialization.duplicate,
      },
    });
    if (!jobId) {
      return compensateFastTrackCreditFailure({
        rule,
        exec,
        deduction: result,
        failure: 'anchor.fast_track job enqueue failed',
      });
    }
    return {
      kind: 'success',
      output: {
        outcome: RULE_DISPATCH_OUTCOME.ANCHOR_DISPATCHED,
        routed_to: RULE_ROUTED_TO.ANCHOR_PIPELINE,
        anchor_materialized: materialization.materialized,
        anchor_public_id: materialization.anchorPublicId,
        duplicate_anchor: materialization.duplicate,
        ...(result.balance != null ? { balance: result.balance } : {}),
      },
    };
  }

  // Credit denial paths — helper normalizes the RPC-shaped errors.
  if (result.error === 'insufficient_credits') {
    // DS-06 fall-through: queue with explicit reason. NOT a failure — the
    // promise of "queued, not anchored" is still kept for the user.
    return buildAnchorQueueOutcome({
      creditDenialReason: 'insufficient_credits',
      balance: result.balance ?? null,
      required: result.required ?? null,
      materialization: await insertAnchorQueueItem(withCreditDenialReason(
        preparedAnchor,
        'insufficient_credits',
      )),
    });
  }

  if (result.error === 'rpc_failure') {
    // RPC threw / network error — retryable.
    return {
      kind: 'transient_failure',
      error: `deduct_org_credit RPC error: ${result.message ?? 'unknown'}`,
    };
  }

  // org_not_initialized and any other refusal shape — configuration
  // problem, won't fix itself on retry.
  return {
    kind: 'permanent_failure',
    error: `deduct_org_credit refused: ${result.error ?? 'unknown'}`,
  };
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
    case 'AUTO_ANCHOR':
      // SCRUM-1649 DS-07
      return dispatchAutoAnchor(rule, exec);
    case 'FAST_TRACK_ANCHOR':
      // SCRUM-1649 DS-06
      return dispatchFastTrackAnchor(rule, exec);
    default:
      // Truly unknown action types fail closed and are visible.
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
          kind: err instanceof DeterministicDispatchError ? 'permanent_failure' : 'transient_failure',
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
