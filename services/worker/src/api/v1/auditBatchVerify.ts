/**
 * Audit Batch Verification API (COMP-06)
 *
 * POST /api/v1/audit/batch-verify — Batch verify credentials for audit sampling
 *
 * Supports:
 * - Direct: provide credential_ids array
 * - Sampling: provide sample_percentage + seed for reproducible random sampling (ISA 530)
 *
 * Returns per-credential pass/fail with anomaly detection.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getCallerOrgId, isCallerOrgAdmin } from '../_org-auth.js';
import { chunkForInFilter, POSTGREST_ROW_LIMIT } from '../../utils/postgrest-filter.js';
import type { Database } from '../../types/database.types.js';

const router = Router();

/**
 * Largest population this endpoint will scan for a `sample_percentage` request.
 *
 * The population is read a page at a time, so the ceiling is really a cap on
 * round trips (25 pages plus the one that proves there is no 26th). Above it
 * the endpoint REFUSES rather than sampling as far as it got: a sample drawn
 * from a prefix of the population is not a weaker answer than a full one, it is
 * a wrong one, and the auditor has no way to tell from the response.
 *
 * Raising this materially means moving the sampling into Postgres (a
 * `TABLESAMPLE`/reservoir RPC returning sample + true population in one call),
 * not adding pages here.
 */
export const MAX_SAMPLEABLE_POPULATION = 25_000;

/**
 * Largest sample one response may carry — the same 1000 the `credential_ids`
 * path has always been capped at, so both routes into this handler are bounded
 * identically and the downstream `.in()` lookup sees the same worst case.
 */
export const MAX_SAMPLE_SIZE = 1_000;

const batchVerifySchema = z.object({
  credential_ids: z.array(z.string()).max(1000).optional(),
  sample_percentage: z.number().min(0.1).max(100).optional(),
  seed: z.number().int().optional(),
}).refine(
  d => d.credential_ids || d.sample_percentage,
  { message: 'Provide credential_ids or sample_percentage' },
);

/**
 * The anchor columns the sample lookup reads. Picked from the generated row
 * type so a schema change breaks the build here rather than silently changing
 * an audit verdict.
 */
type AnchorVerifyRow = Pick<
  Database['public']['Tables']['anchors']['Row'],
  'public_id' | 'status' | 'fingerprint' | 'chain_timestamp' | 'chain_tx_id' | 'created_at'
>;

interface VerifyResult {
  public_id: string;
  status: 'PASS' | 'FAIL' | 'NOT_FOUND';
  anchor_status: string | null;
  fingerprint: string | null;
  secured_at: string | null;
  tx_id: string | null;
  anomalies: string[];
}

/**
 * Seeded PRNG for reproducible sampling (ISA 530 requires auditors to reproduce results).
 *
 * Divides by 2^32, not by `0xffffffff`. The old divisor made the maximum draw
 * exactly 1.0, and `Math.floor(1.0 * (i + 1))` is `i + 1` — one past the end of
 * whatever array the caller is indexing. The LCG has full period over 2^32, so
 * the state that produces it is reachable, not theoretical.
 */
export function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0x1_0000_0000;
  };
}

/**
 * Seeded Fisher-Yates. The only supported way to shuffle a sample here.
 *
 * The previous `[...rows].sort(() => rng() - 0.5)` was not a shuffle. A
 * comparator returning a random sign is not a consistent ordering, so what it
 * produces is a function of the sort algorithm's comparison schedule rather
 * than of the randomness — the quality of the PRNG behind it is irrelevant.
 * Measured under V8's TimSort over a 16-element population: the element at
 * index 0 was selected into the first slot 340 times in 2000 trials against a
 * uniform expectation of 125, and the element at index 1 only 77.
 *
 * For ISA 530 that is disqualifying, not untidy. If a row's selection
 * probability depends on its position in the result set, the sample is not
 * random and nothing an auditor concludes from it generalises to the
 * population.
 *
 * `Math.min(i, …)` clamps the index rather than trusting `rng()` to stay below
 * 1: an out-of-range swap here does not throw, it puts `undefined` into the
 * array, and `undefined` would leave this endpoint as a sampled credential id.
 */
export function seededShuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Read every active `public_id` for an org, one PostgREST page at a time.
 *
 * The bug this replaces: `db.from('anchors').select('public_id').eq('org_id', …)`
 * with no `.range()`. PostgREST answers with its default 1000-row maximum and
 * says nothing about the rest, so on the real DocuSign org (3,151,539 anchors)
 * the "population" was an arbitrary 1000 rows — and the sample drawn from it
 * was reported next to a `total_population` taken from a separate exact count
 * over all 3.1M.
 *
 * `truncated` is deliberately distinct from an error: the caller must decide
 * what to do with a population it could not finish reading, and here that
 * decision is to refuse. Ordering is total (`created_at` then `public_id`)
 * because offset paging over a non-deterministic order silently drops and
 * duplicates rows across page boundaries; `created_at` leads so the scan rides
 * `idx_anchors_org_deleted_created` (org_id, created_at DESC) WHERE deleted_at
 * IS NULL, and ASC keeps concurrent inserts appending past the cursor instead
 * of shifting every page under it.
 */
async function loadOrgPopulation(
  orgId: string,
): Promise<{ ids: string[]; truncated: boolean }> {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (let offset = 0; ; offset += POSTGREST_ROW_LIMIT) {
    const { data, error } = await db
      .from('anchors')
      .select('public_id')
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .order('public_id', { ascending: true })
      .range(offset, offset + POSTGREST_ROW_LIMIT - 1);

    if (error) {
      // Driver CODE only, never `.message` — a Postgres/PostgREST message
      // routinely echoes the offending value back, and this is the same
      // discipline the chunked lookup below uses.
      logger.error(
        { pgCode: (error as { code?: string } | null)?.code ?? null, offset, orgId },
        'Audit batch verify: population scan page failed — refusing to sample a partial population',
      );
      throw new Error(`audit batch verify: population scan failed at offset ${offset}`);
    }

    const page = data ?? [];
    for (const row of page) {
      // Dedupe defensively: a row inserted mid-scan shifts later offsets, and a
      // repeated id would otherwise inflate the population figure the response
      // reports as fact.
      if (row.public_id && !seen.has(row.public_id)) {
        seen.add(row.public_id);
        ids.push(row.public_id);
      }
    }

    // Ceiling first. Checking the short page first would let a population of
    // exactly MAX + 1 through as complete, because its final page is short —
    // the one boundary where "we read everything" and "we read too much" are
    // both true of the same request.
    if (ids.length > MAX_SAMPLEABLE_POPULATION) return { ids, truncated: true };

    // A short page is the end of the population — no further request needed.
    if (page.length < POSTGREST_ROW_LIMIT) return { ids, truncated: false };
  }
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = batchVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
      return;
    }

    const { credential_ids, sample_percentage, seed } = parsed.data;

    // Get user's org (owner-inclusive: resolves via profiles.org_id, then
    // checks org_members owner/admin OR profile ORG_ADMIN OR platform admin).
    const orgId = await getCallerOrgId(userId);
    if (!orgId || !(await isCallerOrgAdmin(userId, orgId))) {
      res.status(403).json({ error: 'Organization administrator role required' });
      return;
    }

    let targetIds: string[] = [];

    // The population the sample was actually drawn from. Reported verbatim as
    // `total_population`, so the response cannot claim a population that was
    // never scanned. `null` on the `credential_ids` path, which has no
    // population.
    let sampledPopulation: number | null = null;

    // The seed the sample was drawn with, echoed so the auditor can replay it.
    // `seed: seed || null` previously told an unseeded caller nothing, which
    // left ISA 530's reproducibility guarantee unmeetable for exactly the
    // requests that most needed it.
    let responseSeed: number | null = null;

    if (credential_ids) {
      targetIds = credential_ids;
    } else if (sample_percentage) {
      const { ids: population, truncated } = await loadOrgPopulation(orgId);

      if (truncated) {
        // No sample and no population figure. The only honest thing we know is
        // a lower bound on the population, and it is labelled as one.
        res.status(422).json({
          error: 'population_too_large',
          // Reads correctly both as an API message and verbatim in the auditor
          // UI, which surfaces this string (`src/pages/AuditorBatchPage.tsx`).
          // "records" is the product-facing word there.
          message:
            `This organization has more than ${MAX_SAMPLEABLE_POPULATION.toLocaleString('en-US')} ` +
            'records, which is more than percentage sampling can read in one request. ' +
            'Supply credential_ids to verify a specific set.',
          population_at_least: MAX_SAMPLEABLE_POPULATION,
          max_sampleable_population: MAX_SAMPLEABLE_POPULATION,
        });
        return;
      }

      const sampleSize = Math.ceil(population.length * (sample_percentage / 100));

      if (sampleSize > MAX_SAMPLE_SIZE) {
        // Silently trimming to the cap would report an N% sample that is not an
        // N% sample. Refuse, and say what would have fitted.
        const maxPercentage = Math.min(
          100,
          Math.floor((MAX_SAMPLE_SIZE / population.length) * 100 * 100) / 100,
        );
        res.status(422).json({
          error: 'sample_too_large',
          message:
            `A ${sample_percentage}% sample of ${population.length.toLocaleString('en-US')} ` +
            `records is ${sampleSize.toLocaleString('en-US')} records, above the ` +
            `${MAX_SAMPLE_SIZE.toLocaleString('en-US')} this endpoint returns in one response. ` +
            `Request at most ${maxPercentage}%.`,
          total_population: population.length,
          requested_sample_size: sampleSize,
          max_sample_size: MAX_SAMPLE_SIZE,
          max_sample_percentage: maxPercentage,
        });
        return;
      }

      // `?? Date.now()` and not `|| Date.now()`: seed 0 is a seed. `seed ||` sent
      // the one value an auditor is most likely to type down the unseeded path,
      // making it the single least reproducible request the endpoint accepted.
      const sampleSeed = seed ?? Math.floor(Math.random() * 2 ** 31);
      responseSeed = sampleSeed;
      sampledPopulation = population.length;
      targetIds = seededShuffle(population, seededRandom(sampleSeed)).slice(0, sampleSize);
    }

    // Batch verify
    const results: VerifyResult[] = [];

    // Fetch the sampled anchors.
    //
    // This was one `.in('public_id', targetIds)` over up to 1000 ids — roughly
    // twice the PostgREST URL budget — with the error discarded. The request
    // took 400 Bad Request, `anchors` came back null, and every id in the
    // sample was reported NOT_FOUND at HTTP 200: a confident, reproducible and
    // completely false compliance answer, which on an audit surface is worse
    // than a failure.
    //
    // ANY chunk error is fatal here, which is deliberately stricter than
    // `assertNotAllChunksFailed` (that only refuses the all-failed case). A
    // sample missing one chunk is not a partial answer — it is a wrong one,
    // and it would be signed off as if it were complete. The throw is caught
    // by this route's handler and returned as 500, before the
    // AUDIT_BATCH_VERIFY event is written.
    const anchorMap = new Map<string, AnchorVerifyRow>();
    for (const { values, start } of chunkForInFilter([...new Set(targetIds)])) {
      const { data: anchors, error } = await db
        .from('anchors')
        .select('public_id, status, fingerprint, chain_timestamp, chain_tx_id, created_at')
        .in('public_id', values)
        .is('deleted_at', null);

      if (error) {
        logger.error(
          { pgCode: (error as { code?: string } | null)?.code ?? null, chunkStart: start, chunkSize: values.length, orgId },
          'Audit batch verify: anchor lookup chunk failed — refusing to report the sample as NOT_FOUND',
        );
        throw new Error(`audit batch verify: anchor lookup failed at chunk offset ${start}`);
      }

      for (const anchor of anchors ?? []) {
        if (anchor.public_id) anchorMap.set(anchor.public_id, anchor);
      }
    }

    for (const id of targetIds) {
      const anchor = anchorMap.get(id);
      if (!anchor) {
        results.push({
          public_id: id,
          status: 'NOT_FOUND',
          anchor_status: null,
          fingerprint: null,
          secured_at: null,
          tx_id: null,
          anomalies: ['Credential not found in database'],
        });
        continue;
      }

      const anomalies: string[] = [];

      // Anomaly: anchor delay >24h
      if (anchor.created_at && anchor.chain_timestamp) {
        const delay = new Date(anchor.chain_timestamp).getTime() - new Date(anchor.created_at).getTime();
        if (delay > 24 * 3600_000) {
          anomalies.push(`Anchor delay: ${Math.round(delay / 3600_000)}h between submission and confirmation`);
        }
      }

      // Anomaly: still PENDING after 48h
      if (anchor.status === 'PENDING') {
        const age = Date.now() - new Date(anchor.created_at).getTime();
        if (age > 48 * 3600_000) {
          anomalies.push(`Stale PENDING: created ${Math.round(age / 3600_000)}h ago, still not anchored`);
        }
      }

      // Anomaly: REVOKED status
      if (anchor.status === 'REVOKED') {
        anomalies.push('Credential has been revoked');
      }

      // Anomaly: missing fingerprint
      if (!anchor.fingerprint) {
        anomalies.push('Missing fingerprint — data integrity issue');
      }

      results.push({
        public_id: anchor.public_id!,
        status: anchor.status === 'SECURED' ? 'PASS' : 'FAIL',
        anchor_status: anchor.status,
        fingerprint: anchor.fingerprint,
        secured_at: anchor.chain_timestamp ?? null,
        tx_id: anchor.chain_tx_id ?? null,
        anomalies,
      });
    }

    // Audit event
    await db.from('audit_events').insert({
      event_type: 'AUDIT_BATCH_VERIFY',
      event_category: 'SYSTEM',
      org_id: orgId,
      details: JSON.stringify({
        total_verified: results.length,
        passed: results.filter(r => r.status === 'PASS').length,
        failed: results.filter(r => r.status === 'FAIL').length,
        not_found: results.filter(r => r.status === 'NOT_FOUND').length,
        anomalies_found: results.filter(r => r.anomalies.length > 0).length,
        sampling: sample_percentage
          ? { percentage: sample_percentage, seed: responseSeed }
          : undefined,
      }),
    });

    // The population figure comes from the scan the sample was drawn from — NOT
    // from a second query. The exact-count head query this replaces ran
    // separately and later, so even with a correct scan the two could disagree,
    // and it was a full count over a 3.1M-row table on the hot `anchors` path
    // (R0-8 / SCRUM-1254, `scripts/ci/check-count-exact-baseline.ts`).
    const totalPopulation = sampledPopulation ?? targetIds.length;

    res.json({
      results,
      summary: {
        total_verified: results.length,
        passed: results.filter(r => r.status === 'PASS').length,
        failed: results.filter(r => r.status === 'FAIL').length,
        not_found: results.filter(r => r.status === 'NOT_FOUND').length,
        anomalies_found: results.filter(r => r.anomalies.length > 0).length,
      },
      total_population: totalPopulation,
      sample_size: results.length,
      seed: responseSeed,
      verified_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({
      error: err instanceof Error ? err.message : String(err),
    }, 'Audit batch verify failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as auditBatchVerifyRouter };
