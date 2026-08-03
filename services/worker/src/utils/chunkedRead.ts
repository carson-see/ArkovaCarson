/**
 * Chunked PostgREST reads for enrichment lookups.
 *
 * The second half of the `.in()` defect class, factored once.
 *
 * A dozen call sites shared the same shape: take a list of ids off a page of
 * rows, look up display names / emails / counts / quotas to enrich them, and
 * write `const { data } = await ...` — discarding the error. postgrest-js
 * RESOLVES a failure as `{ data: null, error }` rather than throwing, so the
 * enrichment silently came back empty and the response looked *complete*:
 * every org name `null`, every member count `0`, every quota absent. An admin
 * cannot tell that from an org that genuinely has no members, and on the
 * quota/anchor-count surfaces that is a number someone makes a decision on.
 *
 * `readInChunks` gives all of them one width guarantee and one error policy:
 * per-chunk failures are logged and the partial result is returned (an
 * enrichment miss degrades to the same "unknown" the row already renders),
 * while an ALL-chunks-failed read throws — that is a different claim, and every
 * caller sits inside a handler `try/catch` that turns it into a 500.
 */
import { assertNotAllChunksFailed, chunkForInFilter } from './postgrest-filter.js';
import { logger } from './logger.js';

/**
 * Run a `.in()`-filtered read over `values`, chunked to stay inside the
 * PostgREST request-line budget, and return every row that came back.
 *
 * `fetchChunk` receives one budget-safe slice and must issue exactly one query
 * with it. Do NOT chunk inside the callback.
 *
 * @param label   identifies the read in logs (e.g. `'admin-lists:orgNames'`)
 * @param values  the filter values; projected to strings by the caller so the
 *                values chunked are provably the values sent
 */
export async function readInChunks<T>(
  label: string,
  values: readonly string[],
  fetchChunk: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  if (values.length === 0) return [];

  const chunks = chunkForInFilter([...values]);
  const rows: T[] = [];
  let failedChunks = 0;

  for (const { values: chunk, start } of chunks) {
    const { data, error } = await fetchChunk(chunk);

    if (error) {
      failedChunks += 1;
      // No filter values in the log line — they are ids (Constitution §1.4).
      logger.error(
        { error, label, chunkStart: start, chunkSize: chunk.length },
        'chunked read failed for one chunk; result is partial',
      );
      continue;
    }

    if (data) rows.push(...data);
  }

  assertNotAllChunksFailed('readInChunks', chunks.length, failedChunks, `${label} (${values.length} values)`);

  return rows;
}
