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
 * actually QUEUED — via a literal (or a resolvable variable) passed to
 * `dispatchWebhookEvent(...)`, or a direct
 * `.from('webhook_delivery_logs' | 'webhook_events').insert(...)` carrying an
 * `event_type` field — and fails if any of them is missing from
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
 * REVIEW FOLLOW-UP (P2, same PR): the first cut of `extractDispatchLiterals`
 * assumed a non-literal `dispatchWebhookEvent` second argument was always
 * constrained by TypeScript to a registered union, so it silently contributed
 * NOTHING for a variable arg — including
 * `const eventType = 'new.unregistered'; dispatchWebhookEvent(orgId, eventType, id, payload);`,
 * a shape `dispatchWebhookEvent`'s actual signature (`eventType: string`) does
 * nothing to prevent. Worse, the extractor used a 400-char window regex after
 * each call site rather than parsing the call's actual argument list, so a
 * quoted event-looking string in the PAYLOAD (or in an unrelated adjacent call
 * within the window) could be misattributed as the dispatch argument.
 *
 * Fixed by making extraction syntax-aware: `extractDispatchArguments` parses
 * each `dispatchWebhookEvent(...)` call's own parenthesised argument list
 * (respecting nested parens/brackets/braces/strings, so multi-line calls and
 * adjacent calls/payloads can no longer bleed into each other) and reads its
 * own second argument, not a fixed-width window. A literal second argument is
 * taken directly. A bare-identifier second argument is resolved against
 * same-file `<ident> = 'literal'` assignments (the same technique
 * `extractDirectInsertLiterals` already used for the `event_type: someVar`
 * shape below) — this is what now catches the reported bug. An identifier
 * that cannot be resolved this way is either a documented, verified case in
 * `KNOWN_TYPE_NARROWED_DISPATCH_ARGS` (see that constant) or an explicit
 * FAILURE (`unresolvedArgs`), never a silent skip.
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
 * — or a dispatch argument that cannot be resolved to a literal and is not on
 * the verified narrowed-type allowlist — is a violation, not a skip.
 *
 * Usage: tsx scripts/ci/check-webhook-event-emission-registration.ts
 * Exit 0 = every emitted event type is registered. Exit 1 = an unregistered
 * emission, or an unresolved dispatch argument, was found.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** Matches a complete event id and nothing else — `family.event_name`. */
const EVENT_ID_RE = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;
const QUOTED_ID_RE = /(['"])([a-z][a-z_]*\.[a-z][a-z_]*)\1/g;
/** A bare identifier and nothing else — used to tell "variable" from "literal"
 * or some other expression (member access, ternary, template literal, call). */
const BARE_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
/** `name: Type` (optionally `name?: Type`) — a TS parameter's own shape, never
 * a real call argument (a bare call argument is an expression; the only way
 * an argument's OWN trimmed text starts with `identifier:` is a declaration's
 * parameter list, since a real object-literal argument would start with `{`).
 * Used to recognize `dispatchWebhookEvent(orgId: string, ...)` — an interface
 * method signature or the function's own declaration line — and skip it: it
 * is not a call site at all. */
const PARAM_SIGNATURE_RE = /^[A-Za-z_$][\w$]*\??\s*:\s*\S/;

/**
 * `test.ping` / `webhook.verification` — see the file header. Both are
 * synthetic, operator-triggered, non-subscribable system pings that never pass
 * through `dispatchWebhookEvent`. Add to this list ONLY for another such
 * out-of-band ping, never for a real customer event type — the fix for a real
 * one is to register a schema (or remove the emitter), not to widen this list.
 */
export const KNOWN_NON_SUBSCRIBABLE_EMISSIONS = ['test.ping', 'webhook.verification'] as const;

/**
 * `dispatchWebhookEvent` call sites whose event-type argument is a bare
 * identifier this scanner cannot resolve to a literal by same-file assignment,
 * because it flows in from a locally-declared, EXHAUSTIVE string-literal union
 * type declared in a sibling file — not a same-file literal assignment. Each
 * entry was verified BY HAND when added: every member of the named union type
 * is present in `PAYLOAD_SCHEMAS_BY_EVENT_TYPE`.
 * `check-webhook-event-emission-registration.test.ts`'s "known narrowed-type
 * allowlist stays honest" suite re-reads each union type straight out of its
 * declaring file on every run and re-verifies every member is still
 * registered, so this allowlist cannot silently go stale even though the
 * scanner itself cannot see the type system.
 *
 * Add an entry here ONLY when you have personally confirmed the identifier's
 * declared type is a closed string-literal union and every member is
 * registered — never as a way to make an unresolved-argument failure go away
 * without doing that check. If `dispatchWebhookEvent` is ever called with a
 * genuinely unconstrained `string`, remove the file from this list rather than
 * add to it.
 */
export const KNOWN_TYPE_NARROWED_DISPATCH_ARGS = [
  {
    file: 'services/worker/src/api/v1/folders-deps.ts',
    identifier: 'eventType',
    unionFile: 'services/worker/src/api/v1/folders.ts',
    unionType: 'FolderEventType',
  },
  {
    file: 'services/worker/src/webhooks/subOrgEvents.ts',
    identifier: 'eventType',
    unionFile: 'services/worker/src/webhooks/subOrgEvents.ts',
    unionType: 'SubOrgEventType',
  },
] as const;

const QUEUE_TABLE_NAMES = ['webhook_delivery_logs', 'webhook_events'] as const;

/** Drop `//` line comments and `/* *\/` blocks before extracting ids — mirrors
 * `check-webhook-event-registration-drift.ts`'s `stripComments`. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Advances past a string/template literal starting at `quote` (index `start`
 * holds the opening quote character), honoring backslash escapes. Returns the
 * index of the closing quote (or the last index of `source` if unterminated). */
function skipStringLiteral(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i;
    i++;
  }
  return source.length - 1;
}

/** Finds the index of the `)` matching the `(` at `openIndex`, honoring
 * nested parens/brackets/braces and skipping over string/template literals so
 * a `)` or `,` inside a string can never be mistaken for structural syntax. */
function findMatchingParen(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipStringLiteral(source, i, c);
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits a call's argument-list text on top-level commas only — commas
 * nested inside `()`/`[]`/`{}` or inside a string/template literal do not
 * split. */
function splitTopLevelArgs(argsSource: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < argsSource.length; i++) {
    const c = argsSource[i];
    if (c === '"' || c === "'" || c === '`') {
      const start = i;
      i = skipStringLiteral(argsSource, i, c);
      current += argsSource.slice(start, i + 1);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      args.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim().length > 0) args.push(current);
  return args;
}

/** Resolves a bare identifier back to every string literal it is directly
 * assigned in the same (already comment-stripped) file — `ident = 'literal'`
 * (not `==`/`===`), covering both a single assignment and the
 * conditionally-reassigned-in-a-branch shape `attestationExpiry.ts` used to
 * have. */
function resolveIdentifierLiterals(identifier: string, cleanSource: string): string[] {
  const ids = new Set<string>();
  const assignRe = new RegExp(`\\b${identifier}\\s*=(?!=)\\s*(['"])([a-z][a-z_]*\\.[a-z][a-z_]*)\\1`, 'g');
  let m: RegExpExecArray | null;
  while ((m = assignRe.exec(cleanSource))) ids.add(m[2]);
  return [...ids];
}

export interface DispatchArgumentResult {
  eventTypes: string[];
  /** One entry per second-argument expression that was neither a literal nor
   * resolvable to one, and is not on `KNOWN_TYPE_NARROWED_DISPATCH_ARGS`. */
  unresolved: string[];
}

/**
 * Syntax-aware extraction of `dispatchWebhookEvent`'s own second argument
 * from every call site in `source` (whose file is `relFile`, used only to
 * check `KNOWN_TYPE_NARROWED_DISPATCH_ARGS`). Replaces the old fixed-width
 * window regex: it parses each call's actual argument list, so a literal in
 * the payload argument or in an adjacent call can no longer be misattributed.
 */
export function extractDispatchArguments(source: string, relFile = ''): DispatchArgumentResult {
  const clean = stripComments(source);
  const eventTypes = new Set<string>();
  const unresolved: string[] = [];
  const CALL_RE = /\bdispatchWebhookEvent\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(clean))) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = findMatchingParen(clean, openParen);
    if (closeParen === -1) {
      unresolved.push(`${relFile}: unterminated dispatchWebhookEvent(...) call`);
      continue;
    }
    const args = splitTopLevelArgs(clean.slice(openParen + 1, closeParen));
    if (args.some((a) => PARAM_SIGNATURE_RE.test(a.trim()))) {
      // Not a call — an interface method signature or the function's own
      // declaration line (e.g. `dispatchWebhookEvent(orgId: string, ...)`).
      continue;
    }
    const secondArg = args[1]?.trim();
    if (!secondArg) {
      unresolved.push(`${relFile}: dispatchWebhookEvent(...) call has no second argument`);
      continue;
    }

    const literalMatch = /^(['"])([a-z][a-z_]*\.[a-z][a-z_]*)\1$/.exec(secondArg);
    if (literalMatch) {
      eventTypes.add(literalMatch[2]);
      continue;
    }

    if (BARE_IDENTIFIER_RE.test(secondArg)) {
      const resolved = resolveIdentifierLiterals(secondArg, clean);
      if (resolved.length > 0) {
        for (const id of resolved) eventTypes.add(id);
        continue;
      }
      const known = KNOWN_TYPE_NARROWED_DISPATCH_ARGS.some(
        (entry) => entry.file === relFile && entry.identifier === secondArg,
      );
      if (known) continue;
      unresolved.push(
        `${relFile}: dispatchWebhookEvent(...) second argument \`${secondArg}\` is a variable with no ` +
          'same-file literal assignment and is not in KNOWN_TYPE_NARROWED_DISPATCH_ARGS',
      );
      continue;
    }

    // Some other expression shape (member access, ternary, template literal,
    // function call, ...) — fail closed rather than guess.
    unresolved.push(
      `${relFile}: dispatchWebhookEvent(...) second argument \`${secondArg}\` is not a literal or a plain ` +
        'identifier this scanner can resolve',
    );
  }
  return { eventTypes: [...eventTypes], unresolved };
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
    for (const id of resolveIdentifierLiterals(ident, clean)) ids.add(id);
  }
  return [...ids];
}

export interface EmissionSource {
  /** Path relative to repo root, forward-slashed, for reporting. */
  file: string;
  eventTypes: string[];
}

/** Every id emitted by a single file, from both extraction strategies, minus
 * the deliberate non-subscribable-ping exclusions. Also returns any
 * unresolved `dispatchWebhookEvent` argument found in the file. */
export function extractFileEmissions(file: string, source: string): EmissionSource & { unresolved: string[] } {
  const excluded = new Set<string>(KNOWN_NON_SUBSCRIBABLE_EMISSIONS);
  const dispatch = extractDispatchArguments(source, file);
  const ids = new Set<string>([...dispatch.eventTypes, ...extractDirectInsertLiterals(source)]);
  for (const excludedId of excluded) ids.delete(excludedId);
  return {
    file,
    eventTypes: [...ids].filter((id) => EVENT_ID_RE.test(id)),
    unresolved: dispatch.unresolved,
  };
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
  /** Per-call-site dispatch arguments that could not be resolved to a literal
   * and are not on the verified narrowed-type allowlist. Non-empty means the
   * scan itself must fail closed, same as `unresolved`. */
  unresolvedArgs: string[];
}

const WORKER_SRC = 'services/worker/src';

export function scanWorkerEmissions(root = ROOT): EmissionScanResult {
  const dir = resolve(root, WORKER_SRC);
  let files: string[];
  try {
    files = listTsFiles(dir);
  } catch {
    return { sources: [], unresolved: `${WORKER_SRC} could not be read`, unresolvedArgs: [] };
  }
  if (files.length === 0) {
    return { sources: [], unresolved: `${WORKER_SRC} contained no .ts files`, unresolvedArgs: [] };
  }
  const unresolvedArgs: string[] = [];
  const sources = files
    .map((full) => {
      const rel = relative(root, full).split('\\').join('/');
      const source = readFileSync(full, 'utf-8');
      const emission = extractFileEmissions(rel, source);
      unresolvedArgs.push(...emission.unresolved);
      return { file: emission.file, eventTypes: emission.eventTypes };
    })
    .filter((s) => s.eventTypes.length > 0);
  return { sources, unresolvedArgs };
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

/**
 * Reads a `type <name> = 'a.b' | 'c.d' | ...;` string-literal union straight
 * out of `file`, for the "known narrowed-type allowlist stays honest" test —
 * NOT used by the runtime scan (which never sees the type system). Returns
 * `undefined` if the declaration can't be found.
 */
export function readStringLiteralUnion(file: string, typeName: string, root = ROOT): string[] | undefined {
  let content: string;
  try {
    content = readFileSync(resolve(root, file), 'utf-8');
  } catch {
    return undefined;
  }
  const clean = stripComments(content);
  const declRe = new RegExp(`type\\s+${typeName}\\s*=([^;]+);`);
  const match = declRe.exec(clean);
  if (!match) return undefined;
  const ids = new Set<string>();
  const idRe = new RegExp(QUOTED_ID_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(match[1]))) ids.add(m[2]);
  return ids.size > 0 ? [...ids] : undefined;
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
  if (scan.unresolvedArgs.length > 0) {
    return { violations: [], unresolved: scan.unresolvedArgs.join('; ') };
  }

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
