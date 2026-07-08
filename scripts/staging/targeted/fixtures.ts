/**
 * scripts/staging/targeted/fixtures.ts
 *
 * Row builders + an injectable executor for the minimal, clearly-synthetic
 * fixtures a targeted driver must seed to force a specific changed branch.
 *
 * These are PURE builders (no DB import) so they unit-test in CI without a
 * Postgres, mirroring seed-baseline-fixture.test.ts's structural-contract style.
 * A driver wires them to a real service-role Supabase client via `makeDbExecutor`
 * only at run time against the PR's ISOLATED rig.
 *
 * §1.11A / seed.ts safety invariants preserved:
 *   - every email @staging.invalid.test (RFC 2606 reserved TLD)
 *   - every URL http://localhost (cannot resolve outside the host — SSRF-safe)
 *   - every fingerprint / id is random bytes — no real PII
 *   - every fixture is tagged `TSOAK-` so it is trivially greppable + reversible
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

/** Prefix stamped on every synthetic public_id / name / event_id we create. */
export const FIXTURE_TAG = 'TSOAK-';

/** True when a value carries the targeted-soak fixture tag. */
export function isSyntheticFixture(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.includes(FIXTURE_TAG);
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function taggedId(kind: string): string {
  return `${FIXTURE_TAG}${kind}-${hex(6)}`;
}

// ─── #1439: SECURED-but-unbatched anchor (NO_BATCH_PROOF branch) ────────────

export interface AnchorFixtureArgs {
  orgId: string;
  userId: string;
}

export interface SecuredUnbatchedAnchorRow {
  public_id: string;
  fingerprint: string;
  filename: string;
  status: 'SECURED';
  chain_tx_id: string;
  chain_block_height: number;
  chain_timestamp: string;
  org_id: string;
  user_id: string;
  metadata: Record<string, unknown>;
}

/**
 * A SECURED anchor that carries an on-chain receipt but has NO `anchor_proofs`
 * row and NO merkle metadata. GET /verify/:public_id/proof therefore resolves
 * the record (not 404 RECORD_NOT_FOUND) and then falls through to the
 * "no batch proof" branch (#1439's NO_BATCH_PROOF). The driver deliberately
 * does NOT insert an anchor_proofs row for this anchor.
 */
export function buildSecuredUnbatchedAnchor(args: AnchorFixtureArgs): SecuredUnbatchedAnchorRow {
  return {
    public_id: taggedId('ANC'),
    fingerprint: hex(32), // 64-hex — anchors_fingerprint_format CHECK
    filename: 'tsoak-unbatched.pdf',
    status: 'SECURED',
    chain_tx_id: hex(32),
    chain_block_height: 800_000,
    chain_timestamp: new Date().toISOString(),
    org_id: args.orgId,
    user_id: args.userId,
    metadata: { source: 'targeted-soak-driver', tsoak: true },
  };
}

// ─── #1443: DLQ row (dlq list + resolve branch) ─────────────────────────────

export interface DlqFixtureArgs {
  orgId: string;
  endpointId: string;
}

export interface DlqFixtureRow {
  org_id: string;
  endpoint_id: string;
  endpoint_url: string;
  event_id: string;
  event_type: string;
  error_message: string;
  failure_kind: string;
  last_attempt: number;
  payload: Record<string, unknown>;
  resolved: false;
  resolved_at: null;
}

/**
 * An UNRESOLVED dead-letter row for the caller's org, so the self-service DLQ
 * list returns ≥1 row and the resolve endpoint has a target to flip. localhost
 * URL keeps it SSRF-safe; payload is metadata-only (no document bytes).
 */
export function buildDlqFixtureRow(args: DlqFixtureArgs): DlqFixtureRow {
  return {
    org_id: args.orgId,
    endpoint_id: args.endpointId,
    endpoint_url: 'http://localhost:9/tsoak-sink',
    event_id: taggedId('EVT'),
    event_type: 'anchor.secured',
    error_message: 'synthetic soak fixture — endpoint unreachable',
    // Must be one of the values allowed by 0338_scrum2244_dlq_idempotency.sql:
    // CHECK (failure_kind IN ('http_delivery', 'log_write')). 'http_delivery' is
    // the migration default and models an exhausted HTTP delivery attempt.
    failure_kind: 'http_delivery',
    last_attempt: 5,
    payload: { tsoak: true, event: 'anchor.secured' },
    resolved: false,
    resolved_at: null,
  };
}

const SyntheticIdSchema = z.string().refine(isSyntheticFixture, 'must carry the TSOAK- fixture tag');

export const SecuredUnbatchedAnchorRowSchema = z
  .object({
    public_id: SyntheticIdSchema,
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    filename: z.string().min(1),
    status: z.literal('SECURED'),
    chain_tx_id: z.string().regex(/^[0-9a-f]{64}$/),
    chain_block_height: z.number().int().positive(),
    chain_timestamp: z.string().datetime(),
    org_id: z.string().min(1),
    user_id: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const DlqFixtureRowSchema = z
  .object({
    org_id: z.string().min(1),
    endpoint_id: z.string().min(1),
    endpoint_url: z.string().url().startsWith('http://localhost'),
    event_id: SyntheticIdSchema,
    event_type: z.string().min(1),
    error_message: z.string().min(1),
    failure_kind: z.enum(['http_delivery', 'log_write']),
    last_attempt: z.number().int().nonnegative(),
    payload: z.record(z.string(), z.unknown()),
    resolved: z.literal(false),
    resolved_at: z.null(),
  })
  .passthrough();

export function validateFixtureRows(
  table: string,
  rows: ReadonlyArray<object>,
): ReadonlyArray<object> {
  const schema =
    table === 'anchors'
      ? SecuredUnbatchedAnchorRowSchema
      : table === 'webhook_dead_letter_queue'
        ? DlqFixtureRowSchema
        : null;
  if (!schema) return rows;
  return rows.map((row, index) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) {
      throw new Error(`Invalid ${table} fixture row ${index}: ${parsed.error.message}`);
    }
    return parsed.data;
  });
}

// ─── Shared: org + ORG_ADMIN profile ────────────────────────────────────────

export interface OrgRow {
  id: string;
  name: string;
}

export interface AdminProfileRow {
  id: string;
  org_id: string;
  role: 'ORG_ADMIN';
  email: string;
}

export function buildOrgAndAdminProfile(): { org: OrgRow; profile: AdminProfileRow } {
  const orgId = randomUUID();
  const userId = randomUUID();
  return {
    org: { id: orgId, name: `${FIXTURE_TAG}Org-${hex(4)}` },
    profile: {
      id: userId,
      org_id: orgId,
      role: 'ORG_ADMIN',
      email: `tsoak-${hex(6)}@staging.invalid.test`,
    },
  };
}

// ─── Executor contract ──────────────────────────────────────────────────────

/**
 * Inserts `rows` into `table` and returns the inserted rows (at minimum an
 * `{ id }`). Abstracted so drivers unit-test their seed sequence with a fake
 * and run against a real service-role client in production.
 */
export type FixtureExecutor = (
  table: string,
  rows: ReadonlyArray<object>,
) => Promise<Array<Record<string, unknown>>>;

/**
 * Build a FixtureExecutor backed by a Supabase-js-shaped client. Kept out of the
 * unit-tested surface (needs a live client) — drivers call this at run time.
 */
export function makeDbExecutor(client: {
  from: (t: string) => {
    insert: (r: unknown) => { select: (c: string) => Promise<{ data: unknown; error: unknown }> };
  };
}): FixtureExecutor {
  return async (table, rows) => {
    const { data, error } = await client.from(table).insert(rows).select('*');
    if (error) {
      throw new Error(`fixture insert into ${table} failed: ${JSON.stringify(error)}`);
    }
    return (data ?? []) as Array<Record<string, unknown>>;
  };
}
