#!/usr/bin/env npx tsx
/**
 * NPH-03: Batch Embedding Backfill Script
 *
 * Embeds all 1.34M unembedded public records in a long-running loop.
 * Designed for Cloud Run jobs or local execution with progress tracking.
 *
 * Usage:
 *   npx tsx scripts/backfill-embeddings.ts [--dry-run] [--limit N]
 *
 * Requires: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { embedPublicRecords } from '../src/jobs/publicRecordEmbedder.js';
import { db } from '../src/utils/db.js';
import { logger } from '../src/utils/logger.js';

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const maxRecords = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;

async function main() {
  logger.info({ isDryRun, maxRecords }, 'NPH-03: Starting embedding backfill');

  // Check how many records need embedding
  const { data: stats } = await db.rpc('get_pipeline_stats');
  const totalRecords = stats?.total_records ?? 0;
  const embeddedRecords = stats?.embedded_records ?? 0;
  const unembedded = totalRecords - embeddedRecords;

  logger.info({ totalRecords, embeddedRecords, unembedded }, 'Pipeline embedding status');

  if (isDryRun) {
    logger.info('Dry run — exiting without processing');
    return;
  }

  let totalProcessed = 0;
  let totalSucceeded = 0;
  let totalFailed = 0;
  let batchNumber = 0;
  const startTime = Date.now();

  while (totalProcessed < maxRecords) {
    batchNumber++;
    const batchStart = Date.now();

    const result = await embedPublicRecords(db);

    if (result.total === 0) {
      logger.info('No more unembedded records — backfill complete');
      break;
    }

    totalProcessed += result.total;
    totalSucceeded += result.succeeded;
    totalFailed += result.failed;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const batchMs = Date.now() - batchStart;
    const rate = (totalSucceeded / (parseInt(elapsed) || 1)).toFixed(1);

    logger.info({
      batch: batchNumber,
      batchTotal: result.total,
      batchSucceeded: result.succeeded,
      batchFailed: result.failed,
      batchMs,
      cumulative: { processed: totalProcessed, succeeded: totalSucceeded, failed: totalFailed },
      elapsed: `${elapsed}s`,
      rate: `${rate} rec/s`,
    }, `Batch ${batchNumber} complete`);

    if (result.errors.length > 0) {
      logger.warn({ errors: result.errors.slice(0, 5) }, 'Sample errors from batch');
    }

    // Brief pause between batches to avoid sustained API pressure
    await new Promise((r) => setTimeout(r, 500));
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  logger.info({
    totalProcessed,
    totalSucceeded,
    totalFailed,
    batches: batchNumber,
    elapsed: `${totalElapsed}s`,
  }, 'NPH-03: Embedding backfill finished');
}

main().catch((err) => {
  logger.error({ error: err }, 'Backfill script failed');
  process.exit(1);
});
