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
import {
  DocusignCapturedSigner,
  MAX_CAPTURED_DOCUSIGN_SIGNERS,
  type DocusignCapturedSignerT,
} from '../../../integrations/connectors/schemas.js';

export const docusignWebhookRouter = Router();

interface DocusignIntegrationRow {
  id: string;
  org_id: string;
  account_id: string | null;
  hmac_keys: HmacKeyEntry[] | null;
}

interface DocusignNonceKey {
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
  signers: DocusignCapturedSignerT[];
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
      // CTO Decision Record R6: pseudonymous signer GUIDs only (never name/
      // email — see extractSigners). Omitted entirely when empty, matching
      // the document_hashes/document_sha256 spread convention below in
      // enqueueRuleEvent — never persist an empty array where "absent" reads
      // more honestly (CLAUDE.md §6: omit rather than null/empty).
      ...(args.signers.length > 0 ? { _signers: args.signers } : {}),
    },
  });
  if (!jobId) {
    logger.error({ integrationId: args.integration.id }, 'DocuSign document-fetch job enqueue failed');
    throw new Error('document_job_enqueue_failed');
  }
  return jobId;
}

function nonceKeyForEvent(event: DocusignCompletedEnvelope, payloadHash: string): DocusignNonceKey {
  return {
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

// ── CTO Decision Record (docusign-bilateral-2026-08, ruling R6): signer capture ──

/**
 * Extract pseudonymous signer identifiers from a DocuSign Connect raw payload.
 *
 * Mirrors `extractNotaryData`'s raw-body access pattern: `recipients.signers[]`
 * lives outside the strict `DocusignEnvelopeCompleted` schema (like the notary
 * data, DocuSign's own recipient shape varies more than that schema validates),
 * so this reads the same `envelopeSummary ?? data ?? root` recipients block
 * directly rather than widening the typed schema. Deliberately does NOT read
 * `recipients.carbonCopies[]` — `findNotaryRecipient` above only ever consults
 * `notaries` and `signers`, and this mirrors that same access pattern.
 *
 * PII discipline (R6): only `recipient_id_guid` / `user_id` / `status` /
 * `signed_at` are ever copied — each field is read individually via
 * `trimmedString`/`firstString` into a fresh literal, never spread from the
 * raw recipient object, so a DocuSign-supplied `name`/`email` can never reach
 * the result even if a future DocuSign payload shape adds more fields.
 * `DocusignCapturedSigner.safeParse` is a second, independent gate — its
 * default (non-`.passthrough()`) object mode strips anything not explicitly
 * listed, rejects entries missing a required `recipient_id_guid`/`status`,
 * AND (PR #2474 review, HIGH) rejects `recipient_id_guid`/`user_id` values
 * that are not GUID-shaped — key-name stripping alone cannot stop a
 * mis-slotted email/name riding in under the right field name; the value
 * shape is pinned too, so that failure mode fails closed (entry skipped),
 * not open.
 *
 * Also dedupes by `recipient_id_guid` — a resend/bounce can list the same
 * signer twice within one delivery, and a duplicate should not burn a second
 * slot of the cap.
 *
 * Capped at `MAX_CAPTURED_DOCUSIGN_SIGNERS` entries (metadata-size + display
 * safety per R6) — truncates rather than rejecting the whole envelope, so an
 * oversized recipient list never blocks the fetch/anchor pipeline for the
 * signed document itself.
 */
export function extractSigners(rawBody: Buffer | string): DocusignCapturedSignerT[] {
  try {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    const json = JSON.parse(text) as Record<string, unknown>;

    const summary = (json.envelopeSummary ?? json.data ?? json) as Record<string, unknown>;
    const recipients = summary.recipients as RecipientGroups | undefined;
    if (!recipients) return [];

    const signers = recipients.signers;
    if (!signers || signers.length === 0) return [];

    const captured: DocusignCapturedSignerT[] = [];
    // Dedupe by recipient_id_guid — a resend/bounce can produce two recipient
    // entries for the same signer within one delivery; without this, a
    // duplicate burns a second slot of the 20-entry cap for no new signer.
    const seenGuids = new Set<string>();
    for (const raw of signers) {
      if (captured.length >= MAX_CAPTURED_DOCUSIGN_SIGNERS) break;

      const recipientIdGuid = trimmedString(raw, 'recipientIdGuid');
      const userId = trimmedString(raw, 'userId');
      const status = trimmedString(raw, 'status');
      const signedAt = firstString(raw, ['signedDateTime']);
      // Optional fields are only spread in when present — an explicit `undefined`
      // value would still leave the key on the object (Zod .optional() accepts
      // that), which would defeat the "absent, not merely falsy" contract the
      // pure-email-link-signer case (no userId) and unsigned-recipient case (no
      // signed_at) both rely on.
      const candidate = {
        ...(recipientIdGuid ? { recipient_id_guid: recipientIdGuid } : {}),
        ...(userId ? { user_id: userId } : {}),
        ...(status ? { status } : {}),
        ...(signedAt ? { signed_at: signedAt } : {}),
      };
      const parsed = DocusignCapturedSigner.safeParse(candidate);
      if (parsed.success && !seenGuids.has(parsed.data.recipient_id_guid)) {
        seenGuids.add(parsed.data.recipient_id_guid);
        captured.push(parsed.data);
      }
      // Entries missing a required recipient_id_guid/status, or whose
      // recipient_id_guid/user_id is not GUID-shaped (PR #2474 review, HIGH:
      // stripping-by-key-name alone cannot stop a mis-slotted email/name from
      // riding in under the right field name), are silently skipped — never
      // persisted as a partial/identity-less/PII row — matches
      // extractNotaryData's fail-soft posture (best-effort metadata, never
      // blocks the standard eSign flow).
    }
    return captured;
  } catch {
    return [];
  }
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

    // Replay protection: dedupe on (envelope_id, event_id, generated_at).
    // DocuSign retries on any non-2xx response, so a duplicate must return
    // 200 to stop the retry loop. Migration 0256 creates the nonce table.
    const nonceKey = nonceKeyForEvent(event, payloadHash);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter -- webhook replay marker write has no tenant key; nonce tuple prevents duplicate provider delivery
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
      // CTO Decision Record R6/Finding 7: signer GUIDs are deliberately kept OFF
      // the rule-event payload (organization_rule_events.payload has a DB CHECK
      // pg_column_size(payload) <= 16384; document_ids/document_hashes alone can
      // approach that ceiling at the 100-envelopeDocuments cap) and carried only
      // on the job → connector_artifact.metadata → anchors.metadata path, which
      // is uncapped.
      const signers = extractSigners(rawBody);
      await enqueueFetchJob({ integration, event, ruleEventId, signers });

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
