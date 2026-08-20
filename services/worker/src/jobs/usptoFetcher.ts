/**
 * USPTO Patent Fetcher Job
 *
 * Strategy: Download ZIP, stream-extract TSV, parse line-by-line,
 * insert in batches. Resumable via last patent_date in DB.
 * Capped at MAX_PER_RUN to avoid Cloud Run timeouts.
 *
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ROUTE STATUS: DECLARED-UNTESTED — no reachable bulk source (BUG-023)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * This fetcher previously hardcoded the PatentsView bulk file at
 * `s3.amazonaws.com/data.patentsview.org/download/g_patent.tsv.zip`. That
 * bucket now returns `<Error><Code>AccessDenied</Code></Error>` (HTTP 403).
 * Confirmed 2026-08-15 from a NON-CLOUD residential IP, so it is not blocked
 * Cloud Run egress — the bucket access was revoked.
 *
 * Cause: PatentsView migrated to the USPTO Open Data Portal on 2026-03-20
 * (`https://data.uspto.gov/support/transition-guide/patentsview`). The
 * replacement is NOT reachable without a new credential:
 *
 *   - `https://api.uspto.gov/api/v1/datasets/…` → HTTP 401 without an ODP
 *     API key (verified 2026-08-15).
 *   - Since 2026-06-18 an ODP API key additionally requires a USPTO.gov
 *     account with MFA, and from 2026-08-18 extra profile fields on pain of
 *     losing key access.
 *
 * Arkova holds no such credential, so there is no endpoint this fetcher can
 * be pointed at today and no way to prove a replacement works. Rather than
 * ship a speculative, unexercised ODP code path that would "look fixed", the
 * source URL is now EXPLICIT CONFIGURATION (`USPTO_BULK_TSV_URL`, or the
 * `sourceUrl` option) and the job REFUSES TO RUN when it is unset — returning
 * `status: 'source_unavailable'` with a non-zero error count so
 * `routes/ingestionResponse.ts` answers non-2xx instead of the old
 * `200 {"status":"download_failed","errors":0}`.
 *
 * To re-enable: obtain an ODP API key, confirm a bulk TSV/ZIP URL that this
 * streaming parser can consume unauthenticated (or extend it to send the key),
 * set `USPTO_BULK_TSV_URL`, and only then delete this banner. The TSV column
 * contract below (`patent_id`, `patent_date`, `patent_title`,
 * `patent_abstract`, `patent_type`) is unverified against any ODP product.
 */

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import unzipper from 'unzipper';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Bulk patent TSV/ZIP source. There is deliberately NO default — see the
 * DECLARED-UNTESTED banner above. Supplying a URL is an explicit operator act.
 * Read via the typed `config` export (config.ts `usptoBulkTsvUrl`, SCRUM-1258)
 * rather than `process.env` directly, so a Cloud Run typo fails validation at
 * startup instead of silently disabling this fetcher.
 */
function resolveSourceUrl(override?: string): string | undefined {
  const url = override ?? config.usptoBulkTsvUrl;
  return url && url.trim().length > 0 ? url.trim() : undefined;
}

/** Max patents to insert per run (Cloud Run has ~10min timeout) */
const MAX_PER_RUN = 5000;

/** Batch size for Supabase inserts */
const INSERT_BATCH_SIZE = 100;

/**
 * Connect + response-headers bound (Sentry bug, untracked in Jira). Without
 * this, `fetch(PATENT_TSV_URL)` had no timeout/AbortController at all — only
 * a transient-error retry — so a stalled S3 upstream hung the call
 * indefinitely, the same unbounded-fetch class as SCRUM-2975. 30s matches the
 * connect-timeout convention used elsewhere in jobs/ and ai/.
 *
 * Scoped to CONNECT + headers only, via a manual AbortController that is
 * cleared the instant fetch() settles (see fetchWithConnectTimeout) — NOT via
 * a single long-lived AbortSignal spanning the whole call. The ~230MB ZIP
 * body is streamed incrementally afterward (Readable.fromWeb + unzipper +
 * readline) and can legitimately take minutes on a healthy connection; a
 * signal that stayed armed past the initial response would abort that
 * in-progress, healthy stream too.
 *
 * NOT routed through `lib/safe-fetch.ts`: this file is on the
 * `ban-raw-fetch-worker.ts` reviewed allow-list (`jobs/*Fetcher.ts` — fixed
 * S3/registry host, no user-controlled URL), and more importantly
 * `SafeFetchResponse`/`createSafeFetchImpl` only expose a fully-buffered
 * `arrayBuffer()` capped at 5 MiB by default (no streaming `.body`) — that's
 * incompatible with this ~230MB streamed download without either rejecting
 * it outright on the size cap or forcing the whole ZIP into memory before
 * unzipping even starts, which would remove the existing streaming/
 * backpressure design and risk trading a hang bug for an OOM bug.
 */
const USPTO_CONNECT_TIMEOUT_MS = 30_000;

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
 * Fetch `url`, bounding only the CONNECT + response-headers wait to
 * `timeoutMs`. The timer is cleared as soon as fetch() settles (resolve OR
 * reject), so it can never fire during a SEPARATE, later body-streaming read
 * — only a stalled connect/response counts as "hung" here.
 */
export async function fetchWithConnectTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch USPTO patent grants from PatentsView bulk TSV and insert into public_records.
 * Resumable: skips patents with dates before the most recent patent in DB.
 */
export async function fetchUsptoPAtents(
  supabase: SupabaseClient,
  options: { connectTimeoutMs?: number; sourceUrl?: string } = {},
): Promise<FetchResult> {
  const connectTimeoutMs = options.connectTimeoutMs ?? USPTO_CONNECT_TIMEOUT_MS;
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping USPTO fetch');
    return { status: 'disabled', inserted: 0, skipped: 0, errors: 0, resumeDate: '' };
  }

  // BUG-023: no bulk source is reachable without an ODP credential we do not
  // hold. Fail loudly and make no request rather than re-attempting a bucket
  // that has been 403 since the 2026-03-20 PatentsView → USPTO ODP migration.
  const patentTsvUrl = resolveSourceUrl(options.sourceUrl);
  if (!patentTsvUrl) {
    logger.error(
      { envVar: 'USPTO_BULK_TSV_URL' },
      'USPTO bulk source is not configured — the legacy PatentsView S3 bucket returns 403 AccessDenied and its USPTO ODP replacement requires an API key Arkova does not hold. Route is DECLARED-UNTESTED.',
    );
    return { status: 'source_unavailable', inserted: 0, skipped: 0, errors: 1, resumeDate: '' };
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

  // Download the ZIP (single retry on transient TCP errors). Each attempt is
  // bounded to connectTimeoutMs — see fetchWithConnectTimeout / USPTO_CONNECT_TIMEOUT_MS.
  // BUG-020: every `download_failed` return below now carries `errors: 1`. It
  // used to report `errors: 0`, which made a hard 403 indistinguishable from a
  // clean run to anything reading the counters.
  let response: Response;
  try {
    response = await fetchWithConnectTimeout(patentTsvUrl, connectTimeoutMs);
  } catch (err) {
    if (err instanceof TypeError && /terminated|socket hang up|ECONNRESET/i.test(err.message)) {
      logger.warn({ error: err }, 'Transient download failure — retrying once');
      await new Promise((r) => setTimeout(r, 2000));
      try {
        response = await fetchWithConnectTimeout(patentTsvUrl, connectTimeoutMs);
      } catch (retryErr) {
        logger.error({ error: retryErr }, 'Failed to download patent bulk data after retry');
        return { status: 'download_failed', inserted: 0, skipped: 0, errors: 1, resumeDate };
      }
    } else {
      logger.error(
        { error: err, timedOut: err instanceof Error && err.name === 'AbortError' },
        'Failed to download patent bulk data',
      );
      return { status: 'download_failed', inserted: 0, skipped: 0, errors: 1, resumeDate };
    }
  }

  if (!response.ok || !response.body) {
    logger.error({ status: response.status }, 'Patent bulk data HTTP error');
    return { status: 'download_failed', inserted: 0, skipped: 0, errors: 1, resumeDate };
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
