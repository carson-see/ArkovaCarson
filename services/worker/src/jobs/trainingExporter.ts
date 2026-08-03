/**
 * Training Data Exporter (PH1-DATA-02)
 *
 * Exports public_records as JSONL for Nessie training pipeline.
 * Marks exported records so they are not re-exported.
 *
 * Constitution refs:
 *   - 4A: Only metadata is stored server-side (no raw documents)
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { assertNotAllChunksFailed, chunkForInFilter } from '../utils/postgrest-filter.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Maximum records per export batch */
const EXPORT_BATCH_SIZE = 1000;

interface TrainingRecord {
  text: string;
  source_url: string | null;
  record_type: string;
  metadata: Record<string, unknown>;
  fingerprint: string;
}

/**
 * Export unexported public_records as JSONL for Nessie training.
 *
 * - Queries records WHERE training_exported = false
 * - Writes JSONL to config.trainingDataOutputPath
 * - Marks records as exported
 */
export async function exportTrainingData(supabase: SupabaseClient): Promise<{
  exported: number;
  errors: number;
}> {
  const outputPath = config.trainingDataOutputPath;
  if (!outputPath) {
    logger.info('TRAINING_DATA_OUTPUT_PATH not set — skipping training export');
    return { exported: 0, errors: 0 };
  }

  const { data: records, error: fetchError } = await supabase
    .from('public_records')
    .select('id, title, source_url, record_type, metadata, content_hash')
    .eq('training_exported', false)
    .order('created_at', { ascending: true })
    .limit(EXPORT_BATCH_SIZE);

  if (fetchError) {
    logger.error({ error: fetchError }, 'Failed to fetch unexported records');
    return { exported: 0, errors: 1 };
  }

  if (!records || records.length === 0) {
    logger.info('No unexported records found');
    return { exported: 0, errors: 0 };
  }

  logger.info({ count: records.length }, 'Exporting training records');

  // Ensure output directory exists
  mkdirSync(dirname(outputPath), { recursive: true });

  const exportedIds: string[] = [];
  let errors = 0;

  for (const record of records) {
    const line: TrainingRecord = {
      text: record.title ?? '',
      source_url: record.source_url,
      record_type: record.record_type,
      metadata: (record.metadata as Record<string, unknown>) ?? {},
      fingerprint: record.content_hash,
    };

    try {
      appendFileSync(outputPath, JSON.stringify(line) + '\n', 'utf-8');
      exportedIds.push(record.id);
    } catch (err) {
      logger.error({ error: err, recordId: record.id }, 'Failed to write training record');
      errors++;
    }
  }

  // Mark exported records.
  //
  // This is the load-bearing half of the job: the rows have ALREADY been
  // appended to the JSONL corpus on disk, and `training_exported` is the only
  // thing stopping the next tick from selecting and appending them again. The
  // filter took the whole page (`.limit(1000)` upstream) in one `.in()`, which
  // is several times the request-line budget, so the update took a 400 and the
  // flag was never set — every tick re-selected the same rows and re-appended
  // them, growing the corpus with duplicates without bound.
  //
  // Chunked, and an all-chunks-failed mark THROWS rather than returning a
  // success-shaped result: the caller cannot distinguish "exported 1000" from
  // "exported 1000 again for the ninth time" on its own, and a cron failure is
  // the signal that stops the loop.
  let failedChunks = 0;
  const chunks = chunkForInFilter(exportedIds);
  for (const { values, start } of chunks) {
    const { error: updateError } = await supabase
      .from('public_records')
      .update({ training_exported: true })
      .in('id', values);

    if (updateError) {
      failedChunks++;
      errors++;
      logger.error(
        { error: updateError, chunkStart: start, chunkSize: values.length },
        'Failed to mark records as exported — these rows WILL be re-exported next tick',
      );
    }
  }

  assertNotAllChunksFailed(
    'trainingExporter.markExported',
    chunks.length,
    failedChunks,
    `${exportedIds.length} record(s) already appended to ${outputPath}`,
  );

  logger.info({ exported: exportedIds.length, errors }, 'Training export complete');
  return { exported: exportedIds.length, errors };
}
