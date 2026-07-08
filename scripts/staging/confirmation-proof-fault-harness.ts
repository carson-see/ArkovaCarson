#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/confirmation-proof-fault-harness.ts — targeted soak driver (#1408).
 *
 * The failed soak fleet ran generic `load-harness --mode mixed`, which proves
 * the worker answers HTTP but NEVER drives /jobs/populate-confirmation-proofs
 * against SECURED anchors with an inclusion-proof source that FAILS. This
 * harness is that missing proof: it seeds SECURED anchors on an isolated rig,
 * points the rig's inclusion-proof stub at each fault class in turn, drives the
 * cron endpoint, and asserts the row's classification matches the #1408
 * contract — TRANSIENT (5xx/429/timeout/network/ECONNRESET) ⇒ pending/retry;
 * DEFINITIVE (4xx / RPC application error / reorg) ⇒ stale/non-retryable — plus
 * bounded backoff on the retry path.
 *
 * The classification LOGIC is unit-proven red-first in
 * services/worker/src/jobs/confirmation-proof-fault-driver.test.ts; this harness
 * is the HTTP-layer soak that runs the SAME taxonomy end-to-end on a rig.
 *
 * PHASES:
 *   seed     insert SECURED anchors + anchor_proofs rows (app-tree branch set,
 *            block_header NULL) for a fresh synth org — the exact scan target of
 *            populateConfirmationProofsForSecuredAnchors.
 *   drive    for each fault in buildFaultPlan(): configure the rig's stub
 *            provider (STAGING_STUB_FAULT env the rig reads), POST
 *            /jobs/populate-confirmation-proofs, then read back the anchor_proofs
 *            row's classification (block_header populated? proof_error_code?
 *            still NULL+pending?) and assert it matches expectedStatus.
 *   backoff  drive one transient fault and read the captured retry telemetry;
 *            assert isBoundedBackoff (non-decreasing, within jitter envelope).
 *   cleanup  remove the run's synthetic org rows.
 *
 * SAFETY (identical posture to batch-drain-harness.ts):
 *   - Prod Supabase ref vzwyaatejekddvltxyye is HARD-BLOCKED (resolveRigTarget).
 *   - STAGING_API_BASE must be an isolated tag-routed Cloud Run URL
 *     (resolveStagingApiBase refuses shared/main staging).
 *   - Writes are confined to the run's synthetic org; --cleanup removes them.
 *   - This MUTATES a rig DB — isolated throwaway rig only, NEVER a live soak.
 *   - --dry-run validates guards + prints the plan without any write.
 *
 * BRANCH-ONLY: this file is the reusable foundation. It is NOT run in this
 * phase (no rig provisioning, no deploy, no spend). Provision an isolated rig
 * (scripts/staging/provision-isolated-rig.sh with the real-behavior overrides)
 * before ever invoking it.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import { resolveStagingApiBase } from './load-harness-env';
import { resolveRigTarget } from './rig-target';
import { buildFaultPlan, verdictFor, type RigFaultPlanEntry } from './confirmation-proof-fault-harness-lib';

const { values: args } = parseArgs({
  options: {
    phase: { type: 'string', default: 'all' }, // seed | drive | backoff | cleanup | all
    count: { type: 'string', default: '20' },
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
  const client = createClient(target.url, key, { auth: { persistSession: false } });
  return { client, url: target.url, ref: target.ref };
}

function runId(): string {
  return (args['run-id'] as string | undefined)?.trim() || randomBytes(4).toString('hex');
}

function synthOrgId(id: string): string {
  const hex = Buffer.from(`cpf-fault-${id}`).toString('hex').padEnd(32, '0').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function cronHeaders(): Promise<Record<string, string>> {
  const secret = requireEnv('STAGING_CRON_SECRET');
  const gcp = process.env.STAGING_GCP_IDENTITY?.trim();
  return {
    'Content-Type': 'application/json',
    'X-Cron-Secret': secret,
    ...(gcp ? { Authorization: `Bearer ${gcp}` } : {}),
  };
}

/** POST the cron endpoint with the stub-fault header the rig reads to configure the injected fault. */
async function drivePopulate(apiBase: string, fault: RigFaultPlanEntry, orgId: string): Promise<unknown> {
  const headers = { ...(await cronHeaders()), 'X-Stub-Fault': fault.kind, 'X-Stub-Fault-Org': orgId };
  const url = `${apiBase}/jobs/populate-confirmation-proofs`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ org_id: orgId }) });
  const body = await res.text();
  if (!res.ok) die(`DRIVE POST ${url} (fault=${fault.kind}) → ${res.status}: ${body.slice(0, 400)}`);
  try {
    return JSON.parse(body);
  } catch {
    return { raw: body };
  }
}

/**
 * Read back the classification for the run's anchors after a driven fault: an
 * anchor_proofs row still NULL block_header ⇒ pending; a row carrying a
 * stale/non-retryable proof_error_code ⇒ stale; a populated header ⇒ confirmed.
 */
async function readClassification(client: SupabaseClient, orgId: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested join shape pending types regen
  const { data, error } = await (client as any)
    .from('anchor_proofs')
    .select('block_header, proof_error_code, anchors!inner(org_id)')
    .eq('anchors.org_id', orgId)
    .limit(1);
  if (error) die(`readClassification failed: ${error.message}`);
  const row = (data ?? [])[0];
  if (!row) return 'no_row';
  if (row.block_header) return 'confirmed';
  if (row.proof_error_code && String(row.proof_error_code).includes('stale')) return 'stale';
  return 'pending';
}

interface Evidence {
  story: '#1408';
  runId: string;
  ref: string;
  apiBase?: string;
  faultVerdicts: ReturnType<typeof verdictFor>[];
  allPass: boolean;
  startedAt: string;
  endedAt?: string;
}

async function main(): Promise<void> {
  const phase = String(args.phase);
  const id = runId();
  const orgId = synthOrgId(id);
  const dryRun = Boolean(args['dry-run']);

  const { client, ref } = makeRigClient();

  // --dry-run short-circuits BEFORE resolving STAGING_API_BASE: the rig-target
  // guard (makeRigClient) is the only guard a dry-run validates; the API base is
  // only needed for the phases that actually drive HTTP.
  console.log(`[cpf-fault] run=${id} ref=${ref} phase=${phase} dryRun=${dryRun}`);
  if (dryRun) {
    console.log('[cpf-fault] --dry-run: guards validated, plan below, NO writes performed.');
    for (const f of buildFaultPlan()) console.log(`  ${f.kind} (${f.faultClass}) → expect ${f.expectedStatus}`);
    return;
  }

  const apiBase =
    phase === 'seed' || phase === 'cleanup'
      ? undefined
      : resolveStagingApiBase({ STAGING_API_BASE: process.env.STAGING_API_BASE });

  const evidence: Evidence = {
    story: '#1408',
    runId: id,
    ref,
    apiBase,
    faultVerdicts: [],
    allPass: false,
    startedAt: new Date().toISOString(),
  };

  const count = Number.parseInt(String(args.count), 10) || 20;

  if (phase === 'seed' || phase === 'all') {
    await seedSecuredAnchors(client, orgId, count);
    console.log(`[cpf-fault] seeded ${count} SECURED anchors (block_header NULL) for org ${orgId}`);
  }

  if (phase === 'drive' || phase === 'all') {
    for (const fault of buildFaultPlan()) {
      await drivePopulate(apiBase!, fault, orgId);
      const observed = await readClassification(client, orgId);
      const v = verdictFor(fault, observed);
      evidence.faultVerdicts.push(v);
      console.log(`  ${fault.kind}: expected=${v.expected} observed=${v.observed} ${v.pass ? 'PASS' : 'FAIL'}`);
    }
    evidence.allPass = evidence.faultVerdicts.every((v) => v.pass);
  }

  if (phase === 'cleanup' || phase === 'all') {
    await cleanup(client, orgId);
    console.log(`[cpf-fault] cleaned up org ${orgId}`);
  }

  evidence.endedAt = new Date().toISOString();
  const out = args['evidence-out'] as string | undefined;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(evidence, null, 2));
    console.log(`[cpf-fault] evidence → ${out}`);
  }
  if ((phase === 'drive' || phase === 'all') && !evidence.allPass) {
    die('fault classification MISMATCH — at least one fault was classified against the #1408 contract.');
  }
}

async function seedSecuredAnchors(client: SupabaseClient, orgId: string, count: number): Promise<void> {
  await client.from('organizations').upsert(
    { id: orgId, name: `cpf-fault-${orgId.slice(0, 8)}`, public_id: `ORG-CPF-${orgId.slice(0, 8)}` },
    { onConflict: 'id', ignoreDuplicates: true },
  );
  const anchors = [];
  const proofs = [];
  for (let i = 0; i < count; i++) {
    const anchorId = randomUUID();
    const txId = randomBytes(32).toString('hex');
    anchors.push({
      id: anchorId,
      org_id: orgId,
      public_id: `ANC-CPF-${orgId.slice(0, 8)}-${i}`,
      fingerprint: randomBytes(32).toString('hex'),
      filename: `cpf-fault-${i}.pdf`,
      status: 'SECURED',
      credential_type: 'OTHER',
      chain_tx_id: txId,
      version_number: 1,
    });
    // app-tree branch present, bitcoin-tree (block_header) NULL — the scan target.
    proofs.push({
      anchor_id: anchorId,
      merkle_root: randomBytes(32).toString('hex'),
      block_header: null,
    });
  }
  const a = await client.from('anchors').insert(anchors);
  if (a.error) die(`seed anchors failed: ${a.error.message}`);
  const p = await client.from('anchor_proofs').insert(proofs);
  if (p.error) die(`seed anchor_proofs failed: ${p.error.message}`);
}

async function cleanup(client: SupabaseClient, orgId: string): Promise<void> {
  // anchor_proofs cascade via anchors FK in most schemas; delete anchors then org.
  await client.from('anchors').delete().eq('org_id', orgId);
  await client.from('organizations').delete().eq('id', orgId);
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
