# Arkova Document Alignment Audit

**Date:** March 21, 2026
**Auditor:** Claude (for Carson @ Arkova)
**Scope:** Cross-document consistency audit against 11 established project decisions
**Purpose:** Pre-execution verification before Carson begins implementation tonight

---

## Critical Findings Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 3 |
| WARNING | 10 |
| INFO | 5 |

---

## Document-by-Document Findings

### 1. Arkova-Strategic-Roadmap-v2.docx (Source of Truth)

**CRITICAL-01: OpenTimestamps Reference**
- **Section:** Appendix C, "Technical Architecture Overview," item 11
- **Quote:** "Verification Layer: Bitcoin anchoring via OpenTimestamps, cryptographic hash verification, and merkle tree management."
- **Severity:** CRITICAL
- **Issue:** OpenTimestamps was explicitly rejected. Arkova uses direct OP_RETURN anchoring, not OpenTimestamps. This is in the master document that is supposed to be the source of truth.
- **Fix:** Replace "via OpenTimestamps" with "via direct OP_RETURN" or "via Merkle-batched OP_RETURN transactions."

**WARNING-01: Crypto Jargon — "wallet" in API description**
- **Section:** Part 1.2, Self-Hosted Facilitator description
- **Quote:** "Manages USDC/stablecoin settlements on Base L2, handles fee splitting, and maintains transaction logs."
- **Severity:** WARNING
- **Issue:** "transaction logs" uses forbidden terminology per CLAUDE.md. Should be "payment records" or "settlement records." This is in a technical/internal section, but the doc may be shared externally.
- **Fix:** Replace "transaction logs" with "settlement records" or "payment records."

**WARNING-02: "Verification layer" language persists**
- **Section:** Multiple places including Part 4 ("cryptographic trust layer"), competitive landscape table
- **Severity:** WARNING
- **Issue:** While the v2 doc correctly uses "autonomous compliance infrastructure" as the primary positioning (title page, executive summary), it still uses "verification layer" in several internal sections. The established vision is "autonomous compliance infrastructure," not just "verification layer."
- **Fix:** Do a find-and-replace pass. Internal technical descriptions can use "verification layer" as a component name, but any positioning/strategic language should say "autonomous compliance infrastructure."

**INFO-01: Coinbase hosted as fallback in risk table**
- **Section:** Part 5.1, Critical Path Dependencies table
- **Quote:** "Coinbase hosted as fallback" listed as mitigation for self-hosted x402 facilitator risk
- **Severity:** INFO
- **Issue:** This is acceptable as a development/testnet fallback, not a production recommendation. The language is appropriate — it says "fallback," not "production recommendation." No change needed, but worth noting.

---

### 2. Arkova-Roadmap-x402-Plan.docx (v1)

**WARNING-03: Crypto jargon — "wallet" used multiple times**
- **Sections:** Step 9 ("payer wallet address"), Story 1.5-04 ("agent's wallet signs"), Section 1.5.3 ("broadest agent wallet support"), Section 1.5.5 ("wallet setup")
- **Severity:** WARNING
- **Issue:** "Wallet" is a forbidden term per CLAUDE.md. In user-facing contexts, should be "Vault." In technical/agent contexts where it refers to agent crypto wallets (not Arkova UI), this is a gray area — but "wallet setup" in documentation guides would be user-facing.
- **Fix:** Replace user-facing instances of "wallet" with "Vault" or "payment account." Technical references to agent crypto wallets in API/protocol context can remain but should use "agent payment address" where possible.

**WARNING-04: Missing Nessie references**
- **Section:** Entire document
- **Severity:** WARNING
- **Issue:** The v1 roadmap predates the Nessie naming decision. It references "AI" capabilities generically (document classification, extraction, anomaly detection) without ever mentioning Nessie. This is a v1/v2 version gap.
- **Fix:** The v1 document should be considered superseded by v2. If v1 is kept as a reference, add a header noting it is superseded. If it will be shared externally, it needs updating.

**WARNING-05: Positioning as "Strategic Roadmap & x402 Implementation Plan" — no "autonomous compliance" framing**
- **Section:** Title, entire document
- **Severity:** WARNING
- **Issue:** v1 is framed as a technical implementation plan focused on verification and payments. It doesn't reflect the evolved "autonomous compliance infrastructure" vision. This is expected for a v1 doc but is a risk if shared externally.
- **Fix:** Mark as superseded or update title/framing.

**INFO-02: v1 correctly handles facilitator decision**
- **Section:** Section 4, "Facilitator Decision"
- **Quote:** "Recommendation: Self-hosted facilitator for production... Use Coinbase testnet facilitator during development"
- **Severity:** INFO
- **Issue:** None — this is correctly aligned. Coinbase hosted for testnet only.

**INFO-03: v1 correctly handles non-custodial model**
- **Section:** Key Principles
- **Quote:** "Non-custodial. Arkova receives USDC to a corporate address. Arkova never holds or manages user funds."
- **Severity:** INFO
- **Issue:** None — correctly aligned.

---

### 3. Arkova-Verification-Bootstrap-Strategy.docx (Summary)

**WARNING-06: "Verification layer" as primary positioning**
- **Section:** Core Problem section, Approach 6 (Sigstore positioning)
- **Quote:** "how do you build a verification layer worth querying" and "Arkova positions as a 'second opinion' — an independent, Bitcoin-anchored verification layer"
- **Severity:** WARNING
- **Issue:** Uses "verification layer" as primary framing throughout. The vision has evolved to "autonomous compliance infrastructure." While "verification layer" is technically accurate as a component description, this doc positions it as the whole identity.
- **Fix:** If this doc will be shared externally, reframe positioning language. If internal-only, lower priority.

**INFO-04: No Nessie mention (expected)**
- **Section:** Entire document
- **Severity:** INFO
- **Issue:** This is a corpus/bootstrap strategy doc, not an AI/SLM doc. Absence of Nessie is appropriate. However, the v2 roadmap ties bootstrap directly to Nessie training data. A cross-reference would strengthen alignment.

---

### 4. Arkova-Verification-Bootstrap-Deep-Dive.docx (7 Approaches)

**CRITICAL-02: OpenTimestamps mentioned as competitor, not rejected anchor**
- **Section:** 1.8 Competitive Landscape
- **Quote:** "OpenTimestamps provides free Bitcoin timestamping using Merkle tree batching (10K documents for approximately $0.03)."
- **Severity:** CRITICAL
- **Issue:** While this section discusses OpenTimestamps as a competitor (which is fine), it's listed neutrally without noting that Arkova explicitly rejected it in favor of direct OP_RETURN. The risk: a reader could interpret this as "we should use OpenTimestamps since it's cheaper." The competitive landscape section should explicitly note that Arkova's approach is direct OP_RETURN, not OpenTimestamps.
- **Additional instance:** Section 5.4 references "Zoho Sign already integrates OpenTimestamps with Bitcoin blockchain" and Section 10.3 mentions "What happens when OpenTimestamps or Woleet add a verification API?"
- **Fix:** Add a clarifying note in section 1.8 that Arkova uses direct OP_RETURN anchoring (not OpenTimestamps) for full control over the anchoring pipeline. The competitor mentions are fine but need this context.

**WARNING-07: "Verification layer" and "verification network" as identity**
- **Section:** Conclusion
- **Quote:** "Arkova is not building a timestamping service (commodity). Arkova is building a verification network (moat)."
- **Severity:** WARNING
- **Issue:** "Verification network" is closer to the evolved vision than "verification layer," but the full positioning is "autonomous compliance infrastructure." This doc predates the v2 framing.
- **Fix:** If kept as a reference doc, note that it predates the v2 positioning update.

**INFO-05: Correct non-custodial and self-custody alignment**
- **Section:** Throughout
- **Severity:** INFO
- **Issue:** None — correctly aligned. Explicitly states non-custodial model and fingerprint-only architecture.

---

### 5. Arkova-Verified-Intelligence-SLM-Analysis.docx (SLM/Nessie Analysis)

**CRITICAL-03: SLM is never called "Nessie"**
- **Section:** Entire document — title says "SLM," all references say "SLM" or "the model"
- **Severity:** CRITICAL
- **Issue:** The established name is "Nessie." This document never uses it. The v2 roadmap prominently features "Nessie" throughout. This is the primary SLM strategy document and it doesn't use the canonical name.
- **Fix:** Global find-and-replace: change positioning references from "the SLM" to "Nessie" (or "Nessie, Arkova's SLM"). Technical references to "SLM" as a category term can remain, but the product should be named.

**WARNING-08: Inflated FTE costs — $450K-$720K for 2-3 ML engineers + 1 data engineer**
- **Section:** Section 7.3 (Talent Acquisition) and Section 2.3 (Annual Compute Budget)
- **Quote:** "A lean team of 2-3 ML engineers plus 1 data engineer is achievable at $450K-$720K total comp."
- **Also:** Section 2.3 shows "ML engineering (2 FTE) $300,000-$500,000" and "Data engineering (1 FTE) $150,000-$220,000"
- **Severity:** WARNING
- **Issue:** The agreed approach is synthetic data / distillation — use existing LLMs (Claude/Gemini) to generate synthetic training data, then fine-tune Nessie. This requires 1 ML engineer, not 2-3 ML engineers + 1 data engineer. The document's cost model is based on a traditional ML team structure that doesn't reflect the distillation approach. The $450K-$720K FTE cost is inflated by 2-3x.
- **Fix:** Revise the team section to reflect the synthetic data/distillation approach: 1 ML engineer who manages the synthetic data generation pipeline (using Claude/Gemini API calls to generate training examples) and runs LoRA fine-tuning. Revised FTE cost: ~$150K-$200K for 1 senior ML engineer. Data engineering work is handled by existing backend engineers running the EDGAR/patent ingestion pipeline.

**WARNING-09: Missing "autonomous compliance infrastructure" framing**
- **Section:** Title, executive summary
- **Severity:** WARNING
- **Issue:** The document titles itself "Verified Intelligence: Building an SLM on Cryptographically Anchored Data." It doesn't connect to the "autonomous compliance infrastructure" vision. The v2 roadmap frames Nessie as the intelligence engine powering autonomous compliance. This doc treats the SLM as a standalone product.
- **Fix:** Add a framing section connecting Nessie to the autonomous compliance vision: Nessie isn't just a model — it's the reasoning engine that makes autonomous compliance possible.

**WARNING-10: No mention of synthetic data / distillation training approach**
- **Section:** Training methodology sections (2.1, 2.2, 2.4)
- **Severity:** WARNING
- **Issue:** The document describes traditional fine-tuning approaches (LoRA on raw documents) but never mentions the synthetic data / distillation approach — using Claude or Gemini to generate high-quality training examples from the anchored corpus, then fine-tuning Nessie on those examples. This is a significant methodological gap.
- **Fix:** Add a section on synthetic data generation: "Use frontier LLMs (Claude, Gemini) to generate question-answer pairs, compliance reasoning chains, and regulatory analysis examples from the anchored corpus. Fine-tune Nessie on this synthetic dataset. This dramatically reduces the need for manual data curation and enables rapid domain expansion."

---

### 6. Arkova-Global-Data-Source-Registry.docx (International Data Sources)

This document is **clean** on all major alignment criteria.

- **Global scope:** Covers 30+ jurisdictions across 7 regions. No US-only bias.
- **No OpenTimestamps references:** Not mentioned.
- **No crypto jargon in user-facing content:** This is an internal technical reference. Uses "transaction" in context of government data (e.g., "transaction data in platform" referring to Kenya's eCitizen), which is appropriate — these aren't Arkova's transactions.
- **No Nessie references needed:** This is a data source registry, not an AI document.
- **Documents-never-leave-device:** Not applicable to this document.
- **Non-custodial:** Not applicable to this document.

No findings.

---

## Cross-Document Consistency Issues

### Positioning Language Drift

| Document | Primary Positioning |
|----------|-------------------|
| v2 Roadmap (source of truth) | "Autonomous compliance infrastructure" |
| v1 Roadmap | "Strategic Roadmap & x402 Implementation Plan" |
| Bootstrap Strategy | "Verification layer" |
| Bootstrap Deep Dive | "Verification network" |
| SLM Analysis | "Verified Intelligence" / standalone SLM product |
| Global Data Registry | Neutral (data reference doc) |

Only the v2 roadmap uses the correct canonical positioning. All other docs predate or diverge from it.

### Nessie Naming

| Document | Uses "Nessie"? |
|----------|---------------|
| v2 Roadmap | Yes — prominently |
| v1 Roadmap | No |
| Bootstrap Strategy | No |
| Bootstrap Deep Dive | No |
| SLM Analysis | **No — this is the primary SLM doc and it doesn't use the name** |
| Global Data Registry | N/A |

### FTE Cost Alignment

| Document | ML Team Size | Annual Cost |
|----------|-------------|-------------|
| v2 Roadmap | Implied lean (no specific FTE count) | $580K-$920K total (including infra) |
| SLM Analysis | 2-3 ML engineers + 1 data engineer | $450K-$720K FTE only |
| Agreed approach | 1 ML engineer (synthetic data/distillation) | ~$150K-$200K FTE |

The v2 roadmap cost table ($580K-$920K) appears to carry forward the SLM Analysis numbers. Both need revision to reflect the synthetic data approach.

---

## Execution Readiness Assessment

### Ready for Execution Tonight (Clean or Minor Issues Only)

1. **Arkova-Global-Data-Source-Registry.docx** — CLEAN. No alignment issues found. Ready to execute against for data ingestion planning.

2. **Arkova-Roadmap-x402-Plan.docx (v1)** — READY WITH CAVEATS. The x402 implementation details are technically sound and correctly aligned on facilitator self-hosting, non-custodial model, and feature flagging. The "wallet" terminology and missing Nessie references are WARNINGs but don't block execution of the x402 implementation steps. **Safe to execute the x402 technical implementation (Part 1) tonight.** Part 2 (full roadmap) is superseded by v2.

3. **Arkova-Verification-Bootstrap-Strategy.docx** — READY WITH CAVEATS. Strategy recommendations are sound and consistent with v2 roadmap's bootstrap approach. "Verification layer" framing is outdated but doesn't affect tactical execution. **Safe to execute bootstrap priorities tonight.**

### Needs Revision Before External Sharing

4. **Arkova-Strategic-Roadmap-v2.docx** — NEEDS ONE CRITICAL FIX. The OpenTimestamps reference in Appendix C must be corrected before this doc is shared with anyone. It's the source of truth document and it contains a factual error about Arkova's anchoring approach. Also review cost projections that may carry forward inflated FTE numbers. **Fix the OpenTimestamps line, then it's ready.**

5. **Arkova-Verification-Bootstrap-Deep-Dive.docx** — NEEDS CONTEXT ADDITIONS. OpenTimestamps competitive mentions need clarifying context that Arkova uses direct OP_RETURN. Otherwise solid for internal use. **Add the clarifying note, then it's ready.**

6. **Arkova-Verified-Intelligence-SLM-Analysis.docx** — NEEDS REVISION. Three issues: (a) Never calls the SLM "Nessie" — CRITICAL naming gap. (b) Inflated FTE costs don't reflect synthetic data/distillation approach. (c) Missing synthetic data methodology entirely. **Do not execute against this doc's cost/team estimates without revision.** The technical architecture (RAG + LoRA, base model selection, client-side inference) is sound and can be referenced.

---

## Recommended Fix Priority

| Priority | Action | Time Est. |
|----------|--------|-----------|
| 1 | Fix OpenTimestamps reference in v2 Roadmap Appendix C | 2 min |
| 2 | Add "Nessie" naming throughout SLM Analysis doc | 15 min |
| 3 | Add clarifying note about direct OP_RETURN in Deep Dive competitive section | 5 min |
| 4 | Revise SLM Analysis team/cost section for synthetic data approach | 30 min |
| 5 | Add synthetic data/distillation methodology to SLM Analysis | 30 min |
| 6 | Replace "wallet" with approved terminology in v1 Roadmap user-facing sections | 10 min |
| 7 | Update positioning language across all docs to "autonomous compliance infrastructure" | 20 min |

---

*Audit completed March 21, 2026. All documents read in full. Findings cross-referenced against CLAUDE.md project configuration and the 11 alignment criteria provided by Carson.*
