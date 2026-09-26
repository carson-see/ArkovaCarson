#!/usr/bin/env tsx
/**
 * PR #3087 connector-supersede-not-duplicate admission driver
 * (`fix/connector-supersede-not-duplicate`, head `0f5284a85f496f325bb542abaaf541b3431af939`, T3).
 *
 * WHY THIS DRIVER EXISTS, NOT THE PR-1408 DEFAULT
 * ------------------------------------------------
 * `scripts/staging/provision-isolated-rig.sh` defaults `driver_path` to
 * `pr1408-chain-resilience-driver.ts` (chain retry/backoff/duplicate-tx
 * semantics). That drives ZERO of the behavior #3087 changes. Using it as-is
 * would soak the rig for 24h and produce a green JSONL stream that says
 * nothing about supersession, lineage, or the two P0s an independent review
 * caught in the provenance timeline. This file is the replacement:
 * `STAGING_DRIVER_PATH=services/worker/scripts/pr3087-supersede-drain-driver.ts`.
 *
 * WHAT #3087 CHANGES
 * ------------------
 * Before: an UPDATE to a connected Google Drive document produced a brand
 * new, UNRELATED anchor via plain INSERT — two independent SECURED anchors
 * for one document, `parent_anchor_id`/`version_number` never set, nothing
 * marking either stale.
 * After: `defaultMaterializeAnchor` (services/worker/src/jobs/connector-artifact-drain.ts)
 * detects the prior anchor for the same `(org_id, source, external_ref)` and
 * calls the existing `supersede_anchor` RPC (migration 0367, 4-arg overload).
 * The prior anchor becomes SUPERSEDED (never REVOKED); the new anchor carries
 * `parent_anchor_id` + an incremented `version_number`. Gated to
 * `source='google_drive'` via `SUPERSESSION_ENABLED_SOURCES`.
 * `services/worker/src/api/v1/provenance.ts` was also fixed in the same PR: a
 * SUPERSEDED anchor's `revoked_at` (dual-purpose column, migration 0367 reuse)
 * must emit `credential_superseded`, never `credential_revoked` — the P0 an
 * independent reviewer caught, because that projection previously gated on
 * `revoked_at` alone.
 *
 * THE EIGHT ASSERTIONS — how each is measured and how each can FAIL
 * -------------------------------------------------------------------
 *  1. SUPERSEDE_NOT_REVOKE   — prior anchor's `status` reads back `SUPERSEDED`,
 *     explicitly NOT `REVOKED`. FAILS if the drain (re)introduces a plain
 *     revoke/insert, or if `supersede_anchor` itself regresses.
 *  2. LINEAGE                — new anchor's `parent_anchor_id` = prior id AND
 *     `version_number` = prior + 1. FAILS on a forked/duplicate anchor or a
 *     version_number miscomputed by `set_anchor_version_number()`.
 *  3. VERIFY_STILL_VALID     — `GET /api/v1/verify/:publicId` on the SUPERSEDED
 *     anchor answers 200 with `body.status === 'SUPERSEDED'`. FAILS on a 404
 *     ("this credential doesn't exist" — untrue) or `body.status === 'REVOKED'`.
 *  4. PROVENANCE_NOT_REVOKED — `GET /api/v1/verify/:publicId/provenance` emits
 *     an event with `event_type === 'credential_superseded'` and NEVER
 *     `credential_revoked`. This is the P0: a regression here republishes
 *     "Revoked" about a customer's still-valid evidence.
 *  5. IDEMPOTENT_REPLAY      — re-enqueuing the identical
 *     `(source, external_ref, external_revision)` via the real
 *     `enqueue_connector_artifact` RPC returns the SAME row id both times
 *     (the table's own dedupe unique index), and a second drain pass over it
 *     produces NO third anchor and does not flip anything back off
 *     SUPERSEDED. FAILS on a distinct id or a changed anchor count/status.
 *  6. NOOP_IDENTICAL_FINGERPRINT — a change event whose fingerprint matches
 *     the current head creates NO new anchor (unique-index reuse,
 *     `created:false`) and does not touch the head's status. FAILS if a
 *     fresh anchor id appears or the head is (re-)superseded.
 *  7. NEGATIVE CONTROL (DocuSign) — the SAME two-fingerprint update sequence
 *     against `source='docusign'` (never in `SUPERSESSION_ENABLED_SOURCES`)
 *     still produces TWO independent, unrelated anchors — neither superseded,
 *     neither linked by `parent_anchor_id`. A driver that cannot fail this
 *     assertion is not evidence: it proves the google_drive gate is real, not
 *     just present in a code comment.
 *  8. MEMBER_OWNED_ACTOR_INDEPENDENT_SUPERSEDE — supersession completes when
 *     the PRIOR anchor's owner is a non-`ORG_ADMIN` org member, because
 *     `supersedeConnectorAnchor` resolves its OWN org-admin caller
 *     (`resolveOrgActorUserId`) independently of the anchor's own `user_id`.
 *     Ownership must be preserved on the child (`supersede_anchor` inherits
 *     `old_anchor.user_id`). Asserted by DB state (new anchor's `user_id` +
 *     lineage + `connector_artifact.status === 'materialized'`), never by
 *     "no error surfaced" — see the SCOPING NOTE below for why, and see
 *     `classifyMemberOwnedSupersede`'s fail branch for the explicit
 *     lost-lease-ambiguity language this assertion requires.
 *
 * SCOPING NOTE ON ASSERTION 8 (read before citing it as full DS-04 coverage)
 * ---------------------------------------------------------------------------
 * The task frames #8 as "a `queue_scope: 'member'` connection... still
 * supersedes successfully". That literal combination is STRUCTURALLY
 * UNREACHABLE in this codebase today, for two independent reasons verified
 * against migrations, not assumed:
 *   - `queue_scope: 'member'` metadata is set ONLY by the DocuSign producers
 *     (`docusign-envelope-completed.ts`, `docusign-queue-reconciliation*.ts`)
 *     — grep confirms Google Drive's producer never sets it.
 *   - `member_integrations.provider` is `CHECK (provider = 'docusign')`
 *     (migration 0320) and `materialize_connector_artifact_anchor`'s v1
 *     member-scope check (migration 0462, ~line 542) requires
 *     `member_integrations.provider = artifact.source` — so a
 *     `source='google_drive'` artifact can NEVER pass the v1 member-scope
 *     check; DS-04 member ownership is DocuSign-only by constraint.
 *   Since supersession is gated to `google_drive` only, "member-scope
 *   google_drive" cannot occur in this codebase's current shape.
 *
 * What IS real, and what this driver exercises instead: `supersedeConnectorAnchor`
 * (the code #3087 actually added) does not read `queue_scope` at all — it
 * resolves its caller via `resolveOrgActorUserId(deps, row.org_id)`
 * independently of who owns the anchor being superseded. That is the actual
 * regression surface the PR's own code comment calls out ("every update to a
 * non-admin member's connected document would be permanently, silently
 * un-supersede-able"). This driver seeds a prior anchor directly with
 * `user_id` = a real non-`ORG_ADMIN` org member (bypassing the DS-04 RPC path
 * entirely, since the anchor's origin is irrelevant to the supersede branch)
 * and drives the real update through the real HTTP drain endpoint. That
 * proves the actor-independence fix; it does not exercise the DocuSign-only
 * DS-04 v1 gate, which is unrelated code this PR does not touch.
 *
 * THE LOST-LEASE AMBIGUITY (why #8 must never score a silent pass)
 * -------------------------------------------------------------------
 * `supersedeConnectorAnchor` maps EVERY `supersede_anchor` RPC error —
 * `insufficient_privilege` (wrong caller), `check_violation` (already
 * REVOKED/SUPERSEDED), a genuine transport error — to the SAME
 * `{ outcome: 'lost_lease' }`. From outside the worker those are
 * indistinguishable in a single observation: the artifact just stays
 * `processing`/`queued`. `classifyMemberOwnedSupersede` therefore never
 * treats "no thrown error reached this driver" as success. It requires
 * POSITIVE, polled evidence — `connector_artifact.status === 'materialized'`
 * AND a concretely-lineaged new anchor — and its failure detail says
 * "indistinguishable from a transient failure (generic lost_lease)" rather
 * than naming a specific cause, because the driver genuinely cannot
 * distinguish them from here.
 *
 * Self-test mode is local validation only: rows are `evidenceForSoak=false`
 * and must never be cited as T3 soak evidence.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHANGED_BEHAVIOR =
  "PR #3087: a Google Drive document UPDATE calls supersede_anchor (prior anchor -> SUPERSEDED, "
  + "never REVOKED; child carries parent_anchor_id + version_number+1) instead of inserting an "
  + 'unrelated duplicate anchor. Gated to source=google_drive. provenance.ts emits '
  + "credential_superseded (never credential_revoked) for a SUPERSEDED anchor. DocuSign (ungated) "
  + 'must keep double-anchoring, and a non-ORG_ADMIN member-owned prior anchor must still supersede '
  + 'via an independently-resolved org-admin actor, with ownership preserved on the child.';

export const ASSERTION = {
  SUPERSEDE_NOT_REVOKE: 'supersede_not_revoke',
  LINEAGE: 'lineage',
  VERIFY_STILL_VALID: 'verify_still_valid',
  PROVENANCE_NOT_REVOKED: 'provenance_not_revoked',
  IDEMPOTENT_REPLAY: 'idempotent_replay',
  NOOP_IDENTICAL_FINGERPRINT: 'noop_identical_fingerprint',
  NEGATIVE_CONTROL_DOCUSIGN: 'negative_control_docusign_still_duplicates',
  MEMBER_OWNED_SUPERSEDE: 'member_owned_actor_independent_supersede',
} as const;

/** Fixture prefix so every row/user this driver creates is identifiable and reapable. */
export const FIXTURE_PREFIX = 'pr3087-soak';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DriverMode = 'self-test' | 'live';

export interface DriverArgs {
  mode: DriverMode;
  targetUrl?: string;
  admissionJson?: string;
  evidenceJsonl?: string;
  cronSecret?: string;
  bearerToken?: string;
  durationMin: number;
  intervalSec: number;
}

export interface ProbeResult {
  name: string;
  status: 'pass' | 'fail';
  detail: string;
}

export interface DriverRow {
  utc: string;
  pr: 3087;
  tier: 'T3';
  mode: DriverMode;
  evidenceForSoak: boolean;
  changedBehavior: string;
  status: 'pass' | 'fail';
  cycle: number;
  counts: Record<string, number | boolean>;
  probes: ProbeResult[];
  admission?: Record<string, unknown>;
  blockers?: string[];
}

/** Minimal shape this driver reads back off an `anchors` row. */
export interface AnchorFacts {
  id: string;
  status: string;
  parent_anchor_id: string | null;
  version_number: number;
  user_id: string;
}

/** Minimal shape this driver reads back off a `connector_artifact` row. */
export interface ArtifactFacts {
  status: string;
  anchor_id: string | null;
}

/** The `GET /api/v1/verify/:publicId` response shape this driver asserts on. */
export interface VerifyProbeResponse {
  httpStatus: number;
  body: { status?: string; error?: string; verified?: boolean };
}

/** One provenance timeline event, as `GET .../provenance` emits it. */
export interface ProvenanceEvent {
  event_type: string;
}

// ---------------------------------------------------------------------------
// Pure classifiers — unit-testable without a network or a database.
// Every one returns a distinct pass/fail with its OWN detail string; none are
// collapsed into a shared boolean (task requirement: "an assertion that
// cannot fail is not evidence").
// ---------------------------------------------------------------------------

function probe(name: string, ok: boolean, detail: string): ProbeResult {
  return { name, status: ok ? 'pass' : 'fail', detail };
}

/** Assertion 1. Explicit on STATUS — the founder decision this PR implements. */
export function classifySupersedeNotRevoke(priorStatusAfter: string): ProbeResult {
  if (priorStatusAfter === 'REVOKED') {
    return probe(
      ASSERTION.SUPERSEDE_NOT_REVOKE,
      false,
      "prior anchor reads back REVOKED — a routine content edit was conflated with a genuine "
        + 'withdrawal of validity (the exact defect §1.5/the founder decision exists to prevent)',
    );
  }
  return probe(
    ASSERTION.SUPERSEDE_NOT_REVOKE,
    priorStatusAfter === 'SUPERSEDED',
    `prior anchor status => ${priorStatusAfter} (expected SUPERSEDED)`,
  );
}

/** Assertion 2. A null child or a forked/duplicate anchor both fail here. */
export function classifyLineage(
  prior: Pick<AnchorFacts, 'id' | 'version_number'>,
  child: Pick<AnchorFacts, 'parent_anchor_id' | 'version_number'> | null,
): ProbeResult {
  if (child === null) {
    return probe(ASSERTION.LINEAGE, false, 'no child anchor found — supersession did not create one');
  }
  const parentOk = child.parent_anchor_id === prior.id;
  const versionOk = child.version_number === prior.version_number + 1;
  return probe(
    ASSERTION.LINEAGE,
    parentOk && versionOk,
    `child.parent_anchor_id=${child.parent_anchor_id} (expected ${prior.id}), `
      + `child.version_number=${child.version_number} (expected ${prior.version_number + 1})`,
  );
}

/** Assertion 3. 404 and REVOKED are both explicit failure branches, not the same as "not 200". */
export function classifyVerifyResponse(res: VerifyProbeResponse): ProbeResult {
  if (res.httpStatus === 404) {
    return probe(
      ASSERTION.VERIFY_STILL_VALID,
      false,
      "verify answered 404 'Record not found' — a superseded (still cryptographically valid) "
        + 'document must not disappear from public verification',
    );
  }
  if (res.body.status === 'REVOKED') {
    return probe(
      ASSERTION.VERIFY_STILL_VALID,
      false,
      "verify published status=REVOKED for a SUPERSEDED anchor — the P0 this PR's provenance.ts fix "
        + 'closes, observed on the public verify surface instead',
    );
  }
  return probe(
    ASSERTION.VERIFY_STILL_VALID,
    res.httpStatus === 200 && res.body.status === 'SUPERSEDED',
    `httpStatus=${res.httpStatus}, body.status=${res.body.status ?? '(absent)'} (expected 200 / SUPERSEDED)`,
  );
}

/** Assertion 4. THE P0: must see credential_superseded, must NEVER see credential_revoked. */
export function classifyProvenanceEvents(events: ProvenanceEvent[]): ProbeResult {
  const types = events.map((e) => e.event_type);
  const hasSuperseded = types.includes('credential_superseded');
  const hasRevoked = types.includes('credential_revoked');
  if (hasRevoked) {
    return probe(
      ASSERTION.PROVENANCE_NOT_REVOKED,
      false,
      'provenance timeline emitted credential_revoked for a SUPERSEDED anchor — regressed P0: '
        + "republishes 'Revoked' about a customer's still-valid evidence",
    );
  }
  return probe(
    ASSERTION.PROVENANCE_NOT_REVOKED,
    hasSuperseded,
    `provenance event_types => [${types.join(', ')}] (expected credential_superseded present, `
      + 'credential_revoked absent)',
  );
}

/**
 * Assertion 5. `enqueueIdA`/`enqueueIdB` are the two `enqueue_connector_artifact`
 * RPC replies for the IDENTICAL (org, source, external_ref, external_revision)
 * — the table's own dedupe unique index (migration 0343) means a genuine
 * replay must resolve to the SAME id, never mint a second row. `anchorCount`
 * before/after the replay's drain pass must be equal (no third anchor), and
 * the prior anchor's status must still read SUPERSEDED (not re-flipped).
 */
export function classifyIdempotentReplay(args: {
  enqueueIdA: string;
  enqueueIdB: string;
  anchorCountBeforeReplay: number;
  anchorCountAfterReplay: number;
  priorStatusAfterReplay: string;
}): ProbeResult {
  const sameRow = args.enqueueIdA === args.enqueueIdB;
  const noThirdAnchor = args.anchorCountBeforeReplay === args.anchorCountAfterReplay;
  const stillSuperseded = args.priorStatusAfterReplay === 'SUPERSEDED';
  return probe(
    ASSERTION.IDEMPOTENT_REPLAY,
    sameRow && noThirdAnchor && stillSuperseded,
    `enqueue replay ids equal=${sameRow} (${args.enqueueIdA} / ${args.enqueueIdB}), `
      + `anchor count ${args.anchorCountBeforeReplay} -> ${args.anchorCountAfterReplay} (expected equal), `
      + `prior status after replay=${args.priorStatusAfterReplay} (expected SUPERSEDED, not re-superseded)`,
  );
}

/**
 * Assertion 6. An unchanged fingerprint must reuse the CURRENT head anchor
 * (unique-index reuse, `created:false`) — never mint a new one, never touch
 * the head's status.
 */
export function classifyNoopIdenticalFingerprint(args: {
  headAnchorIdBefore: string;
  headAnchorIdAfter: string;
  headStatusAfter: string;
}): ProbeResult {
  const sameAnchor = args.headAnchorIdBefore === args.headAnchorIdAfter;
  const notSuperseded = args.headStatusAfter !== 'SUPERSEDED';
  return probe(
    ASSERTION.NOOP_IDENTICAL_FINGERPRINT,
    sameAnchor && notSuperseded,
    `head anchor id ${args.headAnchorIdBefore} -> ${args.headAnchorIdAfter} (expected unchanged), `
      + `head status after=${args.headStatusAfter} (expected NOT SUPERSEDED — no-op must not touch it)`,
  );
}

/**
 * Assertion 7 — THE NEGATIVE CONTROL. Two DocuSign anchors for the same
 * external_ref must remain independent: no lineage link, neither SUPERSEDED.
 * A driver that cannot FAIL this (e.g. by accidentally gating on something
 * else) is not evidence that the google_drive restriction is real.
 */
export function classifyNegativeControlDocuSign(
  anchors: Array<Pick<AnchorFacts, 'id' | 'status' | 'parent_anchor_id'>>,
): ProbeResult {
  if (anchors.length !== 2) {
    return probe(
      ASSERTION.NEGATIVE_CONTROL_DOCUSIGN,
      false,
      `found ${anchors.length} anchors for the DocuSign fixture (expected exactly 2 — the drain must `
        + 'still double-anchor, ungated)',
    );
  }
  const [a, b] = anchors;
  const distinctIds = a.id !== b.id;
  const noLineage = a.parent_anchor_id === null && b.parent_anchor_id === null;
  const neitherSuperseded = a.status !== 'SUPERSEDED' && b.status !== 'SUPERSEDED';
  return probe(
    ASSERTION.NEGATIVE_CONTROL_DOCUSIGN,
    distinctIds && noLineage && neitherSuperseded,
    `docusign anchors => [${a.id}:${a.status}:parent=${a.parent_anchor_id}, `
      + `${b.id}:${b.status}:parent=${b.parent_anchor_id}] (expected two distinct, unlinked, `
      + 'non-superseded anchors — the google_drive gate must not leak to docusign)',
  );
}

/**
 * Assertion 8 — see the SCOPING NOTE and LOST-LEASE AMBIGUITY sections in the
 * file header. `newAnchor === null` after bounded polling is reported with
 * language that names the ambiguity explicitly, per the task's instruction
 * not to score an unprovable outcome a silent pass.
 */
export function classifyMemberOwnedSupersede(args: {
  artifactStatus: string;
  priorAnchorId: string;
  priorVersionNumber: number;
  priorOwnerUserId: string;
  newAnchor: Pick<AnchorFacts, 'user_id' | 'parent_anchor_id' | 'version_number'> | null;
}): ProbeResult {
  if (args.newAnchor === null || args.artifactStatus !== 'materialized') {
    return probe(
      ASSERTION.MEMBER_OWNED_SUPERSEDE,
      false,
      `artifact status=${args.artifactStatus}, no linked child anchor observed after bounded polling — `
        + 'indistinguishable from a transient failure (supersedeConnectorAnchor maps '
        + 'insufficient_privilege, check_violation, and a genuine transport error to the same generic '
        + "lost_lease outcome); this is reported as a FAIL, not scored a pass on 'no error surfaced'",
    );
  }
  const ownershipPreserved = args.newAnchor.user_id === args.priorOwnerUserId;
  const lineageOk =
    args.newAnchor.parent_anchor_id === args.priorAnchorId
    && args.newAnchor.version_number === args.priorVersionNumber + 1;
  return probe(
    ASSERTION.MEMBER_OWNED_SUPERSEDE,
    ownershipPreserved && lineageOk,
    `child.user_id=${args.newAnchor.user_id} (expected member owner ${args.priorOwnerUserId}), `
      + `child.parent_anchor_id=${args.newAnchor.parent_anchor_id} (expected ${args.priorAnchorId}), `
      + `child.version_number=${args.newAnchor.version_number} (expected ${args.priorVersionNumber + 1}) — `
      + 'supersession completed via an independently-resolved org-admin actor with ownership preserved',
  );
}

/** A cycle passes only if every probe in it passed. One failure fails the row. */
export function aggregate(probes: ProbeResult[]): 'pass' | 'fail' {
  return probes.some((p) => p.status === 'fail') ? 'fail' : 'pass';
}

/** Per-assertion counters, so a reviewer can count coverage without re-reading probes. */
export function tally(probes: ProbeResult[]): Record<string, number | boolean> {
  const counts: Record<string, number | boolean> = {};
  for (const name of Object.values(ASSERTION)) {
    const inFamily = probes.filter((p) => p.name === name);
    counts[`${name}_ran`] = inFamily.length > 0;
    counts[`${name}_passed`] = inFamily.length > 0 && inFamily.every((p) => p.status === 'pass');
  }
  counts.probes_total = probes.length;
  counts.probes_failed = probes.filter((p) => p.status === 'fail').length;
  return counts;
}

// ---------------------------------------------------------------------------
// Self-test — no network, no database. Proves the classifiers, not the rig.
// ---------------------------------------------------------------------------

export function runSelfTest(): ProbeResult[] {
  return [
    classifySupersedeNotRevoke('SUPERSEDED'),
    probe(
      `${ASSERTION.SUPERSEDE_NOT_REVOKE}_selftest_rejects_revoked`,
      classifySupersedeNotRevoke('REVOKED').status === 'fail',
      'REVOKED must classify as a fail, not a pass',
    ),
    classifyLineage({ id: 'A', version_number: 1 }, { parent_anchor_id: 'A', version_number: 2 }),
    probe(
      `${ASSERTION.LINEAGE}_selftest_rejects_null_child`,
      classifyLineage({ id: 'A', version_number: 1 }, null).status === 'fail',
      'a missing child anchor must fail, not be skipped',
    ),
    classifyVerifyResponse({ httpStatus: 200, body: { status: 'SUPERSEDED', verified: false } }),
    probe(
      `${ASSERTION.VERIFY_STILL_VALID}_selftest_rejects_404`,
      classifyVerifyResponse({ httpStatus: 404, body: { error: 'Record not found' } }).status === 'fail',
      '404 must fail — a superseded document must not disappear',
    ),
    probe(
      `${ASSERTION.VERIFY_STILL_VALID}_selftest_rejects_revoked_status`,
      classifyVerifyResponse({ httpStatus: 200, body: { status: 'REVOKED' } }).status === 'fail',
      'a REVOKED body for a SUPERSEDED anchor must fail — the P0',
    ),
    classifyProvenanceEvents([{ event_type: 'credential_created' }, { event_type: 'credential_superseded' }]),
    probe(
      `${ASSERTION.PROVENANCE_NOT_REVOKED}_selftest_rejects_revoked_event`,
      classifyProvenanceEvents([{ event_type: 'credential_revoked' }]).status === 'fail',
      'a credential_revoked event must fail regardless of anything else in the timeline',
    ),
    classifyIdempotentReplay({
      enqueueIdA: 'row-1', enqueueIdB: 'row-1', anchorCountBeforeReplay: 2, anchorCountAfterReplay: 2,
      priorStatusAfterReplay: 'SUPERSEDED',
    }),
    probe(
      `${ASSERTION.IDEMPOTENT_REPLAY}_selftest_rejects_third_anchor`,
      classifyIdempotentReplay({
        enqueueIdA: 'row-1', enqueueIdB: 'row-1', anchorCountBeforeReplay: 2, anchorCountAfterReplay: 3,
        priorStatusAfterReplay: 'SUPERSEDED',
      }).status === 'fail',
      'a grown anchor count on replay must fail even if the enqueue ids matched',
    ),
    classifyNoopIdenticalFingerprint({
      headAnchorIdBefore: 'anchor-2', headAnchorIdAfter: 'anchor-2', headStatusAfter: 'PENDING',
    }),
    probe(
      `${ASSERTION.NOOP_IDENTICAL_FINGERPRINT}_selftest_rejects_new_anchor`,
      classifyNoopIdenticalFingerprint({
        headAnchorIdBefore: 'anchor-2', headAnchorIdAfter: 'anchor-3', headStatusAfter: 'PENDING',
      }).status === 'fail',
      'a changed head anchor id on an identical-fingerprint event must fail',
    ),
    classifyNegativeControlDocuSign([
      { id: 'd1', status: 'PENDING', parent_anchor_id: null },
      { id: 'd2', status: 'PENDING', parent_anchor_id: null },
    ]),
    probe(
      `${ASSERTION.NEGATIVE_CONTROL_DOCUSIGN}_selftest_rejects_accidental_supersession`,
      classifyNegativeControlDocuSign([
        { id: 'd1', status: 'SUPERSEDED', parent_anchor_id: null },
        { id: 'd2', status: 'PENDING', parent_anchor_id: 'd1' },
      ]).status === 'fail',
      'docusign rows that got linked/superseded must fail — that would mean the gate leaked',
    ),
    classifyMemberOwnedSupersede({
      artifactStatus: 'materialized', priorAnchorId: 'A', priorVersionNumber: 1, priorOwnerUserId: 'member-1',
      newAnchor: { user_id: 'member-1', parent_anchor_id: 'A', version_number: 2 },
    }),
    probe(
      `${ASSERTION.MEMBER_OWNED_SUPERSEDE}_selftest_rejects_null_child_as_fail_not_pass`,
      classifyMemberOwnedSupersede({
        artifactStatus: 'processing', priorAnchorId: 'A', priorVersionNumber: 1, priorOwnerUserId: 'member-1',
        newAnchor: null,
      }).status === 'fail',
      'a stuck/unresolved artifact must never be scored a pass on the absence of a thrown error',
    ),
    probe(
      `${ASSERTION.MEMBER_OWNED_SUPERSEDE}_selftest_rejects_ownership_reassignment`,
      classifyMemberOwnedSupersede({
        artifactStatus: 'materialized', priorAnchorId: 'A', priorVersionNumber: 1, priorOwnerUserId: 'member-1',
        newAnchor: { user_id: 'org-admin-1', parent_anchor_id: 'A', version_number: 2 },
      }).status === 'fail',
      "ownership silently reassigned to the resolving admin must fail — the member's record must be kept",
    ),
    probe('aggregate_selftest', aggregate([probe('x', true, ''), probe('y', false, '')]) === 'fail',
      'one failed probe fails the whole cycle'),
  ];
}

// ---------------------------------------------------------------------------
// Live fixtures + probes
// ---------------------------------------------------------------------------

/**
 * Per-cycle-unique 64-hex fingerprints (§1.6A: this driver never hashes real
 * bytes — there are none to hash). MUST vary by cycle: `anchors` carries
 * `idx_anchors_user_fingerprint_unique` — a partial UNIQUE INDEX on
 * `(user_id, fingerprint) WHERE deleted_at IS NULL` (migration baseline). Both
 * `seedPriorAnchor` calls in `runCycle` (the google_drive fixture AND the
 * member fixture) insert directly against the SAME fixture users every
 * cycle, so a FIXED fingerprint constant collides with the still-live row
 * from the previous cycle — `duplicate key value violates unique
 * constraint`, every cycle after the first, 100% reproducible. This was the
 * 47/47-failure incident: the fixture collided with itself on repeat cycles.
 * The trailing 8 hex chars are cycle-derived so every cycle gets its own row.
 */
function cycleFingerprint(letter: 'a' | 'b' | 'c', cycle: number): string {
  const suffix = cycle.toString(16).padStart(8, '0').slice(-8);
  return `${letter.repeat(56)}${suffix}`;
}

interface FixtureIdentity {
  orgId: string;
  orgAdminUserId: string;
  memberUserId: string;
}

async function ensureFixtureUser(
  db: SupabaseClient,
  email: string,
): Promise<string> {
  const { data: existing } = await db.from('profiles').select('id').eq('email', email).maybeSingle();
  if (existing && (existing as { id?: string }).id) return (existing as { id: string }).id;

  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
    password: randomUUID(),
  });
  if (createError || !created?.user) {
    throw new Error(`could not create fixture auth user ${email}: ${createError?.message ?? 'unknown'}`);
  }
  return created.user.id;
}

/**
 * Idempotent, re-runnable fixture setup: one org, one ORG_ADMIN owner, one
 * plain ORG_MEMBER. Resolved by a deterministic email/display_name so a
 * re-run of this driver (interrupted soak resume) reuses the same identities
 * instead of accumulating duplicates.
 */
async function ensureFixtureIdentity(db: SupabaseClient): Promise<FixtureIdentity> {
  const ownerEmail = `${FIXTURE_PREFIX}-owner@arkova-soak.invalid`;
  const memberEmail = `${FIXTURE_PREFIX}-member@arkova-soak.invalid`;
  const orgDisplayName = `${FIXTURE_PREFIX}-org`;

  const { data: existingOrg } = await db
    .from('organizations')
    .select('id')
    .eq('display_name', orgDisplayName)
    .maybeSingle();

  const orgAdminUserId = await ensureFixtureUser(db, ownerEmail);
  const memberUserId = await ensureFixtureUser(db, memberEmail);

  let orgId = (existingOrg as { id?: string } | null)?.id ?? null;
  if (!orgId) {
    const { data: org, error: orgError } = await db
      .from('organizations')
      .insert({ legal_name: orgDisplayName, display_name: orgDisplayName, verification_status: 'VERIFIED' })
      .select('id')
      .single();
    if (orgError || !org) throw new Error(`could not create fixture organization: ${orgError?.message}`);
    orgId = (org as { id: string }).id;
  }

  // Upsert profiles/org_members for both identities — idempotent on a re-run.
  await db.from('profiles').upsert(
    { id: orgAdminUserId, email: ownerEmail, role: 'ORG_ADMIN', org_id: orgId },
    { onConflict: 'id' },
  );
  await db.from('profiles').upsert(
    { id: memberUserId, email: memberEmail, role: 'ORG_MEMBER', org_id: orgId },
    { onConflict: 'id' },
  );
  await db.from('org_members').upsert(
    { user_id: orgAdminUserId, org_id: orgId, role: 'owner' },
    { onConflict: 'user_id,org_id' },
  );
  await db.from('org_members').upsert(
    { user_id: memberUserId, org_id: orgId, role: 'member' },
    { onConflict: 'user_id,org_id' },
  );

  return { orgId, orgAdminUserId, memberUserId };
}

/**
 * Seed a "prior anchor" DIRECTLY into `anchors` — standing in for a document
 * already anchored through whatever path. `defaultMaterializeAnchor`'s prior
 * lookup keys ONLY on `(org_id, metadata->>connector_source,
 * metadata->>external_ref)` and reads `status`/`fingerprint`/`user_id` off the
 * row — it does not care how the row came to exist. This is what lets
 * assertion 8 test the actor-independence fix without standing up the
 * unrelated (and, per the SCOPING NOTE, structurally DocuSign-only) DS-04 v1
 * RPC path.
 */
async function seedPriorAnchor(
  db: SupabaseClient,
  args: { orgId: string; userId: string; source: string; externalRef: string; fingerprint: string; status: string },
): Promise<{ id: string; public_id: string; version_number: number }> {
  const { data, error } = await db
    .from('anchors')
    .insert({
      org_id: args.orgId,
      user_id: args.userId,
      filename: `${args.source}:${args.externalRef}`,
      fingerprint: args.fingerprint,
      fingerprint_source: 'document_bytes',
      status: args.status,
      credential_type: 'CONTRACT_POSTSIGNING',
      metadata: { connector_source: args.source, external_ref: args.externalRef },
    })
    .select('id, public_id, version_number')
    .single();
  if (error || !data) throw new Error(`could not seed prior anchor: ${error?.message}`);
  return data as { id: string; public_id: string; version_number: number };
}

async function enqueueArtifact(
  db: SupabaseClient,
  args: {
    orgId: string; source: string; externalRef: string; externalRevision: string | null; fingerprint: string;
  },
): Promise<string> {
  const { data, error } = await db.rpc('enqueue_connector_artifact', {
    p_org_id: args.orgId,
    p_source: args.source,
    p_external_ref: args.externalRef,
    p_external_revision: args.externalRevision,
    p_fingerprint_sha256: args.fingerprint,
    p_byte_length: 1024,
    p_metadata: {},
  });
  if (error || !data) throw new Error(`enqueue_connector_artifact failed: ${error?.message}`);
  return data as string;
}

/**
 * A non-2xx here (the cron route answers 500 whenever `orgsFailed > 0`) can
 * mean an UNRELATED org sharing this rig failed its own drain pass — it must
 * never fail this cycle by itself. The per-probe DB/HTTP assertions in
 * `runCycle` are the actual evidence; a genuine transport failure (rig
 * unreachable) still propagates as a thrown exception from `fetch` itself,
 * which `main()`'s per-cycle try/catch turns into an explicit `cycle_error`
 * probe rather than a silently empty row.
 */
async function triggerDrain(targetUrl: string, cronSecret?: string, bearerToken?: string): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cronSecret) headers['x-cron-secret'] = cronSecret;
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  await fetch(`${targetUrl.replace(/\/+$/, '')}/jobs/drain-connector-artifacts`, {
    method: 'POST',
    headers,
  });
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  ready: (value: T) => boolean,
  attempts: number,
  delayMs: number,
): Promise<T> {
  let last: T = await fn();
  for (let i = 0; i < attempts && !ready(last); i += 1) {
    await new Promise((r) => setTimeout(r, delayMs));
    last = await fn();
  }
  return last;
}

async function fetchAnchorByFilter(
  db: SupabaseClient,
  orgId: string,
  source: string,
  externalRef: string,
): Promise<AnchorFacts[]> {
  const { data, error } = await db
    .from('anchors')
    .select('id, status, parent_anchor_id, version_number, user_id')
    .eq('org_id', orgId)
    .eq('metadata->>connector_source', source)
    .eq('metadata->>external_ref', externalRef)
    .is('deleted_at', null)
    .order('version_number', { ascending: true });
  if (error) throw new Error(`anchor lookup failed: ${error.message}`);
  return (data ?? []) as AnchorFacts[];
}

async function fetchArtifactStatus(db: SupabaseClient, artifactId: string): Promise<ArtifactFacts> {
  const { data, error } = await db
    .from('connector_artifact')
    .select('status, anchor_id')
    .eq('id', artifactId)
    .single();
  if (error || !data) throw new Error(`connector_artifact lookup failed: ${error?.message}`);
  return data as ArtifactFacts;
}

async function verifyPublicId(targetUrl: string, publicId: string): Promise<VerifyProbeResponse> {
  const res = await fetch(`${targetUrl.replace(/\/+$/, '')}/api/v1/verify/${encodeURIComponent(publicId)}`);
  const body = await res.json().catch(() => ({}));
  return { httpStatus: res.status, body };
}

async function provenanceForPublicId(targetUrl: string, publicId: string): Promise<ProvenanceEvent[]> {
  const res = await fetch(
    `${targetUrl.replace(/\/+$/, '')}/api/v1/verify/${encodeURIComponent(publicId)}/provenance`,
  );
  const body = await res.json().catch(() => ({ events: [] }));
  return ((body as { events?: ProvenanceEvent[] }).events) ?? [];
}

/** One full pass over all eight assertions, using a cycle-unique external_ref per scenario. */
async function runCycle(
  db: SupabaseClient,
  targetUrl: string,
  fx: FixtureIdentity,
  cycle: number,
  cronSecret?: string,
  bearerToken?: string,
): Promise<ProbeResult[]> {
  const probes: ProbeResult[] = [];
  const suffix = `${Date.now()}-${cycle}`;
  // Cycle-unique fingerprints — see cycleFingerprint's own doc comment for the
  // exact unique-index collision this fixes (47/47 failures without it).
  const hashA = cycleFingerprint('a', cycle);
  const hashB = cycleFingerprint('b', cycle);
  const hashC = cycleFingerprint('c', cycle);

  // ── Assertions 1, 2, 3, 4, 5, 6: google_drive update / replay / no-op ──
  const gdRef = `${FIXTURE_PREFIX}-gd-${suffix}`;
  const v1 = await seedPriorAnchor(db, {
    orgId: fx.orgId, userId: fx.orgAdminUserId, source: 'google_drive', externalRef: gdRef,
    fingerprint: hashA, status: 'SECURED',
  });

  await enqueueArtifact(db, {
    orgId: fx.orgId, source: 'google_drive', externalRef: gdRef, externalRevision: 'rev-2',
    fingerprint: hashB,
  });
  await triggerDrain(targetUrl, cronSecret, bearerToken);

  const afterUpdate = await pollUntil(
    () => fetchAnchorByFilter(db, fx.orgId, 'google_drive', gdRef),
    (rows) => rows.length >= 2,
    5, 3000,
  );
  const prior1 = afterUpdate.find((a) => a.id === v1.id) ?? null;
  const child1 = afterUpdate.find((a) => a.id !== v1.id) ?? null;

  probes.push(classifySupersedeNotRevoke(prior1?.status ?? 'MISSING'));
  probes.push(classifyLineage({ id: v1.id, version_number: v1.version_number }, child1));

  const verifyRes = await verifyPublicId(targetUrl, v1.public_id);
  probes.push(classifyVerifyResponse(verifyRes));

  const events = await provenanceForPublicId(targetUrl, v1.public_id);
  probes.push(classifyProvenanceEvents(events));

  // Assertion 5 — idempotent replay of the SAME (source, external_ref, external_revision).
  const replayIdA = await enqueueArtifact(db, {
    orgId: fx.orgId, source: 'google_drive', externalRef: gdRef, externalRevision: 'rev-2', fingerprint: hashB,
  });
  const anchorsBeforeReplay = await fetchAnchorByFilter(db, fx.orgId, 'google_drive', gdRef);
  const replayIdB = await enqueueArtifact(db, {
    orgId: fx.orgId, source: 'google_drive', externalRef: gdRef, externalRevision: 'rev-2', fingerprint: hashB,
  });
  await triggerDrain(targetUrl, cronSecret, bearerToken);
  await new Promise((r) => setTimeout(r, 3000));
  const anchorsAfterReplay = await fetchAnchorByFilter(db, fx.orgId, 'google_drive', gdRef);
  const priorAfterReplay = anchorsAfterReplay.find((a) => a.id === v1.id);
  probes.push(classifyIdempotentReplay({
    enqueueIdA: replayIdA,
    enqueueIdB: replayIdB,
    anchorCountBeforeReplay: anchorsBeforeReplay.length,
    anchorCountAfterReplay: anchorsAfterReplay.length,
    priorStatusAfterReplay: priorAfterReplay?.status ?? 'MISSING',
  }));

  // Assertion 6 — identical-fingerprint no-op against the CURRENT head (child1).
  // A bare "enqueue, drain, sleep(3s)" satisfies this observation on
  // pending/failed/still-unprocessed work just as readily as on a genuine
  // no-op — a fixed sleep is not evidence the artifact was ever actually
  // handled. Capture the artifact id and require it reach a TERMINAL result
  // (materialized or failed) before asserting anything about the anchor.
  const headBefore = anchorsAfterReplay.reduce((max, a) => (a.version_number > max.version_number ? a : max));
  const noopArtifactId = await enqueueArtifact(db, {
    orgId: fx.orgId, source: 'google_drive', externalRef: gdRef, externalRevision: 'rev-3',
    fingerprint: hashB, // unchanged content
  });
  await triggerDrain(targetUrl, cronSecret, bearerToken);
  const noopArtifactAfter = await pollUntil(
    () => fetchArtifactStatus(db, noopArtifactId),
    (a) => a.status === 'materialized' || a.status === 'failed',
    5, 3000,
  );
  if (noopArtifactAfter.status !== 'materialized' && noopArtifactAfter.status !== 'failed') {
    probes.push(probe(
      ASSERTION.NOOP_IDENTICAL_FINGERPRINT,
      false,
      `no-op artifact never reached a terminal result (status=${noopArtifactAfter.status} after bounded `
        + 'polling) — cannot assert the head anchor was preserved by an event that was never actually '
        + 'processed',
    ));
  } else {
    const anchorsAfterNoop = await fetchAnchorByFilter(db, fx.orgId, 'google_drive', gdRef);
    const headAfter = anchorsAfterNoop.reduce((max, a) => (a.version_number > max.version_number ? a : max));
    probes.push(classifyNoopIdenticalFingerprint({
      headAnchorIdBefore: headBefore.id, headAnchorIdAfter: headAfter.id, headStatusAfter: headAfter.status,
    }));
  }

  // ── Assertion 7: negative control (docusign, ungated, must still double-anchor) ──
  const dsRef = `${FIXTURE_PREFIX}-ds-${suffix}`;
  await enqueueArtifact(db, {
    orgId: fx.orgId, source: 'docusign', externalRef: dsRef, externalRevision: 'synthetic-a', fingerprint: hashA,
  });
  await enqueueArtifact(db, {
    orgId: fx.orgId, source: 'docusign', externalRef: dsRef, externalRevision: 'synthetic-b', fingerprint: hashC,
  });
  await triggerDrain(targetUrl, cronSecret, bearerToken);
  const dsAnchors = await pollUntil(
    () => fetchAnchorByFilter(db, fx.orgId, 'docusign', dsRef),
    (rows) => rows.length >= 2,
    5, 3000,
  );
  probes.push(classifyNegativeControlDocuSign(dsAnchors));

  // ── Assertion 8: member-owned prior anchor, independently-resolved admin actor ──
  const memberRef = `${FIXTURE_PREFIX}-member-${suffix}`;
  const memberV1 = await seedPriorAnchor(db, {
    orgId: fx.orgId, userId: fx.memberUserId, source: 'google_drive', externalRef: memberRef,
    fingerprint: hashA, status: 'SECURED',
  });
  const memberArtifactId = await enqueueArtifact(db, {
    orgId: fx.orgId, source: 'google_drive', externalRef: memberRef, externalRevision: 'rev-2',
    fingerprint: hashB,
  });
  await triggerDrain(targetUrl, cronSecret, bearerToken);
  const memberArtifactAfter = await pollUntil(
    () => fetchArtifactStatus(db, memberArtifactId),
    (a) => a.status === 'materialized' || a.status === 'failed',
    5, 3000,
  );
  const memberAnchorsAfter = await fetchAnchorByFilter(db, fx.orgId, 'google_drive', memberRef);
  const memberChild = memberAnchorsAfter.find((a) => a.id === memberArtifactAfter.anchor_id) ?? null;
  probes.push(classifyMemberOwnedSupersede({
    artifactStatus: memberArtifactAfter.status,
    priorAnchorId: memberV1.id,
    priorVersionNumber: memberV1.version_number,
    priorOwnerUserId: fx.memberUserId,
    newAnchor: memberChild,
  }));

  return probes;
}

// ---------------------------------------------------------------------------
// CLI + runner
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): DriverArgs {
  const args: DriverArgs = { mode: 'self-test', durationMin: 0, intervalSec: 900 };
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
      case '--duration-min':
        args.durationMin = Number.parseInt(argv[++i] ?? '0', 10);
        break;
      case '--interval-sec':
        args.intervalSec = Number.parseInt(argv[++i] ?? '900', 10);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function emit(row: DriverRow, evidenceJsonl?: string): void {
  const line = `${JSON.stringify(row)}\n`;
  if (evidenceJsonl) appendFileSync(evidenceJsonl, line);
  process.stdout.write(line);
}

function resolveCredentials(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('live mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  return { url, key };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const admission = args.admissionJson
    ? (JSON.parse(readFileSync(args.admissionJson, 'utf8')) as Record<string, unknown>)
    : undefined;

  if (args.mode === 'self-test') {
    const probes = runSelfTest();
    emit({
      utc: new Date().toISOString(),
      pr: 3087,
      tier: 'T3',
      mode: 'self-test',
      evidenceForSoak: false,
      changedBehavior: CHANGED_BEHAVIOR,
      status: aggregate(probes),
      cycle: 0,
      counts: tally(probes),
      probes,
      blockers: ['self-test mode — local validation only, NOT T3 soak evidence'],
    }, args.evidenceJsonl);
    process.exitCode = aggregate(probes) === 'pass' ? 0 : 1;
    return;
  }

  if (!args.targetUrl) throw new Error('--live requires --target-url');
  const { url, key } = resolveCredentials();
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const fx = await ensureFixtureIdentity(db);

  const startedAt = Date.now();
  const deadline = startedAt + args.durationMin * 60_000;
  let cycle = 0;
  let anyCycleFailed = false;

  do {
    cycle += 1;
    let probes: ProbeResult[];
    try {
      probes = await runCycle(db, args.targetUrl, fx, cycle, args.cronSecret, args.bearerToken);
    } catch (error) {
      probes = [probe('cycle_error', false, error instanceof Error ? error.message : 'unknown')];
    }

    if (aggregate(probes) === 'fail') anyCycleFailed = true;

    emit({
      utc: new Date().toISOString(),
      pr: 3087,
      tier: 'T3',
      mode: 'live',
      evidenceForSoak: true,
      changedBehavior: CHANGED_BEHAVIOR,
      status: aggregate(probes),
      cycle,
      counts: tally(probes),
      probes,
      admission,
    }, args.evidenceJsonl);

    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, args.intervalSec * 1000));
  } while (Date.now() < deadline);

  // A failed probe anywhere in the run must fail the process — see pr3083's
  // driver for the same fix and why the CLI must not exit 0 on a red run.
  process.exitCode = anyCycleFailed ? 1 : 0;
}

const invokedDirectly = process.argv[1]?.includes('pr3087-supersede-drain-driver');
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'driver failed'}\n`);
    process.exitCode = 1;
  });
}
