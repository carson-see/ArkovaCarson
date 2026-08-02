#!/usr/bin/env node
/**
 * SCRUM-2912 — HakiChain real-anchor submission PLANNER (DRY-RUN ONLY).
 *
 * REVIEWED 2026-08-01 — premise correction. The original version of this
 * script computed a numeric difference between `org_credits.anchor_quota`
 * (15) and the org's SECURED anchor count (4), and treated that difference
 * as a count of anchors Arkova needed to create on HakiChain's behalf. That
 * computation and its framing are retracted. Per founder-confirmed ground
 * truth (memory/project_hakichain_account_state.md — the founder has
 * independently corrected this exact framing three times, on 2026-07-26,
 * 2026-07-28, and 2026-08-01) and the parallel retraction in
 * docs/partners/hakichain-kpi-reconciliation.md (commit b4dfb04b7): HakiChain
 * has 4 completed anchors, and separately, 15 units of allocated capacity
 * (`org_credits.anchor_quota`) for THEM to draw on whenever they choose to
 * anchor documents. These are two unrelated numbers. Subtracting one from
 * the other does not produce a meaningful quantity, and nothing computed
 * that way represents work Arkova owes. Do not resurrect that computation
 * under any name.
 *
 * CTO NOTE — this tool's reason for existing, not just its wording, is in
 * question. With the old computation removed, no standing legitimate reason
 * for an Arkova operator to originate anchors on HakiChain's behalf remains
 * documented: their allocated capacity is for their own use, and any real
 * documents they anchor would naturally flow through their own normal
 * issuance path, not a manifest an Arkova operator hand-assembles on their
 * behalf. What remains below is a generic, honestly-framed capability — an
 * operator explicitly chooses to submit N real anchors for an org via the
 * real bulk-anchor path — kept functional (rather than deleted outright)
 * only so the CTO/founder can decide, with a working tool in front of them,
 * whether any legitimate use case justifies keeping it. Recommend deleting
 * this file if none surfaces.
 *
 * WHAT THIS TOOL DOES
 *   Builds the request body for the REAL anchoring path — the public
 *   `POST /api/v1/anchor/bulk` endpoint (`BulkAnchorRequestSchema` in
 *   services/worker/src/api/v1/anchor-bulk.ts). That endpoint inserts anchors as
 *   status `PENDING` and lets the normal worker pipeline broadcast + confirm them
 *   to SECURED. Submission therefore goes through real anchoring — Bitcoin
 *   commitment and all — never a hand-written `anchors`/`anchor_proofs` INSERT.
 *
 * WHAT THIS TOOL WILL NEVER DO
 *   - It NEVER writes to Postgres and contains no SQL. It only emits a plan.
 *   - It NEVER emits a real-write request. The dry-run flag on the emitted body is
 *     hard-pinned true; flipping to a real write is a deliberate, founder-gated
 *     manual step performed OUTSIDE this tool.
 *   - It NEVER fabricates document fingerprints. Real 32-byte SHA-256 fingerprints
 *     for every requested anchor must be supplied via `--manifest`. Without a
 *     manifest the tool prints placeholders, marks the plan `blocked`, and exits
 *     non-zero.
 *   - It NEVER computes `count` from any quota or other org capacity figure.
 *     `--count` is a plain operator input: how many real anchors the operator
 *     has decided, for their own stated reason, to submit this run.
 *
 * IDEMPOTENCY
 *   - `--count` is an explicit request size supplied by the operator, not
 *     computed from any other number. Re-running with the same manifest and
 *     count is safe: every planned row carries a deterministic `external_id`
 *     (`HAKI-KPI1-NN`, numbered starting right after `--current-secured`) and
 *     the request uses `duplicate_strategy: "skip"`, so replaying never
 *     double-anchors an already-present fingerprint.
 *
 * USAGE
 *   node scripts/kpi3/haki-provision-plan.mjs \
 *     --current-secured 4 --count 3 [--manifest haki-fingerprints.json] \
 *     [--batch-id haki-batch-2026] [--json]
 *
 *   --current-secured N   REQUIRED. The org's current SECURED count (read-only
 *                         prod query — this tool does not touch the DB). Used
 *                         only to continue external_id numbering after
 *                         existing anchors; never subtracted from anything.
 *   --count N             REQUIRED. The number of real anchors the operator
 *                         has explicitly decided to submit this run. Not a
 *                         default, not derived from any capacity figure — the
 *                         caller must state it.
 *   --manifest PATH       JSON array of { fingerprint, document_type?,
 *                         original_document_date?, matter_or_case_ref?,
 *                         description? }. Real 64-hex SHA-256 fingerprints only.
 *   --batch-id ID         Optional batch_id passed through to the endpoint.
 *   --json                Emit the machine-readable plan object only.
 */

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const EXTERNAL_ID_PREFIX = 'HAKI-KPI1-';

/** Parse argv into a flat options object. Pure; no I/O. */
export function parseArgs(argv) {
  const opts = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--json': opts.json = true; break;
      case '--current-secured': opts.currentSecured = Number(argv[++i]); break;
      case '--count': opts.count = Number(argv[++i]); break;
      case '--manifest': opts.manifest = argv[++i]; break;
      case '--batch-id': opts.batchId = argv[++i]; break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    }
  }
  return opts;
}

/**
 * Deterministic external id for the k-th (1-based) submitted anchor.
 * Zero-padded so re-runs and sorted output line up.
 */
export function externalIdFor(seq) {
  return `${EXTERNAL_ID_PREFIX}${String(seq).padStart(2, '0')}`;
}

/**
 * Build the DRY-RUN submission plan. Pure function of its inputs so it is fully
 * unit-testable and side-effect free.
 *
 * @param {object} args
 * @param {number} args.currentSecured  current SECURED count for the org (numbering only)
 * @param {number} args.count           REQUIRED. Explicit operator-chosen count of real
 *                                       anchors to submit this run. Never derived from any
 *                                       capacity figure — see header note.
 * @param {Array}  [args.manifest=[]]   real fingerprint rows (see USAGE)
 * @param {string} [args.batchId]       optional batch_id
 * @returns {{ status: 'complete'|'blocked'|'ready-dry-run',
 *            count: number, currentSecured: number,
 *            reasons: string[], request: object|null, usesPlaceholders: boolean }}
 */
export function buildPlan({ currentSecured, count, manifest = [], batchId } = {}) {
  const reasons = [];

  if (!Number.isInteger(currentSecured) || currentSecured < 0) {
    throw new Error('--current-secured must be a non-negative integer (read it from prod, read-only)');
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(
      '--count must be a non-negative integer: the number of real anchors you have explicitly '
      + 'decided to submit this run. It is an operator choice, never computed from any capacity figure.',
    );
  }

  // count=0 is a legitimate explicit choice (nothing to submit this run) —
  // not a computed "already there" result, because nothing is computed here.
  if (count === 0) {
    return {
      status: 'complete',
      count: 0,
      currentSecured,
      reasons: ['count is 0; nothing to submit this run'],
      request: null,
      usesPlaceholders: false,
    };
  }

  // Validate any supplied manifest. We only ever CONSUME the first `count`
  // rows — supplying more is fine (idempotent), supplying fewer blocks.
  const rows = [];
  let usesPlaceholders = false;

  for (let i = 0; i < count; i += 1) {
    const seq = currentSecured + i + 1; // continue numbering after existing anchors
    const src = manifest[i];
    if (src && typeof src.fingerprint === 'string' && FINGERPRINT_RE.test(src.fingerprint)) {
      rows.push({
        fingerprint: src.fingerprint,
        external_id: externalIdFor(seq),
        ...(src.document_type ? { document_type: src.document_type } : {}),
        ...(src.original_document_date ? { original_document_date: src.original_document_date } : {}),
        ...(src.matter_or_case_ref ? { matter_or_case_ref: src.matter_or_case_ref } : {}),
        ...(src.description ? { description: src.description } : {}),
      });
    } else {
      usesPlaceholders = true;
      // Deliberately NOT a valid 64-hex SHA-256: it must be impossible to submit a
      // placeholder to /api/v1/anchor/bulk by accident (the endpoint's
      // FINGERPRINT_REGEX would reject it), so the guard can never be bypassed.
      rows.push({
        fingerprint: `PLACEHOLDER-NEEDS-REAL-FINGERPRINT-${externalIdFor(seq)}`,
        external_id: externalIdFor(seq),
        description: 'PLACEHOLDER — real fingerprint required before any submission',
      });
    }
  }

  if (manifest.length > 0 && manifest.length < count) {
    reasons.push(`manifest supplies ${manifest.length} rows but count is ${count}`);
  }

  // The request body is ALWAYS dry_run:true and duplicate_strategy:"skip".
  const request = {
    dry_run: true, // hard-pinned; this tool never emits a real write
    duplicate_strategy: 'skip', // idempotent replay
    ...(batchId ? { batch_id: batchId } : {}),
    anchors: rows,
  };

  if (usesPlaceholders) {
    reasons.unshift(
      'BLOCKED: plan contains placeholder fingerprints. Supply a real --manifest '
      + 'with a real fingerprint for every requested anchor before submitting.',
    );
    return { status: 'blocked', count, currentSecured, reasons, request, usesPlaceholders };
  }

  reasons.unshift(
    'DRY-RUN plan built with real fingerprints. Submitting even this dry_run:true body, '
    + 'and the eventual real write, remain founder-gated manual steps performed OUTSIDE this tool.',
  );
  return { status: 'ready-dry-run', count, currentSecured, reasons, request, usesPlaceholders };
}

/* c8 ignore start — CLI wrapper, exercised via the exported pure functions. */
async function main() {
  const { readFileSync } = await import('node:fs');
  const opts = parseArgs(process.argv.slice(2));

  if (opts.currentSecured === undefined || Number.isNaN(opts.currentSecured)) {
    console.error('ERROR: --current-secured N is required (read the org SECURED count from prod, read-only).');
    process.exit(2);
  }
  if (opts.count === undefined || Number.isNaN(opts.count)) {
    console.error(
      'ERROR: --count N is required — explicitly state how many real anchors to submit this run. '
      + 'This tool will not infer a count from any capacity figure.',
    );
    process.exit(2);
  }

  let manifest = [];
  if (opts.manifest) {
    manifest = JSON.parse(readFileSync(opts.manifest, 'utf8'));
    if (!Array.isArray(manifest)) {
      console.error('ERROR: --manifest must be a JSON array of fingerprint rows.');
      process.exit(2);
    }
  }

  const plan = buildPlan({
    currentSecured: opts.currentSecured,
    count: opts.count,
    manifest,
    batchId: opts.batchId,
  });

  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(`SCRUM-2912 HakiChain real-anchor submission plan (DRY-RUN ONLY)`);
    console.log(`  current SECURED : ${plan.currentSecured}`);
    console.log(`  count (chosen)  : ${plan.count}`);
    console.log(`  status          : ${plan.status}`);
    for (const r of plan.reasons) console.log(`  - ${r}`);
    if (plan.request) {
      console.log(`\n  Request body for POST /api/v1/anchor/bulk (dry_run:${plan.request.dry_run}):`);
      console.log(JSON.stringify(plan.request, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));
    }
  }

  // Non-zero exit unless there is nothing to do or a real dry-run plan is ready.
  if (plan.status === 'blocked') process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exit(2); });
}
/* c8 ignore stop */
