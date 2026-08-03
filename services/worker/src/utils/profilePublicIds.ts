/**
 * Actor-id -> profile `public_id` attribution for legal-evidence artifacts.
 *
 * `anchor-evidence.ts` and `anchor-lifecycle.ts` each had a byte-identical
 * private copy of this lookup, and both carried both halves of the PostgREST
 * `.in()` defect class: an unbounded id filter over actor ids drawn from an
 * unlimited `audit_events` select, and `const { data } = …` discarding the
 * error. A 400 on that read resolved to `data: null`, the map came back empty,
 * and both endpoints answered HTTP 200 with every lifecycle entry silently
 * missing its actor — an evidence package that quietly loses attribution is
 * worse than one that fails, because a court-facing artifact reads as
 * "no actor recorded" rather than "we could not tell you".
 *
 * One copy, so a fix cannot again land at one call site and miss the other —
 * which is exactly how #1795 shipped a fix covering two of three loops.
 */
import { assertNotAllChunksFailed, chunkForInFilter } from './postgrest-filter.js';
import { logger } from './logger.js';

/** The subset of the Supabase client this lookup needs. */
type ProfileQueryClient = {
  from: (table: string) => {
    select: (columns: string) => {
      in: (
        column: string,
        values: string[],
      ) => PromiseLike<{
        data: Array<{ id: string; public_id: string | null }> | null;
        error: unknown;
      }>;
    };
  };
};

/**
 * Map actor ids to profile `public_id`s, chunked to stay inside the PostgREST
 * request-line budget.
 *
 * Error policy — deliberately a PARTIAL result, not fail-closed: a missing
 * actor already renders as an unattributed lifecycle entry, which is the same
 * shape the endpoint produces for a system actor. Losing one chunk degrades
 * attribution for those actors only. Losing EVERY chunk is a different claim —
 * "this credential has no recorded actors" — so `assertNotAllChunksFailed`
 * turns that into a throw the router converts to a 500 rather than a
 * confidently wrong 200.
 */
export async function fetchProfilePublicIdsByActorIds(
  db: ProfileQueryClient,
  actorIds: readonly string[],
  label: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (actorIds.length === 0) return out;

  const chunks = chunkForInFilter([...actorIds]);
  let failedChunks = 0;

  for (const { values, start } of chunks) {
    const { data, error } = await db
      .from('profiles')
      .select('id, public_id')
      .in('id', values);

    if (error) {
      failedChunks += 1;
      // No actor ids in the log line — they are user ids (Constitution §1.4).
      logger.warn(
        { error, label, chunkStart: start, chunkSize: values.length },
        'profile public_id lookup chunk failed; actor attribution degraded for this chunk',
      );
      continue;
    }

    for (const row of data ?? []) {
      if (row.public_id) out.set(row.id, row.public_id);
    }
  }

  assertNotAllChunksFailed(
    'fetchProfilePublicIdsByActorIds',
    chunks.length,
    failedChunks,
    `${label} (${actorIds.length} actor ids)`,
  );

  return out;
}
