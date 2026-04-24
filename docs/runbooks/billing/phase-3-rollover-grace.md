# Billing Phase 3 runbook — rollover, grace, anchor-fee credits, parent-split

**Stories:** [SCRUM-1164](https://arkova.atlassian.net/browse/SCRUM-1164)
(rollover), [SCRUM-1165](https://arkova.atlassian.net/browse/SCRUM-1165)
(anchor-fee credits), [SCRUM-1166](https://arkova.atlassian.net/browse/SCRUM-1166)
(3-day grace), [SCRUM-1167](https://arkova.atlassian.net/browse/SCRUM-1167)
(parent-delinquent split-off)

**Last updated:** 2026-04-24

This runbook covers the Phase 3a schema that shipped in migration 0252
and the Phase 3b worker/UX work that follows.

## Schema shipped (Phase 3a, migration 0252)

| Object | Purpose |
|---|---|
| `organizations.payment_state` | NULL / `grace` / `suspended` / `ok` |
| `organizations.payment_grace_expires_at` | authoritative 3-day timer |
| `organizations.payment_state_updated_at` | audit timestamp |
| `org_monthly_allocation` | one row per org per calendar month (base + rolled-over + used + anchor_fee_credits) |
| `parent_split_tokens` | single-use signed-link tokens for sub-org split-off |
| `roll_over_monthly_allocation(uuid)` RPC | cycle-close: writes next period with carry capped at 3× base |
| `start_payment_grace(uuid)` RPC | Stripe `invoice.payment_failed` → set 3d timer |
| `clear_payment_grace(uuid)` RPC | Stripe `invoice.payment_succeeded` → clear timer |
| `expire_payment_grace_if_due()` RPC | cron sweep → flip `grace` → `suspended` when timer elapses |

## Env vars

| Name | Default | Notes |
|---|---|---|
| `ENABLE_ALLOCATION_ROLLOVER` | `true` | Set `false` to disable the monthly rollover job. |
| `ENABLE_GRACE_EXPIRY_SWEEP` | `true` | Set `false` to disable the grace-expiry cron. |

## Rollover math

```
carry = max(0, base_allocation + rolled_over_balance − used_this_cycle)
carry = min(carry, 3 × base_allocation)   -- cap at 3× base
```

Rationale for the 3× cap:

- Prevents unbounded hoarding (an admin who never anchors for a year
  shouldn't end up with 3000 anchors on tap from a 250-anchor tier).
- Matches the intent of "rollover is a buffer for quiet months, not an
  asset to accumulate."

Mid-cycle seat changes do NOT rewrite the current period. Seat
add-at-cycle-day-15 gets pro-rata for the current cycle (app-layer
increment on `base_allocation`); seat remove-at-cycle-day-15 keeps its
allotment available until cycle close, then the next `base_allocation`
drops by that seat's share.

## Payment grace lifecycle

```
payment_state   triggers
NULL            healthy (default)
grace           set by start_payment_grace after invoice.payment_failed
ok              temporary sentinel post-clear; normalised to NULL in
                subsequent invoice.payment_succeeded events
suspended       set by expire_payment_grace_if_due cron when the timer
                elapsed; queue runs + anchor writes return 402
```

- Queue runs pause.
- Anchor writes return 402.
- Read APIs + public org page stay open.
- After 30 days in `suspended`, cron notifies Carson (platform admin);
  do NOT auto-delete.

## Anchor-fee credits (SCRUM-1165)

`org_monthly_allocation.anchor_fee_credits` is the prepaid balance
that is consumed **after** base + rolled. Checkout creates a pack
purchase that increments this column via a dedicated RPC (lands in
Phase 3b).

Consumption order on each anchor:

1. `base_allocation`
2. `rolled_over_balance`
3. `anchor_fee_credits`
4. hard-fail → queue parks in `PENDING_FUNDING`

## Parent-delinquent split-off (SCRUM-1167)

Schema only in this PR. The Phase 3b flow:

1. `expire_payment_grace_if_due` transitions parent to `suspended`.
2. The same cron iterates child orgs and issues a `parent_split_tokens`
   row per sub-admin; the row's `token_hash` is HMAC-SHA256 of the
   signed link we email.
3. Email (via Resend, `services/worker/src/emails/parent-delinquent-split.ts`)
   contains the signed link pointing at `POST /api/v1/org/split-from-parent`.
4. The landing flow clones members, rules, anchored records, keeping the
   sub-org's `public_id` so external links still resolve. New anchors
   bill to the new stand-alone org.

Legal gate: confirm FCRA audit-trail transfer does not require
re-consent from upstream counterparties. Flagged in the story.

## Cron wiring (Phase 3b)

Cloud Scheduler jobs to add:

| Job | Schedule | Hits |
|---|---|---|
| `monthly-allocation-rollover` | `0 0 1 * *` (1st of month UTC) | `POST /jobs/monthly-allocation-rollover` |
| `grace-expiry-sweep` | every 15 minutes | `POST /jobs/grace-expiry-sweep` |

Both endpoints land with the existing `CRON_SECRET` / OIDC pattern used
by the other CIBA jobs.

## Runbook: manual grace start (ops override)

```sql
SELECT start_payment_grace('<org-uuid>');
```

Then post an update to the treasury Slack channel explaining why.

## Runbook: manual grace clear

```sql
SELECT clear_payment_grace('<org-uuid>');
```

## Runbook: dry-run the rollover for one org

```sql
SELECT * FROM org_monthly_allocation WHERE org_id = '<org-uuid>' ORDER BY period_start DESC LIMIT 3;
SELECT roll_over_monthly_allocation('<org-uuid>');
SELECT * FROM org_monthly_allocation WHERE org_id = '<org-uuid>' ORDER BY period_start DESC LIMIT 3;
```

## References

- Migration: `supabase/migrations/0252_billing_rollover_grace.sql`
- Rollover job: `services/worker/src/jobs/monthly-allocation-rollover.ts`
- Confluence (SCRUM-1164): <https://arkova.atlassian.net/wiki/spaces/A/pages/26476545>
- Confluence (SCRUM-1165): <https://arkova.atlassian.net/wiki/spaces/A/pages/25657400>
- Confluence (SCRUM-1166): <https://arkova.atlassian.net/wiki/spaces/A/pages/26509313>
- Confluence (SCRUM-1167): <https://arkova.atlassian.net/wiki/spaces/A/pages/25919515>
