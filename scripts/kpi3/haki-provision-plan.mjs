#!/usr/bin/env node
/**
 * SCRUM-2912 — HakiChain KPI-1 anchor provisioning PLANNER (DRY-RUN ONLY).
 *
 * KPI-1 (→ first $250 Haki invoice, Aug 9) needs the HakiChain org to hold the
 * full 15-anchor KPI-1 demo set. Read-only prod (2026-07-21, project
 * `vzwyaatejekddvltxyye`) shows the production `HakiChain` org
 * (f52cd07a-6d8a-4387-9346-23babec84e5c) holds exactly 4 SECURED anchors — the
 * 4 DIRECT anchors named in HAKI-KPI3-RUNBOOK. Shortfall to 15 = 11.
 *
 * WHAT THIS TOOL DOES
 *   Builds the request body for the REAL anchoring path — the public
 *   `POST /api/v1/anchor/bulk` endpoint (`BulkAnchorRequestSchema` in
 *   services/worker/src/api/v1/anchor-bulk.ts). That endpoint inserts anchors as
 *   status `PENDING` and lets the normal worker pipeline broadcast + confirm them
 *   to SECURED. Provisioning therefore goes through real anchoring — Bitcoin
 *   commitment and all — never a hand-written `anchors`/`anchor_proofs` INSERT.
 *
 * WHAT THIS TOOL WILL NEVER DO
 *   - It NEVER writes to Postgres and contains no SQL. It only emits a plan.
 *   - It NEVER emits a real-write request. The dry-run flag on the emitted body is
 *     hard-pinned true; flipping to a real write is a deliberate, founder-gated
 *     manual step performed OUTSIDE this tool.
 *   - It NEVER fabricates document fingerprints. Real 32-byte SHA-256 fingerprints
 *     for the 11 documents must be supplied via `--manifest`. Without a manifest
 *     the tool prints placeholders, marks the plan `blocked`, and exits non-zero.
 *
 * FOUNDER / CTO RULING REQUIRED (blocker — see PR body)
 *   What do the 11 batch anchors REPRESENT? Real HakiChain Kenya legal-doc pilot
 *   documents, or a labelled demo set? That is a product/founder decision, not an
 *   engineering one. Until it is ruled and a real fingerprint manifest exists,
 *   this planner cannot produce an executable plan — by design.
 *
 * IDEMPOTENCY
 *   - Target is an absolute count (default 15), not "+11": re-running when the org
 *     already holds N SECURED provisions only `max(0, target - N)` rows.
 *   - Every planned row carries a deterministic `external_id` (`HAKI-KPI1-NN`) and
 *     the request uses `duplicate_strategy: "skip"`, so replaying the same manifest
 *     never double-anchors an already-present fingerprint.
 *
 * USAGE
 *   node scripts/kpi3/haki-provision-plan.mjs \
 *     --current-secured 4 [--target 15] [--manifest haki-fingerprints.json] \
 *     [--batch-id haki-kpi1-2026] [--json]
 *
 *   --current-secured N   REQUIRED. The org's current SECURED count (read-only
 *                         prod query — this tool does not touch the DB).
 *   --target N            Absolute KPI-1 target (default 15).
 *   --manifest PATH       JSON array of { fingerprint, document_type?,
 *                         original_document_date?, matter_or_case_ref?,
 *                         description? }. Real 64-hex SHA-256 fingerprints only.
 *   --batch-id ID         Optional batch_id passed through to the endpoint.
 *   --json                Emit the machine-readable plan object only.
 */

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const DEFAULT_TARGET = 15;
const EXTERNAL_ID_PREFIX = 'HAKI-KPI1-';

/** Parse argv into a flat options object. Pure; no I/O. */
export function parseArgs(argv) {
  const opts = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--json': opts.json = true; break;
      case '--current-secured': opts.currentSecured = Number(argv[++i]); break;
      case '--target': opts.target = Number(argv[++i]); break;
      case '--manifest': opts.manifest = argv[++i]; break;
      case '--batch-id': opts.batchId = argv[++i]; break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    }
  }
  return opts;
}

/**
 * Deterministic external id for the k-th (1-based) provisioned anchor.
 * Zero-padded so re-runs and sorted output line up.
 */
export function externalIdFor(seq) {
  return `${EXTERNAL_ID_PREFIX}${String(seq).padStart(2, '0')}`;
}

/**
 * Build the DRY-RUN provisioning plan. Pure function of its inputs so it is fully
 * unit-testable and side-effect free.
 *
 * @param {object} args
 * @param {number} args.currentSecured  current SECURED count for the org
 * @param {number} [args.target=15]     absolute KPI-1 target
 * @param {Array}  [args.manifest=[]]   real fingerprint rows (see USAGE)
 * @param {string} [args.batchId]       optional batch_id
 * @returns {{ status: 'complete'|'blocked'|'ready-dry-run',
 *            shortfall: number, target: number, currentSecured: number,
 *            reasons: string[], request: object|null, usesPlaceholders: boolean }}
 */
export function buildPlan({ currentSecured, target = DEFAULT_TARGET, manifest = [], batchId } = {}) {
  const reasons = [];

  if (!Number.isInteger(currentSecured) || currentSecured < 0) {
    throw new Error('--current-secured must be a non-negative integer (read it from prod, read-only)');
  }
  if (!Number.isInteger(target) || target < 1) {
    throw new Error('--target must be a positive integer');
  }

  const shortfall = Math.max(0, target - currentSecured);

  // Idempotent short-circuit: nothing to do once the org already holds >= target.
  if (shortfall === 0) {
    return {
      status: 'complete',
      shortfall: 0,
      target,
      currentSecured,
      reasons: [`org already holds ${currentSecured} >= target ${target}; nothing to provision`],
      request: null,
      usesPlaceholders: false,
    };
  }

  // Validate any supplied manifest. We only ever CONSUME the first `shortfall`
  // rows — supplying more is fine (idempotent), supplying fewer blocks.
  const rows = [];
  let usesPlaceholders = false;

  for (let i = 0; i < shortfall; i += 1) {
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

  if (manifest.length > 0 && manifest.length < shortfall) {
    reasons.push(`manifest supplies ${manifest.length} rows but shortfall is ${shortfall}`);
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
      + '(and the founder/CTO ruling on what the 11 anchors represent) before submitting.',
    );
    return { status: 'blocked', shortfall, target, currentSecured, reasons, request, usesPlaceholders };
  }

  reasons.unshift(
    'DRY-RUN plan built with real fingerprints. Submitting even this dry_run:true body, '
    + 'and the eventual real write, remain founder-gated manual steps performed OUTSIDE this tool.',
  );
  return { status: 'ready-dry-run', shortfall, target, currentSecured, reasons, request, usesPlaceholders };
}

/* c8 ignore start — CLI wrapper, exercised via the exported pure functions. */
async function main() {
  const { readFileSync } = await import('node:fs');
  const opts = parseArgs(process.argv.slice(2));

  if (opts.currentSecured === undefined || Number.isNaN(opts.currentSecured)) {
    console.error('ERROR: --current-secured N is required (read the org SECURED count from prod, read-only).');
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
    target: opts.target ?? DEFAULT_TARGET,
    manifest,
    batchId: opts.batchId,
  });

  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(`SCRUM-2912 HakiChain provisioning plan (DRY-RUN ONLY)`);
    console.log(`  current SECURED : ${plan.currentSecured}`);
    console.log(`  target          : ${plan.target}`);
    console.log(`  shortfall       : ${plan.shortfall}`);
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
