# Community & Brand Launch Playbook

**Confluence mirror:** [Top-10 Sprint Batch 3 — 2026-04-17 §1](https://arkova.atlassian.net/wiki/spaces/A/pages/13795329) — "Launch Playbook — GEO-09 (SCRUM-477)"
**Jira:** [SCRUM-477 / GEO-09](https://arkova.atlassian.net/browse/SCRUM-477)
**Last updated:** 2026-04-17
**Owner:** Carson (marketing)
**Engineering status:** Scaffolding complete; external content work outstanding. The `sameAs` array in the Organization JSON-LD at `arkova-marketing/index.html` already advertises 5 canonical profiles (wikidata, linkedin, x, youtube, github). Each net-new community profile requires a **follow-up PR** appending its canonical URL to `sameAs`.

---

## How to use this document

This is the external-marketing operator's playbook. It exists so that launching on ProductHunt / Reddit / G2 / Crunchbase is a checklist, not a planning exercise.

Five concrete steps:

1. **Prepare the launch kit** (§Launch kit). Assets needed: logo SVG + PNG, 3 screenshots, 90-word description, 250-word description, tagline, founder bio.
2. **Schedule each channel** (§Channel-specific playbooks). Don't launch on the same day — stagger across 3 weeks so each post gets its own news cycle.
3. **Execute launch + monitor** — respond to every comment within 4 hours during launch day.
4. **Append new profile URL to `sameAs`** — open a small PR editing `arkova-marketing/index.html` lines 54-60. Re-validate with Google Rich Results Test.
5. **Log outcome** — update this file's §Outcome tracker with the profile URL, launch date, and 30-day engagement metric.

After all four channels launch, SCRUM-477 can transition to Done.

---

## Launch kit (assemble once, reuse everywhere)

| Asset | Spec | Source |
|-------|------|--------|
| Logo (SVG) | 1:1 square, transparent bg | `arkova-marketing/public/logo.svg` |
| Logo (PNG) | 512×512, transparent bg | export from SVG |
| Product screenshots | 1600×900 PNG, real data only (no demo users) | capture from `app.arkova.ai` |
| Tagline | ≤60 chars | "Proof of record, not promise of record." |
| 90-word description | Elevator pitch | see §Copy |
| 250-word description | For Crunchbase / G2 / ProductHunt long | see §Copy |
| Founder bio | 100 words | carson@arkova.ai |

**Never** use demo-user screenshots for launch assets. Re-use the real-tenant captures already produced for the Kenya ODPC filing (`docs/compliance/kenya/odpc-registration.md`).

### Copy: 90-word description

> Arkova is a verification platform that turns credentials, records, and documents into tamper-evident proofs. Documents never leave the user's device — fingerprints and PII-stripped metadata flow to our server, anchor to a permanent public network, and return a verifiable receipt that any counterparty can check in a browser. Client-side processing means we don't hold the original document; the receipt is what buyers, auditors, and regulators rely on. Built for credential issuers, background-check providers, and compliance teams operating under FERPA, HIPAA, GDPR, and Kenya DPA.

### Copy: 250-word description

> Most verification tools either require the verifier to upload the document (creating a new privacy surface) or rely on a trusted central ledger (creating a new single point of failure). Arkova takes a third path: the document is processed entirely in the user's browser, a cryptographic fingerprint is generated locally, and only the fingerprint plus PII-stripped metadata is anchored to a permanent public network. Verifiers receive a public receipt they can validate against that network directly — without Arkova in the loop at verification time.
>
> Under the hood we combine schema-first data modelling (Supabase + RLS on every table), client-side OCR and PII stripping (PDF.js + Tesseract.js), GCP KMS-signed network receipts, and a verification API that returns a signed proof bundle with timestamps, jurisdiction tags, and downstream attestations.
>
> Customers use Arkova for:
>
> - Employment and education verification where the employer cannot (legally) keep the original document on file.
> - Background-check providers who want a single API for credential anchoring across 1.4M+ public records.
> - ATS integrations (webhook, SDK, MCP).
> - International compliance operators subject to FERPA, HIPAA, FCRA, GDPR, Kenya DPA, APP, POPIA, PDPA, APPI, PIPEDA.
>
> 1.41M+ records are already secured on our production network. The client-side processing boundary is a foundational privacy guarantee, not a configuration flag.

---

## Channel-specific playbooks

### 1. ProductHunt

**Prep:** 2 weeks out — build Coming-Soon page at producthunt.com/products/arkova. Pre-seed 50 upvoters via founder network.
**Launch day:** Tuesday 12:01 AM PT (resets at midnight PT; early matters).
**Gallery:** 8 images — hero + 6 screenshots + 1 GIF.
**Topics:** SaaS, Security, Developer Tools, AI (choose 3).
**Comments:** reply to every first comment within 1 hour. Keep founder (Carson) as commenter, not growth-hacker persona.
**Post-launch `sameAs` append:** `https://www.producthunt.com/products/arkova` — PR against `arkova-marketing/index.html` lines 54-60.

### 2. Reddit

**Subreddits:** r/startups, r/Entrepreneur, r/SaaS, r/selfhosted (for the client-side processing angle), r/privacy.
**Rules:** never link-drop. Each subreddit gets a custom post — r/privacy focuses on the client-side fingerprinting boundary; r/startups focuses on go-to-market. Read each subreddit's rules; most ban self-promo in first N posts.
**Timing:** space 5 business days apart.
**Founder account:** `/u/arkova-carson` (or existing account with karma). Do **not** create a new throwaway.
**Post-launch `sameAs` append:** Reddit does not expose a canonical `sameAs` target for a founder's account; skip Reddit for `sameAs`.

### 3. G2

**Type:** Product listing (free).
**Category:** "Background Check Software" + "Identity Verification Software" + "Compliance Software".
**Required fields:** product description, pricing (link to `app.arkova.ai/pricing`), screenshots, logo, 3 initial reviews (solicit from beta customers, disclose G2's review gating).
**Time to listing live:** 5-10 business days once submitted.
**Post-launch `sameAs` append:** `https://www.g2.com/products/arkova` (exact slug confirmed at listing-live).

### 4. Crunchbase

**Type:** Company profile.
**Required fields:** founding date, founders, funding rounds (mark "bootstrapped"), headquarters, description, categories (choose: SaaS, Security, Compliance).
**Acquisition-intel note:** Crunchbase is also used by M&A bots — keep the description accurate, not embellished. Don't claim investors we don't have.
**Post-launch `sameAs` append:** `https://www.crunchbase.com/organization/arkova`.

---

## Post-launch `sameAs` update procedure

Each launched profile returns a canonical URL. Append each URL to the Organization `sameAs` in `arkova-marketing/index.html` (not the main app `index.html` — marketing site is a separate repo / bundle).

```html
<!-- arkova-marketing/index.html, inside the Organization JSON-LD -->
"sameAs": [
  "https://www.wikidata.org/wiki/Q138765025",
  "https://www.linkedin.com/company/arkovatech",
  "https://x.com/arkovatech",
  "https://www.youtube.com/channel/UCTTDFFSLxl85omCeJ9DBvrg",
  "https://github.com/carson-see/ArkovaCarson",
  "https://www.producthunt.com/products/arkova",         // after PH launch
  "https://www.g2.com/products/arkova",                  // after G2 listing live
  "https://www.crunchbase.com/organization/arkova"       // after Crunchbase claim
],
```

**Rules:**

- One PR per added URL — makes it easy to roll back if the profile gets taken down.
- Re-validate with [Google Rich Results Test](https://search.google.com/test/rich-results) after each merge.
- Do **not** add Reddit profile URLs to `sameAs` — Reddit is a forum, not an entity profile.

---

## Outcome tracker

Update this table as each channel launches. Leave blank until live.

| Channel | Launch date | Canonical URL | 30-day upvotes/reviews/mentions | `sameAs` PR | Notes |
|---------|-------------|---------------|---------------------------------|-------------|-------|
| ProductHunt | — | — | — | — | — |
| Reddit r/startups | — | — | — | N/A | — |
| Reddit r/Entrepreneur | — | — | — | N/A | — |
| Reddit r/SaaS | — | — | — | N/A | — |
| Reddit r/privacy | — | — | — | N/A | — |
| G2 | — | — | — | — | — |
| Crunchbase | — | — | — | — | — |

---

## Manual-followup email

Per CLAUDE.md MANUAL-FOLLOWUP EMAIL MANDATE, Carson (marketing) emails `carson@arkova.ai` on each channel launch with: channel name + canonical URL, launch-day engagement summary, link to the follow-up PR that appends the URL to `sameAs` in `arkova-marketing/index.html`, and the updated §Outcome tracker row. One email per channel, not a batched rollup — auditors and procurement may request proof of specific launches.

---

## Definition of Done for SCRUM-477

- [ ] ProductHunt profile live and first 24-hour engagement logged.
- [ ] Reddit posts published in 4 subreddits, no removals.
- [ ] G2 product listing live with ≥3 reviews.
- [ ] Crunchbase profile claimed and populated.
- [ ] `sameAs` in `arkova-marketing/index.html` appended with ProductHunt, G2, Crunchbase URLs.
- [ ] Schema re-validated via Google Rich Results Test.
- [ ] SCRUM-477 transitioned Blocked → Done.
