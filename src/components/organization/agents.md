# agents.md — components/organization
_Last updated: 2026-05-16_

## What This Folder Contains
Organization-level admin components: credential issuance, member management, review queue, and public registry.

## Key Files
- `IssueCredentialForm.tsx` — ORG_ADMIN dialog to issue credentials with type, label, dynamic metadata fields from template, and optional recipient email
- `MembersTable.tsx` — Organization members table with role, status, and management actions
- `InviteMemberModal.tsx` — Invite new members by email
- `AddExistingMemberModal.tsx` — Add existing Arkova users to the org
- `ReviewQueue.tsx` — Admin review queue for flagged credentials: approve/investigate/escalate/dismiss (EU AI Act human-in-the-loop)
- `OrgRegistryTable.tsx` — Public registry of org-issued credentials
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
