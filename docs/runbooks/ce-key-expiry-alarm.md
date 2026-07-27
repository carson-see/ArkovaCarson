# Runbook — Credential Engine (CE) API key expiry alarm (SCRUM-2902)

> Internal engineering runbook. Canonical story/status: Jira SCRUM-2902. Topic
> doc: Confluence (Switchboard / observability). This file is operational notes,
> not the source of truth.

## What it does

The CE partnership API key / CTID publishing credential has a hard expiry and is
an **R-1 FATAL** launch dependency. `services/worker/src/jobs/ce-key-expiry-alert.ts`
runs daily (Cloud Scheduler → `POST /jobs/ce-key-expiry-check`, 08:00 UTC) and:

| Days until expiry | Window | Sentry level | Fires? |
|---|---|---|---|
| > 30 | `OK` | info | no (silent) |
| ≤ 30 | `T-30` | warning | yes |
| ≤ 14 | `T-14` | warning | yes |
| ≤ 7 | `T-7` | error | yes |
| ≤ 0 | `EXPIRED` | error | yes (continuously) |
| unset / sentinel / unparseable | `SENTINEL` | error | **yes, EVERY run** |

**Fail-LOUD / fail-closed.** If `CE_API_KEY_EXPIRES_AT` is missing, blank, a
sentinel placeholder, or unparseable, the alarm does not go quiet — it treats the
situation as the worst case and pages on every run until a real ISO date is set.
A missing config is indistinguishable from "already lapsed" from the outside.

## event ≠ alert (the critical distinction)

Emitting a Sentry event is **necessary but not sufficient** to reach a human. A
captured event sits silently in Sentry unless a **Sentry issue-alert rule** matches
its tags and routes to a human channel.

- The **event** is emitted by the job with tags
  `source=ce-key-expiry`, `story=SCRUM-2902`, `alert_type=ce_api_key_expiry`,
  `expiry_window`, `days_until_expiry`, at level `warning`/`error`.
- The **alert** is the rule `"SCRUM-2902 — Credential Engine API key expiry"` in
  [`infra/sentry/alert-rules.json`](../../infra/sentry/alert-rules.json): it filters
  `source=ce-key-expiry` AND `level>=warning`, and routes to Slack **`#ops`** with
  tags `story,expiry_window,days_until_expiry`.
- Code↔rule tag parity is enforced at PR time by
  `scripts/ci/check-ce-key-expiry-alert-contract.test.ts` (build fails on drift).

The Sentry MCP **cannot** create issue-alert rules. An admin must create the rule
1:1 in the dashboard, and delivery must be **proven live**, never assumed.

## Wiring + delivery-proof procedure (do all of these — the code is only step 1)

1. **[done in PR]** Job emits the tagged event; rule is declared in
   `infra/sentry/alert-rules.json`; contract test is green.
2. **[SOC2/observability owner]** Create the alert rule in Sentry:
   `https://arkova.sentry.io/alerts/rules/` → project `arkova-worker` → new issue
   alert → conditions/filters/actions exactly matching the JSON entry → Slack
   integration → channel `#ops`.
3. **[SOC2/observability owner]** **Prove delivery (event ≠ alert):**
   - Trigger a real event against **staging** (not prod): temporarily set the
     staging worker's `CE_API_KEY_EXPIRES_AT` to unset/sentinel (or a date ≤7 days
     out) and invoke `POST /jobs/ce-key-expiry-check` with valid cron auth.
   - Confirm the event lands in Sentry **and** that the `#ops` Slack channel
     receives the page carrying `story`, `expiry_window`, `days_until_expiry`.
   - **Capture the Slack message screenshot + the Sentry issue link** and attach to
     SCRUM-2902 / the Bug-Tracker evidence. A captured Sentry event with no Slack
     message = the alert is NOT wired; do not close the story.
   - Restore the staging env var afterward.
4. **[Carson / founder — BLOCKER]** Set the **real** prod `CE_API_KEY_EXPIRES_AT`
   in Secret Manager (≈2026-09-09 per project memory — confirm the exact date from
   the CE trial/renewal contract). Until this is set, prod pages continuously by
   design. Also supply the **demo CTID** used for the CE publish/verify smoke.

## Common operations

- **Silence temporarily** (e.g. planned renewal in progress): set
  `ENABLE_CE_KEY_EXPIRY_ALERTS=false`. Re-enable immediately after — this disables
  the whole safety net.
- **After renewal:** update `CE_API_KEY_EXPIRES_AT` to the new expiry; the alarm
  returns to `OK` (silent) automatically once > 30 days out.

## Founder-reserved items (surfaced per feedback_remind_founder_reserved_items)

- Real `CE_API_KEY_EXPIRES_AT` value (prod Secret Manager).
- Demo CTID for the CE publish/verify smoke.
- CE trial/renewal timing (R-1 FATAL; Jeanne Kitchens / CTSO — trial expiry
  ≈2026-09-09).
