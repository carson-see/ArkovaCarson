# GEMB2-04 — Spike: semantic near-dup anchor detection

**Jira:** [SCRUM-1053](https://arkova.atlassian.net/browse/SCRUM-1053)
**Parent:** [SCRUM-1040](https://arkova.atlassian.net/browse/SCRUM-1040)
**Status:** Spike report — recommendation: defer to v1.1 pending legal sign-off on the opt-in carve-out.

---

## Question

Can Gemini Embedding 2 detect that a newly-anchored document is a semantic revision of an existing anchor (feeds the CIBA ARK-104 `SUPERSEDED` lineage flow)?

## Constraint — Privacy boundary (§1.6)

> _"Documents never leave the user's device. Foundational privacy guarantee."_

Our canonical guarantee is that `generateFingerprint` and PII stripping happen client-side. Only PII-stripped **structured metadata** reaches the server. For Gemini Embedding 2 near-dup detection to work, the embeddable representation must live on the server. That means one of:

1. **Opt-in server-side embedding of PII-stripped metadata text** (recommended). Customers explicitly enable `ENABLE_SEMANTIC_SUPERSEDE` for their org and sign a privacy carve-out stating that the PII-stripped metadata text is embedded server-side via Vertex AI (US-only residency).
2. **Client-side embedding + cosine computation** — runs Gemini Embedding 2 in-browser. Not currently feasible (Vertex AI does not expose a browser-safe model; running a 3072-dim embedding locally requires a huge model download).
3. **Hash-based near-dup only** — SHA-256 prefix match on PII-stripped metadata. Very narrow — only catches byte-identical re-uploads.

Recommendation: Option 1, opt-in, with explicit carve-out language.

## Prototype plan

1. Pick 50 known supersede pairs from the existing production anchor DB (manually curated).
2. Run each pair through Gemini Embedding 2 at 3072d.
3. Compute cosine similarity.
4. Plot the distribution of cosine vs. human-labeled supersede/not-supersede.
5. Pick threshold with precision ≥ 95% and recall ≥ 80%.

Prototype code lives in `services/worker/scripts/spike-semantic-supersede.ts` (to be written when we greenlight this in a later PR — not in this one).

## Privacy-carveout language draft

> **Optional: semantic version detection**
>
> With this feature enabled, Arkova embeds a PII-stripped summary of your
> document's metadata (not the document text or fingerprint) into a
> vector representation via Google Vertex AI in the United States. The
> representation is used to detect revisions of documents you previously
> secured, so we can mark the older version as superseded automatically.
>
> You may disable this feature at any time. Disabling takes effect for
> all future anchors; past embeddings are purged on request within 30
> days.
>
> This feature requires a signed privacy carve-out because it is the only
> path in Arkova that sends any derivative of your document content to a
> third-party AI model. All other AI features operate on locally-
> extracted structured metadata, never embeddings.

This language must be reviewed by the NVI attorney gate
([SCRUM-804](https://arkova.atlassian.net/browse/SCRUM-804)) before the feature
ships, even as a v1.1 opt-in. Per `memory/feedback_nvi_gate_pragmatic.md`,
this is an advisory gate — can ship on signoff without a formal legal memo.

## Recommendation

**Defer to v1.1.**

Reasons:
- GEMB2-01/02/03 unblock the P0 training pipeline. GEMB2-04 is cosmetic — CIBA ARK-104 `SUPERSEDED` already works manually via the admin UI.
- The privacy carve-out language materially changes our
  "documents never leave the device" marketing story. Shipping it
  opt-in doesn't avoid the communications work.
- Need the GEMB2-01 benchmark to land first to size the Vertex cost of the 50-pair prototype itself.

## Acceptance criteria (pasted from Jira)

- ✅ Spike report in Confluence with go/no-go + risk analysis — this doc.
- ⏸ Privacy-carveout language reviewed by legal (NVI gate advisory) — handoff.
- ⏸ Prototype measures precision/recall on 50 known supersede pairs — deferred to v1.1.
