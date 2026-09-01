/**
 * PARKED: `GET /api/v1/verify/attestation/:attestationId` (SCRUM-1873).
 *
 * `legally_binding_attestations` has no INSERT path anywhere in the tree, so
 * this endpoint can never return a verified attestation. Verified read-only
 * against prod `vzwyaatejekddvltxyye` on 2026-08-31: 0 rows in the table, and
 * 0 `docusign.notarization_completed` jobs ever enqueued against 21 completed
 * + 4 dead `docusign.envelope_completed` jobs — the upstream DocuSign Notary
 * trigger has never fired in production.
 *
 * WHY THIS IS A 404 AND NOT A 501. 501 is the better semantic, and an earlier
 * draft used it. It is wrong here for an operational reason: the enabled
 * CRITICAL policy `PAGE — arkova-worker 5xx burst` fires on
 * `metric.label.response_code_class="5xx"` for service `arkova-worker` at
 * >5 over 300s, and `run.googleapis.com/request_count` carries no URL-path
 * label, so the parked route cannot be excluded from it. Six requests in five
 * minutes — one scanner, one partner retry loop — would page the on-call for
 * an endpoint that cannot succeed. The status-code contract is therefore left
 * exactly as published (400 malformed / 404 well-formed); what changes is the
 * 404's `error` string, which no longer implies a corpus was searched.
 *
 * WHY IT IS MOUNTED HERE rather than inside `verify/attestation.ts`: mounting
 * it ahead of `apiKeyAuth` / `usageTracking` means a parked request costs no
 * HMAC, no `api_keys` read, and no `api_key_usage` read+upsert — and does not
 * charge the caller's monthly quota for a response that can never succeed
 * (`usageTracking` has no refund path despite its comment).
 *
 * TO UNPARK: delete this module and its mount in `api/v1/router.ts`, then land,
 * in order — (1) a creation API writing `draft` rows, (2) the DocuSign send
 * step recording `docusign_envelope_id` on `draft -> pending_notarization`,
 * (3) the anchoring step writing `anchor_id` / `anchor_timestamp` on
 * `notarized -> anchored`. Step 3 changes anchor lifecycle, so re-run the TLA+
 * check (CLAUDE.md §4). The handler and status-disclosure gate in
 * `verify/attestation.ts` are retained intact and are what step 3 re-exposes.
 */
import type { Request, Response } from 'express';

/** The single route this park covers. Other methods and paths fall through. */
export const PARKED_ATTESTATION_ROUTE = '/verify/attestation/:attestationId';

/** Mirrors the id guard in `verify/attestation.ts` so the 400 is unchanged. */
const ATTESTATION_ID_PATTERN = /^ARK-ATT-[A-Za-z0-9_-]{1,64}$/;

export function parkedAttestationVerify(
  req: Request<{ attestationId: string }>,
  res: Response,
): void {
  const { attestationId } = req.params;

  // Unchanged from the live handler: a malformed id is a routing hint, not a
  // lookup result, and it was always reachable with an empty table.
  if (!attestationId || !ATTESTATION_ID_PATTERN.test(attestationId)) {
    res.status(400).json({
      verified: false,
      error: 'Invalid attestation ID format — expected ARK-ATT-* prefix',
    });
    return;
  }

  // `verified` is retained because the response shape is frozen (CLAUDE.md
  // §1.8). The `error` string is what changes: the previous "Attestation not
  // found" asserted a populated corpus this id was missing from.
  res.status(404).json({
    verified: false,
    error: 'Legally binding attestation verification is not implemented — no attestation records exist',
  });
}
