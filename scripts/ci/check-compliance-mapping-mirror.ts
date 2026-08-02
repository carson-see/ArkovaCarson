#!/usr/bin/env tsx
/**
 * Compliance-mapping mirror guard — anti-drift for the whole false-claim class.
 *
 * WHY THIS EXISTS
 *
 * `services/worker/src/utils/complianceMapping.ts` is a hand-maintained mirror of
 * `src/lib/complianceMapping.ts`. Its own header says "control IDs must match".
 * Nothing enforced that, and it cost us a false regulatory claim served in
 * production:
 *
 *   2026-04-17  `DPF-NOTICE` / `DPF-ACCOUNTABILITY` added to BOTH mappings.
 *   2026-06-05  PO confirms Arkova is NOT self-certified under the EU-US DPF.
 *               The claim is pulled from the /enterprise page — frontend only,
 *               that commit says so explicitly.
 *   2026-07-10  SCRUM-2283 removes both control IDs from the FRONTEND mapping.
 *               The worker mirror is not touched.
 *   2026-08-01  The worker is finally fixed — after continuing to write both IDs
 *               onto every SECURED anchor and serve them from `/api/v1/verify`,
 *               the customer audit export, and the GRC evidence push into
 *               Vanta / Drata / Anecdotes.
 *
 * Two separate remediations both fixed the frontend only. The retired claim
 * survived in the worker for weeks because a human had to remember a second
 * file. This check removes that requirement.
 *
 * WHAT IT ENFORCES
 *
 * The two EMITTED unions must be identical, in both directions. Each module
 * exports `EMITTABLE_CONTROL_IDS` — the union of its universal set and every
 * type-specific set, i.e. exactly the IDs it can attach to a credential.
 *
 * Comparing the emitted unions (not the frontend's `COMPLIANCE_CONTROLS`
 * definitions registry) is deliberate and is the difference between a guard that
 * works and one that looks like it does. The registry legitimately carries
 * jurisdiction controls (Kenya DPA, APP, POPIA, NDPA) that no credential type
 * maps to yet, so it is a strictly larger set — checking against it would let the
 * MINIMAL, most likely retirement slip through: pull an ID from the frontend's
 * emitted arrays (which is sufficient to stop the public badge rendering) but
 * leave its definition in the registry, and a registry-based check stays green
 * while the worker keeps serving the retired ID. That is the incident, replayed.
 *
 * Third assertion: every emitted ID must have a definition in
 * `COMPLIANCE_CONTROLS`, since an emitted-but-undefined ID renders as nothing in
 * the UI while still being written to anchors and served over the API.
 *
 * FAIL CLOSED. Any failure to resolve either side — a moved file, a renamed
 * export, an empty set — is a FAILURE, not a skip. A guard that silently passes
 * when it cannot see the thing it guards is worse than no guard, because it also
 * removes the reason to look.
 *
 * Usage: tsx scripts/ci/check-compliance-mapping-mirror.ts
 * Exit 0 = mirrors agree. Exit 1 = drift (or the check could not verify).
 */

import {
  COMPLIANCE_CONTROLS,
  EMITTABLE_CONTROL_IDS as FRONTEND_EMITTABLE,
} from '../../src/lib/complianceMapping.js';
import { EMITTABLE_CONTROL_IDS as WORKER_EMITTABLE } from '../../services/worker/src/utils/complianceMapping.js';
import { isMainModule } from './lib/ciContext.js';

export interface MirrorInput {
  /** Every control ID the worker can attach to a credential. */
  workerEmitted: ReadonlySet<string>;
  /** Every control ID the frontend can attach to a credential. */
  frontendEmitted: ReadonlySet<string>;
  /** Keys of the frontend `COMPLIANCE_CONTROLS` definitions registry. */
  definedIds: ReadonlySet<string>;
}

export interface MirrorResult {
  ok: boolean;
  lines: string[];
}

function sortedDiff(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...a].filter((id) => !b.has(id)).sort();
}

/**
 * The whole check as a pure function, so every fail-closed branch is assertable
 * from a test instead of only reachable by running CI. `main()` is a thin
 * exit-code wrapper over this.
 */
export function runMirrorCheck(input: MirrorInput): MirrorResult {
  const { workerEmitted, frontendEmitted, definedIds } = input;

  // ── Vacuity guards. An empty side means the check cannot verify anything;
  //    reporting "no drift" from a set we never read is the failure mode this
  //    whole file exists to prevent, so it is an error, not a pass.
  if (frontendEmitted.size === 0) {
    return {
      ok: false,
      lines: [
        'Frontend EMITTABLE_CONTROL_IDS resolved to an EMPTY set — the guard cannot verify anything.',
        'Expected src/lib/complianceMapping.ts to export a non-empty EMITTABLE_CONTROL_IDS.',
        'Failing closed: an empty expected-set would let every worker control ID through unchecked.',
      ],
    };
  }
  if (workerEmitted.size === 0) {
    return {
      ok: false,
      lines: [
        'Worker EMITTABLE_CONTROL_IDS resolved to an EMPTY set.',
        'Either the worker catalogue is gone or the export moved. Failing closed rather than',
        'reporting "no drift" from a set the guard never actually read.',
      ],
    };
  }
  if (definedIds.size === 0) {
    return {
      ok: false,
      lines: [
        'Frontend COMPLIANCE_CONTROLS resolved to an EMPTY registry.',
        'Failing closed: the emitted-ID definition check would be vacuous.',
      ],
    };
  }

  // ── The mirror assertion, both directions. "Control IDs must match" is the
  //    file's own stated contract, so any asymmetry is drift.
  const workerOnly = sortedDiff(workerEmitted, frontendEmitted);
  const frontendOnly = sortedDiff(frontendEmitted, workerEmitted);
  const undefinedIds = [...new Set([...workerEmitted, ...frontendEmitted])]
    .filter((id) => !definedIds.has(id))
    .sort();

  const lines: string[] = [];

  if (workerOnly.length > 0) {
    lines.push(
      `Worker emits ${workerOnly.length} control ID(s) the frontend does NOT: ${workerOnly.join(', ')}`,
      '',
      'This is the retired-claim direction — the dangerous one. An ID here means a control was',
      'removed from the canonical frontend catalogue but the worker still writes it onto every',
      'SECURED anchor and serves it from /api/v1/verify, the audit export, and the GRC evidence',
      'push to Vanta / Drata / Anecdotes.',
      '',
      'This is exactly how the EU-US DPF claim shipped: SCRUM-2283 removed DPF-NOTICE /',
      'DPF-ACCOUNTABILITY from the frontend on 2026-07-10 and the worker kept serving them',
      'until 2026-08-01.',
      '',
      'Fix by removing the ID(s) from services/worker/src/utils/complianceMapping.ts. Do NOT',
      're-add them to the frontend to silence this — that re-asserts the claim (R-7 claims gate',
      '/ CLAUDE.md §1.5). Historical rows are handled separately, on read.',
      '',
    );
  }

  if (frontendOnly.length > 0) {
    lines.push(
      `Frontend emits ${frontendOnly.length} control ID(s) the worker does NOT: ${frontendOnly.join(', ')}`,
      '',
      'The UI would show a control the anchor record never carries, so a verifier reading the API',
      'sees less than the page claims. Add the ID to the worker catalogue, or remove it from the',
      'frontend — but do not leave them disagreeing.',
      '',
    );
  }

  if (undefinedIds.length > 0) {
    lines.push(
      `${undefinedIds.length} emitted control ID(s) have no entry in COMPLIANCE_CONTROLS: ${undefinedIds.join(', ')}`,
      '',
      'An emitted ID with no definition renders as nothing in the UI while still being written to',
      'anchors and served over the API — a claim with no stated meaning.',
      '',
    );
  }

  if (lines.length > 0) {
    return {
      ok: false,
      lines: [
        'Compliance mapping mirror DRIFT — services/worker/src/utils/complianceMapping.ts and '
        + 'src/lib/complianceMapping.ts disagree ("control IDs must match" per the worker file\'s own header).',
        '',
        ...lines,
      ],
    };
  }

  return {
    ok: true,
    lines: [
      `✅ Compliance mapping mirror OK — ${workerEmitted.size} emitted control IDs match exactly on both sides, all defined in COMPLIANCE_CONTROLS.`,
    ],
  };
}

function main(): void {
  const result = runMirrorCheck({
    workerEmitted: WORKER_EMITTABLE,
    frontendEmitted: FRONTEND_EMITTABLE,
    definedIds: new Set(Object.keys(COMPLIANCE_CONTROLS)),
  });

  if (result.ok) {
    for (const line of result.lines) console.log(line);
    return;
  }

  for (const line of result.lines) console.error(line);
  console.error(`::error title=compliance mapping mirror::${result.lines[0]}`);
  process.exit(1);
}

if (isMainModule(import.meta.url, process.argv[1])) main();
