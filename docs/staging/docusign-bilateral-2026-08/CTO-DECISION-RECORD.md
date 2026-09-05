# CTO Decision Record — DocuSign Bilateral Coverage + Record Deep Links
Date: 2026-08-29. Authority: CTO (final technical decision maker). Status: APPROVED for build.
Supersedes the proposal in `DESIGN-BRIEF.md` wherever they differ. Grounded in four discovery reports, two adversarial red-team reviews, and direct prod queries against `vzwyaatejekddvltxyye`.

## Verdict on the two founder problems
- **F2 (record deep links + signer rows): APPROVED, ships this cycle**, fully reviewed and soaked. It is the visible, high-certainty win.
- **F1 (ingest incoming/received envelopes): APPROVED IN PRINCIPLE, built flag-OFF, NOT go-live this cycle.** The sanctioned mechanism (DocuSign Recipient Connect) is real, but two facts make a live claim impossible right now and dishonest to assert:
  1. **Security (CRITICAL, accepted):** the inbound declared-hash path removes the API re-fetch that makes the outbound path forgery-resistant, and the DocuSign Connect HMAC key is customer-side console state — so *every* connected org can already POST a self-signed, self-authored "inbound" event and anchor a **fabricated provenance record** (fake envelope, fake signer GUIDs) the moment the flag flips. This is provenance fraud, exactly what §1.5 / R-7 forbid.
  2. **Feasibility:** the two load-bearing attribution facts (OQ-2, OQ-3) can only be resolved against a *live* Recipient Connect config in a customer's DocuSign Admin console, which is not reachable from this environment. Building a T3 soak on unverified vendor behavior would be a hollow soak (forbidden by `feedback_soaks_must_meet_soc2_type2`).

  Therefore F1 ships as reviewed, flag-OFF code with a corrected threat model, and go-live is gated on a blocking feasibility spike + a real design-partner soak. We do not claim it live or soaked in this cycle.

## Adopted rulings (these are binding on implementation)

### R1 — Write-authority guard migration (closes security Finding 2; foundation for Finding 1)
New migration (next free prefix, currently `0422`), **T3**, copying the exact pattern of `0384`/`0394` (`enforce_*_key_authority` BEFORE INSERT/UPDATE trigger): for any writer that is **not** `service_role`, strip/revert this key family from `anchors.metadata` — `connector_source`, `connector_artifact_id`, `account_id`, `envelope_id`, `_signers`, `_docusign_env`, `_direction`, `_sending_account_id`. Rationale: `bulk_create_anchors` and legacy PostgREST paths persist client metadata verbatim (`connectorFingerprint.ts:34-36`), so without this a user self-uploads a PDF with `connector_source:'docusign'` + fake GUIDs and F2 renders forged DocuSign trust links. Implementation MUST grep every legitimate writer to confirm none of these keys is set by a non-`service_role` path before shipping (the worker connector-artifact-drain path is `service_role` and is unaffected).

### R2 — Reuse the guarded `fingerprint_source` column; do NOT invent `fingerprint_provenance` (security Finding 3)
`anchors.fingerprint_source` already exists in prod (verified) as a CHECK-constrained enum (`document_bytes` | `issuer_record_attestation`, migration `0376`, guarded by `0384`). Rulings:
- OUTBOUND fetched documents keep `fingerprint_source='document_bytes'` + `FINGERPRINT_REDERIVABILITY` class `FETCH_TIME_SNAPSHOT` (unchanged).
- INBOUND declared-hash anchors get `fingerprint_source='issuer_record_attestation'` set **server-side** + a NEW additive `FINGERPRINT_REDERIVABILITY` class `DECLARED_UNVERIFIED` with its own §1.5 note.
- DROP the proposed `metadata.fingerprint_provenance` key entirely.

### R3 — Declared-hash inbound is a visibly weaker evidence class (security Finding 1)
Inbound `DECLARED_UNVERIFIED` anchors are never presented with the same trust signal as a fetched-document anchor. Proof/record copy states plainly: *Arkova did not retrieve or hash this document; the fingerprint is asserted by DocuSign's notification, not measured by Arkova.* (§1.5 measured/asserted/NOT-asserted; R-7 claims gate.)

### R4 — Inbound classification uses server-side state, never attacker-authored body fields (security Finding 1)
`direction='inbound'` is decided by comparing the envelope's owning/sender account against the resolving org's **server-stored** connected `account_id` set — not a `sender` field inside the request body, and not the `?customrecipient` query marker alone (both are requester-controlled). If the marker claims inbound but the envelope owner IS the org's own connected account, treat as outbound. Store `_direction` (guarded per R1) and `_sending_account_id` (underscore-prefixed → auto-stripped by `sanitize_metadata_for_public`).

### R5 — Inbound operational guards (security Findings 4, 5, 6, 9; pre-mortem 6)
- **include-documents HARD OFF** for MVP — declared `sha256` only. Do NOT raise the worker's 1MB raw-body limit (`index.ts:284`) for this path.
- **Nonce tenant-scoping:** add `account_id` (resolved pre-write) to the `docusign_webhook_nonces` uniqueness key via migration before PR-C, so one tenant cannot pre-empt another's nonce triple.
- **Dedicated rate-limit bucket** for `/webhooks/docusign` (today it shares the global `'stripe'` bucket). Check open PR #2441 (per-limiter buckets) first and fold in rather than duplicate.
- **Config cross-validation:** `ENABLE_DOCUSIGN_INBOUND` (default false) requires `ENABLE_DOCUSIGN_WEBHOOK` and — because it reuses the connector_artifact path — `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE` + `ENABLE_CONNECTOR_ARTIFACT_DRAIN` (mirror the existing `ENABLE_DOCUSIGN_QUEUE_RECONCILIATION` guard at `config.ts:794-802`).
- **Kill-switch is inline post-classification** (inbound and outbound share one mounted path, so `pathScopedKillSwitch` cannot gate inbound alone).
- **Flag-OFF behavior:** an inbound-classified event while the flag is off is acknowledged `200` with **no nonce consumed and no durable write** (avoids both DocuSign retry storms and the "nonce consumed while off ⇒ unrecoverable on flip" trap). No backfill of pre-flag envelopes is promised.
- **Distinct inbound orphan/alert signal** separate from the existing (deliberately silent) outbound orphan-drop, so a nonzero inbound-orphan rate while enabled surfaces instead of blending into noise.

### R6 — Signer capture + display (security Finding 8; pre-mortem 4)
- Persist ONLY pseudonymous identifiers under `_signers` (guarded, capped 20): `{recipient_id_guid, user_id?, status, signed_at?}`. **No name/email persisted anywhere** — recipient PII gets §1.6A document-byte discipline.
- Display/link identifier defaults to `recipient_id_guid` (envelope-scoped, less linkable) for data minimization; `user_id` captured but not preferred for display.
- Signer rows render via a **dedicated component**, not the generic `AssetDetailView` metadata-dump loop. Label pattern "Signer N · Verified via DocuSign", GUID secondary, "+N more" when the cap is hit. Each links to the envelope-details URL (DocuSign has no per-user profile URL — verified dead).

### R7 — Deep-link construction (both problems)
New `src/lib/docusignLinks.ts`: strict UUID/GUID validation, then compose onto FIXED https bases (`apps.docusign.com` prod / `apps-d.docusign.com` demo, chosen by `_docusign_env`). No metadata value ever becomes an href without passing GUID validation ⇒ immune to `javascript:`/redirect injection by construction (security review confirmed this design sound). Links: account → `/send/home?account={id}`, envelope + signer → `/send/documents/details/{envelopeId}`. `target=_blank rel="noopener noreferrer"` + `ExternalLink`, styled per `CtdlDataLink`. Copy strings in `src/lib/copy.ts` (verify "envelope" passes `lint:copy`; "DocuSign"/"signer" already clean).
- **Legacy 21 records:** all verified post-cutover prod-era → account/envelope links render safely with env=prod default; no signer rows (no data). No backfill anxiety.

### R8 — Public surface unchanged this cycle (pre-mortem 7)
`/verify/:publicId` is NOT linkified and NEVER receives signer GUIDs (SQL strips `_*`). Proactively extend `scripts/ci/public-pii-projection-contract.json` + its regression tests to ASSERT `_signers`/`_docusign_env`/`_direction`/`_sending_account_id` never egress (security Finding 11). Sweep the known-open `anchor-evidence.ts` 5th projection (Finding 10) as a follow-up ticket, not a blocker.

### R9 — Soak design must be SOC 2 Type 2 grade (pre-mortem 5; security Finding 1)
Before any soak clock starts, extend `services/worker/scripts/load-test/lib/docusign-synth.js` + `k6-docusign.js` with: Recipient-Connect-shaped events (`?customrecipient`), and the adversarial mix — **the self-forgery scenario (own-account self-signed fabricated inbound)**, wrong-HMAC, replay, self-send collision, unknown-account orphan, sha256-present/absent. "Exercises the changed path end-to-end" means: direct DB proof that a classified event reaches a real `connector_artifact` row + anchor; two synthetic orgs cross-checked for queue isolation; continuous Cloud-Run-uptime coverage across the window.

### R10 — TLA PreCheck (Carson's /tlaprecheck ask)
Model the dual-writer dedup invariant — **at most one anchored artifact per (org, envelope) under concurrent outbound + inbound delivery** — in a `.machine.ts`, verify with `check`; re-verify `machines/bitcoinAnchor.machine.ts`.

## Delivery sequence (strict dependency order)
1. **PR-1 — guard migration `0422` (T3):** R1. Foundation; must land before F2 links render as trust signals.
2. **PR-2 — worker signer capture + evidence class (T2):** R2 (outbound `fingerprint_source`), R6 (`_signers`, `_docusign_env` on the forgery-resistant OUTBOUND path).
3. **PR-3 — frontend links + signer rows (T2, `src/**`+`e2e/**` only):** R6/R7/R8. Depends on PR-1 + PR-2.
4. **PR-4 — inbound via Recipient Connect (T3, flag-OFF):** R3/R4/R5/R9/R10. Opened explicitly gated; NOT flag-flipped, NOT claimed soaked-live; blocked on the OQ-2/OQ-3 spike + a design-partner soak.
5. **Docs (T0, separate push):** `docs/runbooks/integrations/docusign.md` inbound/Recipient-Connect section + qualification requirements.

## Jira / Confluence plan
- **F2 → Story under epic SCRUM-2329** ([MVP-D-DS]) with subtasks: guard-migration, worker signer capture, `docusignLinks.ts`, signer-row component, copy.ts, E2E, `[Verify]`/`[Close-out]`.
- **F1 → new epic "[MVP-D-DS-IN] Incoming DocuSign Envelopes"** under SCRUM-2895 ([PI-0.5]); first child = **feasibility spike** (OQ-2/OQ-3 against a live Recipient Connect config) as a blocking gate before the build story.
- Confluence (space A homepage parent 163950): epic AUDIT page; updates to Data Model (786471), Webhooks (655405), Security & RLS (819220), Audit Events (294975). Bug-log rows for the two spec-level gaps the review found (un-prefixed keys; missing config cross-validation) per rule 5.

## Empirically retired risks (do not re-raise)
- Legacy link env mismatch — all 21 prod records post-cutover prod-era (verified).
- `SECURED` forgery via inbound — `AnchorInsertPayload.strict()` pins `status:'PENDING'`; only worker service_role promotes to SECURED (security review confirmed).
- Public metadata leak of `_signers` — SQL `_*` strip + `get_public_anchor` allowlist + `verify.ts` field allowlist are three independent layers (security review confirmed); R8 adds the contract test.
