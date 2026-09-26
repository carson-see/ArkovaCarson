#!/usr/bin/env tsx
/**
 * CI guard: webhook event EMISSION registration detector.
 *
 * WHY THIS EXISTS
 *
 * `check-webhook-event-registration-drift.ts` treats `PAYLOAD_SCHEMAS_BY_EVENT_TYPE`
 * in `services/worker/src/webhooks/payload-schemas.ts` as ground truth and verifies
 * every OTHER surface mirrors its keys. That check has a blind spot: it cannot
 * notice a worker code path that queues an event type the map has never heard of,
 * because from the map's point of view there is nothing to compare against — the
 * id simply does not exist anywhere it looks.
 *
 * This is the other half. It scans `services/worker/src` for event types that are
 * actually QUEUED — via a literal passed to `dispatchWebhookEvent(...)`, or a
 * direct `.from('webhook_delivery_logs' | 'webhook_events').insert(...)` carrying
 * an `event_type` field — and fails if any of them is missing from
 * `PAYLOAD_SCHEMAS_BY_EVENT_TYPE`. A type queued but unregistered is dispatch-dead
 * in two different ways depending on the path:
 *
 *   - `dispatchWebhookEvent(orgId, 'x.y', ...)` with an unregistered id is
 *     unreachable at the CRUD layer (no org can subscribe — `VALID_WEBHOOK_EVENTS`
 *     is `Object.keys(PAYLOAD_SCHEMAS_BY_EVENT_TYPE)`) and, unless the id happens to
 *     be on the shrinking `LEGACY_UNREGISTERED_EVENT_TYPES` ratchet, is refused
 *     outright by `validateWebhookPayload`'s fail-closed branch.
 *   - a direct `.from('webhook_delivery_logs' | 'webhook_events').insert(...)`
 *     bypasses `dispatchWebhookEvent` — and therefore `validateWebhookPayload` —
 *     entirely. The row is written unchecked, and if the destination table has no
 *     consumer at all, the write is a permanent no-op the moment it lands.
 *
 * THE BUG THIS WOULD HAVE CAUGHT
 *
 * Four event types shipped this way with a live producer and no registration:
 * `attestation.expiring` / `attestation.expired` (`jobs/attestationExpiry.ts`,
 * inserting into a `webhook_events` table that does not exist anywhere in
 * `supabase/migrations` or the generated `database.types.ts` — every insert
 * failed at runtime, and for `attestation.expired` the failure additionally
 * blocked the attestation's own `EXPIRED` status transition, because the code
 * only flips status after a successful webhook insert) and
 * `compliance.certificate_expired` / `compliance.score_degraded`
 * (`signatures/compliance/complianceEvents.ts`, a fully orphaned duplicate of the
 * real, cron-callable `webhooks/compliance.ts` — zero production importers,
 * confirmed by grep — that wrote unvalidated rows straight into
 * `webhook_delivery_logs`). All four were removed as dead/unreachable code in the
 * same change that adds this guard; `check-webhook-event-emission-registration.test.ts`
 * pins the detection mechanism against a synthetic fixture reproducing the exact
 * pattern, so the guard's own test does not depend on the buggy code staying in
 * the tree to keep passing.
 *
 * DELIBERATE EXCLUSIONS
 *
 * `test.ping` and `webhook.verification` are real literal `event_type` values
 * written into `webhook_delivery_logs` (`api/v1/webhooks.ts`,
 * `api/v1/webhooks-self-service.ts`) but are NOT customer business events: they
 * are operator/system-triggered synthetic pings sent by a direct `fetch()` call,
 * never routed through `dispatchWebhookEvent`/`validateWebhookPayload`, and never
 * accepted as a subscribable `events` value (absent from `VALID_WEBHOOK_EVENTS`).
 * Their payload shape is fixed and fully internally controlled, so schema
 * validation has nothing to protect against. They are listed explicitly in
 * `KNOWN_NON_SUBSCRIBABLE_EMISSIONS` rather than silently absorbed by a looser
 * pattern — same ratchet discipline as `LEGACY_UNREGISTERED_EVENT_TYPES` in
 * `payload-schemas.ts`: a small, explicit, comment-justified list that a future
 * addition must edit deliberately, not one a scan can grow into on its own.
 *
 * FAIL CLOSED, same as the sibling script: a source region that cannot be located
 * is a violation, not a skip.
 *
 * Usage: tsx scripts/ci/check-webhook-event-emission-registration.ts
 * Exit 0 = every emitted event type is registered. Exit 1 = an unregistered
 * emission was found.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** Matches a complete event id and nothing else — `family.event_name`. */
const EVENT_ID_RE = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;
const QUOTED_ID_RE = /(['"])([a-z][a-z_]*\.[a-z][a-z_]*)\1/g;

/**
 * `test.ping` / `webhook.verification` — see the file header. Both are
 * synthetic, operator-triggered, non-subscribable system pings that never pass
 * through `dispatchWebhookEvent`. Add to this list ONLY for another such
 * out-of-band ping, never for a real customer event type — the fix for a real
 * one is to register a schema (or remove the emitter), not to widen this list.
 */
export const KNOWN_NON_SUBSCRIBABLE_EMISSIONS = ['test.ping', 'webhook.verification'] as const;

const QUEUE_TABLE_NAMES = ['webhook_delivery_logs', 'webhook_events'] as const;

/** Drop `//` line comments and `/* *\/` blocks before extracting ids — mirrors
 * `check-webhook-event-registration-drift.ts`'s `stripComments`. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Literal event-type ids passed as `dispatchWebhookEvent`'s own second
 * argument. Scans a bounded window after each call so multi-line calls are
 * covered; a call whose event-type argument is a variable (already
 * type-constrained to a registered `WebhookEventType`-derived union by
 * TypeScript) contributes nothing, which is correct — this guard's job is
 * literal STRINGS that bypass that compile-time guarantee.
 */
export function extractDispatchLiterals(source: string): string[] {
  const clean = stripComments(source);
  const ids = new Set<string>();
  const CALL_RE = /dispatchWebhookEvent\(/g;
  const WINDOW = 400;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(clean))) {
    const window = clean.slice(m.index, m.index + WINDOW);
    QUOTED_ID_RE.lastIndex = 0;
    const lit = QUOTED_ID_RE.exec(window);
    if (lit) ids.add(lit[2]);
  }
  return [...ids];
}

/**
 * Event types queued via a direct insert into one of `QUEUE_TABLE_NAMES`,
 * bypassing `dispatchWebhookEvent` entirely. File-scoped (not call-windowed):
 * the two known real producers of this shape build the row's `event_type`
 * field far from the `.from(...)` call (a bulk-insert array built earlier in
 * the function, or a value assigned to a local variable a few lines above the
 * object literal), so a narrow per-call window would miss exactly the pattern
 * this guard exists to catch.
 *
 * Handles both:
 *   `event_type: 'literal.id'`               — direct literal
 *   `event_type: someVar` + `someVar = 'literal.id'` elsewhere in the file —
 *     resolves the identifier back to every literal it is assigned in the
 *     same file (covers `attestationExpiry.ts`'s `eventType` pattern).
 *
 * Returns [] for a file that never touches a queue table, so an unrelated
 * `event_type: identifier` elsewhere (e.g. re-projecting an existing DB row,
 * or an audit-log call with an unrelated identifier) can only ever contribute
 * an id if the SAME file also writes to one of the queue tables — narrowing,
 * not widening, the surface a resolvable identifier can pull from.
 */
export function extractDirectInsertLiterals(source: string): string[] {
  const clean = stripComments(source);
  const touchesQueueTable = QUEUE_TABLE_NAMES.some((t) =>
    new RegExp(`\\.from\\(\\s*(['"])${t}\\1\\s*\\)`).test(clean),
  );
  if (!touchesQueueTable) return [];

  const ids = new Set<string>();
  const identifiers = new Set<string>();
  const FIELD_RE = /\bevent_type\s*:\s*(?:(['"])([a-z][a-z_]*\.[a-z][a-z_]*)\1|([A-Za-z_$][\w$]*))/g;
  let m: RegExpExecArray | null;
  while ((m = FIELD_RE.exec(clean))) {
    if (m[2]) ids.add(m[2]);
    else if (m[3]) identifiers.add(m[3]);
  }
  for (const ident of identifiers) {
    const assignRe = new RegExp(`\\b${ident}\\s*=\\s*(['"])([a-z][a-z_]*\\.[a-z][a-z_]*)\\1`, 'g');
    let am: RegExpExecArray | null;
    while ((am = assignRe.exec(clean))) ids.add(am[2]);
  }
  return [...ids];
}

export interface EmissionSource {
  /** Path relative to repo root, forward-slashed, for reporting. */
  file: string;
  eventTypes: string[];
}

/** Every id emitted by a single file, from both extraction strategies, minus
 * the deliberate non-subscribable-ping exclusions. */
export function extractFileEmissions(file: string, source: string): EmissionSource {
  const excluded = new Set<string>(KNOWN_NON_SUBSCRIBABLE_EMISSIONS);
  const ids = new Set<string>([
    ...extractDispatchLiterals(source),
    ...extractDirectInsertLiterals(source),
  ]);
  for (const excludedId of excluded) ids.delete(excludedId);
  return { file, eventTypes: [...ids].filter((id) => EVENT_ID_RE.test(id)) };
}

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      listTsFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

export interface EmissionScanResult {
  sources: EmissionSource[];
  /** Set when the worker source directory could not be located at all. */
  unresolved?: string;
}

const WORKER_SRC = 'services/worker/src';

export function scanWorkerEmissions(root = ROOT): EmissionScanResult {
  const dir = resolve(root, WORKER_SRC);
  let files: string[];
  try {
    files = listTsFiles(dir);
  } catch {
    return { sources: [], unresolved: `${WORKER_SRC} could not be read` };
  }
  if (files.length === 0) {
    return { sources: [], unresolved: `${WORKER_SRC} contained no .ts files` };
  }
  const sources = files
    .map((full) => {
      const rel = relative(root, full).split('\\').join('/');
      const source = readFileSync(full, 'utf-8');
      return extractFileEmissions(rel, source);
    })
    .filter((s) => s.eventTypes.length > 0);
  return { sources };
}

/** The canonical registered set: `PAYLOAD_SCHEMAS_BY_EVENT_TYPE` keys. Same
 * region/extraction the sibling drift script uses for its own canonical read. */
const CANONICAL_FILE = 'services/worker/src/webhooks/payload-schemas.ts';
const CANONICAL_REGION = /PAYLOAD_SCHEMAS_BY_EVENT_TYPE\s*=\s*\{([\s\S]*?)\n\}\s*as\s*const/;

export interface CanonicalReading {
  ids: string[];
  unresolved?: string;
}

export function readCanonicalEventTypes(root = ROOT): CanonicalReading {
  let content: string;
  try {
    content = readFileSync(resolve(root, CANONICAL_FILE), 'utf-8');
  } catch {
    return { ids: [], unresolved: `${CANONICAL_FILE} could not be read` };
  }
  const match = CANONICAL_REGION.exec(content);
  if (!match?.[1]) {
    return { ids: [], unresolved: `${CANONICAL_FILE}: PAYLOAD_SCHEMAS_BY_EVENT_TYPE declaration not found` };
  }
  const clean = stripComments(match[1]);
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  const idRe = new RegExp(QUOTED_ID_RE.source, 'g');
  while ((m = idRe.exec(clean))) ids.add(m[2]);
  if (ids.size === 0) {
    return { ids: [], unresolved: `${CANONICAL_FILE}: declaration found but no event ids parsed out of it` };
  }
  return { ids: [...ids] };
}

export interface EmissionViolation {
  file: string;
  /** Emitted event types this file queues that are absent from the canonical map. */
  unregistered: string[];
}

/** Pure comparison — testable without touching the filesystem. */
export function collectEmissionViolations(params: {
  canonical: CanonicalReading;
  scan: EmissionScanResult;
}): { violations: EmissionViolation[]; unresolved?: string } {
  const { canonical, scan } = params;
  if (canonical.unresolved) return { violations: [], unresolved: canonical.unresolved };
  if (scan.unresolved) return { violations: [], unresolved: scan.unresolved };

  const canonicalSet = new Set(canonical.ids);
  const violations: EmissionViolation[] = [];
  for (const source of scan.sources) {
    const unregistered = source.eventTypes.filter((id) => !canonicalSet.has(id));
    if (unregistered.length > 0) violations.push({ file: source.file, unregistered });
  }
  return { violations };
}

export function checkWebhookEventEmissionRegistration(root = ROOT): number {
  const canonical = readCanonicalEventTypes(root);
  const scan = scanWorkerEmissions(root);
  const { violations, unresolved } = collectEmissionViolations({ canonical, scan });

  if (unresolved) {
    console.error(`Could not verify webhook event emission registration: ${unresolved}`);
    return 1;
  }

  if (violations.length === 0) {
    console.log(
      `No unregistered webhook event emissions found (${canonical.ids.length} registered event types; ` +
        `${scan.sources.length} file(s) in ${WORKER_SRC} emit a registered event type).`,
    );
    return 0;
  }

  for (const v of violations) {
    console.error(`\nUNREGISTERED EMISSION in ${v.file}:`);
    console.error(`  Queues: ${v.unregistered.join(', ')}`);
  }
  console.error(
    `\n${violations.length} file(s) queue an event type absent from PAYLOAD_SCHEMAS_BY_EVENT_TYPE.`,
  );
  console.error(
    'Fix: either register a .strict() schema for the event type in services/worker/src/webhooks/payload-schemas.ts',
  );
  console.error(
    '(and update the six mirror surfaces — see check-webhook-event-registration-drift.ts), or remove the',
  );
  console.error('emitter entirely if the event type is dead/unreachable. Do not leave an emitter that cannot deliver.');
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(checkWebhookEventEmissionRegistration());
}
