# CE Permanent-Key + Sandbox Request — HISTORICAL DRAFT (DO NOT SEND)

> **2026-07-13 reconciliation — SUPERSEDED; do not send or reuse as a new request.** The substance below was sent through the existing Jeanne/Jeff channel and Credential Engine answered it on 2026-06-24. CE confirmed that the evaluation ends **2026-09-09** (exact expiry instant/timezone still unknown), said it copied Arkova's account to sandbox and sent an invite, and identified the Developer Agreement plus annual support-tier selection as the continuation path. Receipt/acceptance of the sandbox invite and usable sandbox access were not verified in the reviewed artifacts.
> The current continuation draft is `docs/lane3/s33-ce-escalation-send-packet-draft.md`. It asks for the agreement/tier decision deadline, activation lead time, exact expiry timestamp, and July follow-up; it does **not** repeat the answered sandbox/date request.
> This file is preserved as relationship history only. The founder reserves any external send; technical claims and key/alerting decisions route to the CTO.
> **Claims discipline (§1.5):** the draft states only what is true — consuming-only eval, publishing kept sandbox-gated, no "listed in the Registry" claim. Do not let edits introduce an overclaim.

---

**To:** Jeanne Kitchens (jkitchens@credentialengine.org) — CTSO / relationship owner
**Cc:** Jeff Grann — technical/CTDL counterpart
**Subject:** Arkova — continuation path + key custody ahead of the trial window close (~Sept)

Hi Jeanne (cc Jeff),

Thank you again for the evaluation agreement and the org CTID — the CTDL integration on our side is live and serializing cleanly, and Jeff and I have a good technical rhythm going from the June 16 sync.

As we approach the close of the 3-month complimentary evaluation window (~early September), I want to get ahead of two things so there's no gap:

1. **Continuation / key custody.** What's the cleanest path to a **permanent production consuming key** so our access doesn't lapse at the window close? We're moving the key into managed secret storage with rotation on our side and want the permanent credential in custody well before the deadline rather than at it. If that means moving to the paid Developer Agreement + a support tier, please point me at the options and the timing, and I'll get the decision made on our end with margin.

2. **Sandbox continuity.** Can we keep (or stand up) a **sandbox/non-production key** alongside the production one, so we can keep validating consuming flows against a non-live target without touching the production Registry? We're keeping any Registry **publishing** sandbox-gated for now per the roles you approved (Quality Assurance Org + Competency Framework Org) — this is purely about a safe place to exercise the consuming path.

A couple of small technical confirmations for Jeff while we're here:

- The exact expiry date/time of the current trial credentials (so our rotation alert fires with the right lead time).
- Whether the consuming methods we should build against remain the Graph Search API + offline download as discussed.

Happy to hop on a short call if that's faster. Thanks for making this easy to get right.

Best,
Carson
Arkova

---

## Historical internal notes (not part of the email)

- **Send boundary:** Carson was the relationship sender; the current session reserves only the external send to the founder. Jeanne owns CE's Developer Integration Program; Jeff is the technical/CTDL counterpart.
- **Development questions:** Jeff replied inline on 2026-06-19; do not carry the old “overdue” label forward.
- **June 24 answer:** record 2026-09-09 as the confirmed date, but keep the expiry time/timezone unknown until CE supplies it. Do not invent an alert timestamp.
- **Continuation:** the open item is the Developer Agreement/support-tier decision and activation lead time, not another sandbox/permanent-key request.
- **Do not** state or imply: credentials "listed in the Registry," live Registry publishing, credential-level CTIDs, or signed W3C VC issuance — none are true today (doc 03 claims-review).
