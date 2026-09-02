#!/usr/bin/env tsx
/**
 * PR #2524 proof tx-inclusion admission driver (T3).
 *
 * Shape, CLI contract, evidence format and exit-code semantics deliberately
 * mirror `pr1408-chain-resilience-driver.ts` — the close-out tooling and the
 * `provision-isolated-rig.sh` admission JSON (`driver_path` / `driver_sha256` /
 * `changed_behavior`) expect that shape, and its stop-conditions include
 * "driver_path or driver_sha256 mismatch" and "soak harness exits non-zero or
 * fails required duration".
 *
 * Self-test mode is local validation only; rows are marked evidenceForSoak=false
 * and must not be used as T3 soak evidence. Live mode requires an admitted
 * isolated rig and writes countable JSONL rows for the PR-specific behavior.
 *
 * WHY THIS FILE EXISTS AT ALL (CLAUDE.md §1.12)
 * --------------------------------------------
 * "Soak evidence must exercise the PR's changed behavior; generic synthetic load
 * is supporting worker-health evidence only." The only driver in the repo before
 * this one exercises retry/backoff classification for PR #1408 — behaviour this
 * PR does not touch. Running it for 48 hours would produce 48 hours of evidence
 * about something else.
 *
 * WHAT PR #2524 CHANGED, AND THEREFORE WHAT THIS DRIVER MEASURES
 * -------------------------------------------------------------
 *   1. The backfill sweep cursor (`jobs/confirmation-proof-populate.ts`, H1).
 *   2. `parseTxOutProof`'s fold guard (`chain/confirmation-proof.ts`, B0).
 *   3. The batched `.in()` write (`utils/anchorProofs.ts`, M3) across the
 *      200-value `chunkForInFilter` cap.
 *   4. Read/write coherence — the writer's `isCoherentInclusionPair` and the
 *      reader's `readTxInclusionEvidence` must agree (H3/H4).
 *   5. `/proof` emitting `tx_inclusion_branch` + `tx_block_index`, and the B2
 *      fix answering 500 (not 404) when the columns cannot be read.
 *
 * THE DISCRIMINATION REQUIREMENT
 * ------------------------------
 * A driver that would also pass against the BROKEN build is worthless. The
 * bug this PR repaired made the job a permanent no-op: the sweep cursor seeded
 * to `''`, PostgREST rendered `anchor_id=gt.` against a `uuid` column, Postgres
 * answered `22P02`, and the scan's error branch returned all-zero counters that
 * read exactly like "no candidates found". So:
 *
 *   - A1 refuses to accept zeros as success (scanned > 0 AND anchorsUpdated > 0
 *     on the first tick of every cycle).
 *   - A2/A3 prove the sweep ADVANCES and WRAPS using a seeded WEDGE cohort that
 *     can never complete and whose presence in a page is observable in the
 *     `anchorsBlockMismatch` counter. A build that re-returns the head of the
 *     keyspace reports the wedge on every tick; the fixed build reports it on
 *     the first tick of a sweep and not again until the wrap.
 *
 * `runSelfTest()` proves that discrimination by running the assertion logic
 * against BROKEN-build vectors and requiring it to fail on them.
 *
 * SAFETY (K3)
 * -----------
 * The prod Supabase ref, the shared staging ref and the shared Cloud Run
 * services are HARD-DENIED, copied from `scripts/staging/provision-isolated-rig.sh`.
 * The driver refuses to run — not merely refuses to write — when the target
 * resolves to any of them. The single non-GET database call (fixture re-arm) is
 * id-scoped to discovered fixture rows and re-checks the deny list immediately
 * before issuing.
 *
 * NO WALL-CLOCK CORRECTNESS (K2)
 * ------------------------------
 * One invocation = one CYCLE = a bounded sequence of cron ticks that is
 * individually verifiable from its own evidence row. Nothing is asserted from
 * elapsed time; the 48-hour duration is the harness's job (invoke repeatedly).
 * The optional inter-tick delay is politeness toward the RPC node, not a
 * correctness input.
 *
 * Constitution refs:
 *   - §1.4 No secrets logged. The GetBlock RPC token rides in the URL PATH, so
 *     only the RPC HOST is ever recorded or printed.
 *   - §1.5 Measured, not asserted: every assertion states what it proves, and
 *     the "what this does NOT catch" list is in the header of the evidence row.
 *   - §1.11A Isolated-rig evidence only; prod and shared staging hard-denied.
 */

import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chunkForInFilter, POSTGREST_IN_FILTER_CHUNK } from '../src/utils/postgrest-filter.js';

// ─── Hard-deny constants (mirror scripts/staging/provision-isolated-rig.sh) ───

/** Production Supabase project ref. NEVER a soak target. */
export const PROD_SUPABASE_REF = 'vzwyaatejekddvltxyye';
/** Shared standing-staging Supabase project ref. Not isolated ⇒ not T3 evidence. */
export const SHARED_STAGING_SUPABASE_REF = 'ujtlwnoqfhtitcmsnrpq';
/** Cloud Run services that are shared/prod and must never be driven. */
export const DENIED_CLOUD_RUN_SERVICES = ['arkova-worker', 'arkova-worker-staging'] as const;
/**
 * Production Arkova domains — apex and every subdomain (`api.`, `edge.`, …).
 * Listed as apexes rather than individual hostnames so a new production
 * subdomain is denied by default instead of needing to be remembered here.
 */
export const DENIED_HOST_SUBSTRINGS = ['arkova.ai', 'arkova.io'] as const;

// ─── Fixture contract (mirrors scripts/staging/seed-proof-txinclusion-fixture.sql) ───

/** `anchors.metadata->>'_purpose'` marker written by the seed. */
export const FIXTURE_PURPOSE = 'pr2524-proof-txinclusion';
/** Cohort markers written to `anchors.metadata->>'_cohort'`. */
export const FIXTURE_COHORTS = ['wedge', 'bulk', 'spread'] as const;
export type FixtureCohort = (typeof FIXTURE_COHORTS)[number];

/**
 * Sanity cap on how many rows the re-arm may touch. The fixture is ~3,000 rows;
 * anything an order of magnitude past that means the discovery query matched
 * something it should not have, and the write must not proceed.
 */
export const REARM_ROW_CAP = 20_000;

/**
 * Re-exported so the boundary test pins the REAL constant rather than a copy of
 * it. A test that hard-codes 200 would keep passing if the cap moved.
 */
export const POSTGREST_CHUNK_CAP_FOR_TESTS = POSTGREST_IN_FILTER_CHUNK;

const CHANGED_BEHAVIOR =
  'PR #2524 proof tx-inclusion: H1 backfill sweep cursor advance/wrap (uuid cursor, no empty-string seed), B0 parseTxOutProof emitted-branch fold guard against real gettxoutproof, M3 batched .in() confirmation write across the 200-value chunk cap, H3/H4 writer/reader inclusion-pair coherence, and /proof emitting tx_inclusion_branch + tx_block_index (B2: 500 not 404 on an unreadable anchor_proofs row)';

/**
 * Stated in every evidence row so a close-out reviewer never has to infer the
 * limits of the measurement from the assertion list (§1.5).
 */
const NOT_ASSERTED = [
  'B2 500-not-404 is exercised in self-test only: reproducing it live requires DROPping the 0427 columns from a running rig, which would invalidate the soak. Live mode asserts only the precondition (0427 readable) and that a fixture anchor holding a proof row is not answered NO_BATCH_PROOF.',
  'isCoherentInclusionPair and readTxInclusionEvidence are module-private. Coherence is proven end-to-end (writer -> DB -> /proof -> cryptographic re-fold), not by calling those functions; a change that makes BOTH sides wrong in the same direction would still pass.',
  'The sweep cursor is in-process module state. On a multi-instance rig each instance keeps its own cursor; advance/wrap still hold per instance, but tick-to-tick counters interleave. The rig must be pinned to one instance for the counter arithmetic to be exact.',
  'Reorg behaviour is exercised only through the seeded block-hash mismatch (the K1 per-anchor gate). No real chain reorg is induced.',
  'Anchors are seeded already-SECURED with real mainnet txids; the broadcast/confirmation path that normally produces them is not exercised here.',
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DriverArgs {
  mode: 'self-test' | 'live';
  targetUrl?: string;
  admissionJson?: string;
  evidenceJsonl?: string;
  cronSecret?: string;
  bearerToken?: string;
  supabaseUrl?: string;
  supabaseServiceKey?: string;
  rpcUrl?: string;
  rpcAuth?: string;
  runId?: string;
  windowStart?: string;
  windowEnd?: string;
  maxTicks?: number;
  tickDelayMs?: number;
  rearm?: boolean;
}

/** One `/jobs/populate-confirmation-proofs` invocation, as observed. */
export interface TickObservation {
  tick: number;
  httpOk: boolean;
  httpStatus: number;
  skipped: boolean;
  scanned: number;
  txAttempted: number;
  txConfirmed: number;
  txPending: number;
  txStale: number;
  anchorsUpdated: number;
  anchorsMissing: number;
  anchorsBlockMismatch: number;
}

export interface AssertionResult {
  id: string;
  /** What a PASS of this assertion actually proves. Copied into the evidence row. */
  proves: string;
  ok: boolean;
  detail: string;
}

export interface DriverRow {
  utc: string;
  pr: 2524;
  tier: 'T3';
  mode: 'self-test' | 'live';
  evidenceForSoak: boolean;
  changedBehavior: string;
  notAsserted: readonly string[];
  /** K4: identifies the soak run this cycle belongs to. */
  runId: string;
  /** K4: monotonic within (evidence file, runId). */
  cycle: number;
  /** K4: the declared soak window, so a close-out can bound its glob. */
  soakWindow: { start: string | null; end: string | null };
  /** K4: false ⇒ this cycle is OUTSIDE the sealed window and is not evidence. */
  withinDeclaredWindow: boolean;
  status: 'pass' | 'fail';
  assertions: AssertionResult[];
  counts: Record<string, number | boolean | string | null>;
  ticks?: TickObservation[];
  admission?: Record<string, unknown>;
  targetUrl?: string;
  supabaseProjectRef?: string | null;
  blockers?: string[];
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Host only — the GetBlock RPC token lives in the URL PATH (§1.4). */
export function hostOnly(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Supabase project ref from a project URL (`https://<ref>.supabase.co`).
 * Returns null when the URL is not a Supabase project URL — which is itself a
 * blocker in live mode, because an unidentifiable ref cannot be deny-checked.
 */
export function supabaseRefFromUrl(url: string | undefined): string | null {
  const host = hostOnly(url);
  if (!host) return null;
  const match = /^([a-z0-9]{20})\.supabase\.(co|in|red)$/i.exec(host);
  return match ? match[1].toLowerCase() : null;
}

// ─── K3: hard-deny ───────────────────────────────────────────────────────────

/**
 * Recover the Cloud Run SERVICE NAME from a run.app hostname.
 *
 * A prefix test is not good enough here and getting it wrong is dangerous in
 * BOTH directions. `arkova-worker-pr2524-staging-abc123-uc.a.run.app` starts
 * with `arkova-worker-`, so a `startsWith` deny refuses the legitimate isolated
 * rig; and `arkova-worker-staging-…` matches the prefixes of two different
 * denied entries at once. Service names contain hyphens, so the only reliable
 * split is to strip Cloud Run's own suffix and compare what remains exactly.
 *
 * Both URL shapes Google issues:
 *   legacy  <service>-<hash>-<regioncode>.a.run.app
 *   current <service>-<hash>.<region>.run.app
 *
 * Returns `null` for a host that is not a run.app URL at all. A host that IS a
 * run.app URL but does not match either shape is treated as unidentifiable by
 * the caller and denied, rather than assumed safe.
 */
export function cloudRunServiceFromHost(host: string): string | null {
  const legacy = /^(.+)-[a-z0-9]+-[a-z]{2}\.a\.run\.app$/i.exec(host);
  if (legacy) return legacy[1].toLowerCase();
  const current = /^(.+)-[a-z0-9]+\.[a-z0-9-]+\.run\.app$/i.exec(host);
  if (current) return current[1].toLowerCase();
  return null;
}

/**
 * K3. Refuse to RUN — not merely refuse to write — when the target resolves to
 * production or to shared staging.
 *
 * Four independent checks, because each one alone has a hole: a rig can be
 * wired to the prod database behind an innocuous Cloud Run URL, a shared
 * staging service can be pointed at a fresh project, an unrecognisable Supabase
 * URL cannot be deny-checked at all, and a run.app host whose service name
 * cannot be recovered is equally uncheckable. All four are refused rather than
 * assumed safe.
 */
export function isDeniedTarget(input: {
  supabaseUrl?: string;
  targetUrl?: string;
}): string[] {
  const blockers: string[] = [];

  const ref = supabaseRefFromUrl(input.supabaseUrl);
  if (input.supabaseUrl && ref === null) {
    blockers.push(
      `unrecognised Supabase URL '${hostOnly(input.supabaseUrl) ?? '<unparseable>'}' — the project ref cannot be deny-checked, so this target is refused`,
    );
  }
  if (ref === PROD_SUPABASE_REF) {
    blockers.push(`Supabase project ref resolves to PRODUCTION (${PROD_SUPABASE_REF}) — hard denied`);
  }
  if (ref === SHARED_STAGING_SUPABASE_REF) {
    blockers.push(
      `Supabase project ref resolves to SHARED staging (${SHARED_STAGING_SUPABASE_REF}) — not isolated, so not T3 evidence`,
    );
  }

  const targetHost = hostOnly(input.targetUrl);
  if (targetHost) {
    if (/\.run\.app$/i.test(targetHost)) {
      const service = cloudRunServiceFromHost(targetHost);
      if (service === null) {
        blockers.push(
          `target host '${targetHost}' is a Cloud Run URL whose service name cannot be recovered — refusing rather than guessing`,
        );
      } else if ((DENIED_CLOUD_RUN_SERVICES as readonly string[]).includes(service)) {
        blockers.push(`target Cloud Run service '${service}' is a shared/prod service — hard denied`);
      }
    }
    for (const denied of DENIED_HOST_SUBSTRINGS) {
      if (targetHost === denied || targetHost.endsWith(`.${denied}`)) {
        blockers.push(`target host '${targetHost}' is a production Arkova host — hard denied`);
      }
    }
  }

  return blockers;
}

// ─── K4: window bounding ─────────────────────────────────────────────────────

/**
 * K4. A previous soak folded post-window cycles into a sealed window because the
 * close-out glob was unbounded. Every row therefore carries the declared window
 * AND a precomputed boolean, so a close-out never has to re-derive it — and a
 * row outside the window is additionally forced to evidenceForSoak=false.
 */
export function withinDeclaredWindow(
  utc: string,
  window: { start: string | null; end: string | null },
): boolean {
  const at = Date.parse(utc);
  if (Number.isNaN(at)) return false;
  if (window.start) {
    const start = Date.parse(window.start);
    if (Number.isNaN(start) || at < start) return false;
  }
  if (window.end) {
    const end = Date.parse(window.end);
    if (Number.isNaN(end) || at > end) return false;
  }
  // No declared window ⇒ cannot claim membership of one.
  return Boolean(window.start || window.end);
}

// ─── Assertion logic (pure — this is what the unit test pins) ─────────────────

/**
 * A1/A2/A3 — the sweep.
 *
 * A1 is the anti-hollow gate: the broken build answered a 400 (`22P02`) whose
 * error branch zeroed every counter, so "scanned 0, updated 0" is the exact
 * signature of the defect AND of a healthy empty database. On the FIRST tick of
 * a cycle — where the fixture guarantees candidates exist — zeros are a failure,
 * never a pass.
 *
 * A2 is the advance proof. The wedge cohort sorts first in the `anchor_id`
 * keyspace and can never complete (its recorded `block_hash` disagrees with the
 * block its real tx is in, and the rows deliberately disagree with EACH OTHER so
 * the group-level unanimity short-circuit stays disarmed and the per-anchor K1
 * gate fires). Its presence in a page is therefore observable as
 * `anchorsBlockMismatch > 0`. A build that re-returns the head of the keyspace
 * reports the wedge on EVERY tick; the fixed build reports it on the first tick
 * of a sweep and then steps over it.
 *
 * A3 is the wrap/rotation proof: an empty page (`scanned === 0`) is the wrap
 * signal the implementation documents, and the tick after it must see the wedge
 * again — proving rotation rather than a one-way walk off the end.
 */
export function evaluateSweep(ticks: TickObservation[]): AssertionResult[] {
  const first = ticks[0];

  const a1: AssertionResult = {
    id: 'A1_scan_not_hollow',
    proves:
      'The first tick of the cycle both SWEPT rows and WROTE evidence. Distinguishes "swept and found nothing" from "errored and reported nothing" — the 22P02 all-zero signature the H1 cursor bug produced.',
    ok: false,
    detail: '',
  };
  if (!first) {
    a1.detail = 'no tick was executed';
  } else if (!first.httpOk) {
    a1.detail = `first tick HTTP ${first.httpStatus} — the cron endpoint did not answer 2xx`;
  } else if (first.skipped) {
    a1.detail =
      'first tick returned skipped=true — the rig is in mock mode or ENABLE_PROD_NETWORK_ANCHORING is off, so the whole soak would be hollow';
  } else if (first.scanned === 0) {
    a1.detail =
      'first tick scanned=0 against a seeded fixture. This is the H1 signature: the scan error branch returns zeroed counters that read exactly like "no candidates". Check for 22P02 (invalid uuid input) in the worker log before believing the database is empty.';
  } else if (first.anchorsUpdated === 0) {
    a1.detail = `first tick scanned=${first.scanned} but anchorsUpdated=0 — rows were visited and none were written`;
  } else {
    a1.ok = true;
    a1.detail = `scanned=${first.scanned} anchorsUpdated=${first.anchorsUpdated} txConfirmed=${first.txConfirmed}`;
  }

  const a2: AssertionResult = {
    id: 'A2_sweep_advances',
    proves:
      'The sweep cursor moved PAST the page it just scanned. The never-completable wedge cohort sits first in the anchor_id keyspace and is visible as anchorsBlockMismatch>0; a later tick that scans rows with mismatch=0 can only have started beyond it.',
    ok: false,
    detail: '',
  };
  if (!first) {
    a2.detail = 'no tick was executed';
  } else if (first.anchorsBlockMismatch === 0) {
    a2.detail =
      'first tick reported anchorsBlockMismatch=0, so the wedge cohort was not in the first page. Without the wedge as a marker this cycle cannot discriminate advance from re-returning the same page — re-seed the fixture (or re-arm it) before trusting any sweep evidence.';
  } else {
    const advanced = ticks.findIndex(
      (t, i) => i > 0 && t.httpOk && t.scanned > 0 && t.anchorsBlockMismatch === 0,
    );
    if (advanced === -1) {
      a2.ok = false;
      a2.detail = `no tick after the first scanned rows without the wedge (mismatch per tick: ${ticks
        .map((t) => t.anchorsBlockMismatch)
        .join(',')}). A build that re-returns the head of the keyspace looks exactly like this.`;
    } else {
      a2.ok = true;
      a2.detail = `tick ${advanced} scanned=${ticks[advanced].scanned} with anchorsBlockMismatch=0 after tick 0 reported ${first.anchorsBlockMismatch}`;
    }
  }

  const a3: AssertionResult = {
    id: 'A3_sweep_wraps',
    proves:
      'The sweep reached the end of the keyspace (an empty page — the documented wrap condition) and then restarted at the beginning, seeing the wedge again. Proves rotation, not a one-way walk that silently stops.',
    ok: false,
    detail: '',
  };
  const emptyIdx = ticks.findIndex((t) => t.httpOk && !t.skipped && t.scanned === 0);
  if (emptyIdx === -1) {
    a3.detail = `no empty page within ${ticks.length} tick(s) — raise --max-ticks, or the fixture is larger than the tick budget allows`;
  } else if (emptyIdx === ticks.length - 1) {
    a3.detail = `empty page at tick ${emptyIdx} but no tick after it to observe the restart — raise --max-ticks by one`;
  } else {
    const after = ticks[emptyIdx + 1];
    if (after.anchorsBlockMismatch > 0) {
      a3.ok = true;
      a3.detail = `tick ${emptyIdx} scanned=0 (wrap) and tick ${emptyIdx + 1} saw the wedge again (mismatch=${after.anchorsBlockMismatch})`;
    } else {
      a3.detail = `tick ${emptyIdx} scanned=0 (wrap) but tick ${emptyIdx + 1} did not see the wedge (mismatch=${after.anchorsBlockMismatch}, scanned=${after.scanned}) — the cursor did not restart at the beginning of the keyspace`;
    }
  }

  return [a1, a2, a3];
}

/**
 * A4 — the batched write crossed the `.in()` chunk boundary.
 *
 * `chunkForInFilter` closes a chunk at 200 values or 8 KiB of encoded request
 * line, whichever binds first, so more than 200 anchors sharing ONE payload is
 * necessarily more than one `.in()` statement. Three things together make this
 * a real assertion rather than an arithmetic one:
 *   (a) every row in the cohort carries a BYTE-IDENTICAL payload ⇒ exactly one
 *       payload group, so the row count is the group's `.in()` width;
 *   (b) `chunkForInFilter` — the real function, imported, not re-derived —
 *       splits those exact ids into >= 2 chunks;
 *   (c) every row is populated ⇒ no chunk was silently dropped.
 */
export function evaluateChunkBoundary(input: {
  cohortSize: number;
  populatedAnchorIds: string[];
  distinctPayloads: number;
}): AssertionResult {
  const result: AssertionResult = {
    id: 'A4_chunk_boundary_crossed',
    proves:
      'The confirmation write fanned one identical payload across MORE THAN ONE PostgREST .in() statement and every row in the group landed. Exercises the per-row .eq() -> grouped .in() change past the 200-value cap.',
    ok: false,
    detail: '',
  };

  const ids = input.populatedAnchorIds;
  if (ids.length <= POSTGREST_IN_FILTER_CHUNK) {
    result.detail = `only ${ids.length} populated rows in the bulk cohort — at or below the ${POSTGREST_IN_FILTER_CHUNK}-value chunk cap, so no boundary was crossed`;
    return result;
  }
  const chunks = chunkForInFilter(ids);
  if (chunks.length < 2) {
    result.detail = `chunkForInFilter split ${ids.length} ids into ${chunks.length} chunk(s) — expected at least 2`;
    return result;
  }
  if (input.distinctPayloads !== 1) {
    result.detail = `bulk cohort carries ${input.distinctPayloads} distinct payloads — it must be exactly 1 for the row count to equal the .in() width`;
    return result;
  }
  if (ids.length !== input.cohortSize) {
    result.detail = `${ids.length} of ${input.cohortSize} bulk-cohort rows are populated — a chunk was dropped or the sweep has not finished the cohort`;
    return result;
  }

  result.ok = true;
  result.detail = `${ids.length} rows, 1 payload, ${chunks.length} chunks (sizes ${chunks
    .map((c) => c.values.length)
    .join('+')}), all populated`;
  return result;
}

/**
 * A5/A6 — the B0 fold guard, against REAL `gettxoutproof` responses.
 *
 * A5 is the positive: a single-txid proof parses, and the branch the parser
 * EMITS (pass #2 of the partial-merkle walk — the array that gets persisted and
 * published) folds back to the merkleroot inside the header. The driver re-folds
 * independently with `foldTxInclusionBranch` rather than trusting the parser's
 * own internal check.
 *
 * A6 is the negative and the reason B0 exists: `gettxoutproof` takes a txid
 * LIST, so a CPartialMerkleTree can mark more than one leaf. Before B0 the
 * emitted branch for a multi-match tree came out longer than the tree is tall
 * and folded to something that is NOT the header's merkleroot — while the
 * verified-root check on pass #1 still passed. `parseTxOutProof` must now reject
 * such a proof outright rather than emit a bundle that refutes itself.
 */
export function evaluateFoldGuard(input: {
  singleTxParsed: boolean;
  singleTxBranchLength: number | null;
  singleTxFoldsToHeaderRoot: boolean;
  multiTxTargetsTried: number;
  multiTxRejected: number;
  error?: string;
}): AssertionResult[] {
  const a5: AssertionResult = {
    id: 'A5_fold_guard_emits_verifiable_branch',
    proves:
      'For a real mainnet gettxoutproof response, the branch parseTxOutProof EMITS folds to the merkleroot inside the block header it came with — re-folded independently by the driver, not taken on the parser\'s word.',
    ok: false,
    detail: input.error ?? '',
  };
  if (input.error) {
    a5.detail = `chain verification did not run: ${input.error}`;
  } else if (!input.singleTxParsed) {
    a5.detail = 'parseTxOutProof returned null for a single-txid proof of a known-good mainnet transaction';
  } else if (!input.singleTxFoldsToHeaderRoot) {
    a5.detail = `emitted branch (length ${input.singleTxBranchLength}) did NOT fold to the header merkleroot`;
  } else {
    a5.ok = true;
    a5.detail = `single-txid proof parsed, branch length ${input.singleTxBranchLength}, folds to the header merkleroot`;
  }

  const a6: AssertionResult = {
    id: 'A6_fold_guard_rejects_multi_match',
    proves:
      'A gettxoutproof built over TWO txids in the same block — the multi-match class whose emitted branch folds to the wrong root — is REJECTED by parseTxOutProof instead of being persisted next to verified:true.',
    ok: false,
    detail: input.error ?? '',
  };
  if (input.error) {
    a6.detail = `chain verification did not run: ${input.error}`;
  } else if (input.multiTxTargetsTried === 0) {
    a6.detail = 'no multi-txid proof was fetched — the negative control did not run';
  } else if (input.multiTxRejected !== input.multiTxTargetsTried) {
    a6.detail = `${input.multiTxRejected} of ${input.multiTxTargetsTried} multi-match targets were rejected — a non-rejected target means a self-refuting branch would be persisted`;
  } else {
    a6.ok = true;
    a6.detail = `all ${input.multiTxTargetsTried} multi-match target(s) rejected`;
  }

  return [a5, a6];
}

/**
 * A7/A8/A9 — read/write coherence and the `/proof` surface.
 *
 * A7 is the coherence property the PR is really about: data the WRITER accepted
 * as valid (`isCoherentInclusionPair`) must not be rejected by the READER
 * (`readTxInclusionEvidence`). Both are module-private, so this is proven at the
 * boundary — what is in the row versus what `/proof` publishes.
 *
 * A8 adds the cryptographic half: the PUBLISHED branch must fold to the
 * merkleroot inside the PUBLISHED header. A bundle that a holder cannot check
 * offline is the whole thing migration 0427 exists to prevent.
 *
 * A9 is the live half of B2: an anchor that demonstrably HAS an `anchor_proofs`
 * row must never come back as the NO_BATCH_PROOF 404, which is what a swallowed
 * read error used to produce.
 */
export function evaluateCoherence(input: {
  httpStatus: number;
  errorCode?: string | null;
  dbBranch: unknown;
  dbIndex: number | null;
  publishedBranch: unknown;
  publishedIndex: number | null;
  publishedFoldsToHeaderRoot: boolean;
  bundlePresent: boolean;
}): AssertionResult[] {
  const dbHasPair = Array.isArray(input.dbBranch) && typeof input.dbIndex === 'number';
  const pubHasPair = Array.isArray(input.publishedBranch) && typeof input.publishedIndex === 'number';
  const sameBranch = JSON.stringify(input.dbBranch ?? null) === JSON.stringify(input.publishedBranch ?? null);

  const a7: AssertionResult = {
    id: 'A7_read_write_coherent',
    proves:
      'The inclusion pair the WRITER persisted is the pair the READER publishes, byte for byte. Data written as valid is not rejected on read (writer isCoherentInclusionPair vs reader readTxInclusionEvidence).',
    ok: false,
    detail: '',
  };
  if (!dbHasPair) {
    a7.detail = `the sampled row carries no stored pair (branch=${Array.isArray(input.dbBranch) ? 'array' : typeof input.dbBranch}, index=${input.dbIndex}) — the sweep has not populated it`;
  } else if (!pubHasPair) {
    a7.detail =
      '/proof published NULL for a row that HAS a stored pair — the reader rejected what the writer accepted (the exact coherence failure this asserts against)';
  } else if (!sameBranch || input.dbIndex !== input.publishedIndex) {
    a7.detail = `stored pair and published pair differ (index ${input.dbIndex} vs ${input.publishedIndex}, branch equal=${sameBranch})`;
  } else {
    a7.ok = true;
    a7.detail = `stored and published pair identical (index ${input.dbIndex}, ${(input.dbBranch as unknown[]).length} siblings)`;
  }

  const a8: AssertionResult = {
    id: 'A8_proof_publishes_verifiable_inclusion',
    proves:
      '/proof returns 200 with a complete proof_bundle carrying tx_inclusion_branch + tx_block_index, and the published branch folds to the merkleroot inside the published block_header — a holder can close the bitcoin-tree half offline.',
    ok: false,
    detail: '',
  };
  if (input.httpStatus !== 200) {
    a8.detail = `/proof answered HTTP ${input.httpStatus}`;
  } else if (!input.bundlePresent) {
    a8.detail = '/proof answered 200 but proof_bundle is null';
  } else if (!pubHasPair) {
    a8.detail = 'proof_bundle present but tx_inclusion_branch / tx_block_index are null';
  } else if (!input.publishedFoldsToHeaderRoot) {
    a8.detail = 'published branch does NOT fold to the merkleroot in the published block_header';
  } else {
    a8.ok = true;
    a8.detail = `bundle published with a ${(input.publishedBranch as unknown[]).length}-sibling branch at index ${input.publishedIndex}; folds to the published header merkleroot`;
  }

  const a9: AssertionResult = {
    id: 'A9_no_false_back_catalogue_404',
    proves:
      'An anchor that HAS an anchor_proofs row is never answered the NO_BATCH_PROOF 404. That 404 is a statement about the RECORD; B2 stops a failed READ from being reported as one.',
    ok: false,
    detail: '',
  };
  if (input.httpStatus === 404 && input.errorCode === 'NO_BATCH_PROOF') {
    a9.detail =
      'a fixture anchor with a proof row was answered 404 NO_BATCH_PROOF — either the read failed and was swallowed, or the proof row is genuinely absent';
  } else if (input.httpStatus >= 500) {
    a9.detail = `/proof answered HTTP ${input.httpStatus} — honest (B2 fails loudly) but the record was not served; investigate before counting this cycle`;
  } else {
    a9.ok = true;
    a9.detail = `HTTP ${input.httpStatus}${input.errorCode ? ` code=${input.errorCode}` : ''}`;
  }

  return [a7, a8, a9];
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

/**
 * Secrets may be supplied by flag (to match the pr1408 CLI contract that the
 * admission tooling drives) or, PREFERABLY, by environment variable — argv is
 * visible in `ps`. Environment values are used only when the flag is absent.
 */
export function parseArgs(argv: string[]): DriverArgs {
  const args: DriverArgs = { mode: 'self-test' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--self-test':
        args.mode = 'self-test';
        break;
      case '--live':
        args.mode = 'live';
        break;
      case '--target-url':
        args.targetUrl = argv[++i];
        break;
      case '--admission-json':
        args.admissionJson = argv[++i];
        break;
      case '--evidence-jsonl':
        args.evidenceJsonl = argv[++i];
        break;
      case '--cron-secret':
        args.cronSecret = argv[++i];
        break;
      case '--bearer-token':
        args.bearerToken = argv[++i];
        break;
      case '--supabase-url':
        args.supabaseUrl = argv[++i];
        break;
      case '--supabase-service-key':
        args.supabaseServiceKey = argv[++i];
        break;
      case '--rpc-url':
        args.rpcUrl = argv[++i];
        break;
      case '--rpc-auth':
        args.rpcAuth = argv[++i];
        break;
      case '--run-id':
        args.runId = argv[++i];
        break;
      case '--window-start':
        args.windowStart = argv[++i];
        break;
      case '--window-end':
        args.windowEnd = argv[++i];
        break;
      case '--max-ticks':
        args.maxTicks = Number.parseInt(argv[++i], 10);
        break;
      case '--tick-delay-ms':
        args.tickDelayMs = Number.parseInt(argv[++i], 10);
        break;
      case '--no-rearm':
        args.rearm = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

/** Fill unset secret/config fields from the environment (flags win). */
export function applyEnvDefaults(args: DriverArgs, env: NodeJS.ProcessEnv): DriverArgs {
  return {
    ...args,
    cronSecret: args.cronSecret ?? env.RIG_CRON_SECRET,
    bearerToken: args.bearerToken ?? env.RIG_BEARER_TOKEN,
    supabaseUrl: args.supabaseUrl ?? env.RIG_SUPABASE_URL,
    supabaseServiceKey: args.supabaseServiceKey ?? env.RIG_SUPABASE_SERVICE_ROLE_KEY,
    rpcUrl: args.rpcUrl ?? env.RIG_BITCOIN_RPC_URL,
    rpcAuth: args.rpcAuth ?? env.RIG_BITCOIN_RPC_AUTH,
  };
}

export function validateLiveArgs(args: DriverArgs): string[] {
  const blockers: string[] = [];
  if (!args.targetUrl) blockers.push('missing --target-url');
  if (!args.admissionJson) blockers.push('missing --admission-json');
  if (!args.evidenceJsonl) blockers.push('missing --evidence-jsonl');
  if (!args.cronSecret && !args.bearerToken) blockers.push('missing --cron-secret or --bearer-token');
  if (!args.supabaseUrl) blockers.push('missing --supabase-url (or RIG_SUPABASE_URL)');
  if (!args.supabaseServiceKey) {
    blockers.push('missing --supabase-service-key (or RIG_SUPABASE_SERVICE_ROLE_KEY)');
  }
  // Fail CLOSED: the fold guard must be exercised against REAL gettxoutproof
  // responses, so a live cycle without RPC access is not this PR's evidence.
  if (!args.rpcUrl) blockers.push('missing --rpc-url (or RIG_BITCOIN_RPC_URL) — the B0 fold guard requires real gettxoutproof responses, not fixtures');
  return blockers;
}

// ─── Self-test ───────────────────────────────────────────────────────────────

function tick(overrides: Partial<TickObservation> & { tick: number }): TickObservation {
  return {
    httpOk: true,
    httpStatus: 200,
    skipped: false,
    scanned: 0,
    txAttempted: 0,
    txConfirmed: 0,
    txPending: 0,
    txStale: 0,
    anchorsUpdated: 0,
    anchorsMissing: 0,
    anchorsBlockMismatch: 0,
    ...overrides,
  };
}

/** A healthy fixed-build cycle: sweep, advance, wrap, restart. */
export function healthyTickSequence(): TickObservation[] {
  return [
    tick({ tick: 0, scanned: 2000, txAttempted: 5, txConfirmed: 5, anchorsUpdated: 1880, anchorsBlockMismatch: 120 }),
    tick({ tick: 1, scanned: 1000, txAttempted: 3, txConfirmed: 3, anchorsUpdated: 1000 }),
    tick({ tick: 2, scanned: 0 }),
    tick({ tick: 3, scanned: 120, txAttempted: 1, txConfirmed: 1, anchorsBlockMismatch: 120 }),
  ];
}

/** The 22P02 signature: the scan error branch zeroing every counter. */
export function hollowTickSequence(): TickObservation[] {
  return [tick({ tick: 0 }), tick({ tick: 1 }), tick({ tick: 2 }), tick({ tick: 3 })];
}

/** The pre-H1 build: every tick re-returns the head of the keyspace. */
export function pinnedTickSequence(): TickObservation[] {
  return [
    tick({ tick: 0, scanned: 2000, anchorsUpdated: 1880, anchorsBlockMismatch: 120 }),
    tick({ tick: 1, scanned: 2000, anchorsUpdated: 0, anchorsBlockMismatch: 120 }),
    tick({ tick: 2, scanned: 2000, anchorsUpdated: 0, anchorsBlockMismatch: 120 }),
    tick({ tick: 3, scanned: 2000, anchorsUpdated: 0, anchorsBlockMismatch: 120 }),
  ];
}

/**
 * Local validation of the assertion logic. Crucially it asserts the logic
 * DISCRIMINATES: the broken-build vectors must fail, not merely the healthy one
 * pass. A driver that green-lights the broken build is worse than no driver.
 */
export async function runSelfTest(): Promise<DriverRow> {
  const utc = new Date().toISOString();

  const healthy = evaluateSweep(healthyTickSequence());
  const hollow = evaluateSweep(hollowTickSequence());
  const pinned = evaluateSweep(pinnedTickSequence());

  const uuid = (n: number) => `5eed2524-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  const wideIds = Array.from({ length: 450 }, (_, i) => uuid(i));
  const narrowIds = Array.from({ length: 199 }, (_, i) => uuid(i));

  const chunkWide = evaluateChunkBoundary({
    cohortSize: 450,
    populatedAnchorIds: wideIds,
    distinctPayloads: 1,
  });
  const chunkNarrow = evaluateChunkBoundary({
    cohortSize: 199,
    populatedAnchorIds: narrowIds,
    distinctPayloads: 1,
  });
  const chunkDropped = evaluateChunkBoundary({
    cohortSize: 450,
    populatedAnchorIds: wideIds.slice(0, 250),
    distinctPayloads: 1,
  });

  const foldGood = evaluateFoldGuard({
    singleTxParsed: true,
    singleTxBranchLength: 12,
    singleTxFoldsToHeaderRoot: true,
    multiTxTargetsTried: 2,
    multiTxRejected: 2,
  });
  const foldBad = evaluateFoldGuard({
    singleTxParsed: true,
    singleTxBranchLength: 13,
    singleTxFoldsToHeaderRoot: false,
    multiTxTargetsTried: 2,
    multiTxRejected: 1,
  });

  const branch = [{ hash: 'a'.repeat(64), position: 'right' as const }];
  const coherent = evaluateCoherence({
    httpStatus: 200,
    dbBranch: branch,
    dbIndex: 0,
    publishedBranch: branch,
    publishedIndex: 0,
    publishedFoldsToHeaderRoot: true,
    bundlePresent: true,
  });
  const readerRejected = evaluateCoherence({
    httpStatus: 200,
    dbBranch: branch,
    dbIndex: 0,
    publishedBranch: null,
    publishedIndex: null,
    publishedFoldsToHeaderRoot: false,
    bundlePresent: true,
  });
  const false404 = evaluateCoherence({
    httpStatus: 404,
    errorCode: 'NO_BATCH_PROOF',
    dbBranch: branch,
    dbIndex: 0,
    publishedBranch: null,
    publishedIndex: null,
    publishedFoldsToHeaderRoot: false,
    bundlePresent: false,
  });

  const ok = (list: AssertionResult[], id: string) => list.find((a) => a.id === id)?.ok === true;

  const counts: Record<string, number | boolean | string | null> = {
    // Healthy build passes every sweep assertion.
    healthySweepAllPass: healthy.every((a) => a.ok),
    // The 22P02 all-zero response must FAIL A1 — this is the discrimination
    // that makes the driver worth running at all.
    hollowFailsA1: !ok(hollow, 'A1_scan_not_hollow'),
    hollowFailsA2: !ok(hollow, 'A2_sweep_advances'),
    // The pre-H1 pinned-window build must FAIL the advance/wrap assertions even
    // though its FIRST tick looks perfectly healthy.
    pinnedPassesA1: ok(pinned, 'A1_scan_not_hollow'),
    pinnedFailsA2: !ok(pinned, 'A2_sweep_advances'),
    pinnedFailsA3: !ok(pinned, 'A3_sweep_wraps'),
    chunkWidePasses: chunkWide.ok,
    chunkNarrowFails: !chunkNarrow.ok,
    chunkDroppedFails: !chunkDropped.ok,
    foldGuardPasses: foldGood.every((a) => a.ok),
    foldGuardFailsOnBadFold: !ok(foldBad, 'A5_fold_guard_emits_verifiable_branch'),
    foldGuardFailsOnUnrejectedMultiMatch: !ok(foldBad, 'A6_fold_guard_rejects_multi_match'),
    coherentPasses: coherent.every((a) => a.ok),
    readerRejectionFailsA7: !ok(readerRejected, 'A7_read_write_coherent'),
    false404FailsA9: !ok(false404, 'A9_no_false_back_catalogue_404'),
    // K3 hard-deny.
    prodRefDenied: isDeniedTarget({ supabaseUrl: `https://${PROD_SUPABASE_REF}.supabase.co` }).length > 0,
    sharedStagingRefDenied:
      isDeniedTarget({ supabaseUrl: `https://${SHARED_STAGING_SUPABASE_REF}.supabase.co` }).length > 0,
    sharedWorkerDenied:
      isDeniedTarget({ targetUrl: 'https://arkova-worker-staging-abc123-uc.a.run.app' }).length > 0,
    prodWorkerDenied: isDeniedTarget({ targetUrl: 'https://arkova-worker-abc123-uc.a.run.app' }).length > 0,
    unidentifiableCloudRunDenied:
      isDeniedTarget({ targetUrl: 'https://something.run.app' }).length > 0,
    unknownSupabaseHostDenied: isDeniedTarget({ supabaseUrl: 'https://db.example.com' }).length > 0,
    isolatedRigAllowed:
      isDeniedTarget({
        supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
        targetUrl: 'https://arkova-worker-pr2524-staging-abc123-uc.a.run.app',
      }).length === 0,
    // K4 window bounding.
    insideWindowTrue: withinDeclaredWindow('2026-09-02T12:00:00Z', {
      start: '2026-09-01T00:00:00Z',
      end: '2026-09-03T00:00:00Z',
    }),
    afterWindowFalse: !withinDeclaredWindow('2026-09-04T12:00:00Z', {
      start: '2026-09-01T00:00:00Z',
      end: '2026-09-03T00:00:00Z',
    }),
    noWindowFalse: !withinDeclaredWindow('2026-09-02T12:00:00Z', { start: null, end: null }),
    // Live mode fails closed without RPC access.
    liveRequiresRpc: validateLiveArgs({ mode: 'live' }).includes(
      'missing --rpc-url (or RIG_BITCOIN_RPC_URL) — the B0 fold guard requires real gettxoutproof responses, not fixtures',
    ),
  };

  const pass = Object.values(counts).every((v) => v === true);

  return {
    utc,
    pr: 2524,
    tier: 'T3',
    mode: 'self-test',
    evidenceForSoak: false,
    changedBehavior: CHANGED_BEHAVIOR,
    notAsserted: NOT_ASSERTED,
    runId: 'self-test',
    cycle: 0,
    soakWindow: { start: null, end: null },
    withinDeclaredWindow: false,
    status: pass ? 'pass' : 'fail',
    assertions: [...healthy, chunkWide, ...foldGood, ...coherent],
    counts,
  };
}

// ─── Live-mode I/O ───────────────────────────────────────────────────────────

type FetchLike = typeof fetch;

/** Injectable chain-side operations (real implementations are loaded lazily). */
export interface ChainOps {
  getBlockHeaderHex(blockHash: string): Promise<string>;
  getTxOutProof(txids: string[], blockHash: string): Promise<string>;
  parseTxOutProof(
    proofHex: string,
    targetTxId: string,
  ): { blockHeader: string; blockMerkleRoot: string; merkleBranch: unknown[]; txIndex: number } | null;
  foldToDisplayRoot(txid: string, branch: unknown[]): string | null;
}

export interface LiveDeps {
  fetchImpl?: FetchLike;
  chainOps?: ChainOps;
  now?: () => Date;
}

interface DbClient {
  /** GET only. Returns parsed JSON plus the Content-Range count when requested. */
  select<T>(path: string, opts?: { exactCount?: boolean }): Promise<{ rows: T[]; total: number | null; status: number; code?: string }>;
  /** The single non-GET call. Id-scoped, deny-checked, capped. */
  patchByAnchorIds(anchorIds: string[], values: Record<string, unknown>): Promise<number>;
}

function makeDbClient(
  supabaseUrl: string,
  serviceKey: string,
  fetchImpl: FetchLike,
): DbClient {
  const base = supabaseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    accept: 'application/json',
  };

  return {
    async select<T>(path: string, opts: { exactCount?: boolean } = {}) {
      const res = await fetchImpl(`${base}/rest/v1/${path}`, {
        method: 'GET',
        headers: opts.exactCount ? { ...headers, prefer: 'count=exact' } : headers,
      });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // keep text for diagnostics
      }
      const range = res.headers.get('content-range');
      const total = range && range.includes('/') ? Number.parseInt(range.split('/')[1], 10) : null;
      const code =
        typeof body === 'object' && body !== null && 'code' in body
          ? String((body as { code?: unknown }).code)
          : undefined;
      return {
        rows: Array.isArray(body) ? (body as T[]) : [],
        total: Number.isNaN(total as number) ? null : total,
        status: res.status,
        code,
      };
    },

    async patchByAnchorIds(anchorIds: string[], values: Record<string, unknown>) {
      // Defence in depth: re-check the deny list at the only write call site.
      const denied = isDeniedTarget({ supabaseUrl });
      if (denied.length > 0) throw new Error(`refusing to write: ${denied.join('; ')}`);
      if (anchorIds.length === 0) throw new Error('refusing an unfiltered PATCH: no fixture ids resolved');
      if (anchorIds.length > REARM_ROW_CAP) {
        throw new Error(
          `refusing to re-arm ${anchorIds.length} rows (cap ${REARM_ROW_CAP}) — the fixture query matched more than the fixture`,
        );
      }

      let touched = 0;
      for (const chunk of chunkForInFilter(assertUuids(anchorIds, 'fixture re-arm'))) {
        const filter = `anchor_id=in.(${chunk.values.join(',')})`;
        const res = await fetchImpl(`${base}/rest/v1/anchor_proofs?${filter}`, {
          method: 'PATCH',
          headers: { ...headers, 'content-type': 'application/json', prefer: 'return=representation' },
          body: JSON.stringify(values),
        });
        if (!res.ok) {
          throw new Error(`re-arm PATCH failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
        }
        const rows = (await res.json()) as unknown[];
        touched += Array.isArray(rows) ? rows.length : 0;
      }
      return touched;
    },
  };
}

/** Default ChainOps: JSON-RPC to GetBlock plus the worker's own parser/folder. */
async function loadChainOps(rpcUrl: string, rpcAuth: string | undefined, fetchImpl: FetchLike): Promise<ChainOps> {
  // Dynamic import: `chain/confirmation-proof.js` reaches `utils/logger.js` ->
  // `config.js`, which THROWS at module load when the worker env is incomplete.
  // Loading it lazily turns "operator ran this without worker env" into a clear
  // assertion failure instead of an unhandled crash before any evidence exists.
  const mod = await import('../src/chain/confirmation-proof.js');

  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (rpcAuth) headers.authorization = rpcAuth;
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '1.0', id: 'pr2524-driver', method, params }),
    });
    if (!res.ok) {
      // §1.4: never echo the URL — the GetBlock token is in its path.
      throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`RPC ${method} error: ${body.error.message ?? 'unknown'}`);
    return body.result;
  };

  return {
    getBlockHeaderHex: async (blockHash) => String(await rpc('getblockheader', [blockHash, false])),
    getTxOutProof: async (txids, blockHash) => String(await rpc('gettxoutproof', [txids, blockHash])),
    parseTxOutProof: (proofHex, targetTxId) =>
      mod.parseTxOutProof(proofHex, targetTxId) as ReturnType<ChainOps['parseTxOutProof']>,
    foldToDisplayRoot: (txid, branch) => {
      const leafLE = Buffer.from(txid, 'hex').reverse();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MerkleProofEntry is structurally identical
      const folded = mod.foldTxInclusionBranch(leafLE, branch as any);
      return folded == null ? null : Buffer.from(folded).reverse().toString('hex');
    },
  };
}

/** Merkleroot from a raw 80-byte header, in display (byte-reversed) hex. */
export function merkleRootFromHeaderHex(headerHex: string): string | null {
  if (typeof headerHex !== 'string' || !/^[0-9a-fA-F]{160}$/.test(headerHex)) return null;
  return Buffer.from(headerHex.slice(72, 136), 'hex').reverse().toString('hex');
}

interface FixtureAnchor {
  id: string;
  public_id: string | null;
  chain_tx_id: string | null;
}

interface FixtureProofRow {
  anchor_id: string;
  block_hash: string | null;
  block_header: string | null;
  tx_inclusion_branch: unknown;
  tx_block_index: number | null;
}

const PAGE = 1000;

async function selectAllPages<T>(db: DbClient, buildPath: (limit: number, offset: number) => string, cap = 6000): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < cap; offset += PAGE) {
    const { rows } = await db.select<T>(buildPath(PAGE, offset));
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function cohortAnchorPath(cohort: FixtureCohort) {
  return (limit: number, offset: number) =>
    `anchors?select=id,public_id,chain_tx_id` +
    `&metadata->>_purpose=eq.${FIXTURE_PURPOSE}` +
    `&metadata->>_cohort=eq.${cohort}` +
    `&order=id.asc&limit=${limit}&offset=${offset}`;
}

/** Canonical uuid. Anything else must never reach an `.in()` filter. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every id that goes into a PostgREST filter is checked first.
 *
 * These values come from a `uuid` column, so they are canonical by
 * construction — but "by construction" is an assumption about a system on the
 * other side of the wire, and a value carrying `,` or `)` would silently
 * restructure the filter rather than fail. Cheap to close, so it is closed.
 */
export function assertUuids(ids: readonly string[], context: string): string[] {
  const bad = ids.filter((id) => !UUID_RE.test(id));
  if (bad.length > 0) {
    throw new Error(`${context}: ${bad.length} id(s) are not canonical uuids — refusing to build a filter from them`);
  }
  return [...ids];
}

/**
 * Read `anchor_proofs` for a set of anchors.
 *
 * Chunked by `chunkForInFilter`, NOT sent as one filter: the bulk cohort is 450
 * uuids ≈ 16 KiB on the request line, twice the 8 KiB PostgREST budget, and the
 * proxy answers 400 rather than truncating. The read path has exactly the same
 * URL-width constraint as the write path, so it uses exactly the same helper —
 * hand-rolling a second chunk loop here is the mistake the repo lints against.
 */
async function readProofRows(db: DbClient, anchorIds: string[]): Promise<FixtureProofRow[]> {
  const out: FixtureProofRow[] = [];
  for (const chunk of chunkForInFilter(assertUuids(anchorIds, 'anchor_proofs read'))) {
    const rows = await selectAllPages<FixtureProofRow>(db, (limit, offset) =>
      `anchor_proofs?select=anchor_id,block_hash,block_header,tx_inclusion_branch,tx_block_index` +
      `&anchor_id=in.(${chunk.values.join(',')})&order=anchor_id.asc&limit=${limit}&offset=${offset}`,
    );
    out.push(...rows);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Next cycle number for (evidence file, runId). Self-numbering, no state file. */
export function nextCycleNumber(evidencePath: string | undefined, runId: string): number {
  if (!evidencePath || !existsSync(evidencePath)) return 1;
  let n = 0;
  for (const line of readFileSync(evidencePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { runId?: string };
      if (row.runId === runId) n += 1;
    } catch {
      // A malformed line is not a cycle.
    }
  }
  return n + 1;
}

export async function runLive(args: DriverArgs, deps: LiveDeps = {}): Promise<DriverRow> {
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const utc = now().toISOString();
  const runId = args.runId ?? `pr2524-${createHash('sha256').update(utc).digest('hex').slice(0, 12)}`;

  const blockers = [...validateLiveArgs(args), ...isDeniedTarget(args)];
  const window = { start: args.windowStart ?? null, end: args.windowEnd ?? null };

  const fail = (extra: Partial<DriverRow> = {}): DriverRow => ({
    utc,
    pr: 2524,
    tier: 'T3',
    mode: 'live',
    evidenceForSoak: false,
    changedBehavior: CHANGED_BEHAVIOR,
    notAsserted: NOT_ASSERTED,
    runId,
    cycle: nextCycleNumber(args.evidenceJsonl, runId),
    soakWindow: window,
    withinDeclaredWindow: withinDeclaredWindow(utc, window),
    status: 'fail',
    assertions: [],
    counts: {},
    blockers,
    targetUrl: args.targetUrl,
    supabaseProjectRef: supabaseRefFromUrl(args.supabaseUrl),
    ...extra,
  });

  if (blockers.length > 0) return fail();

  const admission = JSON.parse(readFileSync(args.admissionJson!, 'utf8')) as Record<string, unknown>;
  const admissionWindow = {
    start: window.start ?? (typeof admission.soak_start === 'string' ? admission.soak_start : null),
    end: window.end ?? (typeof admission.soak_end === 'string' ? admission.soak_end : null),
  };
  const cycle = nextCycleNumber(args.evidenceJsonl, runId);

  // The admission JSON names the rig; a driver pointed somewhere else is not
  // producing evidence for THIS rig no matter how green its assertions are.
  const admissionRef = typeof admission.supabase_project_ref === 'string' ? admission.supabase_project_ref : null;
  const observedRef = supabaseRefFromUrl(args.supabaseUrl);
  if (admissionRef && observedRef && admissionRef !== observedRef) {
    blockers.push(
      `admission supabase_project_ref (${admissionRef}) does not match the driver's target (${observedRef})`,
    );
    return fail({
      admission: { supabase_project_ref: admissionRef },
      cycle,
      soakWindow: admissionWindow,
      withinDeclaredWindow: withinDeclaredWindow(utc, admissionWindow),
    });
  }

  const targetUrl = args.targetUrl!.replace(/\/+$/, '');
  const db = makeDbClient(args.supabaseUrl!, args.supabaseServiceKey!, fetchImpl);

  const counts: Record<string, number | boolean | string | null> = {
    rpcHost: hostOnly(args.rpcUrl),
  };
  const assertions: AssertionResult[] = [];

  // ── K1: is the build the worker is serving actually one with 0427 applied? ──
  const schemaProbe = await db.select<unknown>('anchor_proofs?select=tx_inclusion_branch,tx_block_index&limit=1');
  if (schemaProbe.status >= 400) {
    blockers.push(
      `migration 0427 not readable on this rig (HTTP ${schemaProbe.status}${schemaProbe.code ? ` code=${schemaProbe.code}` : ''}). ` +
        'A 42703 here means the columns do not exist: the worker would report all-zero counters that look exactly like "no candidates". Refusing to report zeros as success.',
    );
    return fail({
      cycle,
      counts,
      soakWindow: admissionWindow,
      withinDeclaredWindow: withinDeclaredWindow(utc, admissionWindow),
    });
  }
  counts.migration0427Readable = true;

  // ── Fixture discovery ──
  const wedge = await selectAllPages<FixtureAnchor>(db, cohortAnchorPath('wedge'));
  const bulk = await selectAllPages<FixtureAnchor>(db, cohortAnchorPath('bulk'));
  const spread = await selectAllPages<FixtureAnchor>(db, cohortAnchorPath('spread'));
  counts.fixtureWedge = wedge.length;
  counts.fixtureBulk = bulk.length;
  counts.fixtureSpread = spread.length;

  if (wedge.length === 0 || bulk.length === 0 || spread.length === 0) {
    blockers.push(
      `fixture absent or incomplete (wedge=${wedge.length}, bulk=${bulk.length}, spread=${spread.length}). ` +
        'All three cohorts are load-bearing: wedge marks the head of the keyspace (A2/A3), bulk crosses the .in() chunk cap (A4), ' +
        'spread supplies the second txid for the multi-match negative control (A6) and the volume that forces more than one sweep page. ' +
        'Seed with scripts/staging/seed-proof-txinclusion-fixture.sql before starting the soak.',
    );
    return fail({
      cycle,
      counts,
      soakWindow: admissionWindow,
      withinDeclaredWindow: withinDeclaredWindow(utc, admissionWindow),
    });
  }

  // ── Re-arm: clear the bitcoin-tree columns on the fixture so THIS cycle is a
  // complete, self-contained trigger cycle (T3 requires multiple of them).
  // Data-only, id-scoped, isolated-rig-only. `block_hash` is reinstated on the
  // wedge (its deliberate disagreement is what makes the sweep observable) and
  // cleared on the completable cohorts (a first population records none). ──
  const rearm = args.rearm !== false;
  if (rearm) {
    const completableIds = [...bulk, ...spread].map((a) => a.id);
    counts.rearmedCompletable = await db.patchByAnchorIds(completableIds, {
      block_header: null,
      block_hash: null,
      tx_inclusion_branch: null,
      tx_block_index: null,
    });
    // The wedge keeps its per-row mismatching hash; only the bitcoin-tree
    // evidence is cleared, so it re-enters the scan exactly as seeded.
    counts.rearmedWedge = await db.patchByAnchorIds(wedge.map((a) => a.id), {
      block_header: null,
      tx_inclusion_branch: null,
      tx_block_index: null,
    });
  }
  counts.rearmed = rearm;

  // ── Ticks ──
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (args.cronSecret) headers['x-cron-secret'] = args.cronSecret;
  if (args.bearerToken) headers.authorization = `Bearer ${args.bearerToken}`;

  const maxTicks = Math.min(Math.max(args.maxTicks ?? 8, 2), 24);
  const tickDelayMs = Math.max(args.tickDelayMs ?? 0, 0);
  const ticks: TickObservation[] = [];
  let sawEmpty = false;

  for (let i = 0; i < maxTicks; i += 1) {
    if (i > 0 && tickDelayMs > 0) await sleep(tickDelayMs);
    const res = await fetchImpl(`${targetUrl}/jobs/populate-confirmation-proofs`, { method: 'POST', headers });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep text for diagnostics
    }
    const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const observation: TickObservation = {
      tick: i,
      httpOk: res.ok,
      httpStatus: res.status,
      skipped: o.skipped === true,
      scanned: Number(o.scanned ?? 0),
      txAttempted: Number(o.txAttempted ?? 0),
      txConfirmed: Number(o.txConfirmed ?? 0),
      txPending: Number(o.txPending ?? 0),
      txStale: Number(o.txStale ?? 0),
      anchorsUpdated: Number(o.anchorsUpdated ?? 0),
      anchorsMissing: Number(o.anchorsMissing ?? 0),
      anchorsBlockMismatch: Number(o.anchorsBlockMismatch ?? 0),
    };
    ticks.push(observation);
    if (!res.ok || observation.skipped) break;
    // Stop one tick AFTER the wrap so A3 can observe the restart.
    if (sawEmpty) break;
    if (observation.scanned === 0) sawEmpty = true;
  }

  assertions.push(...evaluateSweep(ticks));

  // ── A4: the batched write across the chunk boundary ──
  const bulkIds = bulk.map((a) => a.id);
  const bulkProofs = await readProofRows(db, bulkIds);
  const populated = bulkProofs.filter(
    (r) => Array.isArray(r.tx_inclusion_branch) && typeof r.tx_block_index === 'number' && r.block_header,
  );
  const payloadKeys = new Set(
    populated.map((r) =>
      JSON.stringify([r.block_header, r.block_hash, r.tx_inclusion_branch, r.tx_block_index]),
    ),
  );
  assertions.push(
    evaluateChunkBoundary({
      cohortSize: bulkIds.length,
      populatedAnchorIds: populated.map((r) => r.anchor_id).sort(),
      distinctPayloads: payloadKeys.size,
    }),
  );
  counts.bulkCohortSize = bulkIds.length;
  counts.bulkPopulated = populated.length;
  counts.bulkDistinctPayloads = payloadKeys.size;

  // ── A5/A6: the B0 fold guard against REAL gettxoutproof responses ──
  const foldInput = {
    singleTxParsed: false,
    singleTxBranchLength: null as number | null,
    singleTxFoldsToHeaderRoot: false,
    multiTxTargetsTried: 0,
    multiTxRejected: 0,
    error: undefined as string | undefined,
  };
  try {
    const chainOps = deps.chainOps ?? (await loadChainOps(args.rpcUrl!, args.rpcAuth, fetchImpl));
    // Two fixture txids that share ONE block — the multi-match negative control
    // needs them, and the seed guarantees the pairing.
    const sample = populated[0] ?? bulkProofs[0];
    const blockHash = sample?.block_hash ?? null;
    const txA = bulk[0]?.chain_tx_id ?? null;
    const txB = spread.find((a) => a.chain_tx_id && a.chain_tx_id !== txA)?.chain_tx_id ?? null;

    if (!blockHash || !txA) {
      foldInput.error = 'no populated fixture row with a block hash yet — run a cycle that completes the bulk cohort first';
    } else {
      const headerHex = await chainOps.getBlockHeaderHex(blockHash);
      const headerRoot = merkleRootFromHeaderHex(headerHex);
      const singleProof = await chainOps.getTxOutProof([txA], blockHash);
      const parsed = chainOps.parseTxOutProof(singleProof, txA);
      foldInput.singleTxParsed = parsed !== null;
      foldInput.singleTxBranchLength = parsed ? parsed.merkleBranch.length : null;
      if (parsed && headerRoot) {
        const folded = chainOps.foldToDisplayRoot(txA, parsed.merkleBranch);
        foldInput.singleTxFoldsToHeaderRoot = folded !== null && folded.toLowerCase() === headerRoot.toLowerCase();
        counts.headerMerkleRoot = headerRoot;
      }

      // NEGATIVE CONTROL: a proof marking TWO leaves. Before B0 the emitted
      // branch for such a tree came out longer than the tree is tall and folded
      // to the wrong root while pass #1's verified-root check still passed.
      if (txB) {
        const multiProof = await chainOps.getTxOutProof([txA, txB], blockHash);
        for (const target of [txA, txB]) {
          foldInput.multiTxTargetsTried += 1;
          if (chainOps.parseTxOutProof(multiProof, target) === null) foldInput.multiTxRejected += 1;
        }
      }
    }
  } catch (err) {
    foldInput.error = errMsg(err);
  }
  assertions.push(...evaluateFoldGuard(foldInput));
  counts.foldSingleParsed = foldInput.singleTxParsed;
  counts.foldMultiRejected = `${foldInput.multiTxRejected}/${foldInput.multiTxTargetsTried}`;

  // ── A7/A8/A9: read/write coherence through the real /proof reader ──
  const sampleRow = populated[0] ?? null;
  const sampleAnchor = sampleRow ? bulk.find((a) => a.id === sampleRow.anchor_id) ?? null : null;
  const coherenceInput = {
    httpStatus: 0,
    errorCode: null as string | null,
    dbBranch: sampleRow?.tx_inclusion_branch ?? null,
    dbIndex: sampleRow?.tx_block_index ?? null,
    publishedBranch: null as unknown,
    publishedIndex: null as number | null,
    publishedFoldsToHeaderRoot: false,
    bundlePresent: false,
  };
  if (sampleAnchor?.public_id) {
    const res = await fetchImpl(`${targetUrl}/api/v1/proof/${encodeURIComponent(sampleAnchor.public_id)}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    coherenceInput.httpStatus = res.status;
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    coherenceInput.errorCode = typeof body.code === 'string' ? body.code : null;
    const bundle =
      typeof body.proof_bundle === 'object' && body.proof_bundle !== null
        ? (body.proof_bundle as Record<string, unknown>)
        : null;
    coherenceInput.bundlePresent = bundle !== null;
    if (bundle) {
      coherenceInput.publishedBranch = bundle.tx_inclusion_branch ?? null;
      coherenceInput.publishedIndex =
        typeof bundle.tx_block_index === 'number' ? bundle.tx_block_index : null;
      const publishedHeader = typeof bundle.block_header === 'string' ? bundle.block_header : null;
      const publishedRoot = publishedHeader ? merkleRootFromHeaderHex(publishedHeader) : null;
      const txid = typeof bundle.tx_id === 'string' ? bundle.tx_id : null;
      if (publishedRoot && txid && Array.isArray(coherenceInput.publishedBranch) && deps.chainOps) {
        const folded = deps.chainOps.foldToDisplayRoot(txid, coherenceInput.publishedBranch);
        coherenceInput.publishedFoldsToHeaderRoot = folded?.toLowerCase() === publishedRoot.toLowerCase();
      } else if (publishedRoot && txid && Array.isArray(coherenceInput.publishedBranch)) {
        try {
          const ops = await loadChainOps(args.rpcUrl!, args.rpcAuth, fetchImpl);
          const folded = ops.foldToDisplayRoot(txid, coherenceInput.publishedBranch);
          coherenceInput.publishedFoldsToHeaderRoot = folded?.toLowerCase() === publishedRoot.toLowerCase();
        } catch {
          coherenceInput.publishedFoldsToHeaderRoot = false;
        }
      }
    }
  } else {
    coherenceInput.httpStatus = 0;
  }
  assertions.push(...evaluateCoherence(coherenceInput));
  counts.proofHttpStatus = coherenceInput.httpStatus;
  counts.sampledPublicId = sampleAnchor?.public_id ?? null;

  const withinWindow = withinDeclaredWindow(utc, admissionWindow);
  const allOk = assertions.every((a) => a.ok);

  return {
    utc,
    pr: 2524,
    tier: 'T3',
    mode: 'live',
    evidenceForSoak: allOk && withinWindow,
    changedBehavior: CHANGED_BEHAVIOR,
    notAsserted: NOT_ASSERTED,
    runId,
    cycle,
    soakWindow: admissionWindow,
    withinDeclaredWindow: withinWindow,
    status: allOk ? 'pass' : 'fail',
    assertions,
    counts,
    ticks,
    admission: {
      rig_name: admission.rig_name ?? null,
      head_sha: admission.head_sha ?? null,
      base_sha: admission.base_sha ?? null,
      supabase_project_ref: admission.supabase_project_ref ?? null,
      cloud_run_service: admission.cloud_run_service ?? null,
      deployed_revision: admission.deployed_revision ?? null,
      image_digest: admission.image_digest ?? null,
      preflight_result: admission.preflight_result ?? null,
      driver_path: admission.driver_path ?? null,
      driver_sha256: admission.driver_sha256 ?? null,
    },
    targetUrl,
    supabaseProjectRef: observedRef,
  };
}

export async function runDriver(args: DriverArgs, deps: LiveDeps = {}): Promise<DriverRow> {
  return args.mode === 'live' ? runLive(args, deps) : runSelfTest();
}

async function main(): Promise<void> {
  const args = applyEnvDefaults(parseArgs(process.argv.slice(2)), process.env);
  const row = await runDriver(args);
  const line = `${JSON.stringify(row)}\n`;
  if (args.evidenceJsonl) appendFileSync(args.evidenceJsonl, line);
  process.stdout.write(line);
  if (row.status !== 'pass') process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
