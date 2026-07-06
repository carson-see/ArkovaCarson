/**
 * GET /api/v1/credentials/:publicId/ctdl
 *
 * Public CTDL JSON-LD projection for an anchored credential. The endpoint
 * accepts Arkova public IDs only and intentionally returns no internal UUIDs,
 * fingerprints, raw metadata, recipient emails, or source filenames.
 */

import { Router, type Request } from 'express';
import { buildCtdlJsonLd, containsHighConfidencePii, CtdlPiiSafetyError, normalizeContactHours, type CtdlAnchor } from '../../ctdl/ctdl-serializer.js';
import { isCtdlPublishableStatus } from '../../ctdl/ctdl-type-map.js';
import { buildVerifyUrl } from '../../lib/urls.js';
import { db } from '../../utils/db.js';
import { getCorrelationId } from '../../utils/correlationId.js';
import { logger } from '../../utils/logger.js';

const PUBLIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface CredentialsCtdlLookup {
  lookupByPublicId(publicId: string): Promise<CtdlAnchor | null>;
}

interface AuditArgs {
  req: Request;
  publicId: string;
  outcome: 'invalid' | 'not_found' | 'not_publishable' | 'safety_blocked' | 'published' | 'revoked' | 'error';
  httpStatus: number;
  credentialStatus?: string | null;
  credentialType?: string | null;
  orgId?: string | null;
}

function requestId(req: Request): string | null {
  const header = req.headers['x-request-id'] ?? req.headers['x-correlation-id'];
  if (typeof header === 'string') return header;
  return getCorrelationId() ?? null;
}

function userAgent(req: Request): string | null {
  const agent = req.headers['user-agent'];
  if (Array.isArray(agent)) return agent.join(', ').slice(0, 200);
  return typeof agent === 'string' ? agent.slice(0, 200) : null;
}

function auditErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return String(error);
}

function warnAuditFailure(args: AuditArgs, error: unknown): void {
  logger.warn({
    public_id: args.publicId,
    outcome: args.outcome,
    http_status: args.httpStatus,
    error: auditErrorMessage(error),
  }, 'Failed to write CTDL request audit event');
}

function logCtdlRequested(args: AuditArgs): void {
  const payload = {
    event_type: 'ctdl.requested',
    event_category: 'VERIFICATION' as const,
    target_type: 'credential',
    target_id: args.publicId,
    org_id: args.orgId ?? null,
    details: JSON.stringify({
      outcome: args.outcome,
      http_status: args.httpStatus,
      credential_status: args.credentialStatus ?? null,
      credential_type: args.credentialType ?? null,
      request_id: requestId(args.req),
      querying_ip: args.req.ip ?? null,
      querying_agent: userAgent(args.req),
      api_key_id: args.req.apiKey?.keyId ?? null,
    }),
  };

  try {
    // eslint-disable-next-line arkova/missing-org-filter -- audit insert writes a new event; org_id is set when the credential is found.
    void Promise.resolve(db.from('audit_events').insert(payload))
      .then(({ error }) => {
        if (error) throw error;
      })
      .catch((error: unknown) => warnAuditFailure(args, error));
  } catch (error) {
    warnAuditFailure(args, error);
  }
}

// SCRUM-2374 (CE-03) — bounded, allow-listed metadata keys that carry a
// RESOURCE-AVAILABILITY / offering expiry (the date the offering itself is no
// longer available), which is the ONLY expiry Jeanne Kitchens' guidance allows
// to map to CTDL `ceterms:expirationDate`. The issued-person expiry lives on
// `anchors.expires_at` and is deliberately NOT one of these keys. Only a valid
// ISO date-like value is accepted; anything else is ignored (honest omission).
const RESOURCE_AVAILABILITY_METADATA_KEYS = [
  'resource_available_until',
  'resourceAvailableUntil',
  'offering_available_until',
  'offeringAvailableUntil',
  'offering_end_date',
  'offeringEndDate',
] as const;

// Canonicalize an accepted metadata value to a bare, canonical ISO 8601 string.
// This is the ONLY value that can ever reach `ceterms:expirationDate`. Two
// defenses run before canonicalization so nothing but a canonical date survives:
//   1. High-confidence PII gate (email/phone/SSN). Date.parse() is lenient enough
//      that "recipient@example.com 2030-01-01" parses as a valid date — the raw
//      passthrough used to leak the email onto the public projection (MED). Any
//      PII hit rejects the whole value (honest omission), never a canonicalized
//      remnant.
//   2. ISO-8601 canonicalization via `new Date(value).toISOString()`. A non-ISO
//      string like "12/31/2030" is normalized to canonical ISO (or omitted if it
//      does not parse), so a verbatim locale-formatted string can never appear (LOW).
function canonicalizeResourceAvailableUntil(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Reject any value carrying high-confidence PII — do not attempt to salvage a date.
  if (containsHighConfidencePii(trimmed)) return null;
  const parsed = new Date(trimmed);
  const ms = parsed.getTime();
  if (Number.isNaN(ms)) return null;
  return parsed.toISOString();
}

function resourceAvailableUntilFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  for (const key of RESOURCE_AVAILABILITY_METADATA_KEYS) {
    const value = record[key];
    if (typeof value === 'string') {
      const canonical = canonicalizeResourceAvailableUntil(value);
      if (canonical) return canonical;
    }
  }
  return null;
}

// SCRUM-2375 (CE-04) — bounded, allow-listed metadata keys that carry a CE
// continuing-education CONTACT-HOUR credit value (how many contact hours the
// CPE/CLE offering awards). Emitted publicly as a ceterms:ValueProfile with
// creditUnit:ContactHour — see `ctdl-serializer.ts`.
//
// `ceu` / `ceus` are deliberately NOT allow-listed: 1 CEU = 10 contact hours by
// convention, and asserting that conversion would fabricate a number the issuer
// never stated. Honest omission over unit invention.
//
// CONFLATION GUARD: this "credit" is the CE ContactHour credit of the
// credential. It is derived ONLY from anchor metadata — never from the billing
// credit_ledger, which is a different "credit" entirely (paid anchoring
// balance). Enforced by `ctdl-credit-conflation-guard.test.ts`.
const CONTACT_HOUR_METADATA_KEYS = [
  'contact_hours',
  'contactHours',
  'credit_hours',
  'creditHours',
  'ce_credit_hours',
  'ceCreditHours',
] as const;

// Accepts a plain number or a bare numeric string ("1.5"); everything else is
// ignored. The shared plausibility gate (normalizeContactHours, exported by the
// serializer so the row layer and emission layer cannot drift) then rejects
// zero/negative/non-finite/implausibly-large values → honest omission.
function contactHoursFromMetadata(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  for (const key of CONTACT_HOUR_METADATA_KEYS) {
    const raw = record[key];
    let candidate: number | null = null;
    if (typeof raw === 'number') {
      candidate = raw;
    } else if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Number(raw.trim());
      candidate = Number.isNaN(parsed) ? null : parsed;
    }
    const normalized = normalizeContactHours(candidate);
    if (normalized !== null) return normalized;
  }
  return null;
}

// Coerce an unknown row value to a bare string or null. Collapsing the repeated
// `typeof x === 'string' ? x : null` branches into one helper keeps
// normalizeAnchorRow under the cognitive-complexity limit (SonarCloud) without
// changing behavior.
function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function normalizeAnchorRow(row: Record<string, unknown>): CtdlAnchor {
  const organization = row.organization as Record<string, unknown> | null | undefined;
  return {
    publicId: String(row.public_id ?? ''),
    orgId: asStringOrNull(row.org_id),
    status: String(row.status ?? ''),
    credentialType: asStringOrNull(row.credential_type),
    subType: asStringOrNull(row.sub_type),
    label: asStringOrNull(row.label),
    description: asStringOrNull(row.description),
    metadata: row.metadata,
    createdAt: String(row.created_at ?? ''),
    chainTimestamp: asStringOrNull(row.chain_timestamp),
    issuedAt: asStringOrNull(row.issued_at),
    // Issued-person credential expiry — read for completeness but the serializer
    // never routes it to ceterms:expirationDate (SCRUM-2374 / Jeanne guidance).
    expiresAt: asStringOrNull(row.expires_at),
    // Resource-availability / offering expiry (the only expiry that maps to CTDL).
    resourceAvailableUntil: resourceAvailableUntilFromMetadata(row.metadata),
    // CE-04: continuing-education contact-hour credit (CE ContactHour — NOT the
    // billing credit_ledger). Allow-listed metadata keys only.
    contactHours: contactHoursFromMetadata(row.metadata),
    revokedAt: asStringOrNull(row.revoked_at),
    revocationReason: asStringOrNull(row.revocation_reason),
    issuer: organization ? {
      name: asStringOrNull(organization.display_name),
      publicId: asStringOrNull(organization.public_id),
      websiteUrl: asStringOrNull(organization.website_url),
      domain: asStringOrNull(organization.domain),
    } : null,
  };
}

export const defaultCredentialsCtdlLookup: CredentialsCtdlLookup = {
  async lookupByPublicId(publicId: string) {
    const { data, error } = await db
      .from('anchors')
      .select(
        'public_id, status, credential_type, sub_type, label, description, metadata, ' +
          'created_at, chain_timestamp, issued_at, expires_at, revoked_at, revocation_reason, org_id, ' +
          'organization:org_id(display_name, public_id, website_url, domain)',
      )
      .eq('public_id', publicId)
      .is('deleted_at', null)
      .single();

    if (error || !data) return null;
    return normalizeAnchorRow(data as unknown as Record<string, unknown>);
  },
};

export function buildCredentialsCtdlRouter(lookup: CredentialsCtdlLookup = defaultCredentialsCtdlLookup): Router {
  const router = Router();

  router.get('/:publicId/ctdl', async (req, res) => {
    const publicId = req.params.publicId;
    if (!PUBLIC_ID_RE.test(publicId)) {
      logCtdlRequested({ req, publicId, outcome: 'invalid', httpStatus: 400 });
      res.status(400).json({ error: 'invalid_public_id' });
      return;
    }

    let anchor: CtdlAnchor | null = null;
    try {
      anchor = await lookup.lookupByPublicId(publicId);
      if (!anchor) {
        logCtdlRequested({ req, publicId, outcome: 'not_found', httpStatus: 404 });
        res.status(404).json({ error: 'not_found' });
        return;
      }

      const orgId = anchor.orgId ?? null;
      if (!isCtdlPublishableStatus(anchor.status)) {
        logCtdlRequested({
          req,
          publicId,
          outcome: 'not_publishable',
          httpStatus: 404,
          credentialStatus: anchor.status,
          credentialType: anchor.credentialType,
          orgId,
        });
        res.status(404).json({ error: 'not_found' });
        return;
      }

      const body = buildCtdlJsonLd(anchor, { verifyUrl: buildVerifyUrl(publicId) });
      const revoked = anchor.status === 'REVOKED';
      const httpStatus = revoked ? 410 : 200;
      logCtdlRequested({
        req,
        publicId,
        outcome: revoked ? 'revoked' : 'published',
        httpStatus,
        credentialStatus: anchor.status,
        credentialType: anchor.credentialType,
        orgId,
      });
      res.status(httpStatus).type('application/ld+json').json(body);
    } catch (error) {
      if (error instanceof CtdlPiiSafetyError) {
        // Fail closed: a transcript-like record tripped the learner-PII gate, so
        // we emit no public CTDL body. Surface a generic 404 (never leak that a
        // record exists or why it was withheld) and audit as safety_blocked.
        logCtdlRequested({
          req,
          publicId,
          outcome: 'safety_blocked',
          httpStatus: 404,
          credentialStatus: anchor?.status,
          credentialType: anchor?.credentialType,
          orgId: anchor?.orgId,
        });
        res.status(404).json({ error: 'not_found' });
        return;
      }
      logger.error({
        public_id: publicId,
        error: error instanceof Error ? error.message : String(error),
      }, 'Failed to build CTDL response');
      logCtdlRequested({ req, publicId, outcome: 'error', httpStatus: 500 });
      res.status(500).json({ error: 'internal_error' });
    }
  });

  return router;
}

export const credentialsCtdlRouter = buildCredentialsCtdlRouter();
