# RFP Decline Email — Shared Template

**Purpose:** One template reused across all vendor RFP workflows (pentest, SOC 2 auditor, cyber-insurance carrier, etc.) so non-selected firms receive a consistent, polite decline that doesn't burn future bridges.

**Referenced by:**
- [docs/compliance/pentest-rfp-email-draft.md](./pentest-rfp-email-draft.md)
- [docs/compliance/soc2-rfp-email-draft.md](./soc2-rfp-email-draft.md)

---

## Template

**Subject:** Arkova [RFP type] — decision

Hi [firm] team,

Thanks for the thoughtful proposal. We've decided to proceed with a different firm for this engagement, primarily driven by [earliest-start-date / pricing / scope fit / partner continuity / evidence-portal fit]. Your proposal was strong on [specific strength] and we'd welcome the chance to re-engage for [retest window / year-2 rotation / adjacent scope — e.g. "ISO 27001 in Q3", "red-team engagement", "cyber-insurance renewal"].

Happy to share specific feedback on request.

Best,
Matthew
Arkova

---

## Usage rules

- Send within 5 business days of the selection decision.
- Always pick **one** primary driver (not a list) — vendors read multi-driver declines as evasive.
- Always name a specific strength. Never use "overall quality" or similar filler.
- Always keep the door open for a plausible future scope.
- Never disclose the winning firm or the winning proposal numbers.

---

## Manual-followup email (per CLAUDE.md)

After all declines are sent, log in [vendor-register.md](./vendor-register.md) under the RFP section: firms RFP'd, scores, selected firm, decline-send date. Then email `carson@arkova.ai` with the final vendor pick + contract countersign ETA.
