/**
 * GET /api/v1/credentials/ctdl/import?ctid=ce-<uuid>
 *
 * SCRUM-2913 — the CONSUMER that makes the CTDL importer demo-able. Given a CE
 * CTID, it fetches the PUBLIC Credential Engine Registry `/graph/<ctid>` record
 * and runs it through {@link parseCtdlEnvelope}, returning the bounded parsed
 * credential record(s). It works for ANY valid CTID — no demo CTID is baked in.
 *
 * This is a READ/consume path: it issues a GET-only Registry fetch and never
 * writes to the Registry. It does not persist anything; it returns the parsed
 * projection to the authenticated caller.
 *
 * SECURITY — this is an external-fetch endpoint, so it is SSRF-proof by
 * construction:
 *   - The client supplies ONLY a `ctid`, strictly validated against the anchored
 *     `REAL_CTID_PATTERN` (`^ce-<uuid>$`). Anything else → 400 before any fetch.
 *   - The fetch host is NEVER request-derived. The URL is built from the
 *     server-side registry base ({@link DEFAULT_REGISTRY_BASE_URL}, owned by the
 *     importer module) as `${base}/graph/${ctid}`. No URL, host, or base is ever
 *     accepted from the request.
 *   - Egress goes through {@link safeFetch}: scheme allow-list, resolve-and-pin
 *     the IP, reject private/link-local/metadata targets, cap the response body
 *     (5 MiB) before parsing, and — with `maxRedirects: 0` — refuse to auto-follow
 *     ANY redirect (so a 3xx to another host can never be chased).
 *   - An AbortController bounds the whole call to ~8 s.
 *
 * §1.6A discipline: the raw registry bytes are hashed (public-envelope
 * fingerprint — outside the §1.6 client-only boundary) and parsed, and are NEVER
 * logged, sent to Sentry, embedded in an Error message, or written to the audit
 * row. Only the fingerprint + bounded, already-PII-shaped importer records leave.
 *
 * R-7 claims guard (§1.13 / §1.5): the assembled response is passed through
 * {@link assertNoProhibitedClaimInJsonLd} before it is sent, so no measured field
 * can ship a Registry-listing / legal-sufficiency overclaim. `envelopeSignature
 * Verified` is a MEASURED technical fact about the envelope's own signature and
 * is emitted as `null` here (unchecked); it is NEVER rendered as CE endorsement
 * of Arkova.
 */

import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';

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
import {
  safeFetch,
  SafeFetchError,
  defaultSafeFetchDeps,
  type SafeFetchDeps,
} from '../../lib/safe-fetch.js';
import { db } from '../../utils/db.js';
import { getCorrelationId } from '../../utils/correlationId.js';
import { logger } from '../../utils/logger.js';

/** Response body byte cap enforced BEFORE parsing (belt to the 10k-node cap). */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Default wall-clock deadline for the whole outbound call. */
export const DEFAULT_REGISTRY_TIMEOUT_MS = 8_000;

export interface CredentialsCtdlImportRouterOptions {
  /** Injected SSRF-safe fetch deps (resolve + pinned dispatch). Defaults to prod. */
  deps?: SafeFetchDeps;
  /** Injected clock — threaded into the importer as `now` / `retrievedAt`. */
  now?: () => Date;
  /** Outbound wall-clock timeout in ms. Defaults to {@link DEFAULT_REGISTRY_TIMEOUT_MS}. */
  registryTimeoutMs?: number;
}

/**
 * Timeout sentinel so the handler can map an aborted fetch to 504 distinctly.
 * Exported (L3-A6) so the registry-anchor route reuses the SAME fetch/timeout
 * error identity instead of a second, near-duplicate class.
 */
export class RegistryTimeoutError extends Error {
  constructor() {
    super('CE registry fetch exceeded its deadline');
    this.name = 'RegistryTimeoutError';
  }
}

export type ImportOutcome =
  | 'invalid_ctid'
  | 'imported'
  | 'not_found'
  | 'unparseable'
  | 'too_large'
  | 'timeout'
  | 'bad_gateway'
  | 'claims_blocked'
  | 'error';

interface AuditArgs {
  req: Request;
  ctid: string | null;
  outcome: ImportOutcome;
  httpStatus: number;
  recordCount?: number;
}

function requestId(req: Request): string | null {
  const header = req.headers['x-request-id'] ?? req.headers['x-correlation-id'];
  if (typeof header === 'string') return header;
  return getCorrelationId() ?? null;
}

/**
 * Best-effort audit row. Carries ONLY the ctid, outcome, status and record
 * count — NEVER the raw registry bytes or any field lifted from them.
 */
function logImportRequested(args: AuditArgs): void {
  const payload = {
    event_type: 'ctdl.import.requested',
    event_category: 'VERIFICATION' as const,
    actor_id: args.req.authUserId ?? null,
    target_type: 'credential',
    target_id: args.ctid,
    org_id: null,
    details: JSON.stringify({
      outcome: args.outcome,
      http_status: args.httpStatus,
      record_count: args.recordCount ?? null,
      request_id: requestId(args.req),
    }),
  };
  try {
    // eslint-disable-next-line arkova/missing-org-filter -- insert-only audit write; no tenant read.
    void Promise.resolve(db.from('audit_events').insert(payload))
      .then(({ error }: { error: unknown }) => {
        if (error) throw error;
      })
      .catch((error: unknown) => {
        logger.warn(
          { outcome: args.outcome, http_status: args.httpStatus, error: errMessage(error) },
          'Failed to write CTDL import audit event',
        );
      });
  } catch (error) {
    logger.warn(
      { outcome: args.outcome, http_status: args.httpStatus, error: errMessage(error) },
      'Failed to write CTDL import audit event',
    );
  }
}

/** Value-free error message helper — never carries the fetched body. */
function errMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'unknown error';
}

/**
 * Build the registry graph URL from the SERVER-side base only. Exported
 * (L3-A6) so the registry-anchor route builds the identical URL shape without
 * a second implementation of the base-URL trim + path join.
 */
export function buildRegistryGraphUrl(ctid: string): string {
  const base = DEFAULT_REGISTRY_BASE_URL.replace(/\/+$/, '');
  return `${base}/graph/${ctid}`;
}

export interface RegistryFetchResult {
  status: number;
  text: string;
}

/**
 * Fetch the registry envelope with full SSRF protection and a hard wall-clock
 * deadline. `maxRedirects: 0` means any 3xx is refused (never chased to another
 * host). The body byte cap is enforced by safeFetch before we decode it.
 *
 * Exported (L3-A6): this IS the §1.6A-compliant safeFetch → discard path the
 * registry-anchor route reuses verbatim — a second outbound-fetch
 * implementation is exactly what §1.6A hardening exists to avoid duplicating.
 */
export async function fetchRegistryGraph(
  url: string,
  deps: SafeFetchDeps,
  timeoutMs: number,
): Promise<RegistryFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await safeFetch(
      url,
      { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal },
      deps,
      { maxRedirects: 0, maxResponseBytes: MAX_RESPONSE_BYTES, totalTimeoutMs: timeoutMs },
    );
    const buf = await res.arrayBuffer();
    return { status: res.status, text: Buffer.from(buf).toString('utf8') };
  } catch (error) {
    if (controller.signal.aborted) throw new RegistryTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function sendError(
  res: Response,
  args: Omit<AuditArgs, 'recordCount'>,
  errorCode: string,
): void {
  logImportRequested(args);
  res.status(args.httpStatus).json({ error: errorCode });
}

/**
 * Map a SafeFetchError code to an HTTP status + stable error code. Exported
 * (L3-A6) so the registry-anchor route maps the SAME safeFetch failure modes
 * to the SAME status/code pairs — no drift between the two consumers of
 * {@link fetchRegistryGraph}. `ImportOutcome` is this module's audit-outcome
 * union; the registry-anchor route ignores the `outcome` field it doesn't use.
 */
export function mapSafeFetchError(error: SafeFetchError): { status: number; code: string; outcome: ImportOutcome } {
  switch (error.code) {
    case 'response_too_large':
      return { status: 413, code: 'registry_record_too_large', outcome: 'too_large' };
    case 'deadline_exceeded':
      return { status: 504, code: 'registry_timeout', outcome: 'timeout' };
    default:
      // too_many_redirects / redirect_invalid / private_target / unresolvable /
      // scheme_not_allowed / invalid_url / request_failed — all upstream faults
      // for a fixed, server-built public URL.
      return { status: 502, code: 'registry_bad_gateway', outcome: 'bad_gateway' };
  }
}

export function buildCredentialsCtdlImportRouter(
  options: CredentialsCtdlImportRouterOptions = {},
): Router {
  const deps = options.deps ?? defaultSafeFetchDeps();
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.registryTimeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS;

  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    // Defensive auth guard — the mount also applies `requireAuth`, but never
    // let an external-fetch amplifier run for an unauthenticated caller.
    if (!req.authUserId) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    // STRICT ctid validation BEFORE any fetch. A single string only (reject
    // arrays / query-param pollution), matched against the anchored CTID
    // pattern. Anything carrying a host, path, `@`, `#`, `?`, or whitespace
    // fails here — the fetch host can never be steered by the input.
    const rawCtid = req.query.ctid;
    const ctid = typeof rawCtid === 'string' ? rawCtid : null;
    if (!ctid || !REAL_CTID_PATTERN.test(ctid)) {
      sendError(res, { req, ctid: null, outcome: 'invalid_ctid', httpStatus: 400 }, 'invalid_ctid');
      return;
    }

    const url = buildRegistryGraphUrl(ctid);

    let fetched: RegistryFetchResult;
    try {
      fetched = await fetchRegistryGraph(url, deps, timeoutMs);
    } catch (error) {
      if (error instanceof RegistryTimeoutError) {
        sendError(res, { req, ctid, outcome: 'timeout', httpStatus: 504 }, 'registry_timeout');
        return;
      }
      if (error instanceof SafeFetchError) {
        const mapped = mapSafeFetchError(error);
        sendError(res, { req, ctid, outcome: mapped.outcome, httpStatus: mapped.status }, mapped.code);
        return;
      }
      // Never log the fetched body (it does not exist yet here anyway).
      logger.error({ error: errMessage(error) }, 'CTDL import registry fetch failed');
      sendError(res, { req, ctid, outcome: 'error', httpStatus: 502 }, 'registry_bad_gateway');
      return;
    }

    // Registry HTTP status mapping (before we ever parse the body).
    if (fetched.status === 404) {
      sendError(res, { req, ctid, outcome: 'not_found', httpStatus: 404 }, 'registry_record_not_found');
      return;
    }
    if (fetched.status < 200 || fetched.status >= 300) {
      sendError(res, { req, ctid, outcome: 'bad_gateway', httpStatus: 502 }, 'registry_bad_gateway');
      return;
    }

    // Public-envelope fingerprint of the EXACT bytes consumed (§1.6A-allowed).
    const envelopeSha256 = createHash('sha256').update(fetched.text, 'utf8').digest('hex');
    const retrievedAt = now();

    let records: ImportedCtdlRecord[];
    try {
      records = parseCtdlEnvelope(fetched.text, {
        now: retrievedAt,
        retrievedAt,
        registryBaseUrl: DEFAULT_REGISTRY_BASE_URL,
        credentialNodesOnly: true,
        ceEnvelopeSignatureVerified: null,
      });
    } catch (error) {
      if (error instanceof CtdlImportError) {
        // Value-free by construction (invalid JSON / oversize node count) — the
        // message never carries the body. Node-count overflow also lands here.
        const tooManyNodes = error.message.includes(`${MAX_GRAPH_NODES}`);
        sendError(
          res,
          {
            req,
            ctid,
            outcome: tooManyNodes ? 'too_large' : 'unparseable',
            httpStatus: tooManyNodes ? 413 : 422,
          },
          tooManyNodes ? 'registry_record_too_large' : 'registry_record_unparseable',
        );
        return;
      }
      logger.error({ error: errMessage(error) }, 'CTDL import parse failed');
      sendError(res, { req, ctid, outcome: 'error', httpStatus: 500 }, 'internal_error');
      return;
    }

    const body = {
      ctid,
      registry: {
        retrievedAt: retrievedAt.toISOString(),
        envelopeSha256,
        // MEASURED, unchecked here — NEVER an endorsement of Arkova (R-7).
        envelopeSignatureVerified: null as boolean | null,
      },
      count: records.length,
      records,
    };

    // R-7 defense-in-depth: refuse to ship a body carrying a Registry-listing /
    // legal-sufficiency overclaim (e.g. from a hostile registry record's name).
    try {
      assertNoProhibitedClaimInJsonLd(body);
    } catch (error) {
      if (error instanceof ProhibitedClaimError) {
        sendError(res, { req, ctid, outcome: 'claims_blocked', httpStatus: 500 }, 'internal_error');
        return;
      }
      throw error;
    }

    logImportRequested({ req, ctid, outcome: 'imported', httpStatus: 200, recordCount: records.length });
    res.status(200).json(body);
  });

  return router;
}

export const credentialsCtdlImportRouter = buildCredentialsCtdlImportRouter();
