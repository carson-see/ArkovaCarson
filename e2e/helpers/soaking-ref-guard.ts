/**
 * Soaking-ref guard (SCRUM-2603).
 *
 * A hard guard that REFUSES to let the verify-rate-limit repro run against any
 * protected Supabase project: shared staging `ujtlwnoqfhtitcmsnrpq`, prod
 * `vzwyaatejekddvltxyye`, any `*-staging` ref, or any of the live S3 soaking
 * micro-rig refs. This is the #1147 contamination scar made mechanical —
 * assertNotSoakingRef() MUST be called BEFORE any execute_sql / deploy / load
 * against a rig, so a fat-fingered project ref can never dirty live soak
 * evidence (§1.11A / feedback_no_live_soak_rig_as_validation_target).
 *
 * The repro rig is a NEW throwaway project stood up expressly for SCRUM-2603
 * (Carson-gated infra action); its ref is passed via E2E_SUPABASE_PROJECT_REF
 * and validated here. If that env is unset or matches a protected ref, the
 * guard throws and the repro is aborted.
 *
 * NOTE: this guard does not itself stand up, write to, or tear down any rig — it
 * is a pure validation gate. Standing up the throwaway project + its tagged
 * Cloud Run remains a Carson-gated action performed outside this module.
 */

/** Shared staging project ref (§1.11). NEVER a repro target. */
export const SHARED_STAGING_REF = 'ujtlwnoqfhtitcmsnrpq';

/** Production app DB ref. NEVER a repro target. */
export const PROD_APP_REF = 'vzwyaatejekddvltxyye';

/**
 * The 12 live S3 soaking micro-rig refs, plus the shared/prod refs above.
 *
 * These are the refs a repro must never touch while their soaks are in flight.
 * Populate the micro-rig refs from HANDOFF.md "ACTIVE SOAKS" before running;
 * they are intentionally read from the env union too (SOAKING_PROJECT_REFS,
 * comma-separated) so an operator can extend the deny-list without a code edit.
 * Leaving the literal list empty is SAFE — the guard still denies the shared,
 * prod, and any `*-staging` ref, and denies anything the operator lists in
 * SOAKING_PROJECT_REFS.
 */
export const KNOWN_PROTECTED_REFS: readonly string[] = [
  SHARED_STAGING_REF,
  PROD_APP_REF,
  // S3 soaking micro-rig refs — fill from HANDOFF.md ACTIVE SOAKS at run time,
  // or supply via SOAKING_PROJECT_REFS env. Kept literal-empty here so this
  // file carries no rig secrets and cannot go stale silently.
];

/** Parse the operator-supplied extra deny-list from env. */
export function extraProtectedRefsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.SOAKING_PROJECT_REFS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface RefGuardResult {
  ref: string;
  allowed: boolean;
  reason: string;
}

/**
 * Build the case-insensitive deny-set (literal protected refs + operator-listed
 * soaking refs from SOAKING_PROJECT_REFS). Lowercased so a cased variant of a
 * protected ref can never slip past an exact-case `Set.has`.
 */
function buildDenyList(env: NodeJS.ProcessEnv): Set<string> {
  return new Set<string>(
    [...KNOWN_PROTECTED_REFS, ...extraProtectedRefsFromEnv(env)].map((r) =>
      r.toLowerCase(),
    ),
  );
}

/**
 * Return a deny reason if `candidate` is staging-shaped, or if it EQUALS or
 * EMBEDS any denied ref, case-insensitively. Used for two shapes:
 *  - the project ref (exact match: `mode: 'equals'`), and
 *  - the Supabase URL host (substring match: `mode: 'embeds'`), since a host
 *    like `ujtlwnoqfhtitcmsnrpq.supabase.co` CONTAINS the denied ref rather than
 *    equalling it. Returns null when clear.
 */
function denyReason(
  candidate: string,
  env: NodeJS.ProcessEnv,
  mode: 'equals' | 'embeds',
): string | null {
  const lower = candidate.toLowerCase();

  // Any `*-staging` / staging-shaped value is protected regardless of the
  // literal deny-list (matches ref and host alike).
  if (/staging/i.test(candidate)) {
    return 'looks like a staging environment';
  }

  for (const denied of buildDenyList(env)) {
    if (mode === 'equals' ? lower === denied : lower.includes(denied)) {
      return 'is a protected shared/prod/soaking project';
    }
  }

  return null;
}

/**
 * Evaluate a candidate project ref against the deny-list. Pure — no throw, no
 * side effects — so it is unit-testable. Use assertNotSoakingRef() for the
 * throwing gate at repro call sites.
 *
 * ALSO cross-checks `E2E_SUPABASE_URL` from `env`: the seed/teardown path
 * (getServiceClient() in e2e/fixtures/supabase.ts) writes against the URL, not
 * the ref, so a CLEAN throwaway ref paired with a URL still pointing at shared
 * staging/prod must be REFUSED — otherwise createTestAnchor() would dirty a
 * soaking/prod DB even though the ref field was clean (the #1147 blind spot).
 */
export function evaluateReproTargetRef(
  ref: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): RefGuardResult {
  const trimmed = (ref ?? '').trim();

  if (!trimmed) {
    return {
      ref: '',
      allowed: false,
      reason:
        'no project ref supplied (E2E_SUPABASE_PROJECT_REF unset) — refusing to run against an unknown target',
    };
  }

  const refDeny = denyReason(trimmed, env, 'equals');
  if (refDeny) {
    return {
      ref: trimmed,
      allowed: false,
      reason: `ref "${trimmed}" ${refDeny} — repro target denied (#1147 scar)`,
    };
  }

  // Cross-check the Supabase URL even when the ref itself is clean — a mismatched
  // (or stale) URL is the seed-path escape hatch this guard exists to close.
  const urlResult = evaluateReproTargetUrl(env.E2E_SUPABASE_URL, env);
  if (!urlResult.allowed) {
    return {
      ref: trimmed,
      allowed: false,
      reason: urlResult.reason,
    };
  }

  return {
    ref: trimmed,
    allowed: true,
    reason: `ref "${trimmed}" is not on the protected deny-list — cleared as a throwaway repro target`,
  };
}

export interface UrlGuardResult {
  url: string;
  allowed: boolean;
  reason: string;
}

/**
 * Evaluate a candidate Supabase URL (`E2E_SUPABASE_URL`) against the deny-list.
 * Pure — no throw, no side effects. REFUSES a URL whose host EQUALS or EMBEDS
 * any denied ref (shared staging `ujtlwnoqfhtitcmsnrpq`, prod
 * `vzwyaatejekddvltxyye`, an operator-listed soaking ref) or is staging-shaped —
 * case-insensitively. An empty/unset URL is ALLOWED (the fixture then falls back
 * to the localhost default, which is not itself a protected target); it is the
 * ref-side empty check that refuses an unknown project.
 */
export function evaluateReproTargetUrl(
  url: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): UrlGuardResult {
  const trimmed = (url ?? '').trim();

  // No URL configured → no violation to detect here (ref-side handles "unknown
  // target"; the fixture default is localhost).
  if (!trimmed) {
    return { url: '', allowed: true, reason: 'no E2E_SUPABASE_URL supplied — nothing to cross-check' };
  }

  // Extract the host when the value is a parseable URL; otherwise scan the raw
  // string (a bare host or malformed value must still be checked, never skipped).
  let host = trimmed;
  try {
    host = new URL(trimmed).host || trimmed;
  } catch {
    host = trimmed;
  }

  const reason = denyReason(host, env, 'embeds');
  if (reason) {
    return {
      url: trimmed,
      allowed: false,
      reason: `E2E_SUPABASE_URL host "${host}" ${reason} — repro must point at a throwaway project (#1147 scar)`,
    };
  }

  return {
    url: trimmed,
    allowed: true,
    reason: `E2E_SUPABASE_URL host "${host}" is not on the protected deny-list — cleared`,
  };
}

/**
 * Throwing gate. Call BEFORE any execute_sql / deploy / load against a rig.
 * Throws if the target ref is protected, empty, or staging-shaped, OR if
 * `E2E_SUPABASE_URL` (the actual seed/teardown target) points at a protected
 * project.
 */
export function assertNotSoakingRef(
  ref: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = evaluateReproTargetRef(ref, env);
  if (!result.allowed) {
    throw new Error(`[soaking-ref-guard] REFUSED: ${result.reason}`);
  }
  return result.ref;
}
