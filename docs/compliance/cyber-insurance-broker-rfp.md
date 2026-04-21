# Cyber Liability Insurance — Broker RFP

> **Version:** 1.0 | **Created:** 2026-04-21 | **Owner:** Carson
> **Jira:** SCRUM-961 (TRUST-03) | **Pairs with:** `cyber-insurance-checklist.md`
> **Target:** $3M-$5M cyber + E&O coverage bound by **2026-06-15**

---

## Purpose

A customer MSA negotiated in Q2 2026 will require Arkova to show a
bound cyber-liability policy with minimum $3M coverage + E&O carve-out.
The internal checklist (`cyber-insurance-checklist.md`) captures what
we need; this RFP is the outbound packet to send to brokers so we can
get quotes from the four carriers enterprise buyers actually recognise.

## How to use this document

1. Carson sends Section 4 as an email to each of the four listed
   brokers. Inbox notification to `carson@arkova.ai` triggers the
   outbound send date.
2. Brokers reply with quotes within 10 business days. Paste quotes
   into Section 5.
3. Present top-2 quotes to the board at the Q2 review (target
   2026-05-20). Board approves one; Carson signs application + pays
   first premium. Policy-bound date lands in Section 6.
4. Addendum language from Section 7 goes into the MSA template.

## 1. Target coverage

| Dimension | Minimum | Preferred |
|-----------|---------|-----------|
| Per-claim limit | $3,000,000 | $5,000,000 |
| Aggregate limit | $3,000,000 | $5,000,000 |
| Retention (deductible) | $25,000 | $10,000 |
| Coverage territory | United States | Worldwide (incl. EU, KE, AU, SG) |
| Waiting period (business interruption) | 12 hours | 8 hours |
| First-party scope | Cyber extortion, data restoration, business interruption, notification costs | + Reputational harm, regulatory defence |
| Third-party scope | Privacy liability, network security, media liability, errors & omissions | + IP infringement up to $500k |
| Retroactive date | Policy inception | ≥ 6 months pre-inception |

## 2. Arkova risk profile (one-pager attached to every outreach)

- **What we do:** Credential verification platform with
  client-side-only document processing. SHA-256 fingerprints are
  anchored to Bitcoin mainnet. Zero raw documents server-side.
- **Data classification:** No payment-card data (PCI stays with
  Stripe). No HIPAA PHI server-side (architecture blocks). Only
  anchored fingerprints + metadata + auth email addresses.
- **Jurisdictions:** US (federal + 9 state frameworks), Kenya, EU
  (GDPR), Singapore, Australia, Mexico, Colombia, Thailand, Malaysia.
- **Current controls evidence:** SOC 2 Type II observation starts
  2026-06-01 (see SCRUM-959). Annual CREST pentest (SCRUM-962).
  Cyber Essentials Plus UK readiness checklist live (SCRUM-978).
- **Customer size:** Small / mid-market through enterprise education
  + professional services.
- **Revenue (projected Year 1):** <$1M; quote accordingly.

## 3. Brokers / carriers to solicit

| Carrier | Why on the list | Contact |
|---------|-----------------|---------|
| **Beazley** | Industry leader for SaaS cyber; Breach Response service is the benchmark. | <cyber@beazley.com> |
| **Chubb** | Mid-market sweet spot; good at customising retention. | <chubbcyber@chubb.com> |
| **Hiscox** | Strong E&O carve-out for software companies; flexible on retroactive dates. | <cyberuw@hiscox.com> |
| **AIG (CyberEdge)** | Enterprise brand recognition — procurement teams accept without question. | <cyberedge@aig.com> |

If existing broker relationships exist, add them to Section 5 and
quote from them as well; treat this list as the mandatory minimum, not
a cap.

## 4. Outbound email template

```
Subject: Cyber + E&O RFP — Arkova, Inc. ($3M-$5M coverage, Q2 2026 bind target)

Hi [broker],

Arkova is a credential verification SaaS preparing to bind our first
cyber-liability + E&O policy. We are seeking $3M-$5M per-claim /
aggregate with a retroactive date at or before policy inception, bound
by 2026-06-15.

One-pager on our risk profile is attached. Short version:

  - Client-side-only document processing — no raw PII ever hits our
    servers. Only SHA-256 fingerprints + metadata.
  - SOC 2 Type II observation window opens 2026-06-01.
  - Annual CREST-accredited pen test, Cyber Essentials Plus UK
    readiness, vendor-managed Postgres (Supabase) + Cloud Run + CF.
  - Revenue projected <$1M Year 1.

Can you confirm:
  1. Able to quote by 2026-05-10?
  2. Minimum / preferred retention you would offer on $3M / $5M limits?
  3. Whether your breach-response panel covers EU (GDPR), Kenya DPA,
     APPI, and POPIA.
  4. Whether IP-infringement coverage can be added to $500k limit.

Happy to answer questions live. Calendar: https://cal.com/arkova/cyber-rfp

Carson Seeger
CEO, Arkova
carson@arkova.ai
```

## 5. Quote log

| Broker | Received | Limit | Retention | Premium (annual) | Notes |
|--------|----------|-------|-----------|------------------|-------|
| Beazley | _pending_ | | | | |
| Chubb | _pending_ | | | | |
| Hiscox | _pending_ | | | | |
| AIG CyberEdge | _pending_ | | | | |

## 6. Selected policy (filled after bind)

| Field | Value |
|-------|-------|
| Carrier | _tbd_ |
| Policy number | _tbd_ |
| Effective date | _tbd (target 2026-06-15)_ |
| Expiration date | _tbd_ |
| Per-claim limit | _tbd_ |
| Aggregate limit | _tbd_ |
| Retention | _tbd_ |
| Retroactive date | _tbd_ |
| Certificate PDF | `docs/compliance/evidence-binder/2026-Q2/cyber-certificate.pdf` |
| MSA addendum text | _see Section 7_ |

## 7. MSA addendum template (fills on bind)

> **14. Insurance.** During the Term, Arkova will maintain in force
> cyber-liability and errors-and-omissions insurance with a per-claim
> limit of not less than $[X],000,000 and an aggregate limit of not
> less than $[X],000,000. Upon Customer's written request, Arkova will
> furnish a certificate of insurance evidencing the foregoing coverage
> naming Customer as a certificate holder (but not as an additional
> insured). Arkova's failure to maintain the required coverage is a
> material breach of this Agreement.

## 8. Ongoing maintenance (post-bind)

- **Renewal reminder:** 60 days before expiration → carson@arkova.ai.
- **Certificate-of-insurance request automation:** build a
  self-service COI link for customers so procurement asks don't block
  deals. Deferred until policy is bound (follow-up story).
- **Incident trigger:** on any Sev1 security incident, notify carrier
  within 24 hours (matches `incident-response-plan.md` Section 8).

## 9. Change log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-21 | Claude / Carson | Initial RFP (SCRUM-961 TRUST-03). |
