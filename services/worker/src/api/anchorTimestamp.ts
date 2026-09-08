/**
 * `anchor_timestamp` — the ONE definition of the public anchoring moment.
 *
 * BUG-2026-09-08-001 (SCRUM-4517). Five worker surfaces independently decided
 * what this field meant and four of them chose `anchors.created_at` — the
 * moment Arkova inserted the row, not the moment Bitcoin observed it. On prod
 * anchor `ARK-SEC-RUJ2V7` that published `2026-04-09T18:01:01.848397Z` while
 * the chain observed the anchor at `18:11:26Z`: a 10m24s understatement, and
 * an understatement in the direction that flatters us. On an evidence product
 * that is the worse direction to be wrong in.
 *
 * ── THE CANONICAL RULE ─────────────────────────────────────────────────────
 *
 * `public.get_public_anchor()` has always been right, and it is the definition
 * this module mirrors verbatim (migration 0385, line 598 — carried unchanged
 * since 0311):
 *
 *     'anchor_timestamp', CASE WHEN a.status NOT IN ('PENDING')
 *                              THEN a.chain_timestamp END
 *
 * So: the chain-observed time, gated to non-PENDING, and NULL otherwise.
 * Two branches, both of which matter:
 *
 *   1. A PENDING anchor has no anchoring moment yet. Reporting one is a claim
 *      about the chain that the chain has not made.
 *   2. A non-PENDING anchor whose `chain_timestamp` is NULL was never given
 *      an observed time. The honest answer is "not measured", not "here is a
 *      different clock's reading with the same field name".
 *
 * ── WHY THERE IS NO created_at FALLBACK ────────────────────────────────────
 *
 * §1.5 requires Bitcoin times to be published as "Network Observed Time" and
 * requires proof surfaces to separate what is measured from what is asserted.
 * `created_at` is an Arkova-server clock reading. Emitting it under a field
 * whose entire meaning is "when the network observed this" asserts a
 * measurement nobody took — and does it silently, which is precisely how this
 * bug survived from the pre-June edge bundle into prod. A fallback here would
 * be the same defect wearing a comment.
 *
 * The frozen v1 schema (§1.8) fixes the field NAME, so the correction is to
 * the VALUE only; no consumer sees a new or renamed field. Callers that type
 * the field as optional OMIT it when this returns null, matching how
 * `jurisdiction` is handled (CLAUDE.md §6: omit when null, never emit null on
 * the frozen schema). Callers whose contract declares the field nullable emit
 * `null`.
 *
 * ── MEASURED BLAST RADIUS (prod `vzwyaatejekddvltxyye`, 2026-09-08) ────────
 *
 * Read-only against prod, non-deleted `anchors`:
 *   - non-SECURED rows: 3 total, all REVOKED, 1 with `chain_timestamp` NULL.
 *   - SECURED rows: 0 NULL `chain_timestamp` in a 1% TABLESAMPLE (n=38,106).
 *     A full count exceeds the 60s API gateway limit on 3.5M rows, so this is
 *     a sample bound, not an exact zero — stated as measured.
 *
 * So essentially every published row changes from a too-early server clock to
 * the true chain clock, and roughly one row moves to "not measured". Nothing
 * here depends on the fallback that is being removed.
 *
 * ── WHY A HELPER AND NOT THE RPC ───────────────────────────────────────────
 *
 * Routing `/api/v1/verify/:publicId` through `get_public_anchor()` was the
 * first choice and does not work: the RPC's projection is a deliberately
 * narrower public allowlist. It hardcodes `'merkle_proof_hash', NULL` and
 * carries none of the API-RICH fields the v1 envelope has published since
 * SCRUM-772 (`compliance_controls`, `chain_confirmations`, `parent_public_id`,
 * `version_number`, `revocation_tx_id`, `revocation_block_height`, `file_mime`,
 * `file_size`, `confidence_scores`, `sub_type`, `has_stored_proof_branch`,
 * `connector_source`). Swapping to it would blank fields the frozen schema
 * publishes — a far larger contract break than the one being fixed.
 *
 * One definition was still the goal, so the definition moved here instead: the
 * RPC's CASE expression, expressed once in TypeScript, imported by every
 * worker surface that publishes the field. `anchorTimestamp.test.ts` pins this
 * function against the RPC's exact semantics, so the two cannot drift silently
 * the way the worker and the edge bundle did.
 */

/**
 * Statuses for which no anchoring moment exists yet.
 *
 * Mirrors the RPC's `a.status NOT IN ('PENDING')` gate exactly. Kept as a set
 * of its own rather than inlined so that a future status added to the RPC's
 * gate has one obvious place to be added here — and so the test can assert the
 * two lists agree.
 */
const PRE_ANCHOR_STATUSES: ReadonlySet<string> = new Set(['PENDING']);

/**
 * The published anchoring moment for an anchor, or `null` when there isn't one.
 *
 * @param status          `anchors.status` (raw DB status, not the public
 *                        mapped status — the RPC gates on the raw value).
 * @param chainTimestamp  `anchors.chain_timestamp`. NEVER pass `created_at`.
 * @returns the chain-observed time, or `null` when not measured.
 */
export function publicAnchorTimestamp(
  status: string | null | undefined,
  chainTimestamp: string | null | undefined,
): string | null {
  if (!status || PRE_ANCHOR_STATUSES.has(status)) return null;
  return chainTimestamp ?? null;
}

/** Exported for the drift test only — not part of any response. */
export const PRE_ANCHOR_STATUSES_FOR_TEST = PRE_ANCHOR_STATUSES;
