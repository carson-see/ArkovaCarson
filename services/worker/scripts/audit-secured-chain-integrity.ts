#!/usr/bin/env tsx
/**
 * Operator CLI: SECURED-chain-integrity back-catalogue audit (SCRUM-2486 AC-2).
 *
 * STRICTLY READ-ONLY. Resolves the prod service-role Supabase client from Secret
 * Manager (same pattern as `check-anchor-status.ts`), runs the read-only audit
 * library, and prints the structured JSON summary. Never writes / mutates /
 * backfills. Safe to run against prod at any time.
 *
 * Usage:
 *   npx tsx scripts/audit-secured-chain-integrity.ts [--batch-size N] [--sample-limit N]
 *
 * Exit code:
 *   0  invariant holds (clean) OR scan completed with findings reported
 *   1  the scan itself failed (DB read error) — findings are NOT a failure here,
 *      they are the whole point; the operator reads the JSON to see them.
 *
 * NOTE (SCRUM-2486): apply/soak and any prod run are DEFERRED to Sprint-4. This
 * script is authored + unit-tested here; it is not executed against prod by the
 * authoring session.
 */
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { createClient } from '@supabase/supabase-js';

import {
  runSecuredChainIntegrityAudit,
  DEFAULT_BATCH_SIZE,
  DEFAULT_SAMPLE_LIMIT,
} from '../src/jobs/auditSecuredChainIntegrity.js';

dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const batchSize = Number(argValue('--batch-size') ?? DEFAULT_BATCH_SIZE);
  const sampleLimit = Number(argValue('--sample-limit') ?? DEFAULT_SAMPLE_LIMIT);

  const gcpEnv =
    'GOOGLE_APPLICATION_CREDENTIALS=/Users/carson/.config/gcloud/application_default_credentials.json';
  const url = execSync(
    `${gcpEnv} gcloud secrets versions access latest --secret=supabase-url --project=arkova1`,
    { encoding: 'utf-8' },
  ).trim();
  const key = execSync(
    `${gcpEnv} gcloud secrets versions access latest --secret=supabase-service-role-key --project=arkova1`,
    { encoding: 'utf-8' },
  ).trim();

  // Service-role client, but this script only ever SELECTs.
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const summary = await runSecuredChainIntegrityAudit({
    client,
    logger: console,
    batchSize,
    sampleLimit,
  });

  // The summary IS the deliverable — print it as machine-readable JSON.
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('SECURED-chain-integrity audit failed to complete:', err);
  process.exit(1);
});
