# SCRUM-2904 — Dual-DocuSign hash-provenance: CTO ruling memo

**From:** Lane 1 (Trust & Chain) · **To:** CTO (via RTE) · **Ruling target:** Jul 23–24 · **Mode:** doc. Connector flags are **OFF in prod** (go-live gated on a both-sides soak) — this is a **pre-launch design ruling**, not an active-prod change.

## The question
A document that reaches Arkova through the **DocuSign connector** can have **two independent hashes**:
1. **Arkova's server-computed SHA-256** of the bytes we fetch — the §1.6A connector carve-out fingerprint (`connector_artifact.fingerprint_sha256`, materialized to a PENDING anchor by `connector-artifact-drain.ts`). This is the **designed** path — note (AI review F2): connectors are flag-off in prod (`enqueueSignedDocument` no-ops when `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE !== 'true'`; QUEUE-06 drain not in prod), so **zero connector docs are anchored today**. This is what we *would* anchor, not current prod state.
2. **DocuSign's own document digest** — DocuSign's completed-envelope record carries a per-document hash in the Certificate of Completion / eSignature API. **We do not capture this today** (verified: `integrations/connectors/docusign.ts` computes/records no envelope hash).

**Ruling needed:** which hash is authoritative for the anchor, and how do we represent provenance so a verifier isn't misled about what the fingerprint attests?

## Facts (grounding)
- §1.6A permits server-side fingerprinting **only** for connector-fetched docs: fetch → SHA-256 in memory → discard bytes; raw bytes never persisted/logged/Sentry'd. Our current path anchors hash (1) and honors this.
- We currently make **no assertion** about DocuSign's signatures or the envelope's completion state — the anchor asserts only "SHA-256 of the bytes Arkova fetched at time T."
- §1.5 requires proof copy to state what is **measured vs asserted vs NOT asserted**; §R-7 (claims gate) forbids implying an external status we don't hold.

## Options
- **Option 1 — Anchor Arkova's SHA-256 only (status quo).** Simple, §1.6A-clean. Risk: if the bytes DocuSign served differ from the executed envelope (transit/version mismatch), we'd anchor a hash of the wrong bytes and never know. Provenance copy must say "fingerprint of the document Arkova retrieved from DocuSign," NOT "the DocuSign-executed document."
- **Option 2 — Capture DocuSign's envelope digest as corroborating metadata (RECOMMENDED, with a hashing-domain caveat).** On fetch, also read DocuSign's recorded document digest; store it + envelope id as PII-scrubbed provenance metadata (not raw bytes).
  - **⚠ HASHING-DOMAIN CAVEAT (AI review F1) — do NOT make this a hard match-or-hold gate yet.** Arkova fetches `…/envelopes/{id}/documents/combined` — the **combined** signed PDF (all docs concatenated + Certificate of Completion). DocuSign's recorded digest in the CoC/eSignature API is **per individual document** over a different byte representation, so `SHA-256(combined package) == DocuSign per-document digest` will essentially **never** hold. A hard "hold-on-mismatch" gate would route ~100% of envelopes to hold — connectors dead on arrival at flag-flip. **Resolve the hashing domain first:** either fetch per-document bytes via `…/documents/{documentId}` and hash each to match DocuSign's per-doc digest, and/or confirm whether DocuSign exposes a combined-package digest. Until that's settled, the DocuSign digest is **corroborating metadata only**, not an equality invariant. Once the domains are aligned, THEN a match-or-hold gate is safe and lets proof copy say "fingerprint matches the DocuSign-executed document's own recorded digest."
- **Option 3 — Anchor DocuSign's digest directly (reject).** Would make Arkova's proof depend on DocuSign's hashing choices/algorithm and break the uniform "SHA-256 of bytes" model verifiers use elsewhere. Rejected.

## Recommendation
**Option 2.** It closes the transit/version gap, keeps Arkova's SHA-256 as the single anchored fingerprint (uniform verification model), and upgrades the provenance claim from "bytes we fetched" to "bytes we fetched **that match DocuSign's own digest**" — without asserting anything about DocuSign's signature validity (which stays in the NOT-asserted column, §1.5). Implementation is connector-side (a fetch-time digest read + equality gate + scrubbed metadata); **no anchor/proof schema change** if the DocuSign digest lands in the existing `connector_artifact` metadata rather than a new column.

## What this memo does NOT decide
Whether to assert DocuSign signature/identity validity (a separate, larger claim — recommend keeping it NOT-asserted for the pilot). Whether connectors go live at all (flag flip is Carson/soak-gated). No code or migration authored (W3).

## Open input needed from CTO
1. Approve Option 2 (capture + cross-check + hold-on-mismatch) vs status-quo Option 1.
2. Confirm the DocuSign digest is stored as **metadata on `connector_artifact`** (no schema change) vs a dedicated column (would become a 0359+ train item, Task 7).
3. Approve the exact proof-copy wording change (measured/asserted/NOT-asserted) for connector-sourced anchors.

_Lane 1 (Trust & Chain), 2026-07-20 evening. Pre-launch ruling; connectors OFF in prod._
