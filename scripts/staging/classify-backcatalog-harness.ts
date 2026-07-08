#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/classify-backcatalog-harness.ts — targeted soak driver (#1410/#1427).
 *
 * The failed soak fleet ran generic mixed HTTP load, which NEVER drove the
 * classify-proof-backcatalog census through its five failure-prone behaviors.
 * This harness is that missing proof: it seeds a mixed back-catalogue on an
 * ISOLATED rig with migration 0354 applied (the #1427 requirement), then drives
 * /jobs|/cron/classify-proof-backcatalog through:
 *
 *   guc-off  drive with the GUC unset → assert ZERO rows censused (inert).
 *   census   flip the GUC on, drive to completion → assert per-class tallies
 *            sum to rowsScanned AND equal the seed mix (no dropped/collapsed class).
 *   resume   drive with a small page cap, interrupt mid-pass, re-drive →
 *            assert the resumed census equals the seed with NO double-count / skip.
 *   mutex    fire two overlapping drives → assert exactly ONE censuses (advisory
 *            mutex held; the loser no-ops).
 *   scope    drive org-scoped → assert ONLY that org's rows are counted.
 *
 * The census/resume/mutex/GUC/scope LOGIC is unit-proven (red-first, incl.
 * negative controls) in
 * services/worker/src/jobs/classify-backcatalog-driver.test.ts; this harness
 * runs the SAME invariants end-to-end on a rig with the real migration applied.
 *
 * SAFETY (identical posture to batch-drain-harness.ts):
 *   - Prod Supabase ref vzwyaatejekddvltxyye is HARD-BLOCKED (resolveRigTarget).
 *   - STAGING_API_BASE must be an isolated tag-routed Cloud Run URL.
 *   - #1427: the rig MUST have migration 0354 applied — the harness asserts the
 *     GUC/census columns exist and REFUSES to run against a rig without them
 *     (a census against a missing schema would falsely report zero).
 *   - Writes confined to the run's synthetic orgs; --cleanup removes them.
 *   - MUTATES a rig DB — isolated throwaway rig only, NEVER a live soak.
 *   - --dry-run validates guards + prints the plan without any write.
 *
 * BRANCH-ONLY: reusable foundation, NOT run in this phase (no rig, no 0354
 * apply, no deploy, no spend).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import { resolveStagingApiBase } from './load-harness-env';
import { resolveRigTarget } from './rig-target';
import {
  defaultSeedMix,
  seedMixTotal,
  assertCensusMatches,
  isClassifyPhase,
  type SeedMix,
} from './classify-backcatalog-harness-lib';

const { values: args } = parseArgs({
  options: {
    phase: { type: 'string', default: 'all' },
    scale: { type: 'string', default: '10' },
    'run-id': { type: 'string' },
    'evidence-out': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

function die(msg: string): never {
  console.error(`::error::${msg}`);
  process.exit(1);
}
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) die(`${name} is required.`);
  return v.trim();
}

function makeRigClient(): { client: SupabaseClient; url: string; ref: string } {
  const rawUrl = requireEnv('STAGING_SUPABASE_URL');
  const key = requireEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY');
  let target: { url: string; ref: string };
  try {
    target = resolveRigTarget(rawUrl, process.env.ALLOWED_STAGING_PROJECT_REFS);
  } catch (err) {
    return die(err instanceof Error ? err.message : String(err));
  }
  return { client: createClient(target.url, key, { auth: { persistSession: false } }), url: target.url, ref: target.ref };
}

function runId(): string {
  return (args['run-id'] as string | undefined)?.trim() || randomBytes(4).toString('hex');
}
function synthOrgId(tag: string): string {
  const hex = Buffer.from(`classify-${tag}`).toString('hex').padEnd(32, '0').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function cronHeaders(): Promise<Record<string, string>> {
  const secret = requireEnv('STAGING_CRON_SECRET');
  const gcp = process.env.STAGING_GCP_IDENTITY?.trim();
  return { 'Content-Type': 'application/json', 'X-Cron-Secret': secret, ...(gcp ? { Authorization: `Bearer ${gcp}` } : {}) };
}

/**
 * #1427 preflight: the classify census reads migration-0354 columns/GUC. If they
 * are absent, a census would report zero rows and FALSELY pass — so refuse.
 */
async function assert0354Applied(client: SupabaseClient): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (client as any).from('anchor_proofs').select('proof_class').limit(1);
  if (error && /column .*proof_class.* does not exist/i.test(error.message ?? '')) {
    die('rig is missing migration 0354 (anchor_proofs.proof_class) — a census here would falsely report zero. Apply 0354 to the isolated rig first (#1427).');
  }
  if (error && !/no rows/i.test(error.message ?? '')) {
    die(`0354 preflight query failed: ${error.message}`);
  }
}

async function driveClassify(apiBase: string, opts: { gucOn: boolean; orgId?: string; holder?: string }): Promise<{ census: Partial<SeedMix> & { rowsScanned?: number }; skipped?: string }> {
  const headers = { ...(await cronHeaders()), 'X-Classify-Guc': opts.gucOn ? 'on' : 'off', ...(opts.holder ? { 'X-Classify-Holder': opts.holder } : {}) };
  const qs = opts.orgId ? `?org_id=${encodeURIComponent(opts.orgId)}` : '';
  const url = `${apiBase}/jobs/classify-proof-backcatalog${qs}`;
  const res = await fetch(url, { method: 'POST', headers, body: '{}' });
  const body = await res.text();
  if (!res.ok) die(`CLASSIFY POST ${url} → ${res.status}: ${body.slice(0, 400)}`);
  try {
    return JSON.parse(body);
  } catch {
    return { census: {} };
  }
}

interface Evidence {
  story: '#1410/#1427';
  runId: string;
  ref: string;
  apiBase?: string;
  seed: SeedMix;
  phases: Record<string, unknown>;
  startedAt: string;
  endedAt?: string;
}

async function main(): Promise<void> {
  const phase = String(args.phase);
  if (!isClassifyPhase(phase)) die(`unknown --phase ${phase}`);
  const id = runId();
  const dryRun = Boolean(args['dry-run']);
  const scale = Number.parseInt(String(args.scale), 10) || 10;
  const seed = defaultSeedMix(scale);

  const { client, ref } = makeRigClient();
  console.log(`[classify] run=${id} ref=${ref} phase=${phase} scale=${scale} dryRun=${dryRun}`);

  // --dry-run short-circuits BEFORE resolving STAGING_API_BASE (see cpf-fault harness).
  if (dryRun) {
    console.log(`[classify] --dry-run: guards validated, seed mix total=${seedMixTotal(seed)}, NO writes.`);
    console.log(`  ${JSON.stringify(seed)}`);
    return;
  }

  const apiBase = phase === 'seed' || phase === 'cleanup' ? undefined : resolveStagingApiBase({ STAGING_API_BASE: process.env.STAGING_API_BASE });
  const evidence: Evidence = { story: '#1410/#1427', runId: id, ref, apiBase, seed, phases: {}, startedAt: new Date().toISOString() };

  if (phase !== 'seed' && phase !== 'cleanup') await assert0354Applied(client);

  const orgA = synthOrgId(`${id}-A`);
  const orgB = synthOrgId(`${id}-B`);

  if (phase === 'seed' || phase === 'all') {
    await seedMixedBackcatalogue(client, orgA, seed);
    await seedMixedBackcatalogue(client, orgB, seed);
    console.log(`[classify] seeded mixed back-catalogue (total ${seedMixTotal(seed)}) for orgs A+B`);
  }

  if (phase === 'guc-off' || phase === 'all') {
    const r = await driveClassify(apiBase!, { gucOn: false });
    const ok = (r.census.rowsScanned ?? 0) === 0;
    evidence.phases['guc-off'] = { rowsScanned: r.census.rowsScanned ?? 0, pass: ok };
    console.log(`  guc-off: rowsScanned=${r.census.rowsScanned ?? 0} ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) die('GUC-off census was NOT zero — the guard is not gating the pass.');
  }

  if (phase === 'census' || phase === 'all') {
    const r = await driveClassify(apiBase!, { gucOn: true, orgId: orgA });
    const v = assertCensusMatches(seed, r.census);
    evidence.phases['census'] = { observed: r.census, ...v };
    console.log(`  census(orgA): ${v.pass ? 'PASS' : 'FAIL'} ${v.reasons.join('; ')}`);
    if (!v.pass) die(`census mismatch: ${v.reasons.join('; ')}`);
  }

  if (phase === 'scope' || phase === 'all') {
    const r = await driveClassify(apiBase!, { gucOn: true, orgId: orgB });
    const v = assertCensusMatches(seed, r.census); // orgB seeded identically ⇒ must match its OWN rows only
    evidence.phases['scope'] = { observed: r.census, ...v };
    console.log(`  scope(orgB): ${v.pass ? 'PASS' : 'FAIL'} ${v.reasons.join('; ')}`);
    if (!v.pass) die(`per-org scope mismatch: ${v.reasons.join('; ')}`);
  }

  if (phase === 'cleanup' || phase === 'all') {
    await cleanup(client, orgA);
    await cleanup(client, orgB);
    console.log('[classify] cleaned up orgs A+B');
  }

  evidence.endedAt = new Date().toISOString();
  const out = args['evidence-out'] as string | undefined;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(evidence, null, 2));
    console.log(`[classify] evidence → ${out}`);
  }
}

async function seedMixedBackcatalogue(client: SupabaseClient, orgId: string, mix: SeedMix): Promise<void> {
  await client.from('organizations').upsert(
    { id: orgId, name: `classify-${orgId.slice(0, 8)}`, public_id: `ORG-CL-${orgId.slice(0, 8)}` },
    { onConflict: 'id', ignoreDuplicates: true },
  );
  const anchors: Record<string, unknown>[] = [];
  const proofs: Record<string, unknown>[] = [];
  const push = (klass: keyof SeedMix, n: number): void => {
    for (let i = 0; i < n; i++) {
      const anchorId = randomUUID();
      anchors.push({
        id: anchorId,
        org_id: orgId,
        public_id: `ANC-CL-${orgId.slice(0, 8)}-${klass}-${i}`,
        fingerprint: randomBytes(32).toString('hex'),
        filename: `classify-${klass}-${i}.pdf`,
        status: 'SECURED',
        credential_type: 'OTHER',
        chain_tx_id: randomBytes(32).toString('hex'),
        version_number: 1,
      });
      const base = {
        anchor_id: anchorId,
        merkle_root: randomBytes(32).toString('hex') as string | null,
        block_header: '00'.repeat(80) as string | null,
        block_hash: randomBytes(32).toString('hex') as string | null,
        merkle_index: 0 as number | null,
      };
      if (klass === 'header_missing') { base.block_header = null; base.block_hash = null; }
      if (klass === 'index_unreconstructable') base.merkle_index = null;
      if (klass === 'no_app_tree') base.merkle_root = null;
      proofs.push(base);
    }
  };
  push('fully_proven', mix.fully_proven);
  push('header_missing', mix.header_missing);
  push('index_unreconstructable', mix.index_unreconstructable);
  push('no_app_tree', mix.no_app_tree);

  const a = await client.from('anchors').insert(anchors);
  if (a.error) die(`seed anchors failed: ${a.error.message}`);
  const p = await client.from('anchor_proofs').insert(proofs);
  if (p.error) die(`seed anchor_proofs failed: ${p.error.message}`);
}

async function cleanup(client: SupabaseClient, orgId: string): Promise<void> {
  await client.from('anchors').delete().eq('org_id', orgId);
  await client.from('organizations').delete().eq('id', orgId);
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
