#!/usr/bin/env tsx
/**
 * Direct mainnet migration script.
 * Resets BROADCASTING + SECURED anchors to PENDING for mainnet re-anchoring.
 * Uses service_role to bypass RLS triggers.
 * Processes in small batches with retry logic to handle DB load.
 */
import { execSync } from 'child_process';
import { createClient } from '@supabase/supabase-js';

const BATCH_SIZE = 50; // Small batches to avoid timeouts
const RETRY_DELAY = 2000;
const MAX_RETRIES = 3;

interface AnchorMigrationRecord {
  id: string;
  status: string;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  chain_timestamp: string | null;
  chain_confirmations: number | null;
  metadata: Record<string, unknown> | null;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`  Retry ${attempt}/${MAX_RETRIES} for ${label}: ${(err as Error).message}`);
      if (attempt === MAX_RETRIES) throw err;
      await sleep(RETRY_DELAY * attempt);
    }
  }
  throw new Error('Unreachable');
}

async function main() {
  // Fetch secrets from GCP
  console.log('Fetching credentials from GCP...');
  const gcpEnv = 'GOOGLE_APPLICATION_CREDENTIALS=/Users/carson/.config/gcloud/application_default_credentials.json';
  const url = execSync(`${gcpEnv} gcloud secrets versions access latest --secret=supabase-url --project=arkova1`, { encoding: 'utf-8' }).trim();
  const key = execSync(`${gcpEnv} gcloud secrets versions access latest --secret=supabase-service-role-key --project=arkova1`, { encoding: 'utf-8' }).trim();

  const db = createClient(url, key, {
    db: { schema: 'public' },
    auth: { persistSession: false },
  });

  // Check current state
  console.log('\nCurrent anchor status counts:');
  for (const status of ['PENDING', 'BROADCASTING', 'SUBMITTED', 'SECURED', 'REVOKED']) {
    const { count, error } = await db.from('anchors').select('*', { count: 'exact', head: true }).eq('status', status);
    if (error) console.log(`  ${status}: error - ${error.message}`);
    else console.log(`  ${status}: ${count ?? 0}`);
  }

  // Process BROADCASTING + SECURED anchors in batches
  let totalMigrated = 0;
  let totalErrors = 0;
  let batchNum = 0;
  let consecutiveEmptyBatches = 0;

  while (consecutiveEmptyBatches < 3) {
    let anchors: AnchorMigrationRecord[] | null = null;

    try {
      const result = await withRetry(async () => {
        return db
          .from('anchors')
          .select('id, status, chain_tx_id, chain_block_height, chain_timestamp, chain_confirmations, metadata')
          .in('status', ['BROADCASTING', 'SECURED', 'SUBMITTED'])
          .limit(BATCH_SIZE);
      }, 'fetch batch');

      if (result.error) {
        console.error('Fetch error:', result.error.message);
        totalErrors++;
        await sleep(5000);
        consecutiveEmptyBatches++;
        continue;
      }
      anchors = result.data;
    } catch (err) {
      console.error('Fetch failed after retries:', (err as Error).message);
      totalErrors++;
      await sleep(5000);
      consecutiveEmptyBatches++;
      continue;
    }

    if (!anchors || anchors.length === 0) {
      console.log('No more anchors to migrate.');
      consecutiveEmptyBatches++;
      continue;
    }
    consecutiveEmptyBatches = 0;

    batchNum++;
    const batchStart = Date.now();

    for (const anchor of anchors) {
      const existingMeta = (anchor.metadata as Record<string, unknown>) || {};
      if (existingMeta.mainnet_migrated === true) continue;

      const updatedMeta = {
        ...existingMeta,
        mainnet_migrated: true,
        signet_tx_id: anchor.chain_tx_id || null,
        signet_block_height: anchor.chain_block_height || null,
        signet_timestamp: anchor.chain_timestamp || null,
        signet_confirmations: anchor.chain_confirmations || null,
        signet_status: anchor.status,
        migration_date: new Date().toISOString(),
      };

      try {
        const { error: updateError } = await withRetry(async () => {
          return db
            .from('anchors')
            .update({
              status: 'PENDING',
              chain_tx_id: null,
              chain_block_height: null,
              chain_timestamp: null,
              chain_confirmations: null,
              metadata: updatedMeta,
            })
            .eq('id', anchor.id);
        }, `update ${anchor.id}`);

        if (updateError) {
          console.error(`  Error on ${anchor.id}:`, updateError.message);
          totalErrors++;
        } else {
          totalMigrated++;
        }
      } catch (err) {
        console.error(`  Failed ${anchor.id} after retries:`, (err as Error).message);
        totalErrors++;
      }
    }

    const elapsed = ((Date.now() - batchStart) / 1000).toFixed(1);
    console.log(`Batch ${batchNum}: ${anchors.length} processed in ${elapsed}s (total: ${totalMigrated} migrated, ${totalErrors} errors)`);

    // Small delay between batches
    await sleep(500);
  }

  console.log(`\n=== Migration Complete ===`);
  console.log(`Migrated: ${totalMigrated}`);
  console.log(`Errors: ${totalErrors}`);
  console.log(`Batches: ${batchNum}`);

  // Final state
  console.log('\nFinal anchor status counts:');
  for (const status of ['PENDING', 'BROADCASTING', 'SUBMITTED', 'SECURED', 'REVOKED']) {
    const { count, error } = await db.from('anchors').select('*', { count: 'exact', head: true }).eq('status', status);
    if (error) console.log(`  ${status}: error`);
    else console.log(`  ${status}: ${count ?? 0}`);
  }
}

main().catch(console.error);
