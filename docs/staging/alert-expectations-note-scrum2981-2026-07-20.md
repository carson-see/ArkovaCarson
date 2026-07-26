# Alert Expectations Note — SCRUM-2981 (for the founder)

**From:** Release/Train lane (RTE), 2026-07-20 watch window. **Purpose:** so you know, going into the 24h window and the pre-8/10 push, which alerts are *expected true-positives*, which are *known noise being fixed*, and where each one routes. Read this before reacting to a page.

## TL;DR
Three monitors are live in prod. **One will legitimately fire during the window (the pipeline dead-man — it's a true positive on the founder-gated drain backlog).** One route (`refresh-stats`) is emitting known 500s that are *already root-caused with a fix PR open* — do not treat those as a new incident. Everything else should be quiet.

## Live monitors + what to expect

| Monitor | Wired | Expected behavior this window | Signal vs noise |
|---|---|---|---|
| **Pipeline-throughput dead-man** (SCRUM-2901, #1571) | Cloud Scheduler `pipeline-throughput-monitor` */30, OIDC → worker, Sentry capture | **WILL fire** — 261,934 unlinked public_records, oldest ~87d, lastSecured ~45h. This is the paused-feeder backlog you gated. | **TRUE POSITIVE, expected.** Not a regression. It correctly detects the drain you chose to pause. Silence it by resuming feeders (treasury decision), not by touching the monitor. |
| **db-health-monitor** (BUG-011, fixed 07-17) | Scheduler → `/jobs/db-health` (was pointing at nonexistent `/cron/db-health` = guaranteed 404) | Quiet / 200s | Was the long-standing "code 5" false alarm; now fixed. A fire here would be a real DB-health event. |
| **refresh-stats 500s** (SCRUM-2974, fix PR #1584 open) | Cloud Scheduler `refresh-stats` */5 → `/jobs/refresh-stats` | **~30% of firings 500** under drain load (statement-timeout, not a code regression). Dashboard cache stays fresh regardless. | **KNOWN NOISE — do NOT escalate.** Root-caused (monolithic RPC outruns the 120s gateway under drain). Fix PR #1584 is Draft, T2 soak pending. The 500s are scheduler noise + masked signal, not user impact. |

## Also on the radar (not yet paging, triaged separately)
- `/jobs/fetch-courtlistener` 504s at exactly 3599.7s = Cloud Run request-timeout ceiling (upstream fetch hang). SCRUM-2975 filed; separate mechanism, own diagnosis. If a courtlistener alert exists it will be a 504, not a 500.
- Brief JWT `ERR_JOSE_ALG_NOT_ALLOWED` noise in worker logs during the drain window — not an incident.

## Routing reality (be aware)
- Sentry is the capture sink for the dead-man; PII scrubbing is mandatory (§1.1). The dead-man's Sentry path was proven end-to-end on its first live run.
- **Atlassian/Jira alert-rule wiring is NOT confirmed this session** — the Atlassian MCP is unauthorized in this non-interactive session, so I could not verify or create Jira-side alert automations. If you want alerts to auto-open Jira issues, that wiring is owed and needs an interactive/authorized session. Flagged as a follow-up.
- No PagerDuty/Datadog escalation policy verified as connected (those MCPs require auth). If you expect phone-paging, confirm the escalation policy exists before relying on it.

## What I recommend you do
1. Expect the pipeline dead-man to fire; treat it as the backlog reminder, not a bug.
2. Ignore refresh-stats 500s until #1584 soaks + merges.
3. If you want Jira/PagerDuty auto-routing before 8/10, authorize the Atlassian (+ PagerDuty) connector in an interactive session so the wiring can be built and tested — it is not verifiable from here.

_Finalize SCRUM-2981 with the confirmed routing table once connector access is available. Draft published as a W2 docs carve-out._
