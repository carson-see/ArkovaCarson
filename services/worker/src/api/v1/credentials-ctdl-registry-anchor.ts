/**
 * POST /api/v1/credentials/ctdl/registry-anchor
 *
 * L3-A6 — CE Noncredit Data Taxonomy 3.0 anchoring POC (2026-07-28, founder
 * amendment A4, supersedes the generic R12 "registry snapshot" framing).
 *
 * Given a CE CTID, fetches the PUBLIC Credential Engine Registry
 * `/graph/<ctid>` record and creates an Arkova anchor whose fingerprint is
 * derived from the registry envelope's own SHA-256 — a tamper-evident,
 * independently-timestamped proof that a specific registry record existed
 * with specific content at a specific retrieval time. This is the "proof
 * layer for the noncredit publishing push" described in
 * `docs/partners/ce-noncredit-anchoring-poc.md`.
 *
 * REUSE, NOT REBUILD (explicit founder instruction): this route reuses the
 * EXACT §1.6A-compliant fetch primitives from `credentials-ctdl-import.ts`
 * (`fetchRegistryGraph` / `buildRegistryGraphUrl` / `mapSafeFetchError` /
 * `RegistryTimeoutError` / `MAX_RESPONSE_BYTES` / `DEFAULT_REGISTRY_TIMEOUT_MS`)
 * — no second outbound-fetch implementation. `safeFetch` (SSRF-hardened:
 * scheme allow-list, resolve-and-pin IP, private/link-local/metadata-target
 * rejection, response-byte cap, zero redirect-following) is unchanged.
 *
 * §1.6A discipline: raw registry bytes are hashed in memory
 * (`createHash('sha256')`) and then DISCARDED — never persisted to Postgres,
 * never logged, never sent to Sentry, never embedded in an Error message.
 * Only the fingerprint + bounded, PII-free metadata (ctid, registry URL,
 * envelope SHA-256, retrieval time, record name, record type, issuer name —
 * all values already PUBLIC CE Registry data) reach `anchors.metadata`.
 *
 * NONCREDIT PARSER FIX (this same PR, `ctdl-importer.ts`): parses with
 * `credentialNodesOnly: true, includeNoncreditProgramClasses: true` so a
 * `ceterms:LearningProgram` / `ceterms:LearningOpportunityProfile` /
 * `ceterms:LearningOpportunity` / `ceterms:Course` node is admitted — see
 * `ctdl-importer.noncredit.test.ts` for the "before" (silently dropped) vs
 * "after" (anchorable) proof.
 *
 * CLAIMS GUARD (R-7 / §1.13): the assembled response body is passed through
 * `assertNoProhibitedClaimInJsonLd` BEFORE the anchor is created — a
 * Registry-listing / legal-sufficiency overclaim (however it got into the
 * registry record's own free text) can never reach a created anchor or a
 * response body. `ceEnvelopeSignatureVerified` is emitted as `null`
 * (unchecked) and is NEVER rendered as CE endorsement of Arkova.
 *
 * anchors.credential_type: 'OTHER'. There is no dedicated noncredit
 * `credential_type` enum value — adding one is a schema change (migration +
 * `gen:types` + Confluence Data Model update) out of scope for this POC; see
 * the honest-limits section of the partner writeup. `anchors.metadata` (an
 * unconstrained jsonb object column) carries the CE-registry provenance —
 * confirmed via `supabase/migrations/00000000000000_baseline_at_main_HEAD.sql`
 * that `anchors` has NO `source` column / CHECK constraint to widen, so this
 * PR ships with NO migration (the sprint-plan reservation table listed
 * `0375+` as a spare "IF CHECK-constrained" — verified not needed).
 */
import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { REAL_CTID_PATTERN } from '../../ctdl/ctdl-ctid-guard.js';
import {
  CtdlImportError,
  DEFAULT_REGISTRY_BASE_URL,
  MAX_GRAPH_NODES,
  parseCtdlEnvelope,
  type ImportedCtdlRecord,
} from '../../ctdl/ctdl-importer.js';
import {
  assertNoProhibitedClaimInJsonLd,
  ProhibitedClaimError,
} from '../../ctdl/ctdl-claims-guard.js';
import { SafeFetchError, defaultSafeFetchDeps, type SafeFetchDeps } from '../../lib/safe-fetch.js';
import {
  DEFAULT_REGISTRY_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  RegistryTimeoutError,
  buildRegistryGraphUrl,
  fetchRegistryGraph,
  mapSafeFetchError,
} from './credentials-ctdl-import.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { deductOrgCredit, type DeductionResult } from '../../utils/orgCredits.js';
import { buildVerifyUrl } from '../../lib/urls.js';

export interface CredentialsCtdlRegistryAnchorRouterOptions {
  /** Injected SSRF-safe fetch deps (resolve + pinned dispatch). Defaults to prod. */
  deps?: SafeFetchDeps;
  /** Injected clock — threaded into the importer and the anchor timestamps. */
  now?: () => Date;
  /** Outbound wall-clock timeout in ms. Defaults to {@link DEFAULT_REGISTRY_TIMEOUT_MS}. */
  registryTimeoutMs?: number;
}

const RequestBodySchema = z
  .object({
    ctid: z.string().trim().min(1),
    /**
     * Staleness guard mirroring `credential-sources.ts`'s
     * `expected_source_payload_hash`: when the caller previewed via
     * `GET /api/v1/credentials/ctdl/import?ctid=` first, it can pass back the
     * envelope hash it saw. If the registry record changed since, the anchor
     * request is refused (409) rather than silently anchoring different bytes
     * than the caller reviewed.
     */
    expected_envelope_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'Expected envelope hash must be lowercase SHA-256 hex')
      .optional(),
  })
  .strict();

const MAX_PUBLIC_ID_INSERT_ATTEMPTS = 5;

interface AnchorRow {
  id: string;
  public_id: string | null;
  fingerprint: string;
  status: string;
  created_at: string;
}

interface DbErrorLike {
  code?: string;
  message?: string;
}

function errMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'unknown error';
}

function isUniqueViolation(error: DbErrorLike | null | undefined): boolean {
  return error?.code === '23505';
}

/** Deterministic idempotency fingerprint: same registry state → same anchor. */
export function buildRegistryAnchorFingerprint(ctid: string, envelopeSha256: string): string {
  return createHash('sha256').update(`ctdl-registry-anchor:${ctid}:${envelopeSha256}`).digest('hex');
}

function buildAnchorPublicId(now: Date): string {
  return `ARK-${now.getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

async function loadUserOrgId(userId: string): Promise<string | null> {
  const { data, error } = await db.from('profiles').select('org_id').eq('id', userId).single();
  if (error) throw error;
  return (data as { org_id: string | null } | null)?.org_id ?? null;
}

async function findExistingRegistryAnchor(userId: string, fingerprint: string): Promise<AnchorRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;
  const { data, error } = await dbAny
    .from('anchors')
    .select('id, public_id, fingerprint, status, created_at')
    .eq('user_id', userId)
    .eq('fingerprint', fingerprint)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as AnchorRow | null;
}

interface BoundedRegistryMetadata {
  ce_registry_ctid: string;
  ce_registry_url: string;
  ce_envelope_sha256: string;
  ce_retrieved_at: string;
  ce_record_type: string | null;
  ce_record_name: string | null;
  ce_issuer_name: string | null;
  ce_source: 'noncredit_registry_import';
}

async function insertRegistryAnchor(
  userId: string,
  orgId: string | null,
  fingerprint: string,
  metadata: BoundedRegistryMetadata,
  now: Date,
): Promise<{ anchor: AnchorRow | null; error: DbErrorLike | null; duplicate?: AnchorRow }> {
  const label = metadata.ce_record_name ?? `CE Registry record ${metadata.ce_registry_ctid}`;
  const description = metadata.ce_issuer_name
    ? `${label} — Credential Engine Registry snapshot (${metadata.ce_issuer_name})`
    : `${label} — Credential Engine Registry snapshot`;

  let lastError: DbErrorLike | null = null;

  for (let attempt = 0; attempt < MAX_PUBLIC_ID_INSERT_ATTEMPTS; attempt += 1) {
    const publicId = buildAnchorPublicId(now);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = db as any;
    const { data: anchor, error: insertError } = await dbAny
      .from('anchors')
      .insert({
        fingerprint,
        public_id: publicId,
        status: 'PENDING',
        org_id: orgId,
        user_id: userId,
        filename: `${label}.jsonld`.slice(0, 255),
        file_mime: 'application/ld+json',
        credential_type: 'OTHER',
        label: label.slice(0, 500),
        description: description.slice(0, 500),
        metadata,
      })
      .select('id, public_id, fingerprint, status, created_at')
      .single();

    if (!insertError && anchor) return { anchor: anchor as AnchorRow, error: null };
    lastError = insertError;
    if (!isUniqueViolation(insertError)) return { anchor: null, error: insertError };

    const duplicate = await findExistingRegistryAnchor(userId, fingerprint);
    if (duplicate) return { anchor: null, error: insertError, duplicate };
    // public_id collision only (fingerprint not yet present) — retry with a fresh public_id.
  }

  return { anchor: null, error: lastError };
}

async function rollbackAnchor(anchorId: string, userId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;
  const { error } = await dbAny
    .from('anchors')
    .update({ deleted_at: 'now' })
    .eq('id', anchorId)
    .eq('user_id', userId)
    .is('deleted_at', null);
  if (error) {
    logger.error({ error, anchorId, userId }, 'Failed to roll back CE registry anchor after post-create failure');
  }
}

function sendCreditFailure(res: Response, orgId: string, deduction: DeductionResult): void {
  if (deduction.error === 'insufficient_credits') {
    res.status(402).json({
      error: 'insufficient_credits',
      message: 'Organization has insufficient anchor credits for this cycle.',
      balance: deduction.balance,
      required: deduction.required,
    });
    return;
  }
  if (deduction.error === 'rpc_failure') {
    logger.error({ err: deduction.message, orgId }, 'ce_registry_anchor_credit_deduct_rpc_failure');
    res.status(503).json({ error: 'credit_check_unavailable' });
    return;
  }
  res.status(402).json({
    error: 'org_credits_not_initialized',
    message: 'This organization is not provisioned for credit-based billing.',
  });
}

async function logRegistryAnchorAudit(
  userId: string,
  orgId: string | null,
  anchorId: string,
  metadata: BoundedRegistryMetadata,
): Promise<void> {
  const { error } = await db.from('audit_events').insert({
    event_type: 'ce_registry.anchor_created',
    event_category: 'ANCHOR',
    actor_id: userId,
    org_id: orgId,
    target_type: 'anchor',
    target_id: anchorId,
    details: JSON.stringify(metadata),
  });
  if (error) throw error;
}

function toReceipt(anchor: AnchorRow) {
  if (!anchor.public_id) throw new Error('CE registry anchor is missing public_id');
  return {
    public_id: anchor.public_id,
    status: anchor.status,
    created_at: anchor.created_at,
    record_uri: buildVerifyUrl(anchor.public_id),
  };
}

/** Pick the record this POC anchors: the FIRST admitted node in document order. */
function selectPrimaryRecord(records: ImportedCtdlRecord[]): ImportedCtdlRecord | null {
  return records[0] ?? null;
}

export function buildCredentialsCtdlRegistryAnchorRouter(
  options: CredentialsCtdlRegistryAnchorRouterOptions = {},
): Router {
  const deps = options.deps ?? defaultSafeFetchDeps();
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.registryTimeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS;

  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const parsedBody = RequestBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: 'invalid_request', message: 'Request body failed validation' });
      return;
    }
    const { ctid, expected_envelope_sha256: expectedEnvelopeSha256 } = parsedBody.data;

    if (!REAL_CTID_PATTERN.test(ctid)) {
      res.status(400).json({ error: 'invalid_ctid' });
      return;
    }

    const url = buildRegistryGraphUrl(ctid);
    const retrievedAt = now();

    let fetched: { status: number; text: string };
    try {
      fetched = await fetchRegistryGraph(url, deps, timeoutMs);
    } catch (error) {
      if (error instanceof RegistryTimeoutError) {
        res.status(504).json({ error: 'registry_timeout' });
        return;
      }
      if (error instanceof SafeFetchError) {
        const mapped = mapSafeFetchError(error);
        res.status(mapped.status).json({ error: mapped.code });
        return;
      }
      logger.error({ error: errMessage(error) }, 'CE registry anchor fetch failed');
      res.status(502).json({ error: 'registry_bad_gateway' });
      return;
    }

    if (fetched.status === 404) {
      res.status(404).json({ error: 'registry_record_not_found' });
      return;
    }
    if (fetched.status < 200 || fetched.status >= 300) {
      res.status(502).json({ error: 'registry_bad_gateway' });
      return;
    }

    // §1.6A: hash the exact bytes consumed, in memory. `fetched.text` is never
    // logged, sent to Sentry, or embedded in any Error/audit payload below.
    const envelopeSha256 = createHash('sha256').update(fetched.text, 'utf8').digest('hex');

    if (expectedEnvelopeSha256 && expectedEnvelopeSha256 !== envelopeSha256) {
      res.status(409).json({
        error: 'registry_record_changed',
        message: 'Registry record changed since preview. Preview it again before anchoring.',
        expected_envelope_sha256: expectedEnvelopeSha256,
        actual_envelope_sha256: envelopeSha256,
      });
      return;
    }

    let records: ImportedCtdlRecord[];
    try {
      records = parseCtdlEnvelope(fetched.text, {
        now: retrievedAt,
        retrievedAt,
        registryBaseUrl: DEFAULT_REGISTRY_BASE_URL,
        credentialNodesOnly: true,
        includeNoncreditProgramClasses: true,
        ceEnvelopeSignatureVerified: null,
      });
    } catch (error) {
      if (error instanceof CtdlImportError) {
        const tooManyNodes = error.message.includes(`${MAX_GRAPH_NODES}`);
        res.status(tooManyNodes ? 413 : 422).json({
          error: tooManyNodes ? 'registry_record_too_large' : 'registry_record_unparseable',
        });
        return;
      }
      logger.error({ error: errMessage(error) }, 'CE registry anchor parse failed');
      res.status(500).json({ error: 'internal_error' });
      return;
    }

    const record = selectPrimaryRecord(records);
    if (!record) {
      res.status(422).json({
        error: 'no_publishable_record',
        message: 'The registry record at this CTID has no CTDL credential or noncredit-program node to anchor.',
      });
      return;
    }

    const metadata: BoundedRegistryMetadata = {
      ce_registry_ctid: ctid,
      ce_registry_url: record.registryUrl ?? `${DEFAULT_REGISTRY_BASE_URL}/resources/${ctid}`,
      ce_envelope_sha256: envelopeSha256,
      ce_retrieved_at: retrievedAt.toISOString(),
      ce_record_type: record.type,
      ce_record_name: record.name,
      ce_issuer_name: record.issuer?.name ?? null,
      ce_source: 'noncredit_registry_import',
    };

    const responseBody = {
      registry: {
        ctid,
        registryUrl: metadata.ce_registry_url,
        envelopeSha256,
        retrievedAt: metadata.ce_retrieved_at,
        // MEASURED, unchecked — NEVER an endorsement of Arkova (R-7).
        envelopeSignatureVerified: null as boolean | null,
      },
      record: {
        type: record.type,
        name: record.name,
        issuerName: record.issuer?.name ?? null,
      },
    };

    // R-7 defense-in-depth: refuse to ship OR anchor a body carrying a
    // Registry-listing / legal-sufficiency overclaim (e.g. from a hostile
    // registry record's own free text).
    try {
      assertNoProhibitedClaimInJsonLd(responseBody);
    } catch (error) {
      if (error instanceof ProhibitedClaimError) {
        res.status(500).json({ error: 'internal_error' });
        return;
      }
      throw error;
    }

    const fingerprint = buildRegistryAnchorFingerprint(ctid, envelopeSha256);

    let orgId: string | null;
    try {
      orgId = await loadUserOrgId(userId);
    } catch (error) {
      logger.error({ error, userId }, 'Failed to load org for CE registry anchor');
      res.status(500).json({ error: 'internal_error' });
      return;
    }

    try {
      const existing = await findExistingRegistryAnchor(userId, fingerprint);
      if (existing) {
        res.status(200).json({ duplicate: true, anchor: toReceipt(existing), ...responseBody });
        return;
      }

      const createResult = await insertRegistryAnchor(userId, orgId, fingerprint, metadata, retrievedAt);
      if (createResult.duplicate) {
        res.status(200).json({ duplicate: true, anchor: toReceipt(createResult.duplicate), ...responseBody });
        return;
      }
      const { anchor } = createResult;
      if (!anchor) {
        logger.error({ error: createResult.error, userId, ctid }, 'Failed to create CE registry anchor');
        res.status(500).json({ error: 'anchor_create_failed' });
        return;
      }

      if (orgId) {
        const deduction = await deductOrgCredit(db, orgId, 1, 'ce_registry_anchor.create', anchor.id);
        if (!deduction.allowed) {
          await rollbackAnchor(anchor.id, userId);
          sendCreditFailure(res, orgId, deduction);
          return;
        }
      }

      try {
        await logRegistryAnchorAudit(userId, orgId, anchor.id, metadata);
      } catch (auditError) {
        logger.error({ error: auditError, anchorId: anchor.id, userId }, 'Failed to audit CE registry anchor (anchor NOT rolled back)');
        // The anchor row is already the authoritative record; an audit-write
        // failure alone should not undo a successfully created anchor +
        // (possibly) deducted credit. Logged loudly for operator follow-up.
      }

      res.status(201).json({ duplicate: false, anchor: toReceipt(anchor), ...responseBody });
    } catch (error) {
      logger.error({ error: errMessage(error), userId, ctid }, 'CE registry anchor failed');
      res.status(500).json({ error: 'internal_error' });
    }
  });

  return router;
}

export const credentialsCtdlRegistryAnchorRouter = buildCredentialsCtdlRegistryAnchorRouter();

// Response byte cap re-exported for callers/tests that want to assert the
// same ceiling the fetch primitive enforces (kept in one place: the import
// route module).
export { MAX_RESPONSE_BYTES };
