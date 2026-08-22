# PROVENANCE CHAIN SPECIFICATION

## Linking anchors to their source documents, and documents to the people who signed them

**Status:** design specification, not yet scoped into Jira. Read-only research session — nothing was written to any rig, PR, branch, or prod.

**Verification basis:** repo HEAD `587d2f318`, prod `vzwyaatejekddvltxyye` (read-only), PR #2246 head `d7f666004` (open, draft, CONFLICTING), plus DocuSign's published OpenAPI spec and Google Drive's v3 reference. Claims re-verified directly against this tree are marked **(verified)**. Citations are given as file + symbol rather than bare line numbers wherever the symbol is stable, because line numbers drift.

**Revision note:** this document has been through three independent adversarial reviews (privacy engineering, claims-honesty/R-7, adversarial security). Every blocking and major finding is addressed in the body, and §9 records what changed. An earlier draft cited HEAD `fc3629f73`; every line-number citation has been re-checked against `587d2f318`.

---

## 0. The two asks, restated

**(A) Source link.** An anchor should carry a link back to the document it was made from — in DocuSign, Drive, or M365 — pinned to the exact version that was anchored, where the source system's own access control decides who may open it.

**(B) Signer identity.** A signed document should be linked to the Arkova account of the person who signed it, so their public profile ID appears on the record.

Both are good instincts. Both rest on a load-bearing assumption that the research falsified, and this spec is largely about what to build instead.

### (A)'s broken assumption: "DocuSign's own security ensures only signers can view it"

There is no durable, ACL-enforced DocuSign deep link:

- Signing links die permanently the moment an envelope reaches `Completed`.
- Email links expire after 5 clicks or 48 hours, explicitly including links to completed envelopes.
- The recipient-view API works only on `sent` envelopes, returns a single-use URL that expires in 5 minutes, and DocuSign's own documentation states: *"Your application is responsible for authenticating the identity of the recipient."*
- The console-view API carries an information-security notice that it *"provides full access to the sending account."*
- The only stable form is the web-app URL, which resolves only for people who already hold a DocuSign account and are sender or recipient — and which appears in community and third-party institutional IT pages, **not** in DocuSign's own developer reference.

**We cannot delegate the gate to the vendor.** We must hold the gate ourselves and let the vendor's login wall be a second gate behind it.

### (B)'s broken assumption: that a profile public ID is safe to publish

It is the single most dangerous field we could put on an anonymous verify page. §4.1 explains why in detail. The short version: a bare hash requires an offline dictionary attack; `profiles.public_id` requires one HTTP GET.

---

## 1. What this proves

### 1.1 The three-party chain

Three parties each attest to something the other two cannot. **One correction to the obvious framing, and it is load-bearing:** for connector-sourced anchors the source system is *not* independent of the organization whose record it strengthens. See §1.1a.

| Party | What it proves | What it cannot prove |
|---|---|---|
| **Bitcoin (via Arkova)** | A specific 32-byte fingerprint was committed no later than block time T. **For records carrying a per-document inclusion proof**, this is verifiable by anyone, offline, with no dependency on Arkova, DocuSign, Google, or any account staying open. Not a party to the agreement. | What the bytes were. Who agreed to them. Whether anyone consented. **And — critically — for `root_only` records, independent verification currently requires Arkova to reconstruct the inclusion branch.** See §1.1b. |
| **DocuSign (the source system)** | That a session authenticated to a given email address completed the signing ceremony; the recipient routing sequence (sent / delivered / signed / completed) per recipient; the authentication outcome and timestamps DocuSign reports; acceptance of the Electronic Record and Signature Disclosure; a captured signature image; an "Envelope Updated" event for every correction. | **The legal identity of any human.** That the record will still exist later — completed envelope documents are purgeable (14-day purge queue; Document Retention policies purge on schedule; demo accounts drop envelopes at 30 days; ~2 years retention after account closure). It is also attesting about its own logs, so it cannot rebut an allegation that its own logs were altered. **And it is not independent of the securing org — see §1.1a.** |
| **Google Drive (the source system)** | Per-revision attribution via `lastModifyingUser`; a monotonic `version` covering *"every change made to the file on the server, even those not visible to the user"*; a native `sha256Checksum` for binary files that we can cross-check against our own hash at no cost. | That a revision existed at a given wall-clock time in a way that survives Google purging it. Non-`keepForever` revisions are *"typically preserved for 30 days"* and can go sooner past 100 revisions. Drive has no signature, no assent, and no concept of "the parties." |

> **Do not lift this table into a deck without §1.1a and §1.1b.** An earlier draft of this row set said DocuSign proves "who the parties were" and that its Certificate of Completion "is routinely admitted as a business record." The first contradicts §1.3 and §4.1 of this very document; the second is an admissibility claim engineering has no standing to make, especially while the counsel admissibility memo is unfunded. Both are removed.

### 1.1a The source system is not an independent party

For connector-sourced anchors, the attesting DocuSign account is chosen, configured, and controlled by the **same organization** whose record is being strengthened. The org:

- holds the Connect HMAC key (verified per-integration in `webhooks/docusign.ts`, provisioned into the org's own DocuSign account),
- controls the envelope and chooses the recipient email addresses,
- and, under **embedded signing** (`clientUserId` set), is itself the authenticator — which is precisely what DocuSign means by *"Your application is responsible for authenticating the identity of the recipient."*

§0 uses that sentence to dismantle ask (A). It applies with equal force to ask (B), and the design must not quietly forget it.

**Consequence for every claim we publish:** the Asserted clause reads *"an account controlled by this organization reported this address as a recipient at retrieval time"* — never *"a third party attested."* Arkova cannot distinguish a remotely-signed recipient from one the sending organization authenticated itself. That goes in the Not-asserted clause, and it drives the eligibility rule in §4.4.

### 1.1b The durability claim is true of a minority of records today

Prod, **verified 2026-08-20**: 3,553,498 SECURED anchors; 583,350 `anchor_proofs` rows. **16.4% coverage.** Migration 0406's own header says it plainly: Arkova's headline promise is offline, forever verification, and ~2.97M secured records have no per-document proof.

The platform already ships honest vocabulary for this — `PROOF_AVAILABILITY` (`services/worker/src/constants/proofAvailability.ts`) with its `per_document` / `root_only` class and its indivisible note. The spec's job is to use it, not to invent a parallel one.

**Rule:** any surface that carries a source link must also carry that record's `proof_availability` class and note. A durability claim standing next to a link is exactly where `root_only` must be visible. All 17 connector-sourced anchors do carry proofs today, so the *feature-scoped* claim is defensible; the general claim is not, and §10 is scoped accordingly.

### 1.1c The sharpest version of the founder's version-control argument

It is not "here is a link." It is:

> DocuSign's and Google's evidentiary weight is contingent on them still holding the record, and that contingency has a documented expiry date on it. A Bitcoin-anchored fingerprint of those exact bytes outlives the purge.

That is the claim the vendors genuinely cannot make. Lead with it — for `per_document` records.

**The link is the join, and the link is not evidence.** Both vendors' links are liveness-dependent authorization checks. A viewer without access sees a login wall; a viewer with access sees content we never verified and which may have been purged or replaced. The evidence is the fingerprint, the revision pin, and the timestamps.

### 1.2 Extending #2246's language

PR #2246 establishes the honesty caveat for connector fingerprints. **It is not on `main`** — `services/worker/src/constants/connectorFingerprint.ts` exists only on the PR branch (verified). Its text is a single exported constant, `FINGERPRINT_REDERIVABILITY_NOTE`, and it must be **quoted by reference to that constant, never paraphrased.** An earlier draft of this spec called its paraphrase "verbatim" and, in condensing, made two material changes:

1. It rendered *"this record is **marked as** connector-sourced"* as *"this record **is** connector-sourced"* — deleting a hedge the module header explains is load-bearing: *"the metadata blob is org-writable on some legacy paths (e.g. `bulk_create_anchors` persists client metadata verbatim), so this marker is 'recorded classification', not an independently provable fetch event."*
2. It dropped the operative sentence: *"A mismatch between this fingerprint and a re-retrieved copy is therefore not, by itself, evidence that this record is invalid or that the document was altered."*

That second sentence is the entire anti-false-tamper control. **It must appear on every surface that renders a link.**

The caveat was proven necessary empirically: BUG-2026-08-13-010 recorded four fetches of one unchanged DocuSign envelope producing four different SHA-256 values. The module header records the mechanism: the source system re-renders the file on every request.

**This is the strongest single constraint on the whole design.** A source link invites exactly the flow #2246 proves will fail: download, hash, compare. Ship the link without the caveat on the same surface and we have actively manufactured false-tamper readings.

Three new triads follow, drafted as design intent. Final wording is a copy task in `src/lib/copy.ts` under `npm run lint:copy`. All three carry "marked as" until §3.1's write-guard has landed **and legacy rows are audited** — the guard fixes forward only.

**Source-link triad.**
- *Measured:* this record is **marked as** sourced from a named third-party system, together with the identifier and retrieval time Arkova's server recorded at retrieval.
- *Asserted:* that at that time, a document reached through an integration authorized by this organization carried this identifier, and the bytes retrieved produced this fingerprint.
- *Not asserted:* that the source record still exists; that its current contents match what was retrieved; that anyone can open it; that opening it will reproduce this fingerprint. The source system controls access, retention, and deletion independently of Arkova. **The integration is controlled by the securing organization, not by an independent third party.**

**Revision-pin triad.**
- *Measured:* the version handle the source system reported at retrieval time, and its **pin class** (retrievable stored revision vs. point-in-time only).
- *Asserted:* that this fingerprint is of that version, not of some later one.
- *Not asserted:* that the version is still retrievable; that the handle is stable across time; that the source system preserves prior versions. For Google Workspace documents no vendor version handle exists and the pin is a modification timestamp (§3.3). **For DocuSign, the pin is on the envelope record's terminal state, not on the bytes any later retrieval returns (§3.3).**

**Signer-attribution triad** (phase 5 only).
- *Measured:* Arkova observed an email address that the source system reported as a **recipient** on this envelope, together with the reported **recipient type** and **routing status**; and a person holding an Arkova account proved control of that address through a server-minted possession challenge and chose to be named on this record.
- *Asserted:* that an account controlled by the securing organization reported that address with that recipient type and status at retrieval time.
- *Not asserted:* that the named person is the human who physically signed; that any identity document was checked; that the source system verified their legal identity — DocuSign returns authentication results as Pass/Fail plus a timestamp only, with no verified legal name, date of birth, or document number. **That the address is controlled by exactly one person** — possession of a shared or role mailbox proves control of a mailbox, not that one named human holds it. **That Arkova can distinguish a remotely-signed recipient from one the sending organization authenticated itself.** And: that this attribution will remain published — the signer may withdraw it, so its absence later does not mean it was false earlier.

> Note the deliberate asymmetry: "signer" appears nowhere in the Measured row. An earlier draft said the source system recorded the person as a *signer* in Measured and as a *recipient* in Asserted — the same fact at two different strengths, with the stronger framing in the row that means "Arkova observed this." §4.4 turns this into an eligibility rule rather than a caveat.

### 1.3 What the chain does NOT prove, stated plainly for the founder

- It does not prove a contract is valid, enforceable, or binding. It proves bytes and a timestamp.
- It does not prove identity. It proves control of an email address at claim time, plus whatever the source system chose to record — and the source system is the org's own account.
- It does not prove the source document is unchanged today. Only that these bytes existed then.
- It does not prove nobody else signed. We see the recipients the source system reports at fetch time, nothing more.
- It does not make the link work. If the vendor purges the record or the viewer lacks access, the link fails while the anchor remains fully valid. That distinction must be visible in the UI, or a dead link will read as a broken proof.

---

## 2. What already exists

The preliminary brief was wrong on two counts, and both errors point at real work being **cheaper** than assumed.

### 2.1 Corrections to the brief

**`connector_artifact` is not orphaned.** Producer, consumer, reconciler, Drive twin, and dual-path guard are built, deployed, flag-on in prod, and producing anchors. Prod holds **17 rows** (verified 2026-08-20), all `source='docusign'`, all `status='anchored'`, all with `anchor_id`. There are in fact **two** server-side connector materialization paths, not one: `jobs/connector-artifact-drain.ts` and `jobs/rule-action-dispatcher.ts` (per #2246's module header). Any guard that covers only the drain has a second door.

**`create_pending_recipient` does not "already exist."** Migration 0401 replaced its body with an unconditional `RAISE EXCEPTION`. It never created a row. `activate_user` was likewise retired by 0402. The live provisioning path is worker `POST /api/recipients`.

**There is no recipient claim flow.** `link_anchors_to_user` is present in the baseline migration file but **absent from the live database**, with zero callers anywhere. §4.3 explains why reviving it as written would be a vulnerability.

### 2.2 Schema exists AND code writes to it

| Thing | Where | State |
|---|---|---|
| `connector_artifact` table (0343) | `supabase/migrations/0343_*.sql` | Live. 17 prod rows (verified). |
| Dedupe on `(org_id, source, external_ref, COALESCE(external_revision,''))` | 0343 unique index | Live. The COALESCE sentinel is load-bearing (§3.3). |
| DocuSign producer | `jobs/docusign-envelope-completed.ts` | Live. `p_external_revision: null` hardcoded (verified: 0 of 17 rows carry a revision). |
| Drive producer | `jobs/drive-file-changed.ts` | Built and deployed. Has never produced an artifact (§6, out of band). |
| Rule-action dispatcher (2nd materialization path) | `jobs/rule-action-dispatcher.ts` | Live. Writes `connector_source` from the rule execution's vendor. |
| Drain to anchor | `jobs/connector-artifact-drain.ts` | Live. Writes `connector_source`, `connector_artifact_id`, `external_ref` onto anchor metadata. Spreads artifact metadata **first**, so server-derived fields win — a genuine defence, see §3.1. |
| Public source-provenance render surface | `src/components/verification/SourceProvenanceDisplay.tsx` | Shipped, with a triad already written — but the triad and the link render on **independent** conditions (§2.4, Hole 3). |
| Public `source_url` channel | `get_public_anchor` via `private.public_url_or_null` (0356) | Live. Strips query string and fragment. **No host allow-list** (verified; and documented as a known residual in 0394). |
| `profiles.public_id` | 12 chars, ambiguity-free alphabet, random, not derived from identity | Live. 30 prod profiles, all have one, 4 are `is_public_profile`. |
| Possession-token primitives | `services/worker/src/lib/recipient-identity.ts` | Written. `mintPossessionToken` / `verifyRecipientPossession` have **zero non-test callers** (verified). Correctly rejects `hash_equality` as identity proof. Has three exploitable gaps — §4.2. |
| Claim-authority trigger | `enforce_anchor_evidence_claim_authority` (0384) | Live. Protects exactly two keys: `metadata.verification_level` and `fingerprint_source`. |
| **CE provenance key authority (0394)** | `supabase/migrations/0394_sec_ce_provenance_key_authority.sql` | **Live. The brief and the first draft both missed this.** Sibling trigger guarding `registry_url`, `ce_envelope_sha256`, `ce_registry_url`, `ce_registry_ctid`. Its header documents the `source_url` gap as a *known, deliberately-scoped-out residual*. §3.1 follows its pattern. |
| `PROOF_AVAILABILITY` class + note | `services/worker/src/constants/proofAvailability.ts` | Live. The precedent for "a class never travels without its meaning." |

### 2.3 Schema exists, nothing writes to it

| Thing | Evidence |
|---|---|
| `connector_artifact.external_revision` **on the anchor** | Written to the artifact by Drive; never copied to the anchor (verified). 0 of 17 prod artifacts carry one. |
| `connector_artifact.credit_deduction_id` | Read in three places, in no update payload. 0 of 17 rows populated. |
| `legally_binding_attestations` (0314) | **0 prod rows** (verified). `anchor_id` and `public_verification_url` have no writer. `docusign_envelope_id` is read-only in all code and operator-typed. It is a notarization concept, not a document-provenance concept. **Wrong substrate; do not use it.** |
| `anchor_recipients.claimed_at` / `recipient_user_id` | **7 prod rows, 0 claimed** (verified). 6 of 7 are self-import markers (`recipient_email_hash = sha256('self-import:' || recipient_user_id)`). Zero email-based recipient links have ever been created in prod. |
| `app.recipient_pepper` GUC and `RECIPIENT_IDENTIFIER_PEPPER` worker secret | **Both unset** (verified: `pepper_set = false`). `recipient_identifier` is `''` for every anchor in prod, failing closed as 0356 designed. |
| Any signer data at all | `connector_artifact.metadata` keys across all 17 rows are exactly `account_id, content_type, envelope_id, integration_id, queue_scope, rule_event_id`. The connector touches no recipient / signer / email field. **Signer capture is new work against the DocuSign recipients API.** |
| `microsoft_365`, `manual_upload`, `batch_upload` sources | Enum values only, zero code. |
| Any URL | Neither producer records one. DocuSign's `baseUri` is resolved in `docusign-envelope-completed.ts` and then dropped. Drive never requests `webViewLink`. |

### 2.4 Five live holes that must close before anything is built on top

An earlier draft found two. Adversarial review found three more, and two of them are worse than the original pair.

#### Hole 1 — the DocuSign envelope ID is already published anonymously

`connector-artifact-drain.ts` falls back to `filename = "${row.source}:${row.external_ref}"` when the artifact carries no filename, and the DocuSign producer never sets one. The drain writes `credential_type: 'CONTRACT_POSTSIGNING'`, which is not academic, so 0385's filename CASE routes it through `public_free_text_or_null` — which has seven PII detector families and **no UUID detector**. All 17 of 17 connector-sourced prod anchors carry a `docusign:<uuid>` public filename. `PublicVerification.tsx` renders it as the record title and emits it as schema.org JSON-LD `name`, so it is search-engine indexable.

Two extensions the first draft missed:

- **The filename fallback is not the only door.** The drain reads `metadata.filename` / `metadata.external_filename` **first**. The moment the Drive producer starts running, every customer file name becomes a public record title with no caveat.
- **`external_ref` has no format validation at any layer.** `connector_artifact.external_ref` is `text NOT NULL` with no CHECK; `enqueue_connector_artifact` defers to CHECK constraints that do not exist for this column. Because the org holds its own Connect HMAC key, `envelopeId` is **org-controlled free text**, not a DocuSign-guaranteed UUID. An org can post a correctly-signed Connect event with `envelopeId = "Certified authentic by the U.S. Department of State"` and title a Bitcoin-anchored public record with it.
- **A second channel:** `services/worker/src/api/proof-packet.ts` emits `source_event.filename` and `source_event.external_file_id` (the envelope id) plus the raw `payload` blob. Org-authenticated, not anonymous — but the relabel/backfill decision must cover it.

**The riskiest half of ask (A) is already shipped, accidentally, with no caveat, no gate, and no decision.** Bug Tracker row required under §0 rule 5.

#### Hole 2 — the public source link is spoofable (a *known* residual, not a discovery)

`get_public_anchor` projects `source_url` from `anchors.metadata`, which is org-writable: `anchors_insert_own` constrains `user_id`, `status`, `org_id` and says nothing about `metadata`, and `bulk_create_anchors` copies the blob verbatim. `sanitizeSourceUrl` (`src/lib/sourceProvenance.ts`) enforces scheme, rejects embedded credentials, drops a 12-entry sensitive-param set, and clears the fragment — but has **no host allow-list**, and **accepts `http:` as well as `https:`** (verified).

**Correction to the first draft:** this is not newly discovered. Migration **0394's header documents it explicitly**, including a reproduction against a local stack, and states that `public_url_or_null` has no domain allow-list while `sanitizeSourceUrl()` "checks scheme only." 0394 deliberately scoped `source_url` out. Presenting it as a discovery would cause a reprioritisation on a false premise.

Two further keys are projected to anon from the same org-writable blob and are guarded by **neither** 0384 nor 0394: **`fetched_at`** and **`source_provider`** (verified in 0356's projection). Those are precisely the two values the source-link triad asserts as server facts.

#### Hole 3 — the recipient identifier has a second anonymous door, and the caveat has none

Two independent defects on the same surfaces:

**(a) `recipient_identifier` escapes the fail-closed apparatus.** `router.ts` mounts `router.use('/anchor', anchorAnonAllow, anchorEvidenceRouter)` (verified), and `anchor-evidence.ts` emits `recipient_identifier: anchor.recipient_hash` **unconditionally** — no pepper read, no fail-closed branch, no `suppressDirectory` check, no academic-record suppression. It selects `recipient_hash` straight from the `anchors` table. The entire 0356 → 0383 → 0390 fail-closed apparatus **is not in this code path.**

Today the route is inert **only by accident**: `anchors.recipient_hash` does not exist in prod, so the PostgREST select errors and the handler 404s every anchor. That is accidental containment, not a control — and Phase 3's entire purpose is to create a recipient-hash store. **Bug Tracker row: the evidence endpoint 404s all traffic in prod today.**

**(b) The link and the caveat render on independent conditions.** In `SourceProvenanceDisplay.tsx`, the measured/asserted/not-asserted triad is gated on `verificationLevel` parsing non-null, while the source-URL `<a href>` renders on an independent `safeUrl` condition. All 17 connector anchors have `verification_level = NULL` and `fingerprint_source = NULL`, and the enum has **no connector value**. So §3.5's "reuse `source_url`" instruction routes a connector link straight into a component that will render a clickable external link with **zero triad rows**. That is the false-tamper flow §1.2 exists to prevent, manufactured by the design's own reuse instruction.

#### Hole 4 — `get_public_anchor` never honours `directory_info_opt_out`

Verified: zero occurrences of that column in 0356, 0383, or 0385; the only migration mentioning it is the baseline. The REST path honours it (`verify.ts` computes `suppressDirectory` and gates `issuer_name`, `recipient_identifier`, `issued_date`, `expiry_date`), but the SQL projection that the browser verify page **and its JSON-LD** are built from ignores it entirely.

A learner who exercises `/api/v1/directory-opt-out` gets the REST response scrubbed and the browser page unchanged — still rendering issuer and dates, still emitting JSON-LD built explicitly "for AI search discoverability." **They have been told they opted out; they have not.** §5.4 cannot claim immediate revocability on a function with a demonstrated history of ignoring the only suppression flag that exists.

#### Hole 5 — the pepper is an oracle waiting for a key, and the possession token is replayable

Three compounding defects in `recipient-identity.ts` and its callers (all verified):

1. **No domain separation.** `hashRecipientEmail(email, pepper)` = `HMAC(pepper, lower(trim(email)))`. `mintPossessionToken(emailHash, nonce, pepper)` = `HMAC(pepper, "${emailHash}:${nonce}")`. **Same key, no purpose tag.** Any endpoint that returns `HMAC(pepper, caller_string)` is therefore simultaneously an identity-enumeration oracle *and* a possession-token minting oracle.
2. **Such an endpoint already exists.** `lib/credential-source-import.ts` reads `recipientIdentifier` from JSON fetched at a **caller-supplied URL**, passes it through `hashRecipientIdentifier` → `hashRecipientEmail`, and returns the result in the preview response as `credential_recipient_hash` (verified). The route is `requireAuth` only. Client-side truncation is display-only; the HTTP body carries the full 64 hex.
3. **The token is a permanent skeleton key.** `verifyRecipientPossession` recomputes the token from a caller-supplied `(emailHash, nonce)` pair with **no nonce ledger, no TTL, no single-use consumption, and no anchor scoping.**

Chained, post-pepper-provisioning: an attacker reads a victim's `recipient_identifier` H off the public verify page, hosts `{"recipientIdentifier":"<H>:abc123"}`, calls the import preview, and receives a value byte-identical to `mintPossessionToken(H, 'abc123', pepper)`. Presenting `{kind:'signed_challenge', value:<that>, nonce:'abc123'}` yields `verified: true`.

**This is inert today only because the pepper is unset. Phase 3's prerequisite is what arms it.** All three must be fixed *before* the pepper is provisioned, not after.

---

## 3. Design: source linking

### 3.1 The governing rule, and the correct mechanism

Generalized from #2246's header: **an org-writable field may only ever be allowed to make that org's own record look weaker.** #2246's caveat is safe on an org-writable channel precisely because a spoofer can only attach a *weakening* statement to their own record. A source link is *strengthening* and *vendor-naming*. The polarity flips, so the same channel becomes a forgery channel.

**Therefore: every provenance field a viewer could read as strengthening must be written by `service_role` and by nothing else.**

**Protected key set** — the first draft's list plus the two keys review caught:

`source_url`, `connector_source`, `connector_artifact_id`, `external_ref`, `external_revision`, **`fetched_at`**, **`source_provider`**, and any new revision-pin key.

**Mechanism — follow 0394, do not extend 0384.** 0394's header forbids the shape the first draft proposed, for a reason that must not be re-derived the hard way:

> *"WHY A SEPARATE FUNCTION + TRIGGER (not CREATE OR REPLACE of 0384's): get_public_anchor's history shows wholesale redefinition is this schema's dominant failure mode (0376 silently reverted 0356+0362)."*

and

> *"0385 must stay the latest redefiner for the PII contract [test]."*

So: ship a **sibling** `BEFORE INSERT OR UPDATE` trigger in 0394's shape — **strip on INSERT, revert to OLD on UPDATE** (strictly stronger than 0384's "strip/refuse": it undoes deletion and tamper of a service-stamped value, and stops a client splitting a paired key set). Host validation lives in the `service_role` writer that constructs the URL, **not** in a `CREATE OR REPLACE` of `get_public_anchor`. If a projection-side allow-list is still wanted as defence in depth, the change must state explicitly how the 0385-latest-redefiner contract test is preserved.

**Extend the same rule to `anchor_recipients`.** This is the table tier-3 attribution reads from, and it has **two authenticated INSERT policies** (`Org admins can insert recipients`, `Individuals can insert recipients for own anchors`) whose `WITH CHECK` validates only that the anchor belongs to the caller's org — nothing about *which* user id is bound or whether `claimed_at` may be set. There is no UPDATE policy, but INSERT suffices: the unique constraint is `(anchor_id, recipient_email_hash)`, so an attacker can always add another row with a fresh hash.

Left as-is, the single most identity-laden claim in the design would be sourced from a row the publishing organization authored. **Required:** a 0394-shaped trigger on `anchor_recipients` that, for any caller where `get_caller_role() <> 'service_role'`, forces `recipient_user_id` and `claimed_at` to NULL on INSERT and reverts them to OLD on UPDATE. Plus a ratchet test asserting a non-`service_role` INSERT cannot land a non-NULL value in either column.

**One existing defence worth crediting rather than changing:** `connector-artifact-drain.ts` spreads artifact metadata **first**, so server-derived `connector_source` / `connector_artifact_id` / `external_ref` always win; and `connector_artifact` is `service_role`-write with org SELECT only (0343). The laundering path from an org-written artifact row into a `service_role`-authored anchor is closed.

### 3.2 Arkova redirect, not a raw external ID

Store identifiers, never URLs. Resolve the URL server-side at request time from the `org_integrations` row that actually performed the fetch. (`org_integrations` is RLS-forced with a SELECT-only policy for org admins and no client write path, so `base_uri` is not attacker-writable.)

**Route:** `GET /api/v1/anchors/:publicId/source`

Why a redirect rather than publishing the vendor URL:

1. **Server-attested target.** The destination derives from the integration row, not from client-supplied metadata — the only way to satisfy §3.1.
2. **The caveat travels with the link.** #2246's honesty text renders on the same surface as the button — a hard requirement (see the render-blocking rule below).
3. **We control the gate.** Per §0, DocuSign cannot gate this for us.
4. **Immune to the query-string strip.** `get_public_anchor` applies `regexp_replace(..., '\?.*$', '')`, destroying any vendor URL that carries identity in a query string. Our path-based route is unaffected.
5. **Vendor URL shapes change.** Store `account_id` + `envelope_id`, or `file_id` + `revision_id`, and construct at request time.
6. **It is auditable** — which we cannot do if the raw URL is published.

#### Acceptance criteria (not implementation detail — these are where a public-id-keyed route leaks)

- **Authorization is a relationship predicate, never bare authentication.** Org membership on `anchors.org_id`, or a `service_role`-minted recipient binding (`recipient_user_id = auth.uid()` with `claimed_at IS NOT NULL`). `requireAuth` alone is the shape of most routes in this codebase and would let **any org with any API key** walk the public IDs published on every verify page and harvest every other org's DocuSign account/envelope ids.
- **Uniform failure.** `not-found`, `not-connector-sourced`, and `not-authorized` return an **identical 404** with no timing or body difference. A 403/404 split is a free oracle for whether a given law firm has connector-sourced documents at all, and how many.
- **Validate the target immediately before redirecting**, against a compiled per-source host allow-list, **`https:` only**. Otherwise a stale `base_uri` or the unvalidated `external_ref` of Hole 1 turns Arkova's own authenticated domain into the open-redirect hop in a phishing chain aimed at the bound recipient — who, post-Phase-4, is a person in a *different* organization who trusts the link because Arkova sent it.
- **Own rate-limit bucket, and an audit row per resolution.** §3.2 claims auditability as a benefit; that makes it a requirement, not a side effect.

#### What anonymous callers see

The class, never the instance — and **only for `SECURED` records** (see below):

> Source: DocuSign envelope. Version pinned at retrieval — *[pin-class-specific string, §3.3]*.
> Parties to this agreement can open the original from their own DocuSign account.
> *[#2246 caveat, rendered from `FINGERPRINT_REDERIVABILITY_NOTE`]*
> *[record's `proof_availability` class + note, §1.1b]*

No envelope ID. No link. No external identifier of any kind.

**Four constraints on that block:**

- **The caveat is a render-blocking precondition of the link.** No resolvable triad ⇒ no `<a>` tag, enforced **inside the component** by a test — not by a same-surface convention. This closes Hole 3(b). Separately, decide explicitly whether `connector-sourced` joins the existing evidence vocabulary as a third `fingerprint_source` value and/or a `verification_level` tier (additive per §1.8), rather than starting a **third** parallel taxonomy with no stated precedence when the three disagree on one page.
- **`SECURED` only.** `get_public_anchor` admits `PENDING` and `SUBMITTED` (verified), and the drain inserts connector anchors as `PENDING`. The projection already CASE-gates `anchor_timestamp`, `bitcoin_block`, `network_receipt_id`, and `secured_at` on non-`PENDING`; the source statement and any attribution must join them. The pre-`SECURED` window is exactly where a forged claim is cheapest to publish and — via `deleted_at` soft-delete — easiest to erase without a trace.
- **Timestamp precision is reduced to a date, or the timestamp moves to the authenticated surface entirely.** Per-record retrieval times, joined against always-published `issuer_public_id`, `credential_type`, and `anchor_timestamp`, reconstruct an organization's contract-execution timeline at full resolution. §5.1 correctly reasons that contractual-relationship data can be special-category **by inference** in the HakiChain legal-aid context; that reasoning applies to timing and volume, not only to names. "No personal data is published" does not survive an inference analysis.
- **Source-class disclosure is an org-level setting defaulting to OFF.** Naming the vendor partitions an org's public anchors into "executed contract" vs "self-uploaded document" and discloses its vendor relationships. By §1.1c's own standard — the link is not evidence — the vendor's name is not evidence either, and has no verification justification for being anonymous-visible without an affirmative org decision.

#### Vendor targets for authorized viewers

- **DocuSign:** the web-app URL form. Flag in the code comment that this form appears in community and third-party institutional IT pages, **not** in DocuSign's developer reference. Treat as observed behavior, not a vendor contract. It resolves only for viewers holding a DocuSign account who are sender or recipient; everyone else gets a clean failure at the vendor, which is the right outcome.
- **Drive:** `webViewLink`, which requires adding it to the `files.get` field set. Current version only.

**On the founder's phrasing.** §0 falsified "only the persons who signed can view it." Do not quietly restore it as an approximation. The authorization set is: **members of the securing organisation, plus the bound recipient — and behind that, whatever DocuSign admits, which is senders and all recipients, not only signers.** An ORG_ADMIN who was never a party gets the link. If "signatories only" is genuinely wanted, it is its own decision with its own authorization rule.

### 3.3 Revision pinning, and where it is honest

This is the heart of ask (A). A bare Drive link resolves to *current* content, which does not merely fail to support the version-control argument — it actively undermines it: the viewer sees today's document next to a fingerprint of a different day's bytes and concludes we are wrong.

| Source | Handle today | What the pin actually is | Rot |
|---|---|---|---|
| **DocuSign** | `p_external_revision: null` (verified) | **The envelope record's terminal state.** `Completed` is terminal — DocuSign's support docs say a completed envelope "can no longer be corrected or voided" — so `envelope_id` + `completedDateTime` pins *the record*. **It does not pin the bytes** (see below). | Documents are purgeable: 14-day purge queue; retention policies; demo accounts at 30 days; ~2 years post account closure. |
| **Drive, binary files** | `headRevisionId`, captured (verified) | A true vendor revision pin, addressable via `revisions.get`. Bonus: Drive exposes `sha256Checksum` for these, so we can cross-check our own hash for free. | Non-`keepForever` revisions purge at ~30 days, or sooner past 100 revisions. "You can only download blob file content revisions marked as Keep Forever." |
| **Drive, Google Docs/Sheets/Slides** | Synthesized `mtime:<modifiedTime>` (verified in `drive-changes-processor.test.ts`) | **Not a vendor revision handle.** Google exposes no `headRevisionId` for Workspace-native files, so the code synthesizes a modification-time key. Correct as a dedupe discriminator, and a real data-loss fix — but **not re-fetchable**. You cannot ask Drive for "the version at mtime X." | Revisions "may be merged together" and `revisions.list` "might be incomplete" for frequently edited Docs. |
| **M365** | Enum value only, no code | n/a | n/a |

**The DocuSign pin does not cover the bytes.** §7.2 records that repeat-download byte stability is undocumented, and BUG-2026-08-13-010 observed four hashes from four fetches of one unchanged envelope. The response is a *rendering*: `certificate`, `language` (13 options), `watermark`, `show_changes`, and `encrypt` all change the returned bytes, and `documents_by_userid` / `recipient_id` / `shared_user_id` change which documents come back. **Until the repeat-download test in §6 Phase 1 resolves, the DocuSign public statement carries no "version" language at all** — it is "retrieved at T from envelope E, which is in a terminal state."

**Two copy strings, selected server-side by pin class.** A single string violates the rule this section sets:

- *Vendor revision handle:* "pinned to a specific stored revision."
- *Synthesized mtime key:* "pinned to a point in time — the source system does not retain retrievable prior versions." **Do not use the word "version" as a handle.**

Encode the pin class in the data model in Phase 1 so the copy cannot pick the wrong one. Google Docs is the founder's own stated common case for contracts; publishing `mtime:...` as if it were a version handle is a claim we cannot back in a dispute.

**Do not set Drive `keepForever` silently.** Capped at 200 per file, and it "counts towards your storage limit" — the *customer's* storage. Explicit per-integration opt-in with the cost stated, or not at all.

**Adding a DocuSign revision handle** means changing `p_external_revision` from null to a server-derived value — `completedDateTime` or `statusChangedDateTime`. Two cautions:

- **Never use the signer object's `signedDateTime`.** DocuSign's own spec documents it as "Reserved for Docusign." It is a live trap for anyone reading the signer object.
- **This changes the 0343 dedupe key.** `COALESCE(external_revision,'')` moves from `''` to a timestamp string, so a redelivery with a differently-formatted timestamp would insert a second artifact. There is a real safety net — the drain performs an org-scoped, fail-closed envelope-id existence check before insert, so a duplicate artifact would not produce a duplicate anchor — but it needs a targeted test and must not be assumed.

### 3.4 Copy `external_revision` onto the anchor

The drain copies `external_ref` but not `external_revision` (verified; 0 of 17 artifacts carry one anyway). Without it the anchor literally cannot state which version it pinned — precisely the founder's argument. This is the cheapest, highest-value single item in the spec.

**But "internal-only first" is not enforceable by intent.** 0385's live projection already allow-lists `source_id`, `source_payload_content_type`, `source_payload_byte_length`, `source_url`, `source_provider`, `fetched_at` / `source_fetched_at`, and `registry_url` — and the drain spreads artifact metadata onto the anchor. **Whether a new connector field is public is decided by key naming alone.** Current safety is luck: 0 of 17 connector anchors populate any allow-listed `source_*` key.

Write the revision under `connector_external_revision`, **never** `source_id`; record retrieval time under a name that is not `fetched_at`. And **invert the default with a CI check**: assert that the set of metadata keys written by the connector paths (both of them — drain *and* rule-action-dispatcher) has an **empty intersection** with the `get_public_anchor` allow-list. A connector-written key must be proven non-public, not assumed non-public.

### 3.5 Reuse `source_url`, do not invent a second key — with a precondition

`ctdl-importer.ts` explicitly warns against inventing a second source-URL key, and `source_url` is already allow-listed through `private.public_url_or_null`. Whatever we publish goes through the existing key.

**Precondition:** per §3.1 that key must become `service_role`-write-only for connector-sourced anchors, and per Hole 3(b) the render component must block the link when no triad resolves. Reusing the key *before* both land is the false-tamper flow, not a shortcut.

---

## 4. Design: signer identity

### 4.1 The central tension, stated head on

**Publishing a stable signer identifier on the anonymous anchor projection reintroduces exactly the attack migration 0356 was written to prevent — and the specific identifier the founder asked for makes it worse, not better.**

The history: 0311 published a bare `sha256(recipient)`; anyone could compute `sha256(known_email)` offline and enumerate which anchored credentials belong to a person. 0356 replaced it with a keyed HMAC over `app.recipient_pepper`, failing closed to `''` when unset. Then **0376 branched from 0355 and silently clobbered it back to bare sha256 — live and enumerable for four days** — before 0383 restored it, 0385 rebased it on prod, and 0390 added the fail-closed predicate. **This control has already been regressed once by an honest mistake.**

Now compare. The bare sha256 required an offline dictionary attack: guess an email, hash it, compare. `profiles.public_id` requires **one HTTP GET**. It is a stable, resolvable handle — feed it to `get_public_member_profile` and you get display name, avatar, bio, social links, and organization memberships. Publishing it on every anchor turns each verification page into a signer directory and makes cross-anchor clustering trivially de-anonymizing.

A vendor precedent worth weighing: DocuSign's `recipientIdGuid` is documented as per-envelope — *"If the same recipient is associated with multiple envelopes, they will have a different GUID for each one."* DocuSign has already concluded that a stable cross-document person handle is the wrong thing to expose. There is no stable API-exposed DocuSign person identifier at all except `userId`, which exists only for DocuSign account holders.

> **Ruling: `profiles.public_id` never appears on the ANONYMOUS anchor projection.** Not gated, not opt-in, not behind a flag.
>
> **Scoping note (do not read this ruling as a description of the system).** `public_id` *is* already exposed on two org-authenticated surfaces: `anchor-evidence.ts` and `anchor-lifecycle.ts` both set `includeActorPublicId = Boolean(apiKey)` and emit `actor_public_id` on lifecycle entries. It is same-org scoped (cross-org keys 404), which is a reasonable carve-out — but "any holder of a same-org API key" is materially wider than "org member." **This is a known, scoped precedent that this design does not widen**, and it must appear in the DPIA rather than be assumed away.

One fact that reframes the whole question: **today Arkova publishes no recipient identifier at all.** The pepper is provisioned nowhere (verified), so `recipient_identifier` is `''` for every anchor in prod. This would not be extending an existing published identifier. It would be **the first person-identifier ever published on the anonymous verify page.**

### 4.2 Tier 1 — server-side keyed identity, never projected

**What.** At envelope completion, call the DocuSign recipients API, compute `HMAC_pepper(lower(btrim(signer_email)))`, write it to `anchor_recipients.recipient_email_hash`. Never store the raw email. Never project the value to anyone.

**Why this is the foundation.** It is the join key everything else needs, and the only form in which we can hold signer identity without publishing it.

#### On "confirm, don't enumerate"

The research was unambiguous and it does not say what one would hope. `get_public_anchor` takes only `p_public_id`; it accepts no candidate identity. A scan of every function definition in prod found it is the only function referencing `recipient_pepper`, and no function anywhere takes an email and returns its HMAC or a yes/no.

So the current design supports **neither** enumeration **nor** honest confirmation. A verifier who already knows Jane cannot check that this is Jane's document. **If the product goal is "a verifier who knows Jane can confirm," the current primitive does not deliver it and cannot be made to without deliberately building an oracle.**

A confirmation endpoint *is* an oracle. If built, the conditions are: authenticated **and relationship-scoped** (org member or bound recipient — holding a verification link is not enough); returns a boolean, never a hash; rate-limited far below §1.10's 1,000/min (propose 10/min/key on this route); every call written to an audit row.

Even at 10/min a determined caller tests **14,400 addresses per day** against one anchor. This is a relationship-scoped convenience, not a public verification primitive. **Recommendation: do not build it in the first release.**

#### "Authenticated" is not the privacy boundary

Self-serve signup is open, so *authenticated* is a near-zero-cost tier, not a relationship. Worse, `get_public_anchor` is granted to both `anon` and `authenticated`, takes only `p_public_id`, and contains **no caller-scoping branch at all** — there is no "anonymous branch" to pin. Creating one requires an `auth.uid()` / `get_caller_role()` test, and the natural implementation admits every self-registered account.

> **Rule:** any cross-anchor-stable identifier is emitted **only** to a member of the securing org or to the bound recipient — the same predicate §3.2 specifies for the source-link route. **Self-serve authentication is explicitly NOT a sufficient gate.** Written here so the next implementer does not re-derive the weaker version.

#### Residual risk of the HMAC itself — accepted, with reason

It is deterministic, so one recipient string yields one stable 64-hex value across every anchor. If that value were ever visible to an unauthorized caller, they could cluster anchors into "same unnamed person" classes and re-identify by context from `issuer_name`, `credential_type`, dates, and `filename`. That is pseudonymity, not anonymity, and it is why tier 1 keeps the value unprojected.

**Accepted risk:** per-anchor salting would remove the linkability, but it also breaks the matching the claim flow needs. Recorded as a genuine tradeoff, not a free win.

#### Prerequisites — all four gate the pepper, not the other way round

1. **Close every projection before feeding the channel.** Ship a migration pinning the anonymous `recipient_identifier` to `''` permanently, moving HMAC computation to relationship-scoped surfaces only. §1.8 permits a frozen field to narrow; a permanent empty string is a no-statement and therefore allowed. *Justify this as "close before feeding," not by row counts.* Measured: 0 of the 50,000 most recently created non-deleted anchors carry `metadata->>'recipient'`, and 0 of 17 connector anchors do. The flip is near-empty **today** — which is exactly why a reviewer under time pressure might drop the gate as theatre. Phase 3 is what populates it.
2. **A projection inventory, and one shared helper.** Enumerate **every** surface that can emit a recipient identifier: `get_public_anchor`, `/api/v1/verify/:publicId`, **`/api/v1/anchor/:publicId/evidence`** (Hole 3a), `/api/v1/anchor` lifecycle, CTDL, `/verify/batch`, oracle, MCP batch, **and the schema.org JSON-LD** (§4.4). Implement the fail-closed rule **once, in a single shared helper every surface calls**, rather than restating it per projection. Add a ratchet test to `scripts/ci/public-pii-projection-contract.json` that fails when a **new** anon-reachable surface emits the field. **Phase 3 is blocked until that test exists.**
3. **Fix Hole 5 before provisioning the pepper.** Domain-separate every pepper use (purpose-tagged messages — `arkova:recipient-email:v1|`, `arkova:possession:v1|` — or HKDF-derived per-purpose subkeys), with a test asserting the two functions cannot collide. **Never return a pepper-keyed digest to any caller**: drop `credential_recipient_hash` from the import preview response shape. Server-mint possession tokens into a **nonce table with single-use consumption, a short TTL, and binding to a specific `anchor_id`**. Standing rule: *any function keyed on the recipient pepper is an oracle if its output ever reaches a caller.*
4. **Move the pepper out of the GUC.** 0356's provisioning note prescribes `ALTER DATABASE postgres SET app.recipient_pepper = '<secret>'`. A database-level custom GUC is stored in plaintext in `pg_db_role_setting` and is readable by anything that can reach the catalog or issue `SHOW` — the Studio SQL editor, a read-only analytics user, a pooler session, a support connection, a logical dump. It is also a *session* variable, so `current_setting` reads the session value even inside a SECURITY DEFINER function. Today it protects a credential recipient's email; Phase 3 makes it the sole cryptographic protection for **contract-signer identity**. Move it to a private-schema table or Vault behind a SECURITY DEFINER accessor with `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated` (0385 is the in-repo pattern), add a test that fails if the value is reachable from `anon` or `authenticated`, and **give the identifier a key-version prefix** so rotation is a designed operation rather than a data-loss event.

**Also:** two incompatible hash algorithms currently write the same column. The browser's `hashEmail` (`src/lib/fileHasher.ts`) is bare sha256 and writes `recipient_email_hash` directly from `IssueCredentialForm.tsx`; the worker's `hashRecipientEmail` is keyed HMAC. Same email, different digests, and a browser can never hold the pepper under §1.4. Matching between the two is broken by construction. Recipient-hash computation must move server-side, and the fate of the 7 existing rows (1 browser-written bare digest, 6 self-import markers) needs a decision.

**And:** `anchors.recipient_email` already exists as a column in prod (present in `information_schema`, `count = 0` of 3.55M rows). A latent, unpopulated raw-PII column with no writer is exactly what a future well-meaning connector PR fills in, because it needs no migration and nothing forbids it. **Phase 3 should DROP it** (or add a CHECK forcing null) in the same migration that establishes the hashed store, so "never store the raw email" is enforced by the schema rather than asserted in prose. State the disposition of the `metadata->>'recipient'` channel too, since `get_public_anchor` currently reads it.

### 4.3 Tier 2 — authenticated self-view

**What.** The signer creates or logs into an Arkova account, proves control of the signing email, and sees "You signed this" on their own dashboard. **Nothing public changes.**

**Why this is the best real win.** It is exactly what "closes loops" means for the person who signed, it publishes nothing, and the correct primitive is already written — `mintPossessionToken` / `verifyRecipientPossession`, which explicitly reject `hash_equality` on the grounds that "knowing the hash is not possession," with **zero non-test callers**. This is the ship-the-UI-not-just-the-hook failure mode sitting there fully built.

**Flow.** Email round trip to the address the source system recorded; **server-minted** nonce persisted in a nonce ledger with TTL and single-use consumption; signed challenge; constant-time compare. On success set `anchor_recipients.recipient_user_id` and `claimed_at` **via a `service_role` path only** (§3.1's trigger makes any other writer impossible).

#### The claim must be per-document — `link_anchors_to_user` as written is the defect

The baseline function is:

```sql
UPDATE anchor_recipients
   SET recipient_user_id = p_user_id, claimed_at = now()
 WHERE recipient_email_hash = p_email_hash
   AND recipient_user_id IS NULL
```

Matched on the **email hash alone** — no `anchor_id`, no `org_id`. Combined with the org-admin INSERT policy and the fact that `POST /api/recipients` computes the HMAC server-side from a supplied email (so the org never needs the pepper), a single possession proof would bind a person to **every row anyone ever tagged with their address**.

Concretely: a hostile or merely careless org adds `victim@example.com` as a recipient on 500 of its own anchors — an ordinary-looking bulk operation. Months later the victim legitimately signs one contract through a **different** org and completes the possession round-trip for that one document. The function binds them to all 501. Their dashboard asserts they are a recipient of 500 documents they have never seen; the Phase-2 authenticated link grants them a forward link into a stranger's DocuSign envelopes; and Phase 5 offers to publish their name against all of them. **The victim's own possession proof is the attack's authorization step.**

**Required:** `mintPossessionToken` carries the `anchor_id` in the signed challenge, and the claim binds exactly the `(anchor_id, recipient_email_hash)` pair the token was minted for. Phase 4 **replaces** the bulk hash-match semantics; it does not revive them. Test: a token minted for anchor A cannot claim anchor B for the same email.

**Surface.** `get_my_credentials()` is already `auth.uid()`-scoped and is the natural carrier. The authenticated source link becomes available to the bound recipient at this point — the closest we can honestly get to the founder's phrasing, with §3.2's caveat about who else is in that set.

### 4.4 Tier 3 — opt-in, per-document, revocable public attribution

Only after tier 2, only the signer, only for one named anchor, revocable at any time.

#### Eligibility is a filter, not a caveat

DocuSign recipient types include carbon-copy, certified delivery, agent, editor, intermediary, in-person-signer host, and witness — **none of whom signed.** Publish attribution **only** for `recipientType = signer` with status `completed` and a recorded signature event. Anything else is **ineligible, not merely caveated.** Record whether `clientUserId` was present; **embedded-signed recipients are ineligible for attribution, or carry a distinct and weaker label**, because for those the securing org was itself the authenticator (§1.1a).

#### What gets published

**Not the profile public ID.** The signer's chosen display name, plus a **per-anchor opaque handle** generated per `(anchor, profile)` pair — following DocuSign's `recipientIdGuid` precedent so the handle creates no cross-document linkage.

> **Correction to an earlier draft's rationale, which was wrong in a way worth recording.** The draft argued a name is safe because "a name is ambiguous, which is a privacy feature." That does not survive §4.2's own threat model: a name is strictly *more* identifying than an opaque digest under contextual re-identification, and publishing it beside a per-anchor handle **nullifies the handle** — the handle exists to prevent cross-document linkage, and the name is itself a cross-document linkage key. An investigator can join on display name plus `issuer_name` and reconstruct a person's contract history across organisations, which is exactly what §4.2 refuses to allow for a keyed hash.
>
> **Decision required (§8.1 item 3).** Either publish the **per-anchor opaque handle alone**, letting the org-side authenticated surface carry the name — *recommended* — or publish the name and **record in writing that this accepts cross-document linkage**, putting it to counsel alongside the consent question rather than presenting it as the privacy-preserving option.

If the name is published at all, three integrity constraints apply:

- **Routed through `private.public_free_text_or_null`** with a **tight `p_max_length` appropriate to a name** (not the 240 default), and a **dropped value results in OMISSION of the key, never a fallback**. A fallback that substitutes the org display name produces a wrong claim about who signed — the exact failure mode 0385's `issuer_name` comment exists to avoid.
- **Frozen at consent time into an immutable consent-row column, written by `service_role`, never a live mirror of `profiles.display_name`.** Otherwise an attacker passes a claims review with a benign name and flips it afterwards, and nothing re-checks. `public_free_text_or_null` gates high-confidence PII patterns and truncates; it gates **nothing** for impersonation, homoglyphs, embedded URLs, or third-party names ("Jane Smith, General Counsel, BigCorp"; "verify-arkova.com").
- **Re-gated on every read**, not sanitized once at write.

If the signer additionally has `is_public_profile = true` (4 of 30 prod profiles) and wants their profile linked, that is a **second, separate consent** — not a side effect of the first.

#### Contract rules that are non-negotiable

Per §1.8 and §6, the field is **omitted when absent, never null**, and absence means *"no statement,"* never *"did not sign."* Removing one person's attribution must not implicitly make a negative claim about them; the API docs must say so.

**Four projections move together — the first draft listed three.** The SQL `get_public_anchor`; the REST `/api/v1/verify/:publicId`; CTDL; **and the schema.org JSON-LD emitted by `CredentialJsonLd` in `PublicVerification.tsx`** — plus `scripts/ci/public-pii-projection-contract.json` and its contract test. The JSON-LD is a machine-readable projection that publishes `name: data.filename` and, for SECURED records, `additionalProperty { name: 'verificationStatus', value: 'verified' }` — an unqualified machine claim with **no slot for a §1.5 triad**, in the one channel where caveats cannot travel and retraction is impossible.

> **Ruling: no person-identifying field ever enters the JSON-LD.** The format cannot carry the triad. Separately — and independent of this feature — scope the existing `verificationStatus: 'verified'` property so it states *what* was verified, or drop it.

**`DOES_NOT_ASSERT_LABELS` is in the move-together set.** `src/lib/copy.ts` currently renders, unconditionally on every verify page (verified): *"The identity of the signer or uploader, the legal validity of the underlying document, or any jurisdiction."* Ship tier 3 without touching it and the page displays "Signed by Jane Doe" beside "Not Asserted: The identity of the signer or uploader." In a dispute the affirmative name is what gets screenshotted; the disclaimer reads as boilerplate we did not mean. Narrow it — most likely to *"the legal identity of the signer"* — plus an affirmative line stating that a named signer proved control of an address the source system listed, and nothing more. **Ship the disclaimer edit in the same change as the field.**

**`verifyCache` (`services/worker/src/utils/verifyCache.ts`) bumps `KEY_PREFIX`** if the response shape changes, or pre-deploy cached records serve no statement for their whole TTL.

**Never put a signer name into `filename`, `metadata.title`, or any allow-listed free-text key.** 0385 gates values but ships no name detector, deliberately: PR #1815 measured one and it 404'd 28 of 32 real institution names. Names are excluded **structurally**, never filtered.

### 4.5 Optional tier 4 — signer-issued proof

If a verifier genuinely must confirm a named person and tiers 1–3 do not suffice, the honest primitive is a **signed statement**: the signer generates a statement binding their profile public ID to the anchor public ID and hands it to the verifier, who checks a signature. Nobody else learns anything, no public field exists, no oracle exists. **Consent-based rather than oracle-based** — the only construction that gives a third party a confirmable claim without also giving an attacker a probe.

---

## 5. Privacy, consent, and lawful basis

### 5.1 Lawful basis

Kenya filings currently declare, for the Kenya DPA 2019: credential issuance under s.30(1)(a) performance of contract; **verification of credentials by authorized third parties under s.30(1)(f) legitimate interests**; fraud prevention under s.30(1)(c) and (f); marketing under consent with separate opt-in. The DPIA carries a completed s.30(1)(f) balancing test whose stated interest is *"Fraud prevention; truthful labor market; protection of institutional reputation."*

**That test does not cover signer-identity publication and cannot be stretched to.** It was scoped to a person's own claimed credential being checkable by a party they gave the link to. *"Person X executed contract Y with counterparty Z"* is a different data class — contractual relationship, commercial dealings, and in the HakiChain legal-aid context potentially special-category by inference. Different balancing, different outcome. A new balancing test is a **counsel** deliverable.

**Recommendation: tier 3's basis is consent, not legitimate interests**, because it is a publication about an identified natural person who is not our customer.

**The DPIA and filing gap is not prospective — it is already open.** An earlier draft framed connector personal-data ingestion as beginning at Phase 3. Prod contradicts that: `organization_rule_events` holds 21 rows (all `vendor='docusign'`), 4 with a populated **raw `sender_email`**, and `services/worker/src/api/proof-packet.ts` emits `source_event.sender_email` verbatim alongside `external_file_id`, `filename`, and the raw `payload` blob. Sender is not signer — but the claim that the connector pipeline holds no third-party personal data is wrong, and it is the claim §5's sequencing argument rested on.

**Consequence:** the DPIA delta and filing-impact check move into **Phase 0 as blocking**, not parallel. The existing `sender_email` retention and its proof-packet emission join Holes 1–5 in the Phase 0 remediation table.

Note too that **inference-based disclosure is in scope**: §3.2 reduces anonymous timestamp precision, and the DPIA delta and counsel question set must cover **timing and volume inference against the securing organisation and its counterparties**, not only named attribution of signers.

### 5.2 Whose consent, and why phase ordering is a legal constraint

Today sensitive data rides on a **contract exception plus an upstream-consent warranty from the institution**, not on a consent record Arkova holds. The DPIA is explicit: Arkova relies on the contract exception because the institution is the direct contractual party and has obtained upstream consent; the mitigation is a DPA warranty; residual risk is Medium. DPIA risk **R8** is *"institutional misuse: a Kenyan university uploads a student's record without consent."*

Under that model, publishing a signer's identity would rest on the securing organization's warranty about a third party. For HakiChain that is R8 with the blast radius moved from a private record to a public page — and §1.1a sharpens it further, because the "independent" source system is that same organization's own account.

So tier-3 consent must be **Arkova-held, from the signer directly**, which is only possible after tier 2 gives them an account and a proven possession event. **Tier 3 is not shippable before tier 2 for legal reasons as much as technical ones.** A useful constraint, not an inconvenience.

### 5.3 Consent infrastructure is greenfield

A grep for "consent" across the entire migration set returns exactly one hit: `student_consent_obtained boolean DEFAULT false NOT NULL` in the baseline, an unrelated column. No consent table, no per-document grant, no withdrawal ledger, no consent audit trail. `data_subject_requests` exists but is the GDPR request audit log (1 prod row) and is explicitly retained, never scrubbed.

If consent is the basis it must be explicit, per-document, granular, and revocable. All four are new build.

### 5.4 The hard problem: what is actually revocable

Three layers, three different answers.

**Layer 1 — on-chain: what is committed is a 32-byte digest, or for batches a Merkle root.** No name, no email, no envelope ID, no profile ID, no display name reaches the chain.

> **Deliberately not stated here:** whether a hash of personal data is *itself* personal data (pseudonymised rather than anonymised) is a **contested legal question**, not an engineering one — and it would be the load-bearing premise of any erasure story we hand a data subject. An earlier draft declared it settled ("there is no personal data on the chain to revoke"). Repeating that to a Kenyan data subject or to ODPC would be a formal representation engineering has no authority to make. **Routed to counsel** as an open question (§8.2), alongside §5.1's balancing test — consistent with this spec's own rule that counsel owns the basis.

**Layer 2 — the off-chain public projection: revocable, with two named mechanisms that must actually fire.** `get_public_anchor` filters `deleted_at IS NULL`, so a soft-delete removes a record from the anonymous projection. Tier-3 attribution is a per-record optional field, so omitting it removes it from the next response. **But:**

- **Invalidation is event-driven, not state-driven.** `verifyCache.ts`'s own header records the failure mode: `invalidateVerificationCache` *"does not help: nothing re-fires for an ALREADY revoked/expired anchor."* Its only callers are `revocation.ts`, `check-confirmations.ts`, and `directory-opt-out.ts`. **A consent withdrawal fires none of them.** So Phase 5 must call `invalidateVerificationCache` on **both grant and revoke**, in the same worker path that writes the consent row (`directory-opt-out.ts` is the existing "user withdraws, invalidate" precedent), and the revocation acceptance test must assert against a **deliberately warmed cache**, not just the SQL function. The same applies to Phase 0a's relabel, which is also a removal of a published identifier that nothing currently invalidates.
- **Hole 4 must close first.** `get_public_anchor` does not honour `directory_info_opt_out` at all. §5.4 cannot claim immediate revocability until suppression-flag parity across `get_public_anchor`, `/api/v1/verify/:publicId`, and the CTDL serializer is enforced **by test**, not by intent.

**The honest statement is therefore:** *"removed from the projection immediately, and from the cached API path within TTL, provided the invalidation fires"* — with the invalidation named as a required implementation step.

**Layer 3 — genuinely not revocable, said plainly.**

- **AI-crawler and LLM-training ingestion — a first-class irreversibility, not a generic "third-party copies" footnote.** `PublicVerification.tsx` emits JSON-LD explicitly labelled for AI search discoverability. The page is *purpose-built* for machine ingestion; crawlers that took the attributed version re-fetch on no schedule the user or Arkova controls.
- **Ordinary third-party copies.** Anything fetched, cached, screenshotted, or indexed. Not hypothetical: 17 prod anchors emit `docusign:<envelopeId>` as JSON-LD `name` today.
- **The field in the frozen API.** §1.8 makes a published field permanent for 12 months absent a v2. Revocation must therefore be modelled as **per-record omission of an optional field**, never as a schema change.
- **The internal binding, if retained.** Open decision (§8.1 item 7). Recommendation: revoking unpublishes immediately, retains the internal `anchor_recipients` binding for audit, and full deletion routes through `data_subject_requests`.

**One caution on erasure.** The right-to-erasure path was broken in prod until 0403 (verified 2026-08-10): `anonymize_user_data` referenced `verification_events.user_id` and `.details`, columns that never existed, so SQLSTATE 42703 aborted the entire anonymization transaction. Every account-deletion erasure failed — no PII scrubbed, profile never soft-deleted — and the prior test coverage mocked the RPC. **Any erasure claim attached to this feature needs a real, non-mocked test against the actual columns.**

### 5.5 Filing and register obligations

- **Kenya ODPC registration is not complete.** No registration number, no appointed DPO, no named Kenyan representative. Kenya DPA s.24 requires a DPO for a processor handling sensitive personal data. **Shipping a new personal-data publication surface into the HakiChain pilot ahead of ODPC registration is the highest-exposure item in this spec.**
- **Counsel owns the basis, not engineering.** Precedent: counsel owns transfer-basis changes even as removals, and two same-shape defects were deliberately held unfixed pending counsel's ruling.
- **The claims register needs a row**, with `capability_state` describing what is actually true, an owner, a review cadence, and a decision. A recorded decision either way is the pass; silence is the fail.
- Publishing signer identity changes at least three filed fields: nature of processing, categories of data subjects, recipients of data. The existing `sender_email` retention (§5.1) and the same-org `actor_public_id` exposure (§4.1) belong in the same update.
- **Do not author new jurisdiction-tied copy against `src/lib/copy.ts` at HEAD** — repo main and the served prod bundle currently diverge on exactly this class of string.

---

## 6. Implementation plan

Each phase is independently shippable and independently valuable. Tiers are my read of the §1.12 path detector, which fails closed to the highest tier.

### Phase 0 — close the holes (preconditions, not features)

| Item | Change | Tier |
|---|---|---|
| **0a. Stop publishing the envelope ID** | Make the neutral label **unconditional, not a fallback** — and do not let it fall through to `metadata.filename` / `metadata.external_filename`. Add a per-source **format constraint on `external_ref`** (DocuSign: UUID; Drive: file-id charset) at the producer Zod schema **and** as a table CHECK, routing non-conforming events to the DLQ. Add a projection-side guard so existing rows are relabelled. Cover `proof-packet.ts`'s `source_event` fields. Call `invalidateVerificationCache`. Decide the backfill of the 17 live rows. | **T3** (with the projection migration). Bug Tracker row required. |
| **0b. Write-authority on provenance keys** | **Sibling** `BEFORE INSERT OR UPDATE` trigger in **0394's shape** (strip on INSERT, revert on UPDATE) — **not** a `CREATE OR REPLACE` of 0384's — covering `source_url`, `connector_source`, `connector_artifact_id`, `external_ref`, `external_revision`, **`fetched_at`**, **`source_provider`**. Host allow-list + **`https:` only** in the `service_role` writer. If a projection-side allow-list is added, state how 0385 stays the latest redefiner. | **T3** (migration + security). |
| **0c. Write-authority on `anchor_recipients`** | 0394-shaped trigger forcing `recipient_user_id` / `claimed_at` to NULL on INSERT and reverting on UPDATE for every non-`service_role` caller. Ratchet test. | **T3.** |
| **0d. Projection inventory + shared fail-closed helper** | Enumerate all recipient-identifier-emitting surfaces; implement the rule **once**; ratchet test in `public-pii-projection-contract.json` that fails when a **new** anon-reachable surface emits it. **Fix Hole 3a** (`anchor-evidence.ts` emits `recipient_identifier` unconditionally and 404s all prod traffic today) — Bug Tracker row. | **T3.** |
| **0e. Suppression-flag parity** | Make `get_public_anchor` honour `directory_info_opt_out`. Contract test asserting parity across `get_public_anchor`, `/api/v1/verify/:publicId`, and CTDL. Bug Tracker row. | **T3.** |
| **0f. Caveat is render-blocking** | In `SourceProvenanceDisplay.tsx`, no resolvable triad ⇒ no `<a>` tag. Test-enforced. Decide where `connector-sourced` sits in the existing evidence vocabulary rather than starting a third taxonomy. | **T2.** |
| **0g. Land #2246** | OPEN, draft, **CONFLICTING**. Every later phase extends its triad. | **T2** — its own detector output says `{"tier":"T2","reason":"services/worker/src/api/proof-packet.ts — public API surface"}` and its evidence block reads T2. Only the stale title tag says `[T1]`. **12h soak + rollback rehearsal**, and it is draft-held under the freeze, so its landing date is not in this spec's control. |
| **0h. Paper trail — BLOCKING, not parallel** | Claims-register row; **DPIA delta covering the already-open `sender_email` retention and proof-packet emission**, the same-org `actor_public_id` precedent, and **timing/volume inference**; counsel question set; filing-impact note. | No tier (no code), but gates Phase 3+. |

### Phase 1 — revision pin on the anchor, unpublished

- Copy `external_revision` onto anchor metadata under a **defensively named** key (`connector_external_revision`, never `source_id`); retrieval time under a name that is not `fetched_at`.
- **CI check:** connector-written metadata keys ∩ `get_public_anchor` allow-list = ∅, across **both** materialization paths.
- Add a DocuSign revision handle from `completedDateTime` / `statusChangedDateTime`. **Never `signedDateTime`.**
- Encode the **pin class** (retrievable revision vs. point-in-time) in the data model.
- Test the dedupe-key change explicitly, including the envelope-id existence-check safety net.
- **Exit criterion:** the pinned-parameter DocuSign repeat-download hash test (§7.2 item 1). Any public use of the word "version" for DocuSign is gated on its result.

**Tier: T2** (worker behavior + queue/dedupe semantics). T3 if bundled with a projection migration.

### Phase 2 — authorized source link

- `GET /api/v1/anchors/:publicId/source` with §3.2's four acceptance criteria: relationship predicate, uniform 404, allow-list validation immediately before redirect (`https:` only), own rate bucket + audit row.
- Server-side URL construction from `org_integrations`. Add `webViewLink` to the Drive `files.get` field set; thread DocuSign `baseUri` from `resolveConnection` instead of dropping it.
- Public page gets the class-level statement, the #2246 caveat, and the record's `proof_availability` class + note — **`SECURED` only**, **date-precision timestamp**, **org setting default OFF**, **two pin-class copy strings**.

**Tier: T3** (the public statement lands with its allow-list migration, which it should).

### Phase 3 — signer capture, server-side, unpublished (tier 1)

- New DocuSign recipients API call at envelope completion; read `recipients.signers[]`, filter `status='completed'`, record recipient type and `clientUserId` presence.
- Compute the keyed HMAC in the worker; write to `anchor_recipients`; never store the raw email; never project.
- **Prerequisites — all of §4.2's four**, plus: retire browser `hashEmail` from the issuance write path; **DROP `anchors.recipient_email`**; decide the fate of the 7 existing rows; Phase 0d's ratchet test must exist.
- §1.6A discipline holds throughout: fetch → hash in memory → discard; nothing new persisted beyond bounded, PII-scrubbed metadata.

**Tier: T3** (security, migration, new category of personal data ingested).

### Phase 4 — claim and self-view (tier 2)

- Ship the UI for `mintPossessionToken` / `verifyRecipientPossession`, with the **nonce ledger, TTL, single-use consumption, and `anchor_id` binding** of §4.2 prerequisite 3.
- Set `recipient_user_id` / `claimed_at` via `service_role` only. **Replace** `link_anchors_to_user`'s bulk hash-match semantics; test that a token for anchor A cannot claim anchor B.
- Extend Phase 2's authorization to the bound recipient.
- Nothing public changes.

**Tier: T3** (security-sensitive auth surface).

### Phase 5 — opt-in per-document public attribution (tier 3)

- Consent table: per anchor, per profile, `granted_at`, `revoked_at`, evidence of the consent event, **frozen display name column**.
- Eligibility filter: `recipientType=signer`, `completed`, embedded-signed excluded or distinctly labelled.
- Allow-list migration for the new public key with its §1.5 triad. **Four** projections + contract JSON + test. **No person-identifying field in JSON-LD.** `DOES_NOT_ASSERT_LABELS` narrowed in the same change. `verifyCache` `KEY_PREFIX` bump + invalidation on grant **and** revoke.
- Omit when absent, never null; docs state that absence means no statement.
- Non-engineering gates: R-7 claims review, DPIA update, filings updated, counsel sign-off on basis **and** on the Layer-1 characterisation, ODPC registration complete with DPO appointed.

**Tier: T3**, gated on approvals that are not ours to grant.

### Phase 6 (optional) — signer-issued proof

Signed statement binding profile public ID to anchor public ID, verified by signature. No public field, no oracle. **Tier: T2 or T3** depending on where the verification surface lands.

### Out of band

- **Drive cannot demonstrate any of this yet.** `drive_watch_state` is 0 rows and `drive_revision_ledger` is 0 rows despite a connected, active Drive integration. The watch channel has never been bootstrapped, so the changes runner never fires and the producer never runs. Separate blocker, upstream of everything here.
- **M365 is enum-only.** The design is source-agnostic, so adding it later is a producer, not a redesign.
- **`credit_deduction_id` is schema-only** — 0 of 17 rows populated despite 0343's comment saying the worker sets it at SECURING. Not required here, but a live gap in the artifact-to-ledger audit chain; own ticket.

---

## 7. Risks and open questions

### 7.1 Standing risks

- **This control family has been regressed before.** 0376 silently reverted the recipient HMAC to bare sha256 for four days by branching from the wrong base. Any change touching `get_public_anchor` needs a ratchet test that **fails if the projection widens**, not merely one that passes when it is correct.
- **R-7 has thin CI coverage.** There is no general claims-review script in `scripts/ci/`. Enforcement here is a human obligation plus per-claim ratchet tests, so the tests must be written deliberately.
- **The public projection is an allow-list, and the caveat needs its own entry.** `connector_source` is not allow-listed today, which is why the anonymous verify page cannot render #2246's caveat at all. Any phase that publishes a source statement must extend the allow-list **in the same change**, or the claim ships without its §1.5 statement.
- **A dead link reads as a broken proof.** When a vendor purges a record or a viewer lacks access, the link fails while the anchor remains perfectly valid. If the UI does not make that distinction obvious, the feature generates support load and undermines confidence in sound anchors.
- **Do not persist document bytes.** §1.6A's carve-out is conditional and void if any condition breaks. "A link to the agreement" must not become a pretext to cache the document. Fetch, hash in memory, discard.

### 7.2 Open questions where research was inconclusive

Flagged rather than guessed — each would change a design decision if it resolves the other way.

1. **DocuSign repeat-download byte stability is undocumented.** The docs establish the response is a *rendering* (`certificate`, `language`, `watermark`, `show_changes`, `encrypt`; `documents_by_userid` / `recipient_id` / `shared_user_id`). BUG-2026-08-13-010 found four fetches → four SHA-256s. But **no vendor statement exists either way.** Needed: a pinned-parameter repeat-download hash test — **Phase 1 exit criterion.** Weak supporting signal: DocuSign's authoritative-copy flow uses a one-time SHA-1 with a `transactionId` handshake — an export-and-acknowledge protocol, not a re-derivable content hash.
2. **Drive revision access by role.** Older v2 docs and third-party summaries say reading revision history requires `owner`, `organizer`, `fileOrganizer`, or `writer` — a plain `reader` cannot read revisions at all. Not confirmable in the current v3 reference. If true, a connector authorized as a viewer cannot see revisions, which would gut Drive revision pinning. **Verify empirically before committing.**
3. **Whether the 17 published envelope IDs are actually indexed.** They are anon-reachable and emitted as JSON-LD. Whether any search engine has them is unverified, and it changes how urgent 0a's backfill is.
4. **DocuSign `audit_events`.** The endpoint exists, but its OpenAPI schema is `eventFields: array<nameValue>` with no documented keys and an empty description. **Do not build a parsing contract on it.**
5. **Signer IP address.** Exists only inside the Certificate of Completion PDF, not as an API field. Extracting it means parsing a PDF whose layout DocuSign controls — and DocuSign disclaims its evidentiary value anyway, noting it may come from an ISP datacenter, a VPN, or "the nearest cell tower, which can change as the device moves." **Recommendation: do not try.**
6. **Counsel: is a hash of personal data itself personal data?** (§5.4 Layer 1.) Contested, load-bearing for the erasure story, and not an engineering call.

---

## 8. Decisions for the founder

### 8.1 Product and risk decisions

1. **Backfill the 17 live `docusign:<uuid>` filenames, or fix forward only?** They are the public record title and are emitted as JSON-LD. *Recommendation: relabel in place, invalidate the cache, and accept that anything already indexed is beyond reach.*
2. **Does Phase 5 ship at all before ODPC registration and a DPO appointment?** *Recommendation: no.* Phases 0–4 deliver most of the intent and publish nothing new about any person.
3. **What exactly gets published in tier 3 — per-anchor opaque handle alone, or handle plus display name?** *Recommendation: handle alone, name on the authenticated surface.* Publishing the name accepts cross-document linkage (§4.4); if we do it anyway, that is a recorded, counsel-reviewed acceptance, not a privacy feature.
4. **Build the relationship-scoped confirm endpoint at all?** It is an oracle by construction. *Recommendation: not in the first release.*
5. **Do we ever set Drive `keepForever`?** It spends the customer's storage quota, capped at 200 per file. *Recommendation: never silently; explicit per-integration opt-in with the cost stated.*
6. **Does the Phase 2 authorized link ship into the HakiChain pilot**, or do we hold everything source-linking-adjacent until the Kenya filing is complete? Phase 2 publishes no personal data, so I lean toward shipping it — but the pilot's data class, plus the already-open `sender_email` retention, makes this an explicit call rather than an assumption.
7. **On revocation: unpublish only, or delete the internal binding too?** *Recommendation: unpublish immediately, retain internally for audit, route deletion through the erasure process.*
8. **Is source-class disclosure (naming the vendor) on by default?** *Recommendation: off, org-level opt-in.*

### 8.2 Routed to counsel, not to engineering

- The s.30(1)(f) balancing test for signer-identity publication, and whether tier 3's basis is consent.
- Whether a hash of personal data is itself personal data, for the erasure story (§5.4 Layer 1).
- Timing- and volume-inference disclosure against the securing organisation and its counterparties (§3.2, §5.1).
- Whether the DocuSign Certificate of Completion carries the admissibility weight the first draft asserted (removed from §1.1 pending review).

---

## 9. What adversarial review changed

The draft went through three independent adversarial reviews — privacy engineering, claims-honesty (R-7), and adversarial security — each verifying against prod and the live tree rather than the draft's own citations. All three returned **NEEDS_REVISION**. They found **14 blocking** and **21 major** defects. Every one is resolved below; none was silently dropped.

The single most important pattern: **the draft's controls were correct and its inventory of where they had to apply was not.** Five separate findings are the same shape — a rule stated once, in one place, for a surface set that turned out to be incomplete.

### Blocking findings

| # | What review caught | How the design moved |
|---|---|---|
| B1 | `anchor-evidence.ts` emits `recipient_identifier` unconditionally on an anon-allowed route — the entire 0356/0383/0390 fail-closed apparatus is absent from that path. Inert today only because `anchors.recipient_hash` does not exist, so it 404s all prod traffic. | New **Hole 3a**; Phase **0d** adds a projection inventory and **one shared fail-closed helper** every surface calls, plus a ratchet test that fails when a *new* anon-reachable surface emits the field. Phase 3 blocked on it. Bug Tracker row. |
| B2 | "Authenticated" treated as the privacy boundary. Self-serve signup makes that a near-zero-cost tier; `get_public_anchor` has no caller-scoping branch to pin. | §4.2 replaces it with a **relationship predicate** (org member or bound recipient) and states as a written rule that self-serve auth is **not** a sufficient gate. |
| B3 | `get_public_anchor` never reads `directory_info_opt_out`, while the REST path does — users told they opted out have not. | New **Hole 4**; Phase **0e** adds suppression-flag parity enforced by contract test. §5.4's revocability claim is now conditional on it. |
| B4 | `link_anchors_to_user` matches on **email hash alone** — one possession proof binds a person to every row anyone ever tagged with their address. The victim's own proof is the authorization step. | §4.3 makes the token carry `anchor_id`; the claim binds exactly `(anchor_id, recipient_email_hash)`; Phase 4 **replaces** rather than revives the function; test that a token for A cannot claim B. |
| B5 | §3.1's service_role-only rule applied to anchor metadata but **not** to `anchor_recipients`, which has two authenticated INSERT policies — the most identity-laden claim sourced from an org-written row. | §3.1 extends the rule; Phase **0c** adds a 0394-shaped trigger + ratchet test; tier-3 publication requires a `service_role`-minted binding. |
| B6 | §1.1's "verifiable by anyone, forever" is true of **16.4%** of records (583,350 proofs / 3,553,498 SECURED, verified). `PROOF_AVAILABILITY` already exists and the draft never mentioned it. | New **§1.1b**; every link-bearing surface must carry the record's `proof_availability` class + note; §10's lead is scoped to `per_document`. |
| B7 | #2246's note was called "verbatim" but had been strengthened — "**marked as** connector-sourced" → "is", and the anti-false-tamper sentence deleted. | §1.2 quotes **by reference to the constant**, restores both, and carries "marked as" into all three new triads until the write-guard lands and legacy rows are audited. |
| B8 | `SourceProvenanceDisplay` renders the link and the triad on **independent** conditions; all 17 connector anchors have `verification_level = NULL`, so §3.5's reuse instruction ships a link with zero caveat rows. | New **Hole 3b**; Phase **0f** makes the caveat a **render-blocking precondition** enforced in-component by test, and forces an explicit decision on where `connector-sourced` sits in the existing evidence vocabulary. |
| B9 | The signer triad put "signer" in *Measured* and "recipient" in *Asserted* — the same fact at two strengths, stronger one in the row meaning "Arkova observed this." DocuSign recipients include CC, agent, witness, editor. | §1.2's triad says **recipient** in Measured with type and status; §4.4 makes `recipientType=signer` + `completed` an **eligibility filter, not a caveat**. |
| B10 | Tier 3 would contradict `DOES_NOT_ASSERT_LABELS`, rendered unconditionally: "Signed by Jane Doe" beside "Not Asserted: the identity of the signer." | §4.4 adds it to the move-together set with a specified reconciliation, shipped in the same change as the field. |
| B11 | The schema.org JSON-LD is a **fourth** machine-readable projection the draft omitted, with no slot for a §1.5 triad and no retraction path. | §4.4 adds it, and rules that **no person-identifying field ever enters JSON-LD**; the unqualified `verificationStatus:'verified'` property is flagged independently. |
| B12 | `anchor_recipients` is client-writable with no constraint on `recipient_user_id` / `claimed_at` — an attacker can self-bind, or force-inject documents into a victim's dashboard, with one PostgREST INSERT. | Same fix as B5 (Phase **0c**), reached from the attack side rather than the policy side. |
| B13 | **No domain separation** between `hashRecipientEmail` and `mintPossessionToken` (same key), plus a live endpoint that returns `HMAC(pepper, caller_string)` (`credential-source-import.ts` → `credential_recipient_hash`), plus a replayable token with no ledger/TTL/anchor scope. Chained: read a hash off the public page, mint a valid possession token. Armed the day the pepper is provisioned. | New **Hole 5**; §4.2 prerequisite 3 mandates purpose-tagged/HKDF separation, drops `credential_recipient_hash` from the response shape, adds a nonce ledger with TTL + single-use + `anchor_id` binding, and adds the standing rule that any pepper-keyed function whose output reaches a caller is an oracle. |
| B14 | The source system is **not independent** — the org controls its own DocuSign account, holds the Connect HMAC key, and under embedded signing is itself the authenticator. The draft used DocuSign as an adversary-independent corroborator in exactly the malicious-org case where it is not. | New **§1.1a**; every Asserted clause reworded to "an account controlled by this organization reported…"; embedded-signed recipients ineligible for attribution or distinctly labelled. |

### Major findings

| # | What review caught | How the design moved |
|---|---|---|
| M1 | Phase 1's "nothing public changes" is unenforceable — 0385 already allow-lists `source_id`, `fetched_at`, `source_provider`; publication is decided by **key naming alone**. | §3.4: defensive naming (`connector_external_revision`) **plus** a CI check that connector-written keys ∩ allow-list = ∅, across both materialization paths. Default inverted. |
| M2 | Anonymous retrieval timestamps reconstruct an org's contract-execution timeline; §5.1's own inference reasoning was never applied to timing. | §3.2 reduces precision to a date or moves it authenticated; §5.1 extends the DPIA delta and counsel set to timing/volume inference. |
| M3 | Naming the vendor is itself a disclosure — it partitions an org's anchors into "executed contract" vs "self-uploaded" and reveals vendor relationships. | §3.2: source-class disclosure becomes an **org-level setting defaulting to OFF**, justified against §1.1c's own "the link is not evidence" standard. |
| M4 | §4.4 forbids names in free-text keys and then publishes a free-text display name; no gate, no length bound, no omit-on-drop stated. | §4.4 routes it through `public_free_text_or_null` with a name-appropriate max length, **omission never fallback**, re-gated on read. |
| M5 | "Revocable, subject only to TTL" understates two mechanisms: `invalidateVerificationCache` does not re-fire for already-revoked anchors, and the page is purpose-built for AI ingestion. | §5.4 requires invalidation on grant **and** revoke, a warmed-cache acceptance test, and names AI-crawler/LLM ingestion as a **first-class** irreversibility. |
| M6 | §5.1 framed connector personal-data ingestion as prospective; prod already retains raw `sender_email` and `proof-packet.ts` emits it. | §5.1 corrected; the DPIA delta moves into **Phase 0h as blocking**, and the existing retention joins the remediation table. |
| M7 | `fetched_at` and `source_provider` are anon-projected from org-writable metadata and guarded by neither 0384 nor 0394 — yet the triad asserts both as server facts. | Added to §3.1's protected key set and to Phase 0b. |
| M8 | 0b proposed `CREATE OR REPLACE` of 0384's guard. **0394 explicitly forbids that shape** (0376 regression; 0385 must stay latest redefiner) and already documents Hole 2 as a deliberately-scoped-out residual — so the draft also mis-framed it as a discovery. | §3.1 and Phase 0b switch to a **sibling trigger in 0394's shape**; §2.2 and Hole 2 now cite 0394 and state plainly that it is a known residual. |
| M9 | One anonymous copy string for all sources violates §3.3's own two-pin-class rule; Google Docs is the stated common case and its pin is not retrievable. | §3.3 specifies **two strings selected server-side by pin class**, with the class encoded in the data model in Phase 1. |
| M10 | §3.3 called DocuSign a "genuine pin" while §7.2 says byte stability is unverified — and Phases 1–2 designed around it. | §3.3 demotes it to a pin on the **envelope record's terminal state**, not the bytes; the repeat-download test becomes a **Phase 1 exit criterion** gating all "version" language. |
| M11 | §4.4's "a name is ambiguous, which is a privacy feature" contradicts §4.2's own clustering threat model and nullifies the per-anchor handle. | Argument **withdrawn** in the text; §4.4 now recommends handle-only and requires a written, counsel-reviewed acceptance if the name ships. |
| M12 | §5.4 Layer 1 declared a contested legal question settled, in the exact document that elsewhere says counsel owns the basis. | Rewritten as a factual description of what is committed; the characterisation is **routed to counsel** (§8.2). |
| M13 | §4.3 restored the founder's falsified premise as an approximation — org membership is far wider than the signatories. | §3.2 states the authorization set plainly and says the premise **stays falsified**, not approximated. |
| M14 | `external_ref` has no format validation at any layer and is org-controlled free text; the filename fallback is also not the only door (`metadata.filename` is read first). | Phase 0a makes the neutral label **unconditional**, blocks the `metadata.filename` fall-through, and adds a per-source format CHECK + producer schema with DLQ routing. |
| M15 | The redirect route's failure modes were unspecified: bare-auth authorization, a 403/404 oracle, and an unvalidated redirect target. | §3.2 adds four **acceptance criteria**: relationship predicate, uniform 404, allow-list validation immediately before redirect, own rate bucket + audit row. |
| M16 | `get_public_anchor` admits `PENDING`/`SUBMITTED`; the drain inserts connector anchors as `PENDING`, so a forged claim is publishable before any chain commitment and erasable via soft-delete. | §3.2: source statement and attribution project **`SECURED` only**, joining the chain fields already CASE-gated. |
| M17 | The pepper is a database GUC — plaintext in `pg_db_role_setting`, readable via `SHOW`, session-scoped, with no key versioning. | §4.2 prerequisite 4: move to a private-schema table or Vault behind a REVOKE'd accessor, add an unreachability test, add a **key-version prefix**. |
| M18 | Display name as a live mirror of `profiles.display_name` lets an attacker pass review with a benign name and flip it after. | §4.4 requires it **frozen at consent time** into an immutable `service_role`-written column. |
| M19 | #2246 was recorded as "already declared T1"; its own detector output and evidence block say **T2**. | Phase 0g corrected to T2 — 12h soak + rollback rehearsal — which changes the critical-path schedule for every later phase. |
| M20 | Hole 1's scope stopped at the SQL/browser projection; `proof-packet.ts` emits the envelope id too. | Hole 1 and decision 8.1(1) extended to cover `source_event` fields, with the authenticated-vs-anonymous distinction stated. |
| M21 | §1.1 claimed DocuSign proves "who the parties were" (contradicting §1.3 and §4.1) and asserted Certificate-of-Completion admissibility. | The row is rewritten to what DocuSign actually records; the admissibility claim is **removed** and routed to counsel (§8.2). |

### Minor findings, all applied

Verification basis re-pinned from `fc3629f73` to **`587d2f318`** with citations converted to stable symbols; §4.1's ruling reworded to "**anonymous** projection" with the existing same-org `actor_public_id` exposure recorded as a scoped precedent this design does not widen; `anchors.recipient_email` scheduled for DROP so "never store the raw email" is schema-enforced; the pepper prerequisite re-justified as "**close before feeding**" rather than by a falsifiable row count; `sanitizeSourceUrl`'s acceptance of `http:` restricted to `https:` only.

### Risks explicitly accepted rather than fixed

- **Deterministic HMAC linkability** (§4.2). Per-anchor salting would remove it but breaks the matching the claim flow needs. Recorded as a tradeoff; mitigated by never projecting the value.
- **Same-org API-key `actor_public_id` exposure** (§4.1). Pre-existing and scoped; this design does not widen it, but it belongs in the DPIA rather than being assumed away.
- **Anything already indexed from Hole 1.** Beyond reach; the erasure copy must not promise more than the projection can deliver.

---

## 10. The short version

Build the source link as an Arkova-side **authorized redirect** that stores identifiers and never URLs, resolves the vendor target server-side from the integration row that performed the fetch, and shows anonymous visitors the *class* of source, the retrieval date, the #2246 caveat, and the record's proof-availability class — but never the external ID and never a forward link. Copy `external_revision` onto the anchor so the record can state which version it pinned, and be honest that for Google Docs the pin is a timestamp rather than a retrievable revision, and that for DocuSign it pins the envelope record rather than the bytes.

**Close the five live holes first.** We are already publishing DocuSign envelope IDs by accident; the public source-link channel accepts any host from any org; the recipient identifier has a second anonymous door and the caveat has none; `get_public_anchor` ignores the only opt-out flag that exists; and the moment the pepper is provisioned, an existing endpoint becomes both an enumeration oracle and a possession-token minting oracle.

For signer identity, **do not publish a profile public ID.** Capture the signer server-side as a keyed HMAC nobody ever sees, let the signer claim their own document by proving possession of the email **for that document only**, and then, if they choose, per document and revocably, let them be named on it. The person publishes their credential rather than the credential publishing the person. That is the only ordering that satisfies §1.4, §6, migration 0356's threat model, and the Kenya filing position at once.

Phases 0–2 deliver most of what the founder asked for and publish nothing new about any person. Phases 3–5 need the pepper safely provisioned, counsel on the lawful basis, and the ODPC registration finished. That sequencing is not caution for its own sake. It is the order in which each phase's prerequisites can actually be true.

---

*Prepared 2026-08-20. Read-only research session — no rig, PR, branch, or prod state was modified. Verification basis: repo HEAD `587d2f318`, prod `vzwyaatejekddvltxyye` (read-only), PR #2246 head `d7f666004`.*
