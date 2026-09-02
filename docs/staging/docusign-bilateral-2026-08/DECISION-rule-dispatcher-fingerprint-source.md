# Decision — `fingerprint_source` for the rules-engine declared-hash anchor path

Internal engineering note (not the canonical doc — Data Model / On-Chain Policy on Confluence are).
Sibling to the DocuSign Bilateral **CTO Decision Record** (commit `2a676981c`, ruling **R2**), which
lands on `main` with the RC branch; this note may land ahead of it.

- **Author:** engineering (acting CTO call — proof-integrity)
- **Date:** 2026-08-30
- **Surface:** `services/worker/src/jobs/rule-action-dispatcher.ts` — `AUTO_ANCHOR` / `FAST_TRACK_ANCHOR` / `INSTANT_SECURE`
- **Change:** set the top-level `anchors.fingerprint_source` column explicitly to **`NULL`** on this path, enforced by a required `z.null()` in the module's local `AnchorInsertSchema`, pinned by tests.
- **Tier:** **T3** — path-derived, not impact-derived. `scripts/ci/check-staging-evidence.ts` on `main`
  names `services/worker/src/jobs/rule-action-dispatcher.ts` explicitly in its **T3** anchor-materializer
  rule (SCRUM-3802 promoted this module because `AUTO_ANCHOR` / `FAST_TRACK_ANCHOR` / `INSTANT_SECURE`
  **create `anchors` rows**). The detector fails **CLOSED** to the highest matching tier (§1.13), so the
  wire-level "zero behavioural change" argument below does **not** buy a lower tier — declaring T1 or T2
  in the PR body is an under-declaration and the Staging Soak Evidence Gate rejects it.
  See "Soak scoping" below: the changed behaviour is **not observable on the wire**, so a generic 48 h
  soak is worker-health evidence only and does not cover this diff.

## The gap

`rule-action-dispatcher.ts` materializes anchors but never set the top-level
`anchors.fingerprint_source` column (migration `0376`). The local `AnchorInsertSchema` did not declare
the field, so any value would have been stripped by Zod anyway. The column therefore defaulted to
`NULL` by omission — an *implicit* null that read like an oversight and invited a future "fix" that
copies the sibling `connector-artifact-drain.ts` path's value.

> Note the naming trap: this module already writes a **`metadata.fingerprint_source`** key. That is an
> unrelated **free-text debug label** recording *which payload field* the hash was read from (e.g.
> `"payload.document_sha256"`). It is **not** the typed top-level `anchors.fingerprint_source` column
> and must never be conflated with it. This change does not touch the metadata label.

## What this path actually is: a DECLARED (asserted) hash, never measured

The fingerprint comes from a value **DocuSign declares** in the rule trigger payload
(`payload.document_sha256` / `combined_document_sha256` / `sha256` / `document_hashes[0]`).
`rules-engine.ts` (`sanitizeExecutionProviderPayload`) passes it through verbatim, hex-normalized only.
There is **no fetch and no server-side hash** anywhere on this path. The repo's own reconciliation
module says so explicitly:

> `docusign-anchor-reconciliation.ts`: *"(A) DECLARED-HASH rules path … The document bytes are never
> fetched — the hash is ASSERTED, not measured."* vs *"(B) SERVER-FETCHED connector path … computes
> SHA-256 over the ACTUAL bytes … MEASURED over the real signed bytes."*

So evidentially this path is **asserted, not measured by Arkova**.

## Decision: `NULL`, and why not either enum value

`0376` allows `NULL | 'document_bytes' | 'issuer_record_attestation'`. **Both enum values ship a false
§1.5 claim on a vendor-declared hash**, in opposite directions — and the falsehood is not subtle, it is
in the shipped public copy (`src/lib/copy.ts`):

| Value | Public copy it renders | Why it is false here |
|---|---|---|
| `document_bytes` | *"A source document's fingerprint was generated **on your device**"*; triad measured: *"the document bytes provided on your device."* | Arkova/the client never touched the bytes. This is the measurement claim the `connector-artifact-drain` (§1.6A fetch) path is entitled to — though note it does not actually write `fingerprint_source` yet (that is PR-2), so there is no sibling value to copy today — and **claiming it here would be a false measurement claim either way.** |
| `issuer_record_attestation` | *"**No source document was supplied** … that content — **not a document** — was fingerprinted"*; triad not-asserted: *"That a source document exists … **This record was never in document form.**"* | A signed contract demonstrably **does** exist and DocuSign hashed it. This value denies a document that exists. |

`NULL` is the only value that asserts nothing false. It renders as **nothing** on the public page
(`FingerprintSourceDisplay` returns `null` for an unparseable/absent class — *"never guessed, §1.5"*),
which is the honest representation of *"Arkova makes no measured-vs-record claim about how this
fingerprint was produced."* This is §1.5's *"never assert what cannot be proven."*

Two reinforcing facts:

- **Immutability.** Migration `0384` refuses any post-insert change to `fingerprint_source` (except
  `service_role`). The dispatcher writes as `service_role`, so **there is no DB guardrail** stopping a
  wrong value — the guardrail is the `z.null()` schema + tests added here — and a wrong value written
  now would be permanent. `NULL` is also the safe, **backfill-compatible** placeholder: a future
  coordinated `service_role` migration can set the correct positive class in one pass.
- **No new enum value, by design.** A precise third class ("vendor-declared document hash") would need
  a T3 CHECK-constraint migration on the ~3.5M-row `anchors` table + new copy/display, and it would cut
  across **CTO Decision Record R2**, which explicitly *"do NOT invent"* a new axis and instead assigns
  declared-hash anchors `issuer_record_attestation` **paired with a new `DECLARED_UNVERIFIED`
  re-derivability class** (with R3 copy: *"Arkova did not retrieve or hash this document; the
  fingerprint is asserted by DocuSign's notification, not measured by Arkova"*). That pairing is what
  makes `issuer_record_attestation` non-false for a declared-hash-**with**-document. It is owned by the
  inbound declared-hash workstream (**PR-4**, flag-OFF, blocked on a feasibility spike).

**Forward path (when PR-4's `DECLARED_UNVERIFIED` lands):** the R2-consistent end-state for this path is
`fingerprint_source = 'issuer_record_attestation'` **+** `fingerprint_rederivability = DECLARED_UNVERIFIED`,
backfilled onto historical dispatcher anchors via a coordinated `service_role` migration. Until then,
`NULL` is the honest interim. This note is the pointer for that follow-up.

**The backfill's discriminator, named:** that migration must separate dispatcher-created anchors from
genuinely-legacy ones, because after this change `NULL` is **overloaded** — `0376`'s own
`COMMENT ON COLUMN` defines `NULL` as *"unclassified (anchor predates this column)"*, and this path now
also writes `NULL` to mean *"no honest class exists yet."* Both states are the same value in the data.
They are still separable, and the discriminator is **`metadata->>'rule_action_type' IN ('AUTO_ANCHOR',
'FAST_TRACK_ANCHOR', 'INSTANT_SECURE')`** — written by `buildAnchorInsertPayload` on every anchor this
module has ever created, including the ones already in prod. Do not reach for `metadata.connector_source`
instead: the server-fetched `connector-artifact-drain.ts` path writes `'docusign'` there too, so it does
**not** separate declared from fetched. Any future backfill that omits this predicate would silently
relabel pre-`0376` legacy anchors as declared-hash DocuSign anchors.

## Behavioural impact

**None on the wire.** These anchors already returned `fingerprint_source: null` from `/api/v1/verify`
and `get_public_anchor` (the column was already `NULL` by omission — the column is nullable with **no
`DEFAULT`**, so the pre-change omission and the post-change explicit `null` persist the identical row).
This change makes the null *explicit, validated, and tested* so it cannot silently drift to a lying
value. **Existing rows are not touched** — and there is no gap to disclose, because existing dispatcher
anchors already hold exactly the value this PR now writes.

**One thing that IS different: the write.** The PostgREST insert body now carries an explicit
`fingerprint_source` key where it previously omitted it. That is a no-op against any schema cache that
knows the column — but against one that does **not** (a rig replayed from a pre-`0376` snapshot, or one
where `NOTIFY pgrst, 'reload schema'` has not run since `0376` applied) PostgREST answers **`PGRST204`**
and *every* anchor materialization on this path fails, where the old payload would have succeeded.
Bounded (`dispatchCreditFundedAnchor` compensates the credit; `AUTO_ANCHOR` fails the execution toward
the DLQ) and not a prod risk — prod has the column, and `0384`'s `CREATE TRIGGER … UPDATE OF …
fingerprint_source` could not have applied otherwise. **It is a soak-rig precondition:** confirm
`SELECT 1 FROM information_schema.columns WHERE table_name='anchors' AND column_name='fingerprint_source'`
on the rig *before* starting the clock.

## Soak scoping — what a T3 soak can and cannot prove here

The tier is T3 (path-derived, above). **But the changed behaviour is not observable on the wire**, so a
48 h synthetic soak cannot exercise it: fixed and unfixed code both persist `fingerprint_source = NULL`
and both return `fingerprint_source: null` (in `get_public_anchor`) / omit the key entirely (in
`/api/v1/verify`, whose API-RICH loop `continue`s on a null value). No black-box probe distinguishes them.

Per §1.12 — *"soak evidence must exercise the PR's changed behavior; generic synthetic load is supporting
worker-health evidence only"* — the honest evidence split is therefore:

- **What the soak covers:** that this module still materializes anchors correctly under sustained load on
  a rig whose `anchors` table has the column, i.e. that the explicit key did **not** introduce the
  `PGRST204` failure mode above. That is the *only* thing the runtime can newly falsify.
- **What the soak cannot cover:** the honesty invariant itself. That is covered by the write-path guard —
  the required `z.null()` in `AnchorInsertSchema` plus the four `fingerprint_source evidence class (R19
  §1.5)` tests, which fail red (4 failed / 40 passed) when either half of the fix is removed.

Do not present a green 48 h load run as evidence that this diff is correct; it is evidence that this diff
is harmless. The correctness evidence is the red/green test pair.

## Related, HIGHER-severity finding — NOT fixed by this PR (see bug log)

This PR fixes the `fingerprint_source` axis. **A separate, more serious live §1.5 defect remains on the
`fingerprint_rederivability` axis for the same anchors, and this PR does not resolve it:**

`constants/connectorFingerprint.ts` (BUG-2026-08-13-010) classifies anchors by
`metadata.connector_source ∈ {docusign, connector, …}` and attaches
`fingerprint_rederivability = FETCH_TIME_SNAPSHOT` with the note *"**Measured: Arkova computed its
fingerprint from the document bytes retrieved** …"*. The dispatcher writes `connector_source: 'docusign'`
(or `'connector'`), so its **declared-hash** anchors currently emit that **false measurement note** on
three surfaces — `api/v1/verify.ts:573`, `api/proof-packet.ts:362`, `api/v1/verify-proof.ts:615`. That
module's own comment even (wrongly) lists `rule-action-dispatcher.ts` as a *"server-side connector
fetch"* — contradicted by `docusign-anchor-reconciliation.ts` (above) and `rules-engine.ts`.

Verified at the three sites named above: `api/v1/verify.ts:574`, `api/proof-packet.ts:362`,
`api/v1/verify-proof.ts:615`, all emitting from `connectorFingerprintRederivabilityFields()`.

**Why it is out of scope here:** the fix touches the shared classifier + three emission sites, each of
which needs its own tests. That is a different PR from this one, whose whole diff is a `z.null()` and a
comment block. It should **not** be bolted onto a no-behaviour-change fix that a T3 soak already cannot
meaningfully exercise.

**It is NOT, however, blocked on PR-2 or PR-4 — do not let it be parked there.** The earlier framing of
this deferral said declared and fetched anchors are indistinguishable until PR-2 makes the drain write
`document_bytes`. That is wrong: **`metadata->>'rule_action_type'` already discriminates them today.**
`buildAnchorInsertPayload` writes it (`AUTO_ANCHOR` / `FAST_TRACK_ANCHOR` / `INSTANT_SECURE`) on every
anchor this module has ever created; `connector-artifact-drain.ts` never writes that key at all (it
writes only `connector_source` / `connector_artifact_id` / `external_ref`). So the fix is available now,
on data that already exists, and does not need a new enum value to land. A live false measurement
statement on a public proof surface should not wait on a spike.

**Recommended fix (for that PR):** gate the emission on "connector marker present **AND** no
`rule_action_type`" so a declared-hash anchor emits **no** re-derivability statement (silence, per the
module's own *"absence means 'no re-derivability statement'"*) — or the positive `DECLARED_UNVERIFIED`
class once it exists — never `FETCH_TIME_SNAPSHOT`. While doing it, fix
`constants/connectorFingerprint.ts`'s own header, which wrongly lists `jobs/rule-action-dispatcher.ts`
among the paths that perform a *"server-side connector fetch"* — that comment is the origin of the
mis-classification.

## References
- Migration `0376_r19_anchor_fingerprint_source.sql` (column + `COMMENT ON COLUMN` semantics)
- Migration `0384_scrum2481_anchor_evidence_claim_authority.sql` (post-insert immutability — for
  NON-`service_role` callers only; this module is exempt, which is both why the schema+tests are the
  only guard and why a future backfill remains possible)
- CTO Decision Record — DocuSign Bilateral, ruling **R2/R3** (commit `2a676981c`; lands with the RC branch)
- `src/lib/copy.ts` — `FINGERPRINT_SOURCE_DESCRIPTIONS` / `FINGERPRINT_SOURCE_TRIAD`
- `services/worker/src/jobs/docusign-anchor-reconciliation.ts` — declared vs fetched
- Constitution §1.5 (measured/asserted/NOT-asserted), §1.6 / §1.6A, R-7 claims gate
