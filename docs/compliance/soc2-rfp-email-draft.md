# SOC 2 Readiness-Assessment RFP — Ready-to-Send Email Drafts

**Jira:** [SCRUM-522](https://arkova.atlassian.net/browse/SCRUM-522)
**Last updated:** 2026-04-17
**Owner:** Matthew (send), Carson (CC + final sign-off)
**Shortlist:** [docs/compliance/soc2-auditor-shortlist.md](./soc2-auditor-shortlist.md) (authoritative)
**Evidence index:** [docs/compliance/soc2-evidence.md](./soc2-evidence.md)
**Depends on:** [SCRUM-516](https://arkova.atlassian.net/browse/SCRUM-516) — framework selection (SOC 2 Type II confirmed)

---

## How to use this document

Three per-firm email bodies, personalised, ready to send. **Scope reminder:** SCRUM-522 is readiness-only. The Type II observation window is a follow-up epic; do not pre-commit to Type II pricing in the RFP.

Five concrete steps:

1. **Confirm SCRUM-516 is Done** — framework selection memo published at [docs/compliance/soc2-type2-decision.md](./soc2-type2-decision.md). If not Done, stop; this RFP is premature.
2. **Verify intake addresses** (§Delivery addresses). Audit firms rotate sales emails often.
3. **Send** all three RFPs on the same business day. Reply-by: T+14 business days.
4. **Log** sent emails in [docs/compliance/vendor-register.md](./vendor-register.md) under a new `SOC 2 Auditor RFP 2026` section.
5. **When replies arrive** score against the 100-point rubric in [docs/compliance/soc2-auditor-shortlist.md](./soc2-auditor-shortlist.md#scoring-rubric-100-points). Pick highest scorer ≥75/100; sign readiness SOW; transition SCRUM-522 from Blocked → In Progress.

---

## Delivery addresses (VERIFY before sending)

| Firm | RFP intake | Verified on |
|------|-----------|-------------|
| Prescient Assurance | info@prescientassurance.com | VERIFY BEFORE SEND |
| A-LIGN | info@a-lign.com | VERIFY BEFORE SEND |
| Johanson Group | info@johansongroup.net | VERIFY BEFORE SEND |

---

## Email 1 — Prescient Assurance

**Subject:** RFP: SOC 2 Type II readiness assessment — Arkova (SaaS, ~15 people, Supabase+Cloud Run stack)

Hi Prescient team,

We're selecting a firm for a SOC 2 Type II **readiness** assessment for Arkova (arkova.ai), a privacy-preserving credential verification SaaS. Type II observation is a follow-up engagement, but we want the readiness partner to be able to continue through observation.

**Firm profile:**

- ~15 FTE; bootstrapped.
- Cloud footprint: Vercel (frontend), Google Cloud Run (worker), Supabase (database, with RLS and `FORCE ROW LEVEL SECURITY` on every table), Cloudflare Workers (edge), GCP KMS for key custody.
- Client-side processing boundary: documents never leave the user's device. Fingerprints + PII-stripped metadata are anchored to Bitcoin mainnet. This materially reduces audit scope — we're flagging so you scope accurately.
- 1.41M+ anchored records in production; SOC 2 evidence already assembled at the level expected by Drata / Vanta / Hyperproof.

**Engagement we want:**

- Readiness assessment (3 weeks).
- Gap report with OWNER + severity + target close date per finding.
- Readiness integrates with our existing evidence layout (`docs/compliance/*.md` + migration manifests) — do NOT re-key evidence into your portal from scratch.
- Named partner signs the eventual Type II report (for buyer-facing credibility).

**Budget:** readiness $8K–$18K fixed fee. (Type II quoted separately for reference — not contractual in this SOW.)

**Attached:**

1. [docs/compliance/soc2-evidence.md](./soc2-evidence.md) — current evidence index.
2. [docs/compliance/soc2-type2-evidence-matrix.md](./soc2-type2-evidence-matrix.md) — control-to-evidence mapping.
3. [docs/compliance/soc2-type2-decision.md](./soc2-type2-decision.md) — scope + framework decision memo.

**What we're asking for:**

- Fixed-fee readiness quote.
- Indicative Type II quote (not contractual).
- Named partner for both engagements.
- Evidence-portal strategy: can you work off our file-based layout, or do we need to adopt your tool?

**Reply by:** T+14 business days; confirm receipt in 3 business days.

Thanks,
Matthew
Arkova

---

## Email 2 — A-LIGN

**Subject:** RFP: SOC 2 Type II readiness (+ potential ISO 27001 bundle) — Arkova

Hi A-LIGN team,

Requesting a proposal for a SOC 2 Type II **readiness** assessment for Arkova (arkova.ai). We're interested in A-LIGN specifically because of the ability to stack SOC 2 + ISO 27001 + HIPAA under one firm — our 12-month plan includes ISO 27001 certification (Q3–Q4 2026) and we'd prefer the readiness auditor to continue through both.

**Firm profile:**

- ~15 FTE; bootstrapped.
- Cloud footprint: Vercel, Cloud Run, Supabase (RLS-enforced), Cloudflare Workers, GCP KMS.
- Client-side processing boundary (documents never leave user device) materially reduces audit scope.

**Engagement:**

- Readiness assessment (3 weeks).
- Gap report with OWNER + severity + target close date.
- Preference for the partner to also lead ISO 27001 implementation later.

**Budget:** readiness $8K–$18K.

**Attached:** same 3 docs as §Email 1.

**What we want in the proposal:**

- Fixed-fee readiness quote.
- Indicative SOC 2 Type II + ISO 27001 bundled quote (not contractual).
- Account-manager-continuity policy (we've heard A-LIGN churn can bite; please address directly).
- Named partner.

**Reply by:** T+14 business days.

Thanks,
Matthew
Arkova

---

## Email 3 — Johanson Group

**Subject:** RFP: SOC 2 Type II readiness — Arkova (boutique fit, partner-signed)

Hi Johanson team,

Requesting a proposal for a SOC 2 Type II **readiness** assessment for Arkova (arkova.ai), a privacy-preserving credential verification SaaS. Your boutique / founder-friendly model + named-partner signatures make you a strong fit for our first audit cycle.

**Firm profile:**

- ~15 FTE; bootstrapped.
- Cloud footprint: Vercel, Cloud Run, Supabase with RLS, Cloudflare Workers, GCP KMS.
- Client-side processing boundary reduces audit scope.
- 1.41M+ anchored records in production.

**Engagement:**

- Readiness (3 weeks).
- Gap report with OWNER + severity + close-date.
- Named partner signs both readiness and (eventual) Type II reports.
- Budget: readiness $8K–$18K.

**Attached:** same 3 docs as §Email 1.

**Specific asks:**

- Fixed-fee readiness quote.
- Named partner + bench-depth profile (how many auditors supporting the partner? We know smaller firms have PTO-timing risk and want it accounted for in the SOW).
- Indicative Type II quote.
- Evidence-portal strategy (can you work from our `docs/compliance/*.md` layout, or do we adopt your tool?).

**Reply by:** T+14 business days.

Thanks,
Matthew
Arkova

---

## Reply-processing checklist

- [ ] Log receipt date in [docs/compliance/vendor-register.md](./vendor-register.md).
- [ ] Check hard requirements R1–R6 from [soc2-auditor-shortlist.md §Hard requirements](./soc2-auditor-shortlist.md#hard-requirements).
- [ ] Score each surviving proposal on the 100-point rubric.
- [ ] Highest scorer ≥75/100 → SOW negotiation. Tie-break on partner continuity for Type II, then price.
- [ ] Send polite declines to non-selected firms (§Decline template).

---

## Decline email

Use the shared template at [docs/compliance/rfp-decline-email-template.md](./rfp-decline-email-template.md). Subject line: `Arkova SOC 2 readiness RFP — decision`.

---

## Manual-followup email

Per CLAUDE.md MANUAL-FOLLOWUP EMAIL MANDATE, send `carson@arkova.ai` an inbox note on RFP-send day confirming: send date, reply-by date, links back to [soc2-auditor-shortlist.md](./soc2-auditor-shortlist.md) + this draft, T+15 scoring-meeting calendar hold, and budget approval confirmation (readiness $8K–$18K).
