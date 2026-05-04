#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/seed.ts — populate a Supabase preview branch with
 * prod-shape data for soak testing.
 *
 * Strategy: NEVER copy raw prod rows. Instead, sample row counts +
 * status distribution from prod, then SYNTHESIZE rows on the staging
 * branch with the same shape but fake fingerprints, fake org IDs, fake
 * email addresses. This keeps customer data out of the staging blast
 * radius (CLAUDE.md §1.6 spirit applied to test infra).
 *
 * What this script does NOT do:
 *   - Copy any production fingerprints
 *   - Copy any real customer org records
 *   - Copy any real Bitcoin tx_ids
 *   - Touch prod (read-only sampling via env var SAMPLE_FROM_PROD=1)
 *
 * Usage:
 *   STAGING_SUPABASE_URL=... \
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY=... \
 *   npm run staging:seed
 *
 * Optional:
 *   SAMPLE_FROM_PROD=1 PROD_SUPABASE_URL=... PROD_SUPABASE_SERVICE_ROLE_KEY=... \
 *     — read-only counts/distributions from prod to size the synthesis.
 *     Without this, defaults to the SHAPE_BASELINE constants below.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes, randomUUID } from 'node:crypto';

// Staging-only — we don't pass the prod-shaped `Database` generic because
// the staging branch may have additional tables (staging_lease) that
// aren't in src/types/database.types.ts. Use a loose typed client and
// rely on the Postgres responses for safety.
type LooseSupabaseClient = SupabaseClient<unknown, never, never, never, never>;

/** PostgREST insert payload shape — anything serializable. */
type AnyRow = Record<string, unknown>;
/** Cast a loose client's `.from(table).insert(rows)` to accept untyped rows. */
function tableInsert(client: LooseSupabaseClient, table: string) {
  type LooseTable = { insert: (rows: AnyRow | AnyRow[]) => Promise<{ error: { message: string } | null }> };
  return ((client.from as unknown as (t: string) => LooseTable)(table)).insert;
}

const STAGING_URL = requireEnv('STAGING_SUPABASE_URL');
const STAGING_KEY = requireEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY');

const SAMPLE_FROM_PROD = process.env.SAMPLE_FROM_PROD === '1';

/**
 * Fallback shape used when SAMPLE_FROM_PROD is off. Numbers are deliberate
 * — small enough to seed in <60s, large enough to exercise Trigger A
 * (10k batch fire) and Trigger B (3k threshold + 3h clock) within a
 * 4-hour test window when combined with the load harness.
 */
const SHAPE_BASELINE = {
  organizations: 20,
  users_per_org: 3,
  api_keys_per_org: 1,
  anchors_total: 50_000,
  status_distribution: {
    PENDING: 0.05,
    BROADCASTING: 0.001,
    SUBMITTED: 0.04,
    SECURED: 0.91,
    REVOKED: 0.005,
    SUPERSEDED: 0.004,
  },
} as const;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`::error::Required env var ${name} is not set.`);
    process.exit(1);
  }
  return v;
}

function fakeFingerprint(): string {
  return randomBytes(32).toString('hex');
}

function fakeBitcoinTxId(): string {
  return randomBytes(32).toString('hex');
}

function fakeEmail(orgIdx: number, userIdx: number): string {
  return `staging+org${orgIdx}-user${userIdx}@arkova-staging.test`;
}

function fakeOrgName(idx: number): string {
  return `Staging Org ${idx}`;
}

interface Distribution {
  PENDING: number;
  BROADCASTING: number;
  SUBMITTED: number;
  SECURED: number;
  REVOKED: number;
  SUPERSEDED: number;
}

async function readProdShape(): Promise<{ totalAnchors: number; distribution: Distribution }> {
  const PROD_URL = requireEnv('PROD_SUPABASE_URL');
  const PROD_KEY = requireEnv('PROD_SUPABASE_SERVICE_ROLE_KEY');
  const prod = createClient(PROD_URL, PROD_KEY, { auth: { persistSession: false } }) as unknown as LooseSupabaseClient;

  // Use planner stats (reltuples) — count(*) on a 3M-row table times out.
  const { data: ts, error: tsErr } = await prod.rpc('get_anchor_status_counts');
  if (tsErr || !ts) {
    console.error(`::warning::get_anchor_status_counts RPC failed: ${tsErr?.message}`);
    console.error('Falling back to SHAPE_BASELINE.');
    return { totalAnchors: SHAPE_BASELINE.anchors_total, distribution: SHAPE_BASELINE.status_distribution };
  }

  const counts = ts as Array<{ status: string; n: number }>;
  const total = counts.reduce((acc, r) => acc + r.n, 0);
  const dist: Distribution = {
    PENDING: 0,
    BROADCASTING: 0,
    SUBMITTED: 0,
    SECURED: 0,
    REVOKED: 0,
    SUPERSEDED: 0,
  };
  for (const row of counts) {
    if (row.status in dist) dist[row.status as keyof Distribution] = row.n / total;
  }
  return { totalAnchors: Math.min(total, 200_000), distribution: dist };
}

interface SeedPlan {
  organizations: number;
  totalAnchors: number;
  distribution: Distribution;
}

async function plan(): Promise<SeedPlan> {
  if (SAMPLE_FROM_PROD) {
    const shape = await readProdShape();
    return {
      organizations: SHAPE_BASELINE.organizations,
      totalAnchors: shape.totalAnchors,
      distribution: shape.distribution,
    };
  }
  return {
    organizations: SHAPE_BASELINE.organizations,
    totalAnchors: SHAPE_BASELINE.anchors_total,
    distribution: SHAPE_BASELINE.status_distribution,
  };
}

interface SeededOrg {
  id: string;
  org_prefix: string;
}

async function seedOrgs(staging: LooseSupabaseClient, count: number): Promise<SeededOrg[]> {
  const orgs: SeededOrg[] = [];
  for (let i = 0; i < count; i++) {
    const orgId = randomUUID();
    const orgPrefix = `STG${String(i).padStart(3, '0')}`;
    const { error } = await tableInsert(staging, 'organizations')({
      id: orgId,
      name: fakeOrgName(i),
      org_prefix: orgPrefix,
    });
    if (error) throw new Error(`organizations insert failed at i=${i}: ${error.message}`);
    orgs.push({ id: orgId, org_prefix: orgPrefix });

    for (let u = 0; u < SHAPE_BASELINE.users_per_org; u++) {
      const userId = randomUUID();
      const { error: memberErr } = await tableInsert(staging, 'org_members')({
        org_id: orgId,
        user_id: userId,
        email: fakeEmail(i, u),
        role: u === 0 ? 'admin' : 'member',
      });
      if (memberErr) throw new Error(`org_members insert failed: ${memberErr.message}`);
    }
  }
  return orgs;
}

async function seedAnchors(
  staging: LooseSupabaseClient,
  orgs: SeededOrg[],
  total: number,
  distribution: Distribution,
): Promise<void> {
  const statuses = Object.entries(distribution) as Array<[keyof Distribution, number]>;
  const batches = [];
  for (const [status, fraction] of statuses) {
    const n = Math.round(total * fraction);
    if (n === 0) continue;
    batches.push({ status, n });
  }

  let inserted = 0;
  const CHUNK = 500;
  for (const { status, n } of batches) {
    for (let offset = 0; offset < n; offset += CHUNK) {
      const rows = [];
      for (let i = 0; i < Math.min(CHUNK, n - offset); i++) {
        const org = orgs[(inserted + i) % orgs.length];
        rows.push({
          id: randomUUID(),
          public_id: `STG-${org.org_prefix}-${randomBytes(4).toString('hex')}`,
          org_id: org.id,
          fingerprint: fakeFingerprint(),
          status,
          credential_type: 'GENERIC',
          tx_id: status === 'SECURED' || status === 'SUBMITTED' ? fakeBitcoinTxId() : null,
          submitted_at: status === 'SECURED' || status === 'SUBMITTED' ? new Date().toISOString() : null,
        });
      }
      const { error } = await tableInsert(staging, 'anchors')(rows);
      if (error) throw new Error(`anchors insert failed at offset ${offset} status ${status}: ${error.message}`);
      inserted += rows.length;
      if (inserted % 5_000 === 0) {
        console.log(`  inserted ${inserted}/${total} anchors...`);
      }
    }
  }
  console.log(`  inserted ${inserted}/${total} anchors total.`);
}

async function main(): Promise<void> {
  const staging = createClient(STAGING_URL, STAGING_KEY, { auth: { persistSession: false } }) as unknown as LooseSupabaseClient;

  console.log('▶ Planning seed...');
  const seedPlan = await plan();
  console.log(`  ${seedPlan.organizations} orgs, ${seedPlan.totalAnchors} anchors, distribution:`);
  for (const [status, frac] of Object.entries(seedPlan.distribution)) {
    console.log(`    ${status.padEnd(12)} ${(frac * 100).toFixed(1)}%`);
  }

  console.log('▶ Seeding organizations + members...');
  const orgs = await seedOrgs(staging, seedPlan.organizations);

  console.log('▶ Seeding anchors...');
  await seedAnchors(staging, orgs, seedPlan.totalAnchors, seedPlan.distribution);

  console.log('✅ Staging seed complete.');
}

main().catch((err) => {
  console.error(`::error::Staging seed failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
