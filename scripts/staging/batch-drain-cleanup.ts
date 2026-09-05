/**
 * scripts/staging/batch-drain-cleanup.ts — checked cleanup for
 * scripts/staging/batch-drain-harness.ts (SCRUM-3531).
 *
 * Split out (mirrors batch-drain-harness-lib.ts) so the fail-on-every-delete
 * contract is unit-testable: the harness entrypoint runs main() on load and
 * needs live rig credentials. This module performs I/O ONLY through the
 * injected client; nothing runs at import time.
 *
 * Why every delete must be checked (§1.11A): the previous cleanup checked
 * only the anchors delete. A permission, FK, or transient DB error on an
 * anchor_proofs chunk, org_credits, or organizations delete was silently
 * swallowed — the harness still reported successful cleanup and wrote
 * evidence while synthetic rows remained on the isolated rig, contaminating
 * every later soak that used it. Cleanup therefore fails on the FIRST failed
 * delete and then re-asserts zero remaining rows for the synthetic org
 * before reporting success (a delete can "succeed" while removing zero rows,
 * e.g. when a policy filters it — only the re-assert proves the rig clean).
 */

export interface CleanupQueryError {
  message?: string;
}

export interface CleanupDeleteResult {
  error: CleanupQueryError | null;
}

export interface CleanupCountResult {
  count: number | null;
  error: CleanupQueryError | null;
}

export interface CleanupDeleteBuilder {
  in(column: string, values: readonly string[]): PromiseLike<CleanupDeleteResult>;
  eq(column: string, value: string): PromiseLike<CleanupDeleteResult>;
}

export interface CleanupCountBuilder {
  in(column: string, values: readonly string[]): PromiseLike<CleanupCountResult>;
  eq(column: string, value: string): PromiseLike<CleanupCountResult>;
}

/**
 * Minimal structural view of the Supabase client surface cleanup touches —
 * the real SupabaseClient satisfies it, and tests inject a plain stub.
 */
export interface CleanupClient {
  from(table: string): {
    delete(): CleanupDeleteBuilder;
    select(columns: string, options: { count: 'exact'; head: true }): CleanupCountBuilder;
  };
}

export interface CleanupResidual {
  anchors: number;
  anchorProofs: number;
  orgCredits: number;
  organizations: number;
}

export interface CleanupResult {
  removedAnchors: number;
  /** All-zero on success; cleanup throws before returning anything else. */
  residual: CleanupResidual;
}

const DEFAULT_CHUNK = 50;

function messageOf(error: CleanupQueryError | null | undefined): string {
  return error?.message ?? 'unknown';
}

async function countRows(
  query: PromiseLike<CleanupCountResult>,
  label: string,
): Promise<number> {
  const { count, error } = await query;
  if (error) throw new Error(`cleanup residual count for ${label} failed: ${messageOf(error)}`);
  if (typeof count !== 'number') {
    throw new Error(`cleanup residual count for ${label} returned no count; refusing to assume zero.`);
  }
  return count;
}

async function assertZeroResidual(
  client: CleanupClient,
  orgId: string,
  anchorIds: readonly string[],
  chunkSize: number,
): Promise<CleanupResidual> {
  const residual: CleanupResidual = {
    anchors: await countRows(
      client.from('anchors').select('id', { count: 'exact', head: true }).eq('org_id', orgId),
      'anchors',
    ),
    orgCredits: await countRows(
      client.from('org_credits').select('org_id', { count: 'exact', head: true }).eq('org_id', orgId),
      'org_credits',
    ),
    organizations: await countRows(
      client.from('organizations').select('id', { count: 'exact', head: true }).eq('id', orgId),
      'organizations',
    ),
    anchorProofs: 0,
  };
  // anchor_proofs has no org_id; re-check via the anchor ids captured before
  // the deletes (any anchor the id walk missed shows up in `anchors` above).
  for (let i = 0; i < anchorIds.length; i += chunkSize) {
    residual.anchorProofs += await countRows(
      client
        .from('anchor_proofs')
        .select('anchor_id', { count: 'exact', head: true })
        .in('anchor_id', anchorIds.slice(i, i + chunkSize)),
      'anchor_proofs',
    );
  }

  const leftovers = Object.entries(residual).filter(([, n]) => n > 0);
  if (leftovers.length > 0) {
    throw new Error(
      `cleanup left residual rows for org ${orgId} — rig is contamination-suspect (§1.11A): `
      + leftovers.map(([table, n]) => `${table}=${n}`).join(' '),
    );
  }
  return residual;
}

/**
 * Remove every synthetic row the harness created for `orgId`: anchor_proofs
 * (chunked, FK-safe, BEFORE anchors), anchors, org_credits, organizations.
 * Throws on the first failed delete and on any nonzero residual afterwards.
 */
export async function cleanupSyntheticOrg(
  client: CleanupClient,
  orgId: string,
  anchorIds: readonly string[],
  chunkSize: number = DEFAULT_CHUNK,
): Promise<CleanupResult> {
  if (!orgId?.trim()) throw new Error('cleanup requires an orgId.');
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`chunkSize must be a positive integer; received ${chunkSize}.`);
  }

  for (let i = 0; i < anchorIds.length; i += chunkSize) {
    const chunk = anchorIds.slice(i, i + chunkSize);
    const { error } = await client.from('anchor_proofs').delete().in('anchor_id', chunk);
    if (error) {
      throw new Error(
        `cleanup anchor_proofs delete failed on chunk ${Math.floor(i / chunkSize) + 1} `
        + `(${chunk.length} anchor ids): ${messageOf(error)}`,
      );
    }
  }

  const { error: anchorsError } = await client.from('anchors').delete().eq('org_id', orgId);
  if (anchorsError) throw new Error(`cleanup anchors delete failed: ${messageOf(anchorsError)}`);

  const { error: creditsError } = await client.from('org_credits').delete().eq('org_id', orgId);
  if (creditsError) throw new Error(`cleanup org_credits delete failed: ${messageOf(creditsError)}`);

  const { error: orgError } = await client.from('organizations').delete().eq('id', orgId);
  if (orgError) throw new Error(`cleanup organizations delete failed: ${messageOf(orgError)}`);

  const residual = await assertZeroResidual(client, orgId, anchorIds, chunkSize);
  return { removedAnchors: anchorIds.length, residual };
}
