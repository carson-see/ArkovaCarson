#!/usr/bin/env tsx
/**
 * Operator CLI: SECURED-chain-integrity back-catalogue audit (SCRUM-2486 AC-2).
 *
 * STRICTLY READ-ONLY. Resolves the service-role Supabase client from explicit
 * environment variables first (for isolated staging/admission rigs), then falls
 * back to prod Secret Manager (same pattern as `check-anchor-status.ts`). Runs
 * the read-only audit library and prints the structured JSON summary. Never
 * writes / mutates / backfills. Safe to run against prod at any time.
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
import { pathToFileURL } from 'url';
import { createClient } from '@supabase/supabase-js';

import {
  runSecuredChainIntegrityAudit,
  DEFAULT_BATCH_SIZE,
  DEFAULT_SAMPLE_LIMIT,
} from '../src/jobs/auditSecuredChainIntegrity.js';

dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

type Env = NodeJS.ProcessEnv;
type SecretReader = (secret: string) => string;

interface SupabaseCredentials {
  url: string;
  key: string;
  source: 'staging-env' | 'generic-env' | 'prod-secret-manager';
}

const GCP_ENV =
  'GOOGLE_APPLICATION_CREDENTIALS=/Users/carson/.config/gcloud/application_default_credentials.json';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pairFromEnv(
  env: Env,
  urlName: 'STAGING_SUPABASE_URL' | 'SUPABASE_URL',
  keyName: 'STAGING_SUPABASE_SERVICE_ROLE_KEY' | 'SUPABASE_SERVICE_ROLE_KEY',
): { url: string; key: string } | undefined {
  const url = env[urlName]?.trim();
  const key = env[keyName]?.trim();
  if (url && key) {
    return { url, key };
  }
  if (url || key) {
    throw new Error(
      `Both ${urlName} and ${keyName} are required when either one is set`,
    );
  }
  return undefined;
}

function readProdSecret(secret: string): string {
  return execSync(
    `${GCP_ENV} gcloud secrets versions access latest --secret=${secret} --project=arkova1`,
    { encoding: 'utf-8' },
  ).trim();
}

export function resolveSupabaseCredentials(
  env: Env = process.env,
  readSecret: SecretReader = readProdSecret,
): SupabaseCredentials {
  const staging = pairFromEnv(
    env,
    'STAGING_SUPABASE_URL',
    'STAGING_SUPABASE_SERVICE_ROLE_KEY',
  );
  if (staging) {
    return { ...staging, source: 'staging-env' };
  }

  const generic = pairFromEnv(env, 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  if (generic) {
    return { ...generic, source: 'generic-env' };
  }

  return {
    url: readSecret('supabase-url'),
    key: readSecret('supabase-service-role-key'),
    source: 'prod-secret-manager',
  };
}

async function main(): Promise<void> {
  const batchSize = Number(argValue('--batch-size') ?? DEFAULT_BATCH_SIZE);
  const sampleLimit = Number(argValue('--sample-limit') ?? DEFAULT_SAMPLE_LIMIT);
  const { url, key } = resolveSupabaseCredentials();

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

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((err) => {
    console.error('SECURED-chain-integrity audit failed to complete:', err);
    process.exit(1);
  });
}
