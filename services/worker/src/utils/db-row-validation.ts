/**
 * Validation helpers for data read back OUT of Postgres (BUG-2026-08-12-003 / FD-15).
 *
 * Two distinct defects motivated this module, and they are worth keeping apart:
 *
 * 1. **Over-validation of DB-sourced identifiers.** Zod 4.x's `z.string().uuid()`
 *    is a strict RFC-9562 check: it rejects any UUID whose version nibble is not
 *    1-8 or whose variant nibble is not 8/9/a/b. Postgres `uuid` is *looser* than
 *    that — it accepts and stores any 128-bit value, zero nibbles included. So a
 *    `uuid` column can legitimately hold values the application then refuses to
 *    read. Re-validating a value the database already typed as `uuid` with a
 *    STRICTER rule than the database enforces cannot add safety; it can only
 *    cause false rejection of data we ourselves stored. Use {@link dbUuid} for
 *    those reads.
 *
 *    This is not a new convention — it is the one already used for owner-key
 *    validation in `billing/entitlements.ts`, `api/audit-event.ts`,
 *    `api/admin-org-members.ts` and `api/invitations.ts`. This module gives the
 *    duplicated `UUID_RE` literal a single home.
 *
 *    **This helper is for DB-sourced values only.** External input — request
 *    bodies, query strings, URL params, webhook payloads, OAuth callbacks — must
 *    keep strict `z.string().uuid()`. There the strictness IS the security
 *    boundary, and nothing upstream has already guaranteed the shape.
 *
 * 2. **Whole-batch parse blast radius.** `z.array(RowSchema).safeParse(rows)` is
 *    all-or-nothing: one malformed row fails the array, and every other row in
 *    the batch is denied service. That is how a single bad fixture UUID took
 *    `org-queue-scheduler` to INTERNAL on every run for an entire soak — every
 *    due organization was starved by one unrelated value. {@link parseDbRows}
 *    replaces that with per-row parsing: bad rows are quarantined and logged
 *    loudly, good rows proceed.
 */
import { z } from 'zod';

/**
 * Format-only UUID matcher (8-4-4-4-12 hex), case-insensitive.
 *
 * This is exactly the set Postgres emits: whatever input form a `uuid` value was
 * written in (braced, unhyphenated, mixed case), Postgres always renders it back
 * as canonical lowercase 8-4-4-4-12. Validating that shape therefore accepts
 * everything a `uuid` column can hand us and still fails closed on a genuinely
 * malformed string — which is the whole point of keeping a check at all.
 */
export const DB_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Zod schema for a UUID read back from a Postgres `uuid` column.
 *
 * Shape-only by design — see the module header. Do NOT use this for external
 * input; use `z.string().uuid()` there.
 *
 * @param field name used in the failure message, for diagnosability only.
 */
export function dbUuid(field = 'value'): z.ZodString {
  return z.string().regex(DB_UUID_RE, `${field} must be a UUID`);
}

/** Minimal logger shape needed to report quarantined rows. */
export interface RowQuarantineLogger {
  error: (...args: unknown[]) => void;
}

export interface ParsedDbRows<T> {
  /** Rows that validated. */
  rows: T[];
  /** How many rows were dropped. Non-zero is always worth alerting on. */
  quarantined: number;
}

/**
 * Render a ZodError as a diagnosable, PII-safe string.
 *
 * Deliberately emits issue PATHS and MESSAGES only, never the offending value.
 * DB rows routinely carry user-scoped data, and this string is written to logs
 * (CLAUDE.md §1.4 / §1.6A: no PII, document bytes or secrets in logs or Sentry).
 * Zod's built-in messages describe the expectation ("expected string, received
 * number"), not the input, so they are safe to pass through.
 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    })
    .join('; ');
}

/**
 * Parse an array of database rows one row at a time.
 *
 * A row that fails validation is quarantined — dropped from the result and
 * logged at `error` — instead of failing the whole batch. This is the FD-15 fix:
 * one malformed value must not deny service to every other row in the pass.
 *
 * A non-array `input` is a different failure entirely: the query contract itself
 * is wrong, there is nothing to salvage per-row, and silently returning zero
 * rows would hide it. That still throws.
 *
 * Callers should surface `quarantined` in their result/metrics — quarantining is
 * a degraded mode, and it must be visible rather than silently absorbed.
 */
export function parseDbRows<T>(
  schema: z.ZodType<T>,
  input: unknown,
  opts: { source: string; logger: RowQuarantineLogger },
): ParsedDbRows<T> {
  if (input == null) return { rows: [], quarantined: 0 };

  if (!Array.isArray(input)) {
    throw new Error(
      `${opts.source} returned an unusable payload: expected an array of rows, received ${
        input === null ? 'null' : typeof input
      }`,
    );
  }

  const rows: T[] = [];
  let quarantined = 0;

  for (let index = 0; index < input.length; index += 1) {
    const parsed = schema.safeParse(input[index]);
    if (parsed.success) {
      rows.push(parsed.data);
      continue;
    }
    quarantined += 1;
    opts.logger.error(
      {
        source: opts.source,
        rowIndex: index,
        issues: describeIssues(parsed.error),
      },
      `${opts.source}: quarantined a malformed row — skipping it and continuing with the rest of the batch`,
    );
  }

  if (quarantined > 0) {
    opts.logger.error(
      { source: opts.source, quarantined, accepted: rows.length, total: input.length },
      `${opts.source}: ${quarantined} of ${input.length} rows failed validation and were quarantined`,
    );
  }

  return { rows, quarantined };
}
