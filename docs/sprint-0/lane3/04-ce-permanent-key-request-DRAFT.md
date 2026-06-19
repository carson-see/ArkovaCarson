# CE Permanent-Key + Sandbox Request — DRAFT (Carson sends)

> **STATUS: DRAFT for Carson to send.** The train does NOT send partner email (pre-mortem PM-4 — outward-facing, irreversible). This is a paste-ready draft; Carson edits the specifics (exact dates, paid-tier intent) and sends.
> **Why now:** the CE 3-month Complimentary Evaluation & API Trial Agreement (executed 6/9/2026) auto-expires **~2026-09-09** (risk R-1, FATAL). Securing the continuation path + a stable key in custody before the cliff is the entire point of S0-7.2.
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

## Internal notes (not part of the email)
- **Owner:** Carson is the relationship + send owner; Jeanne holds the keys/agreement.
- **Overdue Arkova action (from the 6/16 sync):** the dev-questions list owed to Jeff Grann — fold it in or send separately.
- **After send:** log the request + date in the S0-E7 external-gate tracker (SCRUM-2523) and the KEY-EXPIRY inventory (doc 01 §3); set the rotation alert once the exact expiry date comes back.
- **Do not** state or imply: credentials "listed in the Registry," live Registry publishing, credential-level CTIDs, or signed W3C VC issuance — none are true today (doc 03 claims-review).
