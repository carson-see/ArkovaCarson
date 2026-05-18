/**
 * USPTO Patent Fetcher Job
 *
 * Fetches patent grants from PatentsView bulk TSV download (S3).
 * The PatentsView REST API was shut down March 2026 — this uses the
 * bulk data files which are still available on S3.
 *
 * Source: https://s3.amazonaws.com/data.patentsview.org/download/g_patent.tsv.zip
 * Updated weekly (Tuesdays). ~230MB compressed, ~4M patents.
 *
 * Strategy: Download ZIP, stream-extract TSV, parse line-by-line,
 * insert in batches. Resumable via last patent_date in DB.
 * Capped at MAX_PER_RUN to avoid Cloud Run timeouts.
 *
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 */

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import unzipper from 'unzipper';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** PatentsView bulk data S3 URL */
const PATENT_TSV_URL = 'https://s3.amazonaws.com/data.patentsview.org/download/g_patent.tsv.zip';

/** Max patents to insert per run (Cloud Run has ~10min timeout) */
const MAX_PER_RUN = 5000;

/** Batch size for Supabase inserts */
const INSERT_BATCH_SIZE = 100;

interface FetchResult {
  status: string;
  inserted: number;
  skipped: number;
  errors: number;
  resumeDate: string;
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Fetch USPTO patent grants from PatentsView bulk TSV and insert into public_records.
 * Resumable: skips patents with dates before the most recent patent in DB.
 */
export async function fetchUsptoPAtents(supabase: SupabaseClient): Promise<FetchResult> {
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping USPTO fetch');
    return { status: 'disabled', inserted: 0, skipped: 0, errors: 0, resumeDate: '' };
  }

  // Determine resume point
  const { data: lastRecord } = await supabase
    .from('public_records')
    .select('metadata')
    .eq('source', 'uspto')
    .order('created_at', { ascending: false })
    .limit(1);

  const resumeDate = lastRecord?.[0]?.metadata?.patent_date
    ? String((lastRecord[0].metadata as Record<string, string>).patent_date)
    : '2020-01-01';

  logger.info({ resumeDate, maxPerRun: MAX_PER_RUN }, 'USPTO bulk fetch starting');

  // Download the ZIP
  let response: Response;
  try {
    response = await fetch(PATENT_TSV_URL);
  } catch (err) {
    logger.error({ error: err }, 'Failed to download PatentsView bulk data');
    return { status: 'download_failed', inserted: 0, skipped: 0, errors: 0, resumeDate };
  }

  if (!response.ok || !response.body) {
    logger.error({ status: response.status }, 'PatentsView bulk data HTTP error');
    return { status: 'download_failed', inserted: 0, skipped: 0, errors: 0, resumeDate };
  }

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  try {
    const nodeStream = Readable.fromWeb(response.body as import('stream/web').ReadableStream);

    // Parse ZIP and process entries
    await new Promise<void>((resolve, reject) => {
      const zip = nodeStream.pipe(unzipper.Parse());

      zip.on('entry', async (entry: unzipper.Entry) => {
        if (!entry.path.endsWith('.tsv')) {
          entry.autodrain();
          return;
        }

        logger.info({ file: entry.path, size: entry.vars?.compressedSize }, 'Processing TSV entry');

        let headers: string[] = [];
        let isFirstLine = true;
        const insertBatch: Array<Record<string, unknown>> = [];

        const rl = createInterface({ input: entry, crlfDelay: Infinity });

        for await (const line of rl) {
          if (isFirstLine) {
            headers = line.split('\t').map((h: string) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
            isFirstLine = false;
            logger.info({ headers: headers.slice(0, 6) }, 'USPTO TSV headers parsed');
            continue;
          }

          if (totalInserted >= MAX_PER_RUN) {
            rl.close();
            break;
          }

          const fields = line.split('\t');
          if (fields.length < 3) continue;

          const record: Record<string, string> = {};
          for (let i = 0; i < headers.length && i < fields.length; i++) {
            record[headers[i]] = (fields[i] ?? '').replace(/^"|"$/g, '');
          }

          const patentId = record.patent_id;
          const patentDate = record.patent_date;
          if (!patentId || !patentDate) continue;

          // Skip patents before resume date
          if (patentDate <= resumeDate) {
            totalSkipped++;
            continue;
          }

          const title = record.patent_title || `US Patent ${patentId}`;
          const abstract = (record.patent_abstract || '').slice(0, 2000);

          insertBatch.push({
            source: 'uspto',
            source_id: patentId,
            source_url: `https://patents.google.com/patent/US${patentId}`,
            record_type: 'patent_grant',
            title,
            content_hash: computeContentHash(JSON.stringify({ patent_id: patentId, title, date: patentDate })),
            metadata: {
              patent_id: patentId,
              patent_type: record.patent_type || 'utility',
              patent_date: patentDate,
              abstract,
            },
          });

          // Flush batch
          if (insertBatch.length >= INSERT_BATCH_SIZE) {
            const { error: insertError } = await supabase
              .from('public_records')
              .upsert(insertBatch, { onConflict: 'source,source_id', ignoreDuplicates: true });

            if (insertError) {
              logger.error({ error: insertError, batch: insertBatch.length }, 'USPTO batch insert failed');
              totalErrors += insertBatch.length;
            } else {
              totalInserted += insertBatch.length;
            }
            insertBatch.length = 0;

            if (totalInserted % 1000 === 0 && totalInserted > 0) {
              logger.info({ inserted: totalInserted, skipped: totalSkipped }, 'USPTO progress');
            }
          }
        }

        // Flush remaining
        if (insertBatch.length > 0) {
          const { error: insertError } = await supabase
            .from('public_records')
            .upsert(insertBatch, { onConflict: 'source,source_id', ignoreDuplicates: true });

          if (insertError) {
            totalErrors += insertBatch.length;
          } else {
            totalInserted += insertBatch.length;
          }
        }

        resolve();
      });

      zip.on('error', reject);
      zip.on('close', resolve);
    });
  } catch (err) {
    logger.error({ error: err }, 'USPTO stream processing error');
    totalErrors++;
  }

  logger.info({ totalInserted, totalSkipped, totalErrors }, 'USPTO bulk fetch complete');
  return {
    status: 'complete',
    inserted: totalInserted,
    skipped: totalSkipped,
    errors: totalErrors,
    resumeDate,
  };
}
