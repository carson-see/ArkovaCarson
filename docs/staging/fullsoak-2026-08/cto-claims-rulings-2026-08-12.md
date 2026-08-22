# CTO rulings — claims register + open founder-reserved decisions

**Ruled 2026-08-12 by the CTO session, during the Day-0 window of the 7-day SOC2 Type 2 soak.**
Authority: founder delegation ("you're the CTO... we cannot afford a re-soak"), CLAUDE.md §1.13 R-7
(claims-review gate) and §1.5 (measured / asserted / NOT asserted).

**Governing constraint applied to every ruling below:** no ruling may require mutating the frozen soak
rig, the worker, or prod runtime. Decisions are recorded now; remediation code is authored now and
**lands after the window closes** (premortem §6.2) — except where the artifact is a document, which
moves freely. Per premortem §3.5 the PASS criterion is that no claim ends the soak in the state
"not demonstrated and not retracted". **A recorded decision is the pass. Silence is the fail.**

## R-1 — `/nessie/query` priced at $0.010 on `/developers` → **RETRACT** (final)

Nessie is permanently disabled by standing founder directive (2026-08-01) and no work may plan to
activate it. A price attached to a permanently disabled capability is a commercial representation, not
marketing copy. Remove the priced line from `src/pages/DevelopersPage.tsx`. **No conditions, no review
date.** Remediation PR authored and held; it MUST land before launch even if launch precedes the soak
close — a false priced offer must not survive to launch day.

### R-1 STRENGTHENED (same day) — Nessie does not fail closed, and that makes the retraction urgent

Live evidence found after the ruling: `/api/v1/nessie/query` is mounted **unconditionally** at
`services/worker/src/api/v1/router.ts:542` — no flag check, and `ENABLE_NESSIE_*` is not even a row in the
rig's `switchboard_flags`. The endpoint returns **HTTP 200** with a success-shaped body
(`{"results":[],"count":0}`; MCP `nessie_ask` synthesizes `{"answer":"No relevant verified documents were
found…","confidence":0}`).

This is materially worse than the premise R-1 was decided on. The offer is not merely priced-but-dead: a
paying caller receives a **200 success shape** from a capability that is permanently disabled by founder
directive. That reads as "the feature works and found nothing", not "this feature is off". Two consequences,
both mandatory:
1. The `/developers` price line is removed (R-1, unchanged, final).
2. **The endpoint must additionally be gated or removed** — an unconditionally-mounted route for a
   permanently-disabled capability is a live surface, not a dormant one. A 200 that means "off" is the
   fail-open pattern this codebase has been bitten by before.

## R-2 — `/ai/search` priced at $0.010 → **HEDGE with an automatic RETRACT deadline**

Unlike Nessie, semantic search is genuinely under soak: the embedding producer (`/api/v1/ai/embed`)
was located on Day 0, the flag is ON, and `credential_embeddings` is materializing. Ruling:
- The price **stays** only if the Day-7 probes demonstrate semantic (not lexical) retrieval.
- If they do not, this **auto-converts to RETRACT before launch** — no further decision needed, no
  meeting, no escalation. The deadline is the decision.
- **Independently and unconditionally:** the edge MCP `search_credentials` tool falls back to a literal
  `ILIKE %query%` while six surfaces describe it as semantic similarity. That is a misdescription
  regardless of how the soak resolves. Fix the fallback or disclose it in the tool description — the
  status quo is not an option. Tracked as its own remediation item.

## R-3 — Fraud detection asserted "Continuous" to the SOC 2 auditor → **CLOSED, already correct**

Verified live in `docs/compliance/soc2-type2-evidence-matrix.md`: CC3.3 now reads *"Automated fraud
detection is **not operating** — see note ‡"* with frequency *"Automated fraud detection: not operating
— no operating history to test"*, plus a §1.5 measured/asserted/NOT-asserted footnote. The register's
recommended correction had already been implemented. **No action; row closed as CLOSED-VERIFIED, not
HEDGE.** This was the highest-severity item on the register (a false control assertion to an auditor)
and it is not, in fact, open.

## R-4 — G8, the historical proof gap (2,967,774 SECURED anchors, 85.4%, without per-document proof)

**Ruling: publish the limitation. Do not block launch on a backfill.**
- *Measured:* the anchors are genuinely on-chain; the Day-0 census found **zero false-SECURED rows**.
  What is missing is proof **materialisation**, not anchoring.
- *Asserted:* the proof path works for **new** records — demonstrated end-to-end on Day 0 (12/12
  anchors SECURED with 80-byte raw block headers verified against an independent RPC node).
- *NOT asserted:* that historical records carry per-document proofs.
- Actions: (a) state the limitation plainly in customer material and in the HakiChain conversation;
  (b) schedule the backfill **post-launch**; (c) it must **not** run during the soak window (BTC9
  forbids it and PR #2140 is explicitly out of scope for the period).
Rationale for not blocking: a backfill is a bulk mainnet operation whose risk is highest under time
pressure, and the customer-facing guarantee for anything issued from launch onward is already proven.

## R-5 — Schedule (soak closes 2026-08-19T15:51:30Z vs a ~2026-08-17 launch)

The launch **date** is a business decision and remains the founder's. The **evidence rule** is mine and
is binding regardless of which date is chosen:

> The Day-7 pack states the **true elapsed period**. If the launch occurs mid-soak, the pack issued at
> launch says exactly how many days elapsed and which exit criteria are therefore unmet — naming G3
> (offline proof close-out), G4 (7/7 isolation) and G5 (7/7 safety loops) if they are not yet complete.
> **No report will present a partial period under a seven-day heading.** That is the calendar-layer
> hollow soak and it is prohibited.

No decision is required from anyone for this rule to hold; it constrains the report, not the calendar.

## R-6 — Partner provisioning / HakiChain onboarding → **BUILD, do not retract**

Discovered on Day 0: the SCRUM-2990 state machine is implemented and tested (22 tests) but was never
given an HTTP router, so `/api/partner-provisioning` 404s behind an already-mounted fail-closed gate.
Ruling: **wire the router** (org creation + entitlement grant + API key issuance ⇒ T3 by path rule),
soak it **48 h on a separate isolated rig in parallel** with the frozen full-soak window, and convert
the register row from RETRACT-candidate to a true claim. Retracting a partner-onboarding capability
while actively onboarding a partner is the wrong trade when the missing piece is a router over
already-tested logic.

### R-6 AMENDED (same day, after the build) — **the router is necessary but NOT sufficient; the claim is RETRACTED for now**

Building the router (PR #2219) surfaced the real state of the feature, and it invalidates the reasoning
above. Reaching `status = 'provisioned'` **does not deliver a working partner account.** It records that a
platform admin bound an **already-existing** organization to an approved request. Missing end-to-end:

1. **No org creation** — `provisionPartnerAccount` takes `partnerOrgId` as an *input*; the org must be
   created out-of-band and its UUID pasted in. No org-creation path exists.
2. **No API key issuance** — a "provisioned" partner has no credential to call the API with.
3. **No entitlement / credit / quota grant** — the org gets no plan.
4. **No user invite** — nobody at the partner receives a login.
5. **No flag-seeding migration** — `ENABLE_PARTNER_PROVISIONING` fails closed, so the surface is 404 in
   every environment until release-ops seeds the row.

**Amended ruling.** The register row "Partner provisioning is available (HakiChain onboarding)" is
**RETRACTED**, effective now, not converted to a true claim. Internally and to partners the honest
description is: *partner onboarding is administrator-assisted and manual; the request/approve/provision
lifecycle is recorded and audited, and the remaining steps are performed by hand.* PR #2219 stands on its
merit — it gives that lifecycle an authorized, audited front door and closes a genuine gap — but it is
**step 1 of 5**, and the 48 h T3 soak is deferred until the feature can actually deliver an account.
Steps 2–5 are scoped as post-window work.

**Why this amendment exists in writing:** the earlier R-6 reasoned from "the state machine is tested, so
only the router is missing." That was true about the *code layout* and false about the *capability*. A
claim is true when a customer can do the thing, not when the internal lifecycle is representable. Left
uncorrected, this is precisely the ship-the-hook-not-the-feature failure the soak exists to catch — and it
would have shipped inside the soak's own evidence pack.

---

_All six rulings are CTO-final and require no founder action. R-5's launch date and the founder-reserved
account items (npm/PyPI publication, dashboard-only Supabase rig deletions) remain the founder's._
