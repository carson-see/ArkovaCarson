#!/usr/bin/env tsx
/**
 * scripts/staging/probe-pipeline-template-keys.ts — SCRUM-5106 T2 soak probe.
 *
 * Read-only sanity check that the credential-template projection
 * (`services/worker/src/jobs/publicRecordTemplate.ts`) is actually landing
 * in `anchors.metadata` for newly-created pipeline anchors on a live rig.
 * Selects the single newest anchor whose metadata carries a
 * `pipeline_source` key, and fails unless that row's metadata carries at
 * least one of `issuerName` / `licenseNumber` / `authors` for a source the
 * projector covers. Read-only (SELECT only) and safe to re-run repeatedly —
 * including once per T3 trigger cycle against the same soak — since each
 * run just re-queries the current newest row and reports which anchor id it
 * inspected; see `--help` for detail.
 *
 * Deliberately NOT imported from `services/worker/src/jobs/` — this script
 * lives in a different package (root `scripts/`, plain `tsx`, bundler
 * module resolution) than the worker (`services/worker/`, NodeNext, its own
 * `package.json`/`node_modules`), and a cross-package source import would
 * not resolve the way either package's own tooling expects. `PIPELINE_TEMPLATE_SOURCES`
 * below is a literal mirror of `publicRecordTemplate.ts`'s
 * `SOURCE_FIELD_TABLE` keys — keep it in sync if that table gains or loses
 * a source.
 *
 * Env (never hardcoded):
 *   SUPABASE_URL               Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY  service-role key (read-only query only)
 *
 * Usage: npx tsx scripts/staging/probe-pipeline-template-keys.ts [--help]
 * Exit code 0 = pass, 1 = fail (including missing env / query error).
 */

import { createClient } from '@supabase/supabase-js';

/** Mirror of publicRecordTemplate.ts's SOURCE_FIELD_TABLE keys (2026-09-13). */
export const PIPELINE_TEMPLATE_SOURCES = new Set([
  'openalex',
  'edgar',
  'edgar_form_adv',
  'sec_adv_bulk', // pre-rename alias of edgar_form_adv — same spec, same projection
  'sec_iapd',
  'federal_register',
  'openstates',
  'courtlistener',
  'uspto',
  'npi',
  'finra',
  'calbar',
  'dapip',
  'acnc',
  'acra_sg',
  'cnpj_br',
  'moh_sg',
  'australia_law',
  'kenya_law',
  'australia_caselaw',
  'kenya_caselaw',
]);

const IDENTITY_KEYS = ['issuerName', 'licenseNumber', 'authors'] as const;

export interface ProbeAnchorRow {
  id: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export interface ProbeResult {
  ok: boolean;
  reason?: string;
  /** Which anchor this run inspected — printed on every run (pass or fail) so a
   * T3 soak's repeated invocations across trigger cycles can be told apart. */
  anchorId?: string;
  pipelineSource?: string;
  keysFound: string[];
}

/**
 * Pure assertion logic — no network, no env reads. Exported so the test
 * file can exercise it against an in-memory row.
 */
export function evaluateProbeRow(row: ProbeAnchorRow | null): ProbeResult {
  if (!row) {
    return {
      ok: false,
      reason: 'no anchor row with a pipeline_source key found in the last 24h',
      keysFound: [],
    };
  }

  const meta = row.metadata ?? {};
  const keysFound = Object.keys(meta);
  const pipelineSource = typeof meta.pipeline_source === 'string' ? meta.pipeline_source : undefined;

  if (!pipelineSource) {
    return {
      ok: false,
      reason: 'newest matching row has no string pipeline_source in metadata',
      anchorId: row.id,
      keysFound,
    };
  }

  if (!PIPELINE_TEMPLATE_SOURCES.has(pipelineSource)) {
    // A real pipeline source the projector doesn't cover yet — not a probe
    // failure (SOURCE_FIELD_TABLE has no entry, so `{}` is the honest
    // output today), but worth flagging rather than silently passing.
    return {
      ok: true,
      reason: `pipeline_source=${pipelineSource} has no SOURCE_FIELD_TABLE entry — nothing to check`,
      anchorId: row.id,
      pipelineSource,
      keysFound,
    };
  }

  const hasIdentitySignal = IDENTITY_KEYS.some((key) => {
    const value = meta[key];
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null && value !== '';
  });

  return {
    ok: hasIdentitySignal,
    reason: hasIdentitySignal
      ? undefined
      : `pipeline_source=${pipelineSource} metadata carries none of issuerName/licenseNumber/authors`,
    anchorId: row.id,
    pipelineSource,
    keysFound,
  };
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`Usage: npx tsx scripts/staging/probe-pipeline-template-keys.ts [--help]

Read-only SCRUM-5106 soak probe. Selects the newest 'anchors' row whose
metadata carries a pipeline_source key (filtered on created_at > now() -
interval '1 day' FIRST, so the query stays index-backed rather than
scanning the whole anchors table) and asserts the credential-template
projection landed — issuerName, licenseNumber, or authors present in that
row's metadata — for any pipeline_source in PIPELINE_TEMPLATE_SOURCES.

Safe to run repeatedly, including once per T3 trigger cycle on the same
soak: it only ever SELECTs (no anchors/insert/update/delete calls), so
back-to-back or concurrent invocations against the same rig cannot
interfere with each other or with the soak driver. Each run re-queries for
the CURRENT newest matching row rather than caching one — the printed
'anchorId' names exactly which anchor that run inspected, so a sequence of
runs across trigger cycles A/B and the daily flush can be told apart in
soak evidence instead of all looking like one repeated check.

Env (required to run; never hardcode):
  SUPABASE_URL               Supabase project URL
  SUPABASE_SERVICE_ROLE_KEY  service-role key (read-only usage here)

Prints the evaluated row's id and keys either way. Exit 0 = pass, 1 = fail.`);
}

async function main(): Promise<number> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    // eslint-disable-next-line no-console
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set in env.');
    return 1;
  }

  const client = createClient(url, key, { auth: { persistSession: false } });

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from('anchors')
    .select('id, created_at, metadata')
    .gt('created_at', since) // index-backed bound FIRST — see header
    .not('metadata->>pipeline_source', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    // eslint-disable-next-line no-console
    console.error('Probe query failed:', error.message);
    return 1;
  }

  const row = ((data?.[0] as ProbeAnchorRow | undefined) ?? null);
  const result = evaluateProbeRow(row);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === new URL(`file://${entry}`).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    process.exit(0);
  } else {
    main().then((code) => process.exit(code));
  }
}
