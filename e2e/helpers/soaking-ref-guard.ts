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
 * Evaluate a candidate project ref against the deny-list. Pure — no throw, no
 * side effects — so it is unit-testable. Use assertNotSoakingRef() for the
 * throwing gate at repro call sites.
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

  // Any `*-staging` ref is protected regardless of the literal deny-list.
  if (/-staging$/i.test(trimmed) || /staging/i.test(trimmed)) {
    return {
      ref: trimmed,
      allowed: false,
      reason: `ref "${trimmed}" looks like a staging environment — repro must use a throwaway project`,
    };
  }

  // Compare case-insensitively: the staging heuristic above is /i, so the
  // literal deny-list must match with the same case-insensitivity or an
  // UPPERCASED shared/prod/soaking ref would slip past Set.has (exact-case) and
  // clear as a throwaway target. Supabase refs are canonically lowercase, but a
  // safety guard must not depend on the caller casing the ref correctly.
  const denyList = new Set<string>(
    [...KNOWN_PROTECTED_REFS, ...extraProtectedRefsFromEnv(env)].map((r) =>
      r.toLowerCase(),
    ),
  );

  if (denyList.has(trimmed.toLowerCase())) {
    return {
      ref: trimmed,
      allowed: false,
      reason: `ref "${trimmed}" is a protected shared/prod/soaking project — repro target denied (#1147 scar)`,
    };
  }

  return {
    ref: trimmed,
    allowed: true,
    reason: `ref "${trimmed}" is not on the protected deny-list — cleared as a throwaway repro target`,
  };
}

/**
 * Throwing gate. Call BEFORE any execute_sql / deploy / load against a rig.
 * Throws if the target ref is protected, empty, or staging-shaped.
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
