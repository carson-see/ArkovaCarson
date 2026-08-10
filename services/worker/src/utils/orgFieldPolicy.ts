/**
 * Org-scoped request-field policy — DPA Schedule 1 / clause 4.6.
 *
 * A data-processing agreement can permit a counterparty to send only a named
 * set of fields and oblige Arkova to reject prohibited ones INDEPENDENTLY of
 * that counterparty agreeing to stop sending them. This module is that
 * control: it reads `public.organization_field_policies` (migration 0405) and
 * refuses a request that carries a field the caller's organisation may not
 * send.
 *
 * Three properties are load-bearing:
 *
 *   1. DEFAULT PERMISSIVE. No row → no restriction. Applying 0405 changes
 *      behaviour for zero organisations; only an explicit operator INSERT
 *      turns enforcement on for one org.
 *
 *   2. REJECT, NEVER SILENTLY DROP. A dropped field is indistinguishable from
 *      a compliant client, which would leave the counterparty believing it is
 *      compliant while it keeps transmitting prohibited data — and would leave
 *      Arkova unable to show it enforced anything. Every hit is a 400.
 *
 *   3. THE VALUE NEVER LEAVES. Responses and logs carry field NAMES and JSON
 *      paths only. The rejected value is precisely the data we are refusing to
 *      accept; echoing it into a log line or an error body would defeat the
 *      point (§1.1: no Sentry/log events containing user content).
 *
 * WHY THE RAW BODY, NOT THE ZOD OUTPUT
 *   Both anchor schemas are `.strict()` today, so an unknown top-level key
 *   already 400s. That is a property of a schema someone may relax, not a
 *   guarantee. This guard walks the RAW request body so its correctness does
 *   not depend on another module staying strict, and so it sees fields nested
 *   inside `metadata` (which is `z.record(..., z.unknown())` and passes Zod
 *   untouched) and inside each element of a bulk `anchors` array.
 */

import type { Response } from 'express';
import { db } from './db.js';
import { logger } from './logger.js';

export const ORG_FIELD_POLICY_REJECTED_ERROR = 'field_not_permitted' as const;
export const ORG_FIELD_POLICY_UNAVAILABLE_ERROR = 'field_policy_unavailable' as const;

/**
 * Break-glass. Set to the literal string 'true' to suppress enforcement
 * process-wide. Only exists because the unavailable-policy path fails CLOSED
 * (see loadOrgFieldPolicy) and an operator needs a lever that does not require
 * a deploy. Engaging it VOIDS the contractual control — it logs at error level
 * every time it suppresses a check, and anything other than the exact string
 * 'true' leaves enforcement on, so a typo cannot quietly disable it.
 */
const BREAK_GLASS_ENV = 'DISABLE_ORG_FIELD_POLICY';

/** Fresh-cache TTL. Enforcement therefore begins within this window of an operator INSERT. */
const POLICY_TTL_MS = 60_000;
/**
 * How long a cached policy stays usable as a fallback when the table becomes
 * unreadable. Longer than the fresh TTL so a DB blip cannot quietly turn
 * enforcement off for an org we already know is configured.
 */
const POLICY_STALE_FALLBACK_MS = 60 * 60_000;
/** Crude bound on cache growth; orgs are bounded but the map should not be unbounded. */
const POLICY_CACHE_MAX_ENTRIES = 5_000;

/** Walk budget. Bulk is capped at 1000 shallow rows; `metadata` is arbitrary. */
const MAX_WALK_DEPTH = 12;
const MAX_WALK_NODES = 200_000;
/** Bound the response body: report enough to fix the integration, not a novel. */
const MAX_REPORTED_HITS = 20;
const MAX_REPORTED_PATH_CHARS = 200;

export interface OrgFieldPolicy {
  orgId: string;
  /** Normalized field names this org may not send. Empty ⇒ nothing to enforce. */
  disallowedFields: ReadonlySet<string>;
  reason: string | null;
  contractReference: string | null;
}

export interface ProhibitedFieldHit {
  /** JSON path of the offending key as the client sent it, e.g. `anchors.1.description`. */
  path: string;
  /** Normalized policy field name that matched. */
  field: string;
}

interface PolicyCacheEntry {
  policy: OrgFieldPolicy | null;
  fetchedAt: number;
}

type PolicyLoad =
  | { status: 'ok'; policy: OrgFieldPolicy | null }
  /** Table absent ⇒ 0405 is not deployed here ⇒ no org can have a policy. */
  | { status: 'not_deployed' }
  /** Deployed but unreadable, and no usable cached answer. */
  | { status: 'unavailable' };

const policyCache = new Map<string, PolicyCacheEntry>();

/** Test seam and operational lever: drop every cached policy. */
export function clearOrgFieldPolicyCache(): void {
  policyCache.clear();
}

/**
 * Fold a request key onto the form policy rows are stored in.
 *
 * Case and separator style are not meaningful distinctions in a JSON key here,
 * so `Description`, ` description ` and `Matter-Description` all fold onto the
 * stored `description` / `matter_description`. This is deliberately NOT a
 * fuzzy match: only case, surrounding whitespace and `-`/space separators are
 * folded, so `descriptor` stays distinct from `description`.
 */
export function normalizeFieldName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[-\s]+/g, '_');
}

/**
 * Every prohibited key present anywhere in `payload`.
 *
 * Presence is what matters, not the value: `description: null` still sends a
 * field the agreement does not permit. Objects and arrays are walked so that
 * neither `metadata.description` nor `anchors[3].description` is a way around
 * a top-level rule.
 *
 * `truncated` is returned rather than thrown, and callers MUST treat it as a
 * rejection: a payload too deep or too large to inspect is one we cannot
 * certify as compliant, and "we could not check" must never render as "it is
 * fine".
 */
export function findProhibitedFields(
  payload: unknown,
  disallowed: ReadonlySet<string>,
): { hits: ProhibitedFieldHit[]; truncated: boolean } {
  const hits: ProhibitedFieldHit[] = [];
  if (disallowed.size === 0) return { hits, truncated: false };

  let nodes = 0;
  let truncated = false;
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; path: string; depth: number }> = [
    { value: payload, path: '', depth: 0 },
  ];

  while (stack.length > 0) {
    const current = stack.pop() as { value: unknown; path: string; depth: number };
    const { value, path, depth } = current;
    if (value === null || typeof value !== 'object') continue;

    if (++nodes > MAX_WALK_NODES) {
      truncated = true;
      break;
    }
    if (depth >= MAX_WALK_DEPTH) {
      truncated = true;
      continue;
    }
    // Cyclic structures cannot come from JSON.parse, but this module must not
    // depend on its only caller being express.json().
    if (seen.has(value as object)) continue;
    seen.add(value as object);

    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        stack.push({ value: value[i], path: path ? `${path}.${i}` : String(i), depth: depth + 1 });
      }
      continue;
    }

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      const normalized = normalizeFieldName(key);
      if (disallowed.has(normalized)) {
        hits.push({ path: childPath.slice(0, MAX_REPORTED_PATH_CHARS), field: normalized });
      }
      stack.push({ value: child, path: childPath, depth: depth + 1 });
    }
  }

  // Deterministic order so the response is stable across runs.
  hits.sort((a, b) => a.path.localeCompare(b.path));
  return { hits, truncated };
}

interface PolicyRow {
  org_id?: string | null;
  disallowed_fields?: unknown;
  enabled?: boolean | null;
  policy_reason?: string | null;
  contract_reference?: string | null;
}

function toPolicy(orgId: string, row: PolicyRow | null): OrgFieldPolicy | null {
  if (!row) return null;
  if (row.enabled === false) return null;
  const raw = Array.isArray(row.disallowed_fields) ? row.disallowed_fields : [];
  const fields = new Set(
    raw
      .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
      .map(normalizeFieldName),
  );
  if (fields.size === 0) return null;
  return {
    orgId,
    disallowedFields: fields,
    reason: typeof row.policy_reason === 'string' ? row.policy_reason : null,
    contractReference: typeof row.contract_reference === 'string' ? row.contract_reference : null,
  };
}

/** PostgREST/Postgres codes meaning "this table does not exist here". */
function isTableMissing(code: string | null): boolean {
  // PGRST205: table not found in the schema cache. PGRST202/42P01: undefined table.
  return code === 'PGRST205' || code === 'PGRST202' || code === '42P01';
}

/**
 * Read (and cache) the policy for one org.
 *
 * Failure semantics, which are the interesting part:
 *
 *  - Table missing ⇒ 0405 is not deployed in this environment, so NO org can
 *    have a policy. Permissive, and cached briefly so a fresh environment does
 *    not re-probe on every request.
 *  - Read fails but we hold a recent answer ⇒ serve the stale one. A DB blip
 *    must not be a way to turn a contractual control off.
 *  - Read fails with nothing cached ⇒ `unavailable`, and the caller fails
 *    CLOSED. This is the deliberate trade: we cannot distinguish "this org has
 *    no policy" from "this org has a policy we cannot see", and accepting
 *    possibly-prohibited data is the worse error. The blast radius is small in
 *    practice because this read hits the same Postgres as the insert that
 *    follows it — if this read is failing, the write was about to fail anyway.
 */
async function loadOrgFieldPolicy(orgId: string): Promise<PolicyLoad> {
  const now = Date.now();
  const cached = policyCache.get(orgId);
  if (cached && now - cached.fetchedAt < POLICY_TTL_MS) {
    return { status: 'ok', policy: cached.policy };
  }

  let data: PolicyRow | null = null;
  let error: { code?: string | null; message?: string | null } | null;
  try {
    const result = await db
      .from('organization_field_policies')
      .select('org_id, disallowed_fields, enabled, policy_reason, contract_reference')
      .eq('org_id', orgId)
      .maybeSingle();
    data = (result.data ?? null) as PolicyRow | null;
    error = (result.error ?? null) as { code?: string | null; message?: string | null } | null;
  } catch (err) {
    // postgrest-js RESOLVES most failures, but a transport error still throws.
    error = { code: null, message: err instanceof Error ? err.name : 'unknown' };
  }

  if (error) {
    const code = error.code ?? null;
    if (isTableMissing(code)) {
      policyCache.set(orgId, { policy: null, fetchedAt: now });
      return { status: 'not_deployed' };
    }
    // Never log error.message — a PostgREST message can echo the offending
    // value back verbatim, and the offending value is the prohibited data.
    logger.error({ pgCode: code, orgId }, 'org_field_policy_read_failed');
    if (cached && now - cached.fetchedAt < POLICY_STALE_FALLBACK_MS) {
      logger.warn({ orgId }, 'org_field_policy_serving_stale_policy');
      return { status: 'ok', policy: cached.policy };
    }
    return { status: 'unavailable' };
  }

  const policy = toPolicy(orgId, data);
  if (policyCache.size >= POLICY_CACHE_MAX_ENTRIES) policyCache.clear();
  policyCache.set(orgId, { policy, fetchedAt: now });
  return { status: 'ok', policy };
}

function rejectionMessage(fields: string[]): string {
  const list = fields.map((f) => `"${f}"`).join(', ');
  return fields.length === 1
    ? `The field ${list} is not permitted for this organization and the request was rejected. Remove it and resend.`
    : `The fields ${list} are not permitted for this organization and the request was rejected. Remove them and resend.`;
}

/**
 * Enforce the caller org's field policy against a raw request body.
 *
 * Returns true when the caller may proceed. Returns false when a response has
 * already been written and the caller must return immediately — the same
 * contract as `ensureAnchorQuotaAvailable`.
 *
 * Call this AFTER Zod validation (so a malformed body still gets the normal
 * schema error) but BEFORE any duplicate lookup, quota consumption, credit
 * deduction or insert: a request carrying prohibited data must not reach a
 * dedup short-circuit that would answer 200, and must not spend the caller's
 * quota or credits.
 */
export async function enforceOrgFieldPolicy(params: {
  orgId: string | null;
  body: unknown;
  res: Response;
  /** Call-site label for logs, e.g. 'anchor-submit' / 'anchor-bulk'. */
  scope: string;
}): Promise<boolean> {
  const { orgId, body, res, scope } = params;
  if (!orgId) return true;

  if (process.env[BREAK_GLASS_ENV] === 'true') {
    logger.error(
      { orgId, scope },
      'org_field_policy_enforcement_disabled_by_break_glass — contractual field validation is NOT running',
    );
    return true;
  }

  const load = await loadOrgFieldPolicy(orgId);

  if (load.status === 'not_deployed') return true;

  if (load.status === 'unavailable') {
    logger.error({ orgId, scope }, 'org_field_policy_unavailable_failing_closed');
    res
      .status(503)
      .type('application/problem+json')
      .json({
        type: 'https://arkova.ai/errors/field-policy-unavailable',
        title: 'Field policy unavailable',
        status: 503,
        error: ORG_FIELD_POLICY_UNAVAILABLE_ERROR,
        message:
          'Could not confirm this organization\'s permitted-field policy. No record was created and no credits were consumed. Please retry.',
      });
    return false;
  }

  const policy = load.policy;
  if (!policy) return true;

  const { hits, truncated } = findProhibitedFields(body, policy.disallowedFields);

  if (truncated) {
    logger.warn({ orgId, scope }, 'org_field_policy_payload_not_inspectable');
    res
      .status(400)
      .type('application/problem+json')
      .json({
        type: 'https://arkova.ai/errors/field-not-permitted',
        title: 'Request could not be validated against the organization field policy',
        status: 400,
        error: ORG_FIELD_POLICY_REJECTED_ERROR,
        message:
          'This request is too deeply nested to validate against your organization\'s permitted-field policy, so it was rejected. Flatten the payload and resend.',
        details: [],
        ...(policy.reason ? { policy_reason: policy.reason } : {}),
        ...(policy.contractReference ? { contract_reference: policy.contractReference } : {}),
      });
    return false;
  }

  if (hits.length === 0) return true;

  const distinctFields = [...new Set(hits.map((h) => h.field))];
  // Field names and paths only — never a value (see module header).
  logger.warn(
    {
      orgId,
      scope,
      fields: distinctFields,
      occurrences: hits.length,
      contractReference: policy.contractReference,
    },
    'org_field_policy_rejected',
  );

  const reported = hits.slice(0, MAX_REPORTED_HITS);
  res
    .status(400)
    .type('application/problem+json')
    .json({
      type: 'https://arkova.ai/errors/field-not-permitted',
      title: 'Field not permitted for this organization',
      status: 400,
      error: ORG_FIELD_POLICY_REJECTED_ERROR,
      message: rejectionMessage(distinctFields),
      details: reported.map((hit) => ({
        path: hit.path,
        code: ORG_FIELD_POLICY_REJECTED_ERROR,
        message: `The field "${hit.field}" is not permitted for this organization.`,
      })),
      ...(hits.length > reported.length ? { truncated_details: hits.length - reported.length } : {}),
      ...(policy.reason ? { policy_reason: policy.reason } : {}),
      ...(policy.contractReference ? { contract_reference: policy.contractReference } : {}),
    });
  return false;
}
