/**
 * Flag reconciliation gate — the third SPOF-class module in this folder, after
 * `providerSpof.ts` (chain provider) and `flagSpof.ts` (env↔DB fail-open).
 *
 * WHAT THIS ADDS THAT flagSpof DOES NOT. `flagSpof` iterates only the flags
 * pinned in `expected-prod-config.json.flags`. That manifest asserted 6 flags
 * out of a ~48-flag surface, so 42 flags were invisible to every config gate in
 * the repo. Worse, `flagSpof` reasons about ONE hazard direction — the env var
 * winning when a `switchboard_flags` row is ABSENT. The inverse direction is
 * live in prod today and nothing caught it:
 *
 *   `flagRegistry.ts` resolves a DB-backed flag as
 *       dbFlagMap.has(key) ? dbFlagMap.get(key) : (process.env[key] === 'true')
 *   so when the row is PRESENT the deploy env var is **inert** — read by
 *   nothing, yet sitting in `deploy-worker.yml` telling every reader the
 *   opposite of the truth. `deploy-worker.yml` sets `ENABLE_SEMANTIC_SEARCH=true`
 *   and `ENABLE_AI_FRAUD=true`; both have `switchboard_flags` rows set FALSE.
 *   Both features are OFF in prod. Anyone reading the deploy workflow — or
 *   grepping for the flag — concludes they are ON.
 *
 * THE OTHER FAILURE THIS CLOSES: a census cannot hold. The flag surface is
 * spread over `ENV_FLAG_GETTERS` + `DB_FLAGS` (flagRegistry.ts), `config.ts`,
 * `deploy-worker.yml`, `src/lib/switchboard.ts`, the edge worker, and live
 * `switchboard_flags` rows. Every hand-written inventory of it has gone stale
 * (the manifest's own `pendingLaunchFlags` was wrong on 4 of 5 entries). So the
 * inventory here is DECLARED, and the gate fails when the declaration and the
 * code surface disagree in either direction — `unregistered-flag` when the code
 * grows a flag the manifest does not name, `stale-inventory-entry` when the
 * manifest names one the code no longer has.
 *
 * DETECTION ONLY, and code-side only. This never edits a flag, a deploy file or
 * a `switchboard_flags` row (CLAUDE.md §1.11A), and it never queries prod — CI
 * has no prod credentials. The observed prod values live in the manifest with a
 * capture stamp, exactly like `prod-config-snapshot.json`; what the gate
 * mechanically enforces is that the CODE surface has not drifted away from the
 * reconciled inventory, plus the soak posture declared for each flag.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { stripJsLineComment } from '../check-ce-registry-key-parity.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Where a flag's value comes from at runtime.
 *  - `env`        — worker resolves it from `process.env` (flagRegistry
 *                   `ENV_FLAG_GETTERS`, `config.ts`, or a raw `process.env` read
 *                   such as `integrationKillSwitch.ts`).
 *  - `db`         — worker resolves it from `switchboard_flags` (flagRegistry
 *                   `DB_FLAGS`, or a `get_flag` RPC gate).
 *  - `frontend`   — declared in `src/lib/switchboard.ts` `FLAGS`.
 *  - `edge`       — read by the Cloudflare edge worker.
 *  - `db-orphan`  — a live `switchboard_flags` row that NOTHING in the tree
 *                   reads. Declared so it stays visible instead of silently
 *                   accumulating.
 */
export type FlagSource = 'env' | 'db' | 'frontend' | 'edge' | 'db-orphan';

/**
 * What the 7-day soak needs from this flag.
 *  - `must-be-on`  — the soak cannot exercise this feature unless it is ON. A
 *                    green soak with it OFF is a soak that silently skipped it.
 *  - `must-be-off` — being ON invalidates the soak (fabricated data) or breaks a
 *                    standing directive.
 *  - `either`      — the soak does not depend on it.
 */
export type SoakPosture = 'must-be-on' | 'must-be-off' | 'either';

/** `true`/`false` = a live row with that value; `absent` = NO row at all. */
export type ProdDbRow = boolean | 'absent';

/**
 * Where a surface OUTSIDE the codebase's own control flow tells someone that
 * this capability exists. `public-marketing` and `compliance` are the two that
 * carry legal weight: the first is a representation to customers (and, on
 * `/developers`, a priced commercial offer), the second is a representation to
 * an auditor.
 */
export type ClaimSurface = 'public-marketing' | 'public-api-docs' | 'compliance' | 'partner';

export interface ClaimReference {
  /** Repo-relative path to the file making the claim. */
  path: string;
  surface: ClaimSurface;
  /** What the surface asserts, in plain words. */
  claim: string;
}

export interface FlagInventoryEntry {
  sources: FlagSource[];
  /** Code sites that actually resolve this flag (not just mention it). */
  resolvers: string[];
  prodDbRow: ProdDbRow;
  /** The value the runtime resolves in prod, through the real resolver. */
  prodResolved: boolean;
  /** True when a customer-facing surface (UI or public API) changes with it. */
  customerReachable: boolean;
  soak: SoakPosture;
  why: string;
  /**
   * Public / auditor-facing surfaces that state this capability is available.
   * When the flag resolves OFF, every entry here is an R-7 claims-gate
   * violation (CLAUDE.md §1.13): we are telling someone a capability is live
   * that is not.
   */
  claimedBy?: ClaimReference[];
}

export interface FlagInventoryManifest {
  observedProd: { projectRef: string; capturedAt: string; workerGitSha: string };
  flags: Record<string, FlagInventoryEntry>;
  /**
   * Flags KNOWN to carry an inert/contradictory deploy env var whose removal is
   * a deploy-file change owned elsewhere (T3/Carson for chain-adjacent ones).
   * Acknowledged entries are loud warnings; a NEW one is a hard error — the
   * same two-tier calibration `flagSpof` uses.
   */
  acknowledgedInertEnvFlags?: string[];
  /**
   * Flags KNOWN to be OFF while a public/compliance surface claims otherwise.
   * Acknowledging one keeps it loudly visible as a warning instead of blocking
   * every unrelated PR — the fix is a copy or docs edit owned outside this
   * gate. A NEW contradiction is a hard error.
   */
  acknowledgedClaimContradictions?: string[];
}

/** The live code surface, parsed from real files. */
export interface FlagCodeSurface {
  /** `ENABLE_*`/`MAINTENANCE_MODE` env vars `deploy-worker.yml` actually sets. */
  deployedFlags: Record<string, boolean>;
  /** flagRegistry `ENV_FLAG_GETTERS` keys. */
  envFlagNames: Set<string>;
  /** flagRegistry `DB_FLAGS` entries. */
  dbFlagNames: Set<string>;
  /** `src/lib/switchboard.ts` `FLAGS` keys. */
  frontendFlagNames: Set<string>;
}

export type FlagInventoryCode =
  | 'unregistered-flag'
  | 'stale-inventory-entry'
  | 'inert-env-var'
  | 'env-db-contradiction'
  | 'decorative-db-row'
  | 'claimed-capability-off'
  | 'stale-claim-reference'
  | 'soak-required-flag-off'
  | 'soak-forbidden-flag-on';

export interface FlagInventoryFinding {
  severity: 'error' | 'warn';
  code: FlagInventoryCode;
  flag: string;
  message: string;
}

// ─── Classifier ─────────────────────────────────────────────────────────────

function surfaceNames(surface: FlagCodeSurface): Set<string> {
  return new Set<string>([
    ...Object.keys(surface.deployedFlags),
    ...surface.envFlagNames,
    ...surface.dbFlagNames,
    ...surface.frontendFlagNames,
  ]);
}

/**
 * Pure reconciler. Findings, in order:
 *
 *  1. `unregistered-flag`      ERROR — code exposes a flag the manifest omits.
 *  2. `stale-inventory-entry`  ERROR — manifest names a flag with no code
 *                                      surface AND no prod row.
 *  3. `env-db-contradiction`   ERROR — DB-backed, a prod row EXISTS, and the
 *                                      deploy env var says the OPPOSITE. The
 *                                      env var is inert AND misleading.
 *  4. `inert-env-var`          WARN  — same shape, but env and row agree. Not
 *                                      wrong today; the trap is that editing
 *                                      the deploy value does nothing.
 *  5. `decorative-db-row`      WARN  — worker resolves from ENV but a
 *                                      switchboard row exists, so the frontend
 *                                      (`get_flag`) and the worker can disagree.
 *  6. `soak-required-flag-off` ERROR — `must-be-on` flag not resolving ON.
 *  7. `soak-forbidden-flag-on` ERROR — `must-be-off` flag resolving ON, or
 *                                      switched on in the deploy.
 *
 * 3 and 4 are mutually exclusive: a contradiction supersedes the benign case.
 */
export function checkFlagInventory(
  manifest: FlagInventoryManifest,
  surface: FlagCodeSurface,
): FlagInventoryFinding[] {
  const findings: FlagInventoryFinding[] = [];
  const acknowledged = new Set(manifest.acknowledgedInertEnvFlags ?? []);
  const declared = new Set(Object.keys(manifest.flags));

  // 1. Code grew a flag the manifest does not name.
  for (const name of [...surfaceNames(surface)].sort()) {
    if (declared.has(name)) continue;
    findings.push({
      severity: 'error',
      code: 'unregistered-flag',
      flag: name,
      message:
        `flag ${name} is exposed by the code surface (deploy-worker.yml, flagRegistry.ts, ` +
        `or src/lib/switchboard.ts) but is not declared in flag-inventory.json. Every flag ` +
        `must declare its source, resolver, prod value, customer reachability and soak ` +
        `posture — an undeclared flag is a feature the soak may silently skip.`,
    });
  }

  for (const [flag, entry] of Object.entries(manifest.flags)) {
    const inSurface = surfaceNames(surface).has(flag);
    const deployHasFlag = Object.prototype.hasOwnProperty.call(surface.deployedFlags, flag);
    const deployValue = deployHasFlag ? surface.deployedFlags[flag] : undefined;
    const rowExists = entry.prodDbRow !== 'absent';

    // 2. Manifest names a flag the code dropped, and no prod row keeps it alive.
    if (!inSurface && !rowExists) {
      findings.push({
        severity: 'error',
        code: 'stale-inventory-entry',
        flag,
        message:
          `flag ${flag} is declared in flag-inventory.json but appears in no code surface and ` +
          `has no switchboard_flags row. Remove the entry, or restore the flag if the removal ` +
          `was accidental.`,
      });
    }

    // 3/4. DB-backed flag with a live row + a deploy env var → env var is inert.
    if (surface.dbFlagNames.has(flag) && rowExists && deployValue !== undefined) {
      const contradicts = deployValue !== entry.prodDbRow;
      const severity: 'error' | 'warn' =
        contradicts && !acknowledged.has(flag) ? 'error' : 'warn';
      findings.push(
        contradicts
          ? {
              severity,
              code: 'env-db-contradiction',
              flag,
              message:
                `flag ${flag} is DB-backed (flagRegistry.ts DB_FLAGS) and its switchboard_flags ` +
                `row is ${String(entry.prodDbRow)}, but deploy-worker.yml sets ${flag}=` +
                `${String(deployValue)}. flagRegistry consults the env var ONLY when the row is ` +
                `absent, so the env var is inert AND states the opposite of the effective value — ` +
                `every reader of deploy-worker.yml is misled about whether this feature is live. ` +
                `Either set ${flag}=${String(entry.prodDbRow)} in deploy-worker.yml so it fails ` +
                `SAFE and reads true, or drop the line entirely.`,
            }
          : {
              severity: 'warn',
              code: 'inert-env-var',
              flag,
              message:
                `flag ${flag} is DB-backed with a live switchboard_flags row, so the ` +
                `${flag}=${String(deployValue)} line in deploy-worker.yml is inert — editing it ` +
                `does not change worker behaviour. It agrees with the row today; keep them in ` +
                `sync or remove the env line to avoid a future contradiction.`,
            },
      );
    }

    // 5. Worker reads env, but a row exists that the frontend's get_flag WILL read.
    if (entry.sources.includes('env') && rowExists && !surface.dbFlagNames.has(flag)) {
      findings.push({
        severity: 'warn',
        code: 'decorative-db-row',
        flag,
        message:
          `flag ${flag} is resolved from the environment by the worker, but a switchboard_flags ` +
          `row exists (${String(entry.prodDbRow)}). The worker never reads that row, while the ` +
          `frontend get_flag() RPC does — the two runtimes can disagree about this feature ` +
          `without any error surfacing. Prod resolves the worker side to ` +
          `${String(entry.prodResolved)}.`,
      });
    }

    // 6. Claims gate (R-7). A flag that resolves OFF while a public or
    //    auditor-facing surface says the capability is available is a
    //    misrepresentation, not a config nit — and it is the class that has
    //    historically only ever been caught by an annual audit.
    const claims = entry.claimedBy ?? [];
    if (!entry.prodResolved && claims.length > 0) {
      const acknowledgedClaim = new Set(manifest.acknowledgedClaimContradictions ?? []).has(flag);
      const surfaces = claims
        .map((c) => `${c.surface} — ${c.path} ("${c.claim}")`)
        .join('; ');
      findings.push({
        severity: acknowledgedClaim ? 'warn' : 'error',
        code: 'claimed-capability-off',
        flag,
        message:
          `R-7 CLAIMS GATE: ${flag} resolves OFF in prod, but ${claims.length} surface(s) state ` +
          `the capability is available: ${surfaces}. CLAUDE.md §1.13 forbids claiming external ` +
          `status or capability we do not hold. Either enable the flag, or correct the copy/doc ` +
          `so it describes what is actually served.`,
      });
    }

    // 7/8. Soak posture.
    if (entry.soak === 'must-be-on' && !entry.prodResolved) {
      findings.push({
        severity: 'error',
        code: 'soak-required-flag-off',
        flag,
        message:
          `flag ${flag} is declared must-be-on for the soak but resolves OFF in prod ` +
          `(switchboard row ${String(entry.prodDbRow)}). The soak cannot exercise this feature; ` +
          `a green result would be silence, not evidence. Turn it on before the soak starts or ` +
          `re-declare its posture with a reason.`,
      });
    }
    if (entry.soak === 'must-be-off' && (entry.prodResolved || deployValue === true)) {
      findings.push({
        severity: 'error',
        code: 'soak-forbidden-flag-on',
        flag,
        message:
          `flag ${flag} is declared must-be-off for the soak but is ON ` +
          `(prod resolved ${String(entry.prodResolved)}` +
          `${deployValue === true ? `, deploy-worker.yml sets it true` : ''}). ${entry.why}`,
      });
    }
  }

  return findings;
}

// ─── Source parsers (fail closed) ───────────────────────────────────────────

function stripComments(source: string): string {
  return source.split(/\r?\n/).map(stripJsLineComment).join('\n');
}

const ENV_GETTERS_BLOCK_RE = /const\s+ENV_FLAG_GETTERS\s*=\s*\{([\s\S]*?)\}\s*as\s+const\s*;/;
const ENV_GETTER_KEY_RE = /^\s*([A-Z][A-Z0-9_]*)\s*:/gm;

/**
 * Parse the `ENV_FLAG_GETTERS` keys out of `flagRegistry.ts` — the flags the
 * worker resolves from `config.ts`/`process.env` rather than the switchboard.
 * Throws (fail closed) if the block cannot be located or yields no names: a
 * parser that silently returns an empty set would report every env flag as
 * "not in the code surface" and pass a fully-drifted tree.
 */
export function parseEnvFlagNames(flagRegistrySource: string): Set<string> {
  const block = ENV_GETTERS_BLOCK_RE.exec(stripComments(flagRegistrySource));
  if (!block) {
    throw new Error(
      'flag-inventory: could not parse the ENV_FLAG_GETTERS block from flagRegistry.ts (fail closed)',
    );
  }
  const names = new Set<string>();
  for (const m of block[1].matchAll(ENV_GETTER_KEY_RE)) names.add(m[1]);
  if (names.size === 0) {
    throw new Error(
      'flag-inventory: ENV_FLAG_GETTERS block parsed but contained no flag names (fail closed)',
    );
  }
  return names;
}

const FRONTEND_FLAGS_BLOCK_RE = /export\s+const\s+FLAGS\s*=\s*\{([\s\S]*?)\}\s*as\s+const\s*;/;
const FRONTEND_FLAG_KEY_RE = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*(?:true|false)\s*,?\s*$/gm;

/**
 * Parse the `FLAGS` map out of `src/lib/switchboard.ts` — the frontend's flag
 * list and its code defaults. Anchored to `KEY: true|false` so the `FlagId`
 * type alias and any prose below the block cannot be swept in. Fails closed.
 */
export function parseFrontendFlagNames(switchboardSource: string): Set<string> {
  const block = FRONTEND_FLAGS_BLOCK_RE.exec(stripComments(switchboardSource));
  if (!block) {
    throw new Error(
      'flag-inventory: could not parse the FLAGS block from src/lib/switchboard.ts (fail closed)',
    );
  }
  const names = new Set<string>();
  for (const m of block[1].matchAll(FRONTEND_FLAG_KEY_RE)) names.add(m[1]);
  if (names.size === 0) {
    throw new Error(
      'flag-inventory: FLAGS block parsed but contained no flag names (fail closed)',
    );
  }
  return names;
}

// ─── Manifest loading (fail closed on a degraded file) ──────────────────────

const FlagEntrySchema = z.object({
  sources: z.array(z.enum(['env', 'db', 'frontend', 'edge', 'db-orphan'])).min(1),
  resolvers: z.array(z.string()),
  prodDbRow: z.union([z.boolean(), z.literal('absent')]),
  prodResolved: z.boolean(),
  customerReachable: z.boolean(),
  soak: z.enum(['must-be-on', 'must-be-off', 'either']),
  why: z.string().min(1),
  claimedBy: z
    .array(
      z.object({
        path: z.string().min(1),
        surface: z.enum(['public-marketing', 'public-api-docs', 'compliance', 'partner']),
        claim: z.string().min(1),
      }),
    )
    .optional(),
});

const ManifestSchema = z
  .object({
    observedProd: z.object({
      projectRef: z.string().min(1),
      capturedAt: z.string().min(1),
      workerGitSha: z.string().min(1),
    }),
    flags: z
      .record(z.string(), FlagEntrySchema)
      .refine((f) => Object.keys(f).length > 0, { message: 'flags must be a non-empty object' }),
    acknowledgedInertEnvFlags: z.array(z.string().min(1)).optional(),
    acknowledgedClaimContradictions: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

/** Read + schema-validate the manifest. Throws on a missing/degraded file. */
export function loadFlagInventory(path: string): FlagInventoryManifest {
  return ManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) as FlagInventoryManifest;
}

export interface FlagInventorySources {
  deployYmlPath: string;
  flagRegistryPath: string;
  frontendSwitchboardPath: string;
  /**
   * Repo root. When supplied, every `claimedBy.path` is checked to still exist —
   * a claim annotation pointing at a deleted file has rotted and stopped
   * protecting anything, which is exactly how `pendingLaunchFlags` went stale on
   * 4 of its 5 entries.
   */
  repoRoot?: string;
}

// Re-parsed here rather than imported from flagSpof so this module owns its own
// fail-closed contract; the two parsers are deliberately independent.
const DEPLOY_FLAG_RE = /\b((?:ENABLE_[A-Z0-9_]+)|MAINTENANCE_MODE|USE_MOCKS)=(true|false)\b/g;
const DB_FLAGS_BLOCK_RE = /const\s+DB_FLAGS\s*=\s*\[([\s\S]*?)\]\s*as\s+const\s*;/;
const FLAG_NAME_RE = /['"]([A-Z0-9_]+)['"]/g;

export function parseDeployedFlagValues(deployYmlSource: string): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const m of deployYmlSource.matchAll(DEPLOY_FLAG_RE)) flags[m[1]] = m[2] === 'true';
  if (Object.keys(flags).length === 0) {
    throw new Error('flag-inventory: no env flags parsed from deploy-worker.yml (fail closed)');
  }
  return flags;
}

export function parseDbFlagList(flagRegistrySource: string): Set<string> {
  const block = DB_FLAGS_BLOCK_RE.exec(flagRegistrySource);
  if (!block) {
    throw new Error('flag-inventory: could not parse DB_FLAGS from flagRegistry.ts (fail closed)');
  }
  const names = new Set<string>();
  for (const m of block[1].matchAll(FLAG_NAME_RE)) names.add(m[1]);
  if (names.size === 0) {
    throw new Error('flag-inventory: DB_FLAGS parsed but empty (fail closed)');
  }
  return names;
}

/** Read the real source files, parse the surface, and reconcile. */
export function runFlagInventoryCheck(
  manifest: FlagInventoryManifest,
  sources: FlagInventorySources,
): FlagInventoryFinding[] {
  const flagRegistrySource = readFileSync(sources.flagRegistryPath, 'utf8');
  const findings = checkFlagInventory(manifest, {
    deployedFlags: parseDeployedFlagValues(readFileSync(sources.deployYmlPath, 'utf8')),
    envFlagNames: parseEnvFlagNames(flagRegistrySource),
    dbFlagNames: parseDbFlagList(flagRegistrySource),
    frontendFlagNames: parseFrontendFlagNames(
      readFileSync(sources.frontendSwitchboardPath, 'utf8'),
    ),
  });

  // Rot guard: a claim annotation that points nowhere protects nothing.
  const { repoRoot } = sources;
  if (repoRoot !== undefined) {
    for (const [flag, entry] of Object.entries(manifest.flags)) {
      for (const claim of entry.claimedBy ?? []) {
        if (existsSync(resolve(repoRoot, claim.path))) continue;
        findings.push({
          severity: 'error',
          code: 'stale-claim-reference',
          flag,
          message:
            `flag ${flag} declares a claim on ${claim.path}, but that file does not exist. The ` +
            `annotation has rotted: either update the path to where the claim moved, or remove ` +
            `the entry if the claim was retired. A dangling claim reference silently disables ` +
            `the R-7 check for this flag.`,
        });
      }
    }
  }

  return findings;
}
