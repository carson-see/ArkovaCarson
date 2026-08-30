/**
 * DocuSign Connect webhook handler (SCRUM-1101 / SCRUM-1872).
 *
 * Receives HMAC-verified `envelope-completed` events, resolves the connected
 * org integration by DocuSign account id, and queues both:
 *   1. a sanitized rules-engine event (`ESIGN_COMPLETED`)
 *   2. a retryable document-fetch job for the signed envelope
 *   3. (SCRUM-1872) if notary data is present, a `docusign.notarization_completed` job
 *
 * Raw Connect payloads and signed documents are never persisted here.
 */
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { db } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { config } from '../../../config.js';
import { submitJob } from '../../../utils/jobQueue.js';
import { DOCUSIGN_ENVELOPE_COMPLETED_JOB_TYPE } from '../../../jobs/docusign-envelope-completed.js';
import { DOCUSIGN_NOTARIZATION_COMPLETED_JOB_TYPE } from '../../../jobs/docusign-notarization-completed.js';
import { adaptDocusign } from '../../../integrations/connectors/adapters.js';
import {
  parseDocusignConnectPayload,
  type DocusignCompletedEnvelope,
} from '../../../integrations/oauth/docusign.js';
import {
  verifyDocusignConnectHmacMultiKey,
  extractDocusignSignatures,
} from '../../../integrations/oauth/docusign-hmac.js';
import { resolveHmacKeys, type HmacKeyEntry } from './docusign-hmac-helpers.js';

export const docusignWebhookRouter = Router();

interface DocusignIntegrationRow {
  id: string;
  org_id: string;
  account_id: string | null;
  hmac_keys: HmacKeyEntry[] | null;
}

interface DocusignNonceKey {
  // docusign-bilateral-2026-08 / migration 0424: tenant-scopes the replay-
  // protection key. Always resolved BEFORE the nonce write, for both the
  // outbound and inbound branches — see nonceKeyForEvent below.
  account_id: string;
  envelope_id: string;
  event_id: string;
  generated_at: string;
}

type IntegrationTable = 'org_integrations' | 'member_integrations';
type RecipientGroups = Record<string, Array<Record<string, unknown>> | undefined>;

function getRawBody(req: Request): Buffer | null {
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? req.body;
  return Buffer.isBuffer(rawBody) ? rawBody : null;
}

async function lookupIntegrationRows(
  table: IntegrationTable,
  accountId: string,
  label: 'org integration' | 'member integration',
): Promise<DocusignIntegrationRow[] | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- webhook ingress: resolving org from external provider ID
  const { data, error } = await (db as any)
    .from(table)
    .select('id, org_id, account_id, hmac_keys')
    .eq('provider', 'docusign')
    .eq('account_id', accountId)
    .is('revoked_at', null);

  if (error) {
    logger.error({ error, accountId }, `DocuSign webhook ${label} lookup failed`);
    throw new Error('integration_lookup_failed');
  }

  return data as DocusignIntegrationRow[] | null;
}

function requireUnambiguousIntegrationRows(
  rows: DocusignIntegrationRow[] | null,
  accountId: string,
  ambiguityMessage: string,
): DocusignIntegrationRow | null {
  if (!rows || rows.length === 0) {
    return null;
  }

  if (rows.length > 1) {
    logger.error(
      { accountId, orgIds: rows.map(r => r.org_id) },
      ambiguityMessage,
    );
    throw new Error('ambiguous_integration_lookup');
  }

  return rows[0];
}

async function lookupInheritedSubOrgMarkers(
  parentIntegration: DocusignIntegrationRow,
): Promise<DocusignIntegrationRow[] | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter -- webhook ingress: resolving child marker from parent-owned provider ID before tenant attribution exists
  const { data, error } = await (db as any)
    .from('org_integrations')
    .select('id, org_id, account_id, hmac_keys')
    .eq('provider', 'docusign')
    .eq('inherited_from_org_id', parentIntegration.org_id)
    .is('account_id', null)
    .is('revoked_at', null);

  if (error) {
    logger.error(
      { error, parentOrgId: parentIntegration.org_id },
      'DocuSign webhook inherited sub-org marker lookup failed',
    );
    throw new Error('integration_lookup_failed');
  }

  return data as DocusignIntegrationRow[] | null;
}

function resolveInheritedAttribution(
  parentIntegration: DocusignIntegrationRow,
  markers: DocusignIntegrationRow[] | null,
): DocusignIntegrationRow {
  if (!markers || markers.length === 0) {
    return parentIntegration;
  }

  if (markers.length > 1) {
    logger.error(
      { parentOrgId: parentIntegration.org_id, childOrgIds: markers.map(marker => marker.org_id) },
      'DocuSign webhook: ambiguous inherited sub-org attribution — rejecting to prevent cross-tenant leak',
    );
    throw new Error('ambiguous_inherited_integration_lookup');
  }

  const marker = markers[0];
  return {
    id: marker.id,
    org_id: marker.org_id,
    account_id: parentIntegration.account_id,
    hmac_keys: parentIntegration.hmac_keys,
  };
}

/**
 * SCRUM-2044: Dual-table integration lookup.
 *
 * Resolution order (per spec):
 *   1. org_integrations by account_id — org-level takes precedence
 *   2. member_integrations by account_id — fallback for personal accounts
 *
 * Same ambiguity guard applies to both tables: if the same account_id
 * appears in multiple orgs within a table, reject to prevent cross-tenant leak.
 */
async function findIntegration(accountId: string): Promise<DocusignIntegrationRow | null> {
  // Step 1: Check org_integrations first (existing behavior, org-level wins)
  const orgIntegration = requireUnambiguousIntegrationRows(
    await lookupIntegrationRows('org_integrations', accountId, 'org integration'),
    accountId,
    'DocuSign webhook: ambiguous org lookup — same accountId connected to multiple orgs, rejecting to prevent cross-tenant leak',
  );
  if (orgIntegration) {
    return resolveInheritedAttribution(
      orgIntegration,
      await lookupInheritedSubOrgMarkers(orgIntegration),
    );
  }

  // Step 2: Fall back to member_integrations (SCRUM-2044)
  return requireUnambiguousIntegrationRows(
    await lookupIntegrationRows('member_integrations', accountId, 'member integration'),
    accountId,
    'DocuSign webhook: ambiguous member lookup — same accountId connected across multiple orgs, rejecting to prevent cross-tenant leak',
  );
}

function documentHashes(event: DocusignCompletedEnvelope): string[] {
  const sha256Hex = /^[a-f0-9]{64}$/;
  return [...new Set(
    event.envelopeDocuments
      .map((doc) => doc.sha256?.trim().toLowerCase())
      .filter((hash): hash is string => Boolean(hash && sha256Hex.test(hash))),
  )];
}

async function enqueueRuleEvent(args: {
  integration: DocusignIntegrationRow;
  event: DocusignCompletedEnvelope;
  payloadHash: string;
}): Promise<string> {
  const canonical = adaptDocusign(args.event, { org_id: args.integration.org_id });
  const hashes = documentHashes(args.event);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db.rpc as any)('enqueue_rule_event', {
    p_org_id: canonical.org_id,
    p_trigger_type: canonical.trigger_type,
    p_vendor: canonical.vendor,
    p_external_file_id: canonical.external_file_id,
    p_filename: canonical.filename ?? null,
    p_folder_path: canonical.folder_path ?? null,
    p_sender_email: canonical.sender_email ?? null,
    p_subject: canonical.subject ?? null,
    p_payload: {
      source: 'docusign_connect',
      integration_id: args.integration.id,
      account_id: args.event.accountId,
      envelope_id: args.event.envelopeId,
      document_ids: args.event.envelopeDocuments.map((doc) => doc.documentId),
      ...(hashes.length > 0 ? { document_hashes: hashes } : {}),
      ...(hashes.length === 1 ? { document_sha256: hashes[0] } : {}),
      generated_at: args.event.generatedDateTime ?? null,
      payload_hash: args.payloadHash,
    },
  });

  if (error || !data) {
    logger.error({ error, integrationId: args.integration.id }, 'DocuSign rule-event enqueue failed');
    throw new Error('rule_event_enqueue_failed');
  }

  return String(data);
}

async function enqueueFetchJob(args: {
  integration: DocusignIntegrationRow;
  event: DocusignCompletedEnvelope;
  ruleEventId: string;
}): Promise<string> {
  const jobId = await submitJob({
    type: DOCUSIGN_ENVELOPE_COMPLETED_JOB_TYPE,
    max_attempts: 5,
    priority: 10,
    payload: {
      org_id: args.integration.org_id,
      integration_id: args.integration.id,
      account_id: args.event.accountId,
      envelope_id: args.event.envelopeId,
      rule_event_id: args.ruleEventId,
      document_ids: args.event.envelopeDocuments.map((doc) => doc.documentId),
      // DS-03: forward the Connect completion time so the materializer records
      // connector_artifact.source_timestamp. Optional — undefined when DocuSign
      // omits it; the job payload schema and the RPC both accept null.
      envelope_completed_at: args.event.generatedDateTime,
    },
  });
  if (!jobId) {
    logger.error({ integrationId: args.integration.id }, 'DocuSign document-fetch job enqueue failed');
    throw new Error('document_job_enqueue_failed');
  }
  return jobId;
}

function nonceKeyForEvent(
  event: DocusignCompletedEnvelope,
  payloadHash: string,
  accountId: string,
): DocusignNonceKey {
  return {
    account_id: accountId,
    envelope_id: event.envelopeId,
    event_id: event.eventId ?? event.event,
    generated_at: event.generatedDateTime ?? payloadHash,
  };
}

async function rollbackNonceAfterEnqueueFailure(nonceKey: DocusignNonceKey): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter -- webhook replay marker rollback scoped by nonce unique key
  const { error } = await (db as any)
    .from('docusign_webhook_nonces')
    .delete()
    .match(nonceKey);

  if (error) {
    logger.error(
      { error, envelopeId: nonceKey.envelope_id, eventId: nonceKey.event_id },
      'DocuSign webhook: nonce rollback failed after enqueue failure',
    );
    throw new Error('nonce_rollback_failed');
  }
}

async function dlqInsert(args: {
  reason: string;
  externalId: string | null;
  payloadHash: string;
}): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- webhook_dlq is migration-owned and not present in generated Supabase types yet
    const { error } = await (db as any).from('webhook_dlq').insert({
      provider: 'docusign',
      reason: args.reason.slice(0, 500),
      external_id: args.externalId,
      payload_hash: args.payloadHash,
    });
    if (error) {
      logger.warn({ error }, 'DocuSign webhook: DLQ insert failed (non-fatal)');
    }
  } catch (err) {
    logger.warn({ error: err }, 'DocuSign webhook: DLQ insert threw (non-fatal)');
  }
}

// ── SCRUM-1872: Notary data extraction ──────────────────────────────

export interface NotaryData {
  notary_name: string | null;
  notary_commission_state: string | null;
  notary_commission_number: string | null;
  notarization_completed_at: string;
}

/**
 * Extract notary metadata from a DocuSign Connect raw payload.
 *
 * DocuSign Notary embeds notary signer info in the envelope's recipients.
 * The notary appears as a recipient with `recipientType: 'notary'` or
 * `roleName` containing 'notary'. Returns null if no notary data found.
 */
export function extractNotaryData(rawBody: Buffer | string): NotaryData | null {
  try {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    const json = JSON.parse(text) as Record<string, unknown>;

    // Check for notary recipients in the envelope summary
    const summary = (json.envelopeSummary ?? json.data ?? json) as Record<string, unknown>;
    const recipients = summary.recipients as RecipientGroups | undefined;

    if (!recipients) return null;

    const notaryInfo = findNotaryRecipient(recipients);
    if (!notaryInfo) return null;

    return {
      notary_name: trimmedString(notaryInfo, 'name'),
      notary_commission_state: firstTrimmedString(notaryInfo, ['notaryCommissionState', 'jurisdiction']),
      notary_commission_number: firstTrimmedString(notaryInfo, ['notaryCommissionNumber', 'commissionNumber']),
      notarization_completed_at: firstString(notaryInfo, ['completedDateTime'])
        ?? firstString(summary, ['completedDateTime'])
        ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function findNotaryRecipient(recipients: RecipientGroups): Record<string, unknown> | null {
  const notaries = recipients.notaries;
  if (notaries && notaries.length > 0) {
    return notaries[0];
  }

  const signers = recipients.signers;
  if (!signers) {
    return null;
  }

  return signers.find(isNotaryRecipient) ?? null;
}

function isNotaryRecipient(recipient: Record<string, unknown>): boolean {
  const recipientType = firstString(recipient, ['recipientType']);
  const roleName = firstString(recipient, ['roleName']);
  return (
    (recipientType !== null && recipientType.toLowerCase() === 'notary')
    || (roleName !== null && roleName.toLowerCase().includes('notary'))
  );
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
}

function trimmedString(record: Record<string, unknown>, key: string): string | null {
  const value = firstString(record, [key]);
  if (!value) {
    return null;
  }

  return value.trim() || null;
}

function firstTrimmedString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = trimmedString(record, key);
    if (value) {
      return value;
    }
  }
  return null;
}

/**
 * SCRUM-1872: Enqueue notarization job if notary data is present.
 * Non-fatal — failure here does not block the standard eSign flow.
 */
async function enqueueNotarizationJob(args: {
  integration: DocusignIntegrationRow;
  event: DocusignCompletedEnvelope;
  ruleEventId: string;
  notaryData: NotaryData;
}): Promise<string | null> {
  try {
    const jobId = await submitJob({
      type: DOCUSIGN_NOTARIZATION_COMPLETED_JOB_TYPE,
      max_attempts: 5,
      priority: 10,
      payload: {
        org_id: args.integration.org_id,
        integration_id: args.integration.id,
        account_id: args.event.accountId,
        envelope_id: args.event.envelopeId,
        rule_event_id: args.ruleEventId,
        notary_name: args.notaryData.notary_name,
        notary_commission_state: args.notaryData.notary_commission_state,
        notary_commission_number: args.notaryData.notary_commission_number,
        notarization_completed_at: args.notaryData.notarization_completed_at,
      },
    });
    if (jobId) {
      logger.info(
        { envelopeId: args.event.envelopeId, notarizationJobId: jobId },
        'DocuSign notarization job enqueued',
      );
    }
    return jobId;
  } catch (err) {
    logger.warn(
      { error: err, envelopeId: args.event.envelopeId },
      'DocuSign notarization job enqueue failed — non-fatal',
    );
    return null;
  }
}

function verifyRawBodyWithEnvKey(
  rawBody: Buffer,
  headers: Request['headers'],
): 'ok' | 'invalid_signature' | 'webhook_unconfigured' {
  const envKey = process.env.DOCUSIGN_CONNECT_HMAC_SECRET;
  if (!envKey) {
    return 'webhook_unconfigured';
  }

  const signatures = extractDocusignSignatures(headers as Record<string, string | string[] | undefined>);
  return verifyDocusignConnectHmacMultiKey({ rawBody, signatures, keys: [envKey] })
    ? 'ok'
    : 'invalid_signature';
}

async function acknowledgeUnknownIntegration(
  req: Request,
  res: Response,
  rawBody: Buffer,
  accountId: string,
): Promise<void> {
  const verification = verifyRawBodyWithEnvKey(rawBody, req.headers);
  if (verification === 'webhook_unconfigured') {
    logger.error('DocuSign webhook: unknown account and no env HMAC key — cannot verify');
    res.status(503).json({ error: { code: verification } });
    return;
  }
  if (verification === 'invalid_signature') {
    res.status(401).json({ error: { code: verification } });
    return;
  }

  logger.warn({ accountId }, 'DocuSign webhook: unknown connected account');
  res.status(200).json({ ok: true, orphaned: true });
}

function verifyIntegrationSignature(
  req: Request,
  res: Response,
  rawBody: Buffer,
  integration: DocusignIntegrationRow,
): boolean {
  const hmacKeys = resolveHmacKeys(
    integration.hmac_keys,
    process.env.DOCUSIGN_CONNECT_HMAC_SECRET,
  );
  if (hmacKeys.length === 0) {
    logger.error({ integrationId: integration.id }, 'No HMAC keys configured — webhook rejected');
    res.status(503).json({ error: { code: 'webhook_unconfigured' } });
    return false;
  }

  const signatures = extractDocusignSignatures(req.headers as Record<string, string | string[] | undefined>);
  if (!verifyDocusignConnectHmacMultiKey({ rawBody, signatures, keys: hmacKeys })) {
    res.status(401).json({ error: { code: 'invalid_signature' } });
    return false;
  }

  return true;
}

// ── docusign-bilateral-2026-08: inbound (Recipient Connect) classification ──
//
// THREAT MODEL (CTO Decision Record, docusign-bilateral-2026-08): the
// DocuSign Connect HMAC key is CUSTOMER-side console state — every connected
// org holds a VALID signing key for deliveries to its own listener. A
// declared-hash inbound path that skipped API re-verification would let any
// connected org self-POST a self-signed "inbound" event claiming to be about
// someone ELSE's envelope, and anchor a forged provenance record. The
// mitigation is that `direction` is decided from SERVER-STORED state ONLY —
// never from an attacker-authored body field, and never from the
// `?customrecipient` query marker alone (a marker cannot upgrade an envelope
// to a trust level the account comparison itself disproves).
//
// This whole feature ships behind ENABLE_DOCUSIGN_INBOUND (default false)
// and is NOT going live this cycle (SCRUM-3817 feasibility spike).

export type DocusignDirection = 'outbound' | 'inbound';

export interface DocusignDirectionClassification {
  direction: DocusignDirection;
  /** event.senderAccountId ?? event.accountId — the envelope's declared owning/sending account. */
  sendingAccountId: string;
  /**
   * Set only when direction resolved to 'inbound' via the fail-safe branch
   * (the org's-own-account lookup itself errored) rather than a genuine
   * foreign-account comparison. Never set for 'outbound'.
   */
  orphanReason?: 'own_account_lookup_failed';
}

/**
 * All DocuSign account_ids this org has itself connected — org_integrations
 * UNION member_integrations, both `provider = 'docusign'`, not revoked. This
 * is the "resolving org's OWN connected account_id set" the classifier
 * compares the envelope's declared owner against. SERVER-STORED state only;
 * the request body never reaches this function.
 */
async function resolveOrgOwnAccountIds(orgId: string): Promise<Set<string>> {
  const [orgRows, memberRows] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- webhook ingress: same untyped-table pattern as findIntegration above
    (db as any)
      .from('org_integrations')
      .select('account_id')
      .eq('org_id', orgId)
      .eq('provider', 'docusign')
      .is('revoked_at', null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from('member_integrations')
      .select('account_id')
      .eq('org_id', orgId)
      .eq('provider', 'docusign')
      .is('revoked_at', null),
  ]);

  if (orgRows.error || memberRows.error) {
    throw new Error('own_account_lookup_failed');
  }

  const ids = new Set<string>();
  for (const row of [...(orgRows.data ?? []), ...(memberRows.data ?? [])] as Array<{ account_id: string | null }>) {
    if (row.account_id) ids.add(row.account_id);
  }
  return ids;
}

/**
 * R4: decide outbound vs inbound. Called AFTER HMAC + integration resolution
 * — the `integration` row already proves the request is signed by a key this
 * ORG registered. This function decides nothing about who is calling; it
 * decides whose envelope this is:
 *
 * - `sendingAccountId` present in the org's own connected-account set ->
 *   `outbound` (the existing, byte-for-byte unchanged path below).
 * - present but NOT in that set -> `inbound` (a different account owns the
 *   envelope).
 * - the own-account lookup itself fails (DB error) -> fail SAFE to `inbound`
 *   (never silently trust an unverifiable case as outbound) and record why,
 *   so the caller emits the distinct orphan signal instead of crashing.
 *
 * FAST PATH, zero extra DB round-trips: `integration` was itself resolved
 * (in `findIntegration` above) via an EXACT match on `account_id =
 * event.accountId`. So whenever the envelope's declared sending account is
 * `event.accountId` unchanged — every payload shape that predates
 * `senderAccountId`, i.e. 100% of traffic before this PR and still the
 * common case after it — membership in the org's own-account set is already
 * proven BY CONSTRUCTION; re-querying would be redundant. This is also what
 * keeps the existing outbound flow reaching the database exactly as many
 * times as it did before this PR (backward-compat, tested explicitly). Only
 * a genuinely distinct declared `senderAccountId` falls through to the real
 * cross-check below.
 */
async function classifyDirection(
  integration: DocusignIntegrationRow,
  event: DocusignCompletedEnvelope,
): Promise<DocusignDirectionClassification> {
  const sendingAccountId = event.senderAccountId ?? event.accountId;

  if (sendingAccountId === integration.account_id) {
    return { direction: 'outbound', sendingAccountId };
  }

  let ownAccountIds: Set<string>;
  try {
    ownAccountIds = await resolveOrgOwnAccountIds(integration.org_id);
  } catch (err) {
    logger.error(
      { error: err, orgId: integration.org_id, envelopeId: event.envelopeId },
      'DocuSign webhook: own-account lookup failed — classifying inbound (fail-safe, never trust unverifiable as outbound)',
    );
    return { direction: 'inbound', sendingAccountId, orphanReason: 'own_account_lookup_failed' };
  }

  if (ownAccountIds.has(sendingAccountId)) {
    return { direction: 'outbound', sendingAccountId };
  }
  return { direction: 'inbound', sendingAccountId };
}

/**
 * R5: a DISTINCT inbound orphan-drop signal, separate from the existing
 * (deliberately silent) unknown-integration orphan path in
 * `acknowledgeUnknownIntegration` above. That path is silent BY DESIGN — an
 * unrecognised account is routine, expected noise. This one is not: a
 * nonzero inbound-orphan rate while ENABLE_DOCUSIGN_INBOUND is on means real
 * inbound envelopes are arriving and NOT being anchored. Structured log field
 * is the house pattern for this signal shape (see the UTXO RPC-fallback
 * breadcrumb, `chain_rpc_fallback: true`, documented in
 * services/worker/agents.md) — there is no dedicated metrics/counter client
 * in this codebase to bind to instead.
 */
function recordInboundOrphanDrop(args: {
  envelopeId: string;
  accountId: string;
  reason: 'own_account_lookup_failed' | 'no_usable_declared_hash';
}): void {
  logger.warn(
    {
      docusign_inbound_orphan_drop: true,
      envelopeId: args.envelopeId,
      accountId: args.accountId,
      reason: args.reason,
    },
    'DocuSign webhook: inbound envelope dropped without anchoring (orphan)',
  );
}

/**
 * The single per-envelope declared SHA-256 an inbound (declared-hash)
 * artifact can anchor. Reuses `documentHashes` (already de-dupes + validates
 * sha256 shape) and requires EXACTLY one distinct value — a multi-document or
 * zero-hash envelope has no single fingerprint this v1 path can commit to, so
 * it orphan-drops rather than guessing which document (or a concatenation)
 * the caller meant. (Scope note: multi-document inbound envelopes are an
 * explicit v1 limitation — see the PR description — not a silent gap.)
 */
function extractSingleDeclaredHash(event: DocusignCompletedEnvelope): string | null {
  const hashes = documentHashes(event);
  return hashes.length === 1 ? hashes[0] : null;
}

/**
 * R3: INBOUND + FLAG ON declared-hash anchor path. NEVER calls any
 * `/envelopes/{id}/documents/*` DocuSign API — the fingerprint is the
 * DocuSign-DECLARED per-document sha256 already present on the Connect
 * payload, not anything Arkova fetched or measured (cross-account fetch is
 * being locked down by DocuSign 26.3, 2026-09, and fetching a foreign
 * account's document was never in scope for Arkova's OAuth grant regardless).
 *
 * Reuses the SAME `enqueue_connector_artifact` RPC (migration 0343) the
 * outbound connector path uses (source='docusign'), with the `_direction` /
 * `_sending_account_id` metadata markers this PR's classifier produces —
 * both underscore-prefixed, in the write-authority guard's key family
 * (PR #2472's metadata key write-authority trigger); this handler writes via
 * the service_role client, which that guard allows.
 *
 * `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE` is guaranteed true here BY
 * CONSTRUCTION — config.ts's cross-field guard refuses to boot with
 * ENABLE_DOCUSIGN_INBOUND=true and that flag off — so this never needs its
 * own runtime flag check the way the outbound job's `enqueueSignedDocument`
 * does.
 */
async function enqueueInboundDeclaredHashArtifact(args: {
  integration: DocusignIntegrationRow;
  event: DocusignCompletedEnvelope;
  sendingAccountId: string;
  declaredHash: string;
}): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- enqueue_connector_artifact (mig 0343) not yet in generated types; same cast convention as the RPC calls above
  const { data, error } = await (db.rpc as any)('enqueue_connector_artifact', {
    p_org_id: args.integration.org_id,
    p_source: 'docusign',
    p_external_ref: args.event.envelopeId,
    p_external_revision: null,
    p_fingerprint_sha256: args.declaredHash,
    p_byte_length: null,
    p_source_timestamp: args.event.generatedDateTime ?? null,
    p_metadata: {
      account_id: args.event.accountId,
      envelope_id: args.event.envelopeId,
      integration_id: args.integration.id,
      // R4: underscore-prefixed, write-authority-guard key family (PR #2472).
      _direction: 'inbound',
      _sending_account_id: args.sendingAccountId,
    },
  });

  if (error || !data) {
    logger.error(
      { error, integrationId: args.integration.id, envelopeId: args.event.envelopeId },
      'DocuSign inbound declared-hash connector-artifact enqueue failed',
    );
    throw new Error('inbound_connector_artifact_enqueue_failed');
  }

  return String(data);
}

docusignWebhookRouter.post('/', async (req: Request, res: Response) => {
  const rawBody = getRawBody(req);
  if (!rawBody) {
    logger.error({ path: req.path }, 'DocuSign webhook: rawBody missing — raw parser must be mounted');
    res.status(500).json({ error: { code: 'misconfigured_raw_body' } });
    return;
  }

  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');

  // SCRUM-2043: lookup-first order — parse body to get accountId, then
  // resolve integration (+ per-org HMAC keys), then verify HMAC.
  let event: DocusignCompletedEnvelope;
  try {
    event = parseDocusignConnectPayload(rawBody);
  } catch (err) {
    // Return 401 (not 400) to prevent oracle: attackers must not distinguish
    // parse failure from HMAC failure (P0 review finding 2026-05-28).
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'DocuSign webhook: malformed body');
    res.status(401).json({ error: { code: 'invalid_signature' } });
    return;
  }

  try {
    const integration = await findIntegration(event.accountId);
    if (!integration) {
      // Unknown account — verify HMAC with env-var key before acking.
      // Without this, an attacker can probe which accounts are connected
      // by comparing response codes for known vs unknown account IDs.
      await acknowledgeUnknownIntegration(req, res, rawBody, event.accountId);
      return;
    }

    // SCRUM-2043: resolve HMAC keys — per-org keys take priority, env var is fallback
    if (!verifyIntegrationSignature(req, res, rawBody, integration)) {
      return;
    }

    // R4 (docusign-bilateral-2026-08): classify AFTER HMAC + integration
    // resolution, from SERVER-STORED state only — see classifyDirection's
    // doc comment above for the full threat-model rationale.
    const classification = await classifyDirection(integration, event);
    const markerClaimsInbound = typeof req.query.customrecipient !== 'undefined';
    if (markerClaimsInbound && classification.direction === 'outbound') {
      // The marker cannot upgrade trust — logged, never acted on.
      logger.warn(
        { envelopeId: event.envelopeId, accountId: event.accountId },
        "DocuSign webhook: customrecipient marker claimed inbound but the envelope's owning account is this org's own connected account — classifying outbound",
      );
    }

    if (classification.direction === 'inbound') {
      if (!config.enableDocusignInbound) {
        // R3 flag-OFF: acknowledge 200 with NO nonce consumed and NO durable
        // write. Avoids DocuSign retry storms on a path this deploy cannot
        // process yet, AND preserves recoverability — DocuSign resends on
        // any non-401/-invalid-sig-shaped failure path is not what's
        // happening here (this IS a 2xx ack), but critically consuming a
        // nonce here would permanently discard an inbound envelope that
        // happened to arrive before the flag was enabled, even after a
        // later flip-on and resend.
        logger.info(
          { envelopeId: event.envelopeId, accountId: event.accountId },
          'DocuSign webhook: inbound envelope acknowledged, ENABLE_DOCUSIGN_INBOUND is off — no nonce consumed, no durable write',
        );
        res.status(200).json({ ok: true, inbound: true, skipped: 'flag_disabled' });
        return;
      }

      const declaredHash = extractSingleDeclaredHash(event);
      if (!declaredHash) {
        // Orphan-drop BEFORE any nonce write: nothing to reconcile on retry —
        // a resend of the same unusable envelope orphan-drops again,
        // harmlessly. Bounded 200, never a crash.
        recordInboundOrphanDrop({
          envelopeId: event.envelopeId,
          accountId: event.accountId,
          reason: classification.orphanReason ?? 'no_usable_declared_hash',
        });
        res.status(200).json({ ok: true, inbound: true, skipped: 'no_usable_declared_hash' });
        return;
      }

      // Replay protection, tenant-scoped (migration 0424) by the resolving
      // account_id — same shape as the outbound branch below.
      const inboundNonceKey = nonceKeyForEvent(event, payloadHash, event.accountId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter -- webhook replay marker write scoped by account_id (migration 0424); nonce tuple prevents duplicate provider delivery
      const { error: inboundNonceErr } = await (db as any).from('docusign_webhook_nonces').insert(inboundNonceKey);
      if (inboundNonceErr) {
        if ((inboundNonceErr as { code?: string }).code === '23505') {
          logger.info(
            { envelopeId: event.envelopeId, eventId: event.eventId },
            'DocuSign webhook: duplicate inbound delivery — returning 200',
          );
          res.status(200).json({ ok: true, duplicate: true, inbound: true });
          return;
        }
        logger.error(
          { error: inboundNonceErr, envelopeId: event.envelopeId },
          'DocuSign webhook: inbound nonce insert failed',
        );
        res.status(500).json({ error: { code: 'nonce_insert_failed' } });
        return;
      }

      try {
        await enqueueInboundDeclaredHashArtifact({
          integration,
          event,
          sendingAccountId: classification.sendingAccountId,
          declaredHash,
        });
      } catch (enqueueErr) {
        await rollbackNonceAfterEnqueueFailure(inboundNonceKey);
        throw enqueueErr;
      }
      res.status(202).json({ ok: true, inbound: true });
      return;
    }

    // ── OUTBOUND: existing path, unchanged ──────────────────────────────
    // Replay protection: dedupe on (account_id, envelope_id, event_id,
    // generated_at). DocuSign retries on any non-2xx response, so a
    // duplicate must return 200 to stop the retry loop. Migration 0256
    // creates the nonce table; migration 0424 tenant-scopes it by account_id.
    const nonceKey = nonceKeyForEvent(event, payloadHash, event.accountId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter -- webhook replay marker write scoped by account_id (migration 0424); nonce tuple prevents duplicate provider delivery
    const { error: nonceErr } = await (db as any).from('docusign_webhook_nonces').insert(nonceKey);
    if (nonceErr) {
      // Postgres unique_violation — duplicate delivery, ack so retries stop.
      if ((nonceErr as { code?: string }).code === '23505') {
        logger.info(
          { envelopeId: event.envelopeId, eventId: event.eventId },
          'DocuSign webhook: duplicate delivery — returning 200',
        );
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
      logger.error(
        { error: nonceErr, envelopeId: event.envelopeId },
        'DocuSign webhook: nonce insert failed',
      );
      res.status(500).json({ error: { code: 'nonce_insert_failed' } });
      return;
    }

    try {
      const ruleEventId = await enqueueRuleEvent({ integration, event, payloadHash });
      await enqueueFetchJob({ integration, event, ruleEventId });

      // SCRUM-1872: Check for notary data and enqueue notarization job (non-fatal)
      const notaryData = extractNotaryData(rawBody);
      if (notaryData) {
        await enqueueNotarizationJob({
          integration,
          event,
          ruleEventId,
          notaryData,
        });
      }
    } catch (enqueueErr) {
      await rollbackNonceAfterEnqueueFailure(nonceKey);
      throw enqueueErr;
    }
    res.status(202).json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unexpected';
    logger.error({ error: err, accountId: event.accountId }, 'DocuSign webhook processing failed');
    await dlqInsert({ reason: message, externalId: event.envelopeId, payloadHash });
    res.status(500).json({ error: { code: 'webhook_processing_failed' } });
  }
});
