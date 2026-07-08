/**
 * Pure, side-effect-free helpers for scripts/staging/batch-drain-harness.ts.
 *
 * Split out (mirrors load-harness-env.ts) so the safety guards can be unit
 * tested without importing the harness entrypoint, which runs main() on load
 * and needs live rig credentials. NOTHING here touches the network or a DB.
 */

export const PROD_PROJECT_REF = 'vzwyaatejekddvltxyye';

export interface RigTarget {
  url: string;
  ref: string;
}

/**
 * Validate that a Supabase URL points at a permitted, non-prod rig.
 *
 * Layered exactly like scripts/staging/seed.ts:
 *   1. Hard-block: the prod project ref must never appear anywhere in the URL.
 *   2. Format: host must be `<20-lowercase-letters>.supabase.co`.
 *   3. Allow-list: if ALLOWED_STAGING_PROJECT_REFS is set, the ref must be in
 *      it (and every entry is format-checked + prod-blocked).
 *
 * Throws on any violation; returns the resolved {url, ref} on success.
 */
export function resolveRigTarget(
  url: string | undefined,
  allowedRefsRaw?: string,
): RigTarget {
  const trimmed = url?.trim();
  if (!trimmed) throw new Error('STAGING_SUPABASE_URL is required.');

  if (new RegExp(PROD_PROJECT_REF, 'i').test(trimmed)) {
    throw new Error(`STAGING_SUPABASE_URL contains prod project ref ${PROD_PROJECT_REF}. Refusing to run.`);
  }

  let host: string;
  try {
    host = new URL(trimmed).hostname;
  } catch {
    throw new Error(`STAGING_SUPABASE_URL must be an absolute URL; received \`${trimmed}\`.`);
  }

  // Strict full-host match: ref is the leftmost label and the host must be
  // exactly `<ref>.supabase.co` (a leftmost-label-only check would accept
  // `<ref>.attacker.tld`).
  const suffix = '.supabase.co';
  if (!host.endsWith(suffix)) {
    throw new Error(`STAGING_SUPABASE_URL host \`${host}\` must be <ref>.supabase.co.`);
  }
  const ref = host.slice(0, host.length - suffix.length);
  if (!/^[a-z]{20}$/.test(ref)) {
    throw new Error(`STAGING_SUPABASE_URL host \`${host}\` does not carry a valid Supabase ref (20 lowercase letters).`);
  }
  if (ref === PROD_PROJECT_REF) {
    throw new Error('Refusing to run against the prod project ref.');
  }

  if (allowedRefsRaw && allowedRefsRaw.trim()) {
    const allowed = allowedRefsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    for (const a of allowed) {
      if (a === PROD_PROJECT_REF || !/^[a-z]{20}$/.test(a)) {
        throw new Error(`ALLOWED_STAGING_PROJECT_REFS entry '${a}' invalid (20 lowercase letters, not prod).`);
      }
    }
    if (!allowed.includes(ref)) {
      throw new Error(`Rig ref '${ref}' is not in ALLOWED_STAGING_PROJECT_REFS. Refusing to run.`);
    }
  }

  return { url: trimmed, ref };
}

/**
 * Deterministic synthetic org UUID for a run id, so re-invoking a phase (seed
 * then drain then cleanup) targets the same org. Not cryptographic — only
 * needs to be stable within a run and shaped like a v4 UUID.
 */
export function runOrgId(runId: string): string {
  if (!runId || !runId.trim()) throw new Error('runId is required for runOrgId.');
  const hex = Buffer.from(`batch-drain-${runId}`).toString('hex').padEnd(32, '0').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
