# Train C Environment Request - 2026-06-11

Status: approval request only. This document does not create services, apply Scheduler jobs, change Supabase, rotate secrets, deploy code, start a soak, or mutate Train A/B.

## Request

Approve a separate Train C soak environment so the DocuSign, Credential Engine, Google Drive, CPE/CLE UI, and CSI/Accredible work can collect evidence without disturbing Train A or Train B.

Current protected lanes:

- `train-a`: active named cron soak, latest local dashboard sample `165 OK / 0 fail`.
- `train-b`: active named cron soak, latest local dashboard sample `165 OK / 0 fail`.

Do not reuse Train A/B services, release evidence roots, Scheduler jobs, Supabase projects, secrets, deploy tags, or mutable queues for Train C.

## Proposed Naming

- Train: `train-c`
- Evidence root: `/Volumes/Extreme/Arkova/release-evidence/train-c`
- Cloud Run service or tag prefix: `train-c`
- Screen session prefix: `train-c-<lane>-soak-<timestamp>`
- Final RC manifest, only after approval and evidence: `docs/staging/rc-manifests/rc-2026-06-11-train-c.json`

## Required Isolation

| Surface | Required state before soak |
| --- | --- |
| Cloud Run | Dedicated Train C service/tag URL for each active lane or a single approved cumulative stack URL. |
| Supabase | Read-only production-safe smoke for non-mutating checks, or an isolated clean mirror when migrations, writes, queues, or org-scoped data are exercised. |
| Scheduler | No production Scheduler apply. Use Train C-only Scheduler job names and target URLs for #1147. |
| Secrets | Use existing approved secret storage paths only through runtime access. No key values in logs, docs, PRs, Jira, Confluence, or screenshots. |
| Queues/webhooks | Train C-only queue/test webhook targets, or explicit read-only N/A. |
| Feature flags | Explicit Train C flag state per lane; no shared staging/prod flag flips. |
| Release evidence | New `train-c` evidence files only. Do not edit Train A/B evidence. |

## Lane Requests

| Lane | Candidate | Environment ask |
| --- | --- | --- |
| CE cumulative stack | #1146 + #1148 | One isolated worker endpoint for CTDL output/Registry smoke. Allow read-only CE Graph Search/GetRecord smoke with redacted logs. No public Registry publishing until SCRUM-2293/2294/2295 decisions pass. |
| DocuSign | #1147 | One Train C Scheduler target and listener-drift endpoint. Declarative config may be tested, but no production Scheduler job should be applied. |
| CPE/CLE UI | #1149 / #1150 | Preview or staging URL sufficient for 1280px and 375px UAT if confirmed UI-only. Escalate to T2 if backend/API behavior is exercised. |
| Google Drive | TBD PR | Feature-flagged isolated staging path for page-token bootstrap, folder matching, queue materialization, review/digest, and file-change-to-queue smoke. |
| CSI/Accredible | #1039 -> #1040 -> #1041 after #1038 | Separate migration-aware lane only if the #1038 foundation is explicitly included. Otherwise keep out of Train C's first soak. |

## Approval Questions

The release owner, Architect, and DB Admin need to answer these before any Train C soak starts:

1. Is Train C allowed to use a single cumulative service for CE #1146/#1148, or must each PR get its own tag URL?
2. Which Supabase project or clean mirror is approved for Train C write/queue evidence?
3. Are Train C Scheduler job names approved for #1147, and who applies them when the gate opens?
4. Is #1151 release tooling included in Train C, or kept as a separate hardening lane?
5. Is Google Drive allowed into the first Train C soak, or does it wait for a dedicated implementation PR?
6. Is CSI/Accredible included only after #1038, or deferred to the next migration-aware train?

## Stop Conditions

Stop or do not start Train C soak if any of these are true:

- Any lane points at Train A/B services, evidence roots, Scheduler jobs, or Supabase projects without explicit re-scope approval.
- Any PR head SHA moves after evidence starts.
- A lane lacks exact deploy provenance, preflight result, smoke result, rollback plan, or evidence file name.
- CE evidence would log secrets, learner PII, fake CTIDs, or unresolved CTDL expiration/credit semantics.
- DocuSign evidence requires applying a production Scheduler job before approval.
- Google Drive evidence requires shared staging/prod feature flag mutation.
- CSI/Accredible evidence requires unapproved migration writes.
