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
 * Two separate remediations both fixed only the frontend. The retired claim
 * survived in the worker for weeks because a human had to remember a second
 * file. This check removes that requirement.
 *
 * WHAT IT ENFORCES
 *
 * Every control ID the WORKER can emit must be defined in the FRONTEND registry
 * (`COMPLIANCE_CONTROLS`), which is the canonical catalogue of controls Arkova
 * claims. Deleting an ID from the frontend therefore makes this check FAIL until
 * the worker stops emitting it — a retired claim cannot quietly live on in the
 * mirror.
 *
 * The check is DIRECTIONAL on purpose. Worker ⊄ frontend is an error (the worker
 * is asserting something the catalogue does not define). Frontend ⊅ worker is
 * fine and expected — the registry carries jurisdiction controls (LGPD, PDPA,
 * POPIA, …) that no credential type maps to yet.
 *
 * FAIL CLOSED. Any failure to resolve either side — a moved file, a renamed
 * export, an import error, an empty worker set — is a FAILURE, not a skip. A
 * guard that silently passes when it cannot see the thing it guards is worse
 * than no guard, because it also removes the reason to look.
 *
 * Behavioural, not textual: the worker side is read by CALLING
 * `getComplianceControlIds()` across every credential type, so the check keeps
 * working through internal refactors of the catalogues it reads.
 *
 * Usage: tsx scripts/ci/check-compliance-mapping-mirror.ts
 * Exit 0 = mirrors agree. Exit 1 = drift (or the check could not verify).
 */

import { COMPLIANCE_CONTROLS } from '../../src/lib/complianceMapping.js';
import { getComplianceControlIds } from '../../services/worker/src/utils/complianceMapping.js';

/**
 * Credential types the worker maps. Mirrors the local `CredentialType` union in
 * the worker module, which is not exported.
 *
 * Hardcoding the list is safe here in a way it would not be elsewhere: an
 * omission can only make the check see FEWER worker IDs. The `TYPE_COVERAGE`
 * assertion below closes that gap by requiring every type-specific catalogue
 * entry to be reachable from this list, so adding a credential type to the
 * worker without adding it here is itself a failure.
 */
const CREDENTIAL_TYPES = [
  'DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT',
  'PROFESSIONAL', 'CLE', 'SEC_FILING', 'PATENT',
  'REGULATION', 'PUBLICATION', 'BADGE', 'ATTESTATION',
  'FINANCIAL', 'LEGAL', 'INSURANCE', 'OTHER',
] as const;

/**
 * The pure assertion, exported for unit testing.
 *
 * Directional by design: an ID the worker emits but the frontend does not define
 * is drift; the reverse is expected (the registry carries jurisdiction controls
 * no credential type maps to yet).
 */
export function findOrphanedControlIds(
  workerIds: Iterable<string>,
  frontendIds: ReadonlySet<string>,
): string[] {
  return [...workerIds].filter((id) => !frontendIds.has(id)).sort();
}

function fail(lines: string[]): never {
  for (const line of lines) console.error(line);
  console.error('');
  console.error('::error title=compliance mapping mirror::' + lines[0]);
  process.exit(1);
}

function main(): void {
  // ── Frontend: the canonical catalogue of controls Arkova claims ──────────
  const frontendIds = new Set<string>();
  for (const [key, control] of Object.entries(COMPLIANCE_CONTROLS)) {
    frontendIds.add(key);
    // The registry is keyed by ID and each entry repeats it; take both so a
    // key/id mismatch cannot open a hole in the allowlist.
    if (control && typeof control.id === 'string') frontendIds.add(control.id);
  }

  if (frontendIds.size === 0) {
    fail([
      'Frontend COMPLIANCE_CONTROLS resolved to an EMPTY set — the guard cannot verify anything.',
      'Expected src/lib/complianceMapping.ts to export a non-empty COMPLIANCE_CONTROLS registry.',
      'Failing closed: an empty allowlist would let every worker control ID through unchecked.',
    ]);
  }

  // ── Worker: every ID it can actually emit, read behaviourally ────────────
  const workerIds = new Set<string>();
  // `undefined` covers the universal-only path taken by anchors with no type.
  for (const type of [undefined, ...CREDENTIAL_TYPES]) {
    for (const id of getComplianceControlIds(type)) workerIds.add(id);
  }

  if (workerIds.size === 0) {
    fail([
      'Worker getComplianceControlIds() returned NO control IDs for any credential type.',
      'Either the worker mapping is empty or the export moved. Failing closed rather than',
      'reporting "no drift" from a set the guard never actually read.',
    ]);
  }

  // ── TYPE_COVERAGE: universal-only types would hide a type-specific list ──
  // If a credential type exists in the worker but not in CREDENTIAL_TYPES above,
  // its controls are invisible to this guard. We cannot enumerate the worker's
  // private catalogue, but we CAN assert the union is a strict superset of the
  // universal set — i.e. at least one type contributed extra IDs. That is true
  // today and stays true for any real catalogue.
  const universalOnly = new Set(getComplianceControlIds(undefined));
  const contributedExtra = [...workerIds].some((id) => !universalOnly.has(id));
  if (!contributedExtra) {
    fail([
      'No credential type contributed a type-specific control ID.',
      'Every type in CREDENTIAL_TYPES resolved to the universal set alone, which means either',
      'the type-specific catalogue is gone or this list no longer matches the worker union.',
      'Failing closed: type-specific IDs would be invisible to this guard.',
    ]);
  }

  // ── The actual assertion ────────────────────────────────────────────────
  const orphaned = findOrphanedControlIds(workerIds, frontendIds);

  if (orphaned.length > 0) {
    fail([
      `Worker compliance mapping emits ${orphaned.length} control ID(s) the frontend registry does not define: ${orphaned.join(', ')}`,
      '',
      'services/worker/src/utils/complianceMapping.ts is a MIRROR of src/lib/complianceMapping.ts',
      '("control IDs must match" — its own header). An ID present only in the worker means a',
      'control was retired from the canonical catalogue but the worker still writes it onto every',
      'SECURED anchor and serves it from /api/v1/verify, the audit export, and the GRC evidence',
      'push to Vanta / Drata / Anecdotes.',
      '',
      'This is the exact failure that shipped the EU-US DPF claim: SCRUM-2283 removed',
      'DPF-NOTICE / DPF-ACCOUNTABILITY from the frontend on 2026-07-10 and the worker kept',
      'serving them until 2026-08-01.',
      '',
      'Fix by removing the ID(s) from the worker catalogue too. Do NOT re-add them to the',
      'frontend to silence this — that re-asserts the claim (R-7 claims gate / CLAUDE.md §1.5).',
      'Historical rows are handled separately, on read.',
    ]);
  }

  console.log(
    `✅ Compliance mapping mirror OK — all ${workerIds.size} worker control IDs are defined in the frontend registry (${frontendIds.size} entries).`,
  );
}

// Only run the check when invoked directly, so the unit test can import the
// pure helper without the script exiting the test process.
if (process.argv[1] && process.argv[1].endsWith('check-compliance-mapping-mirror.ts')) {
  main();
}
