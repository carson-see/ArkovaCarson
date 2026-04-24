# Org, Rules, API, and Pipeline Accountability - 2026-04-24

This note mirrors the April 24, 2026 incident and product requirements into
the codebase. Jira remains the canonical backlog, but this file keeps the
implementation map next to the code reviewed in the pipeline PR.

## Jira Backlog Items

- `SCRUM-1124` - Production Bitcoin anchoring queue must never stall behind per-transaction batching limits.
- `SCRUM-1125` - Public and private organization profiles with member privacy and sub-org visibility.
- `SCRUM-1126` - Smart queue rules and version control for automatic document anchoring.
- `SCRUM-1127` - Make the API usable for API-key users and agents across search, records, fingerprints, documents, and organizations.

## Implementation Update - SCRUM-1125 Through SCRUM-1127

Completed in this PR:

- Public org profiles now return verified status, safe public members,
  anonymized private members, and approved sub-organizations from
  `get_public_org_profile`.
- Public members with `is_public_profile = true` are clickable and render
  through the new `/profile/:profileId` public route.
- Private org profiles now expose Rules, Queue, and notification badge entry
  points alongside existing records, settings, revoke, and member management.
- Rule writes are now org-admin-only on the worker, not just hidden in the UI.
- Rules can be listed, opened, edited, enabled/disabled, and deleted. Full
  trigger/action configs are fetched one scoped rule at a time.
- Rule firing and queue resolution emit org-admin notifications so private
  org pages can surface queue/job/version-review activity.
- API-key clients now have direct v2 search aliases for organizations,
  records, fingerprints, and documents in addition to `/api/v2/search`.

Still tracked as follow-up work before production can claim the full product
contract:

- `SCRUM-1129` - Add an org-scoped manual `Run anchoring job` endpoint/button with an admin
  guard. The existing batch anchor job is platform/global, so exposing it as-is
  would be unsafe.
- `SCRUM-1130` - Add a durable 24-hour org queue scheduler with last-run tracking and
  idempotency keys.
- `SCRUM-1131` - Replace JSON config editing with first-class form controls for each rule
  type once connector setup UX is finalized.
- `SCRUM-1132` - Expand the v2 API from search aliases into read/detail endpoints for any
  resource agents need to inspect after search.
- `SCRUM-1133` - Add a full notification center so users can review queue,
  anchoring job, and version-review notifications instead of only seeing a badge.

## Pipeline And Bitcoin Anchoring Rules

- One Bitcoin transaction can carry up to 10,000 anchors; batch sizing must use
  a shared constant instead of page-local or job-local magic numbers.
- Pipeline records are not counted as Bitcoin-anchored until their anchor has a
  Bitcoin transaction id.
- Already-submitted or secured duplicate anchors should be linked to matching
  public records instead of broadcasting another transaction.
- A job run must claim anchors before broadcast so concurrent workers cannot
  publish the same anchors twice.
- Failed broadcasts must release claimed anchors back to pending status.
- Pipeline metrics must separate unlinked records, queued anchors,
  broadcasting anchors, submitted anchors, secured anchors, and embedded records.

Code touched in this PR:

- `services/worker/src/jobs/anchor-batching.ts`
- `services/worker/src/jobs/batch-anchor.ts`
- `services/worker/src/jobs/publicRecordAnchor.ts`
- `services/worker/src/jobs/publicRecordEmbedder.ts`
- `services/worker/src/api/admin-pipeline-stats.ts`
- `src/pages/PipelineAdminPage.tsx`
- `supabase/migrations/0242_pipeline_anchoring_scale.sql`
- `supabase/migrations/0243_scale02_anchor_disk_hygiene.sql`

## Organization Page Contract

Public viewers must be able to see the organization name, logo/profile picture,
verified badge, banner, website/social links, about text, public members,
and sub-organizations. Member names must be anonymized unless the person has a
public profile, and public-profile members must be clickable.

Organization members/admins should see the same base page with private controls:
anchored records, anchoring queue, settings, rules view/edit, document revoke,
member management, notifications for queue/job/version-review events, and the
user-facing action label `Secure Document`.

Current code inventory:

- Public org registry: `src/pages/IssuerRegistryPage.tsx`
- Private org profile: `src/pages/OrgProfilePage.tsx`
- Member list hook: `src/hooks/useOrgMembers.ts`
- Sub-org API: `services/worker/src/api/v1/orgSubOrgs.ts`
- Notification dispatch: `services/worker/src/notifications/dispatcher.ts`

## Rules And Smart Queue Contract

Org admins must be able to define rules for local folders, Google Drive,
Microsoft 365, DocuSign, and vertical workflows such as law firms and
recruiting firms. A watched new or updated document should notify admins and
enter the anchoring queue automatically. DocuSign documents should enter the
queue only after all counterparties sign.

Queue execution rule: the queue runs when an org admin manually presses Run or
every 24 hours, whichever happens first. Only organization admins can manually
trigger an anchoring job. Multiple versions of the same external document must
go through version review before the chosen version anchors.

Current code inventory:

- Rule schemas/evaluation: `services/worker/src/rules/`
- Rule CRUD routes: `services/worker/src/api/rules-crud.ts`
- Rules engine cron: `services/worker/src/jobs/rules-engine.ts`
- Connector event schemas: `services/worker/src/integrations/connectors/schemas.ts`
- Version review UI: `src/pages/AnchorQueuePage.tsx`

## API Contract

API-key users and agent clients need one predictable API surface to search and
inspect organizations, records, fingerprints, and documents. Public IDs should
be returned instead of internal database IDs wherever possible, stale schema
columns must not be queried, and scope failures must be explicit.

Code touched in this PR:

- `services/worker/src/api/v2/search.ts`
- `services/worker/src/api/v2/scopeGuard.ts`
