/**
 * Training Data Exporter
 *
 * Exports public_records as JSONL for Nessie model training.
 * Marks records as exported after writing.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Batch size for export queries */
const EXPORT_BATCH_SIZE = 1000;

interface PublicRecord {
  id: string;
  source_url: string;
  record_type: string;
  metadata: Record<string, unknown>;
  content_hash: string;
  title: string | null;
}

/**
 * Format a single record as a JSONL line.
 */
export function formatJsonlLine(record: PublicRecord): string {
  return JSON.stringify({
    text: record.title ?? '',
    source_url: record.source_url,
    record_type: record.record_type,
    metadata: record.metadata,
    fingerprint: record.content_hash,
  });
}

/**
 * Export unexported public_records as JSONL and mark them as exported.
 */
export async function exportTrainingData(supabase: SupabaseClient): Promise<void> {
  const outputPath = config.trainingDataOutputPath ?? './training-data';
  const outputFile = `${outputPath}/nessie-training.jsonl`;

  // Ensure output directory exists
  mkdirSync(dirname(outputFile), { recursive: true });

  const { data: records, error } = await supabase
    .from('public_records')
    .select('id, source_url, record_type, metadata, content_hash, title')
    .eq('training_exported', false)
    .order('created_at', { ascending: true })
    .limit(EXPORT_BATCH_SIZE);

  if (error) {
    logger.error({ error }, 'Failed to query unexported public_records');
    return;
  }

  if (!records || records.length === 0) {
    logger.info('No unexported records to export');
    return;
  }

  logger.info({ count: records.length }, 'Exporting training data');

  // Write JSONL lines
  const lines = records.map((r) => formatJsonlLine(r as PublicRecord)).join('\n') + '\n';
  appendFileSync(outputFile, lines, 'utf-8');

  // Mark as exported
  const ids = records.map((r) => r.id);
  const { error: updateError } = await supabase
    .from('public_records')
    .update({ training_exported: true })
    .in('id', ids);

  if (updateError) {
    logger.error({ error: updateError }, 'Failed to mark records as exported');
    return;
  }

  logger.info({ exportedCount: records.length, outputFile }, 'Training data export complete');
}
