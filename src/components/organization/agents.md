# agents.md — components/organization
_Last updated: 2026-05-30_

## What This Folder Contains
Organization-level admin components: credential issuance, member management, review queue, and public registry.

## Key Files
- `IssueCredentialForm.tsx` — ORG_ADMIN dialog to issue credentials with type, label, dynamic metadata fields from template, and optional recipient email
- `MembersTable.tsx` — Organization members table with role, status, and management actions
- `InviteMemberModal.tsx` — Invite new members by email
- `AddExistingMemberModal.tsx` — Add existing Arkova users to the org
- `ReviewQueue.tsx` — Admin review queue for flagged credentials: approve/investigate/escalate/dismiss (EU AI Act human-in-the-loop)
- `OrgRegistryTable.tsx` — Public registry of org-issued credentials. Handles all four states (SCRUM-1999): loading skeletons, empty ("No records found"), explicit fetch-error banner with Retry, and permission-denied banner (42501 / `insufficient_privilege`, no retry) — both rendered in the mobile and desktop layouts. Error copy lives in the local `REGISTRY_STATE_COPY` constant.
- `CreateOrgDialog.tsx` — Organization creation dialog
- `RevokeDialog.tsx` — Credential revocation confirmation dialog
- `index.ts` — Barrel exports

## Dependencies
- `@/hooks/useReviewQueue` — review queue data and actions
- `@/components/anchor/IntegrityScoreBadge` — integrity display in review queue
- `@/lib/copy` (ORG_PAGE_LABELS, REVIEW_QUEUE_LABELS) — UI strings

## Do / Don't Rules
- DO: Use "Issue Credential" only for the restricted verified-organization credential issuance flow (SCRUM-1672)
- DO NOT: Use "Issue Credential" for the universal document-securing action — use "Secure Document" instead
- DO: On a data-fetch failure, set an explicit error state and render the error/permission banner instead of `console.error`-ing and falling through to the empty state (SCRUM-1999). Detect permission denials with the `42501` / `insufficient_privilege` predicate (mirrors `useRevokeAnchor.ts`).
