# Decision — `fingerprint_source` for the rules-engine declared-hash anchor path

Internal engineering note (not the canonical doc — Data Model / On-Chain Policy on Confluence are).
Sibling to the DocuSign Bilateral **CTO Decision Record** (commit `2a676981c`, ruling **R2**), which
lands on `main` with the RC branch; this note may land ahead of it.

- **Author:** engineering (acting CTO call — proof-integrity)
- **Date:** 2026-08-30
- **Surface:** `services/worker/src/jobs/rule-action-dispatcher.ts` — `AUTO_ANCHOR` / `FAST_TRACK_ANCHOR` / `INSTANT_SECURE`
- **Change:** set the top-level `anchors.fingerprint_source` column explicitly to **`NULL`** on this path, enforced by a required `z.null()` in the module's local `AnchorInsertSchema`, pinned by tests.
- **Tier:** T1 (worker code; **zero behavioural change on the wire** — see below).

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
| `document_bytes` | *"A source document's fingerprint was generated **on your device**"*; triad measured: *"the document bytes provided on your device."* | Arkova/the client never touched the bytes. This is the measurement claim the `connector-artifact-drain` (§1.6A fetch) path legitimately makes — **copying it here would be a false measurement claim.** |
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

## Behavioural impact

**None on the wire.** These anchors already returned `fingerprint_source: null` from `/api/v1/verify`
and `get_public_anchor` (the column was already `NULL` by omission). This change makes the null
*explicit, validated, and tested* so it cannot silently drift to a lying value. Tier **T1**.

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

**Why it is out of scope here:** the fix touches the shared classifier + three emission sites and must
distinguish declared (dispatcher) from fetched (drain) anchors, which today share
`connector_source='docusign'` and (on `main`) both have `fingerprint_source=NULL`. Doing it correctly is
entangled with PR-2 (drain setting `document_bytes`, which becomes the discriminator) and PR-4
(`DECLARED_UNVERIFIED`). It deserves its own PR + tests across all three surfaces, coordinated with that
workstream — not bolted onto this focused, no-behaviour-change fix.

**Recommended fix (for that PR):** a declared-hash anchor must emit **no** re-derivability statement
(silence, per the module's own *"absence means 'no re-derivability statement'"*) — or the positive
`DECLARED_UNVERIFIED` class once it exists — never `FETCH_TIME_SNAPSHOT`.

## References
- Migration `0376_r19_anchor_fingerprint_source.sql` (column + `COMMENT ON COLUMN` semantics)
- Migration `0384_scrum2481_anchor_evidence_claim_authority.sql` (post-insert immutability)
- CTO Decision Record — DocuSign Bilateral, ruling **R2/R3** (commit `2a676981c`; lands with the RC branch)
- `src/lib/copy.ts` — `FINGERPRINT_SOURCE_DESCRIPTIONS` / `FINGERPRINT_SOURCE_TRIAD`
- `services/worker/src/jobs/docusign-anchor-reconciliation.ts` — declared vs fetched
- Constitution §1.5 (measured/asserted/NOT-asserted), §1.6 / §1.6A, R-7 claims gate
