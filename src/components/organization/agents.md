# agents.md — components/organization
_Last updated: 2026-08-18_

## What This Folder Contains
Organization-level admin components: credential issuance, member management, review queue, and public registry.

## Key Files
- `IssueCredentialForm.tsx` — ORG_ADMIN dialog to issue credentials with type, label, dynamic metadata fields from template, and optional recipient email
- `MembersTable.tsx` — Organization members table with role, status, and management actions
- `InviteMemberModal.tsx` — Invite new members by email
- `AddExistingMemberModal.tsx` — Add existing Arkova users to the org. The membership guard queries `org_members` (NOT `org_memberships`, which does not exist — the old name returned PGRST205, silently swallowed, so the guard never fired). Accepts `useAdminEndpoints`: when true (platform admin viewing a foreign org), search + add route through the service_role worker endpoints (`GET /api/admin/users/search`, `POST /api/admin/organizations/:id/members`) instead of RLS-scoped Supabase queries / the `add_org_member` RPC (which checks `auth.uid()` and would reject a non-member admin). Standard org-admin path is unchanged.
- `ReviewQueue.tsx` — Admin review queue for flagged credentials: approve/investigate/escalate/dismiss (EU AI Act human-in-the-loop)
- `OrgRegistryTable.tsx` — Public registry of org-issued credentials. Handles all four states (SCRUM-1999): loading skeletons, empty ("No records found"), explicit fetch-error banner with Retry, and permission-denied banner (42501 / `insufficient_privilege`, no retry) — both rendered in the mobile and desktop layouts. Error copy lives in the local `REGISTRY_STATE_COPY` constant. **SCRUM-3010 STEP 1 (frontend gate):** requires an `isAdmin: boolean` prop and a `currentUserId` prop. Admins query the whole org (`.eq('org_id')`); a **non-admin member is scoped to their OWN rows only** (`.eq('user_id', currentUserId)`, mirroring the `useAnchors` INDIVIDUAL path) and the query **fails closed** (empty table, no fetch) if `currentUserId` is missing — so a coworker's filenames/fingerprints/metadata never leak. The CSV export (`handleExport`) delegates with the SAME scope (`exportAnchors(orgId, { isAdmin, userId })`), so the export path can't leak what the table won't show. The RLS tightening that enforces this server-side is deferred to STEP 2 (T3), post-soak. _(Restored 2026-07-28 — lost by the union-merge-driver incident; see `docs/incidents/2026-07-28-agents-md-union-drop-remediation.md`.)_
- `CreateOrgDialog.tsx` — Organization creation dialog
- `RevokeDialog.tsx` — Credential revocation confirmation dialog
- `PendingInvitationsList.tsx` — Read-only status list (pending/expired/revoked) for an org's non-accepted invitations, plus a per-row Resend action. Renders `null` once loaded if there is nothing to show. Backed by `@/hooks/useOrgInvitations` (RLS-scoped read via the pre-existing "Org admins can view invitations" policy — no migration). Resend does NOT reuse the old `invitations.token`/expiry; it re-runs the existing `invite_member` RPC + `/api/send-invitation-email` path via the same `useInviteMember` hook `InviteMemberModal` uses, creating a fresh row with a fresh 7-day clock. Wired into `OrgProfilePage`'s People tab, admin-only.
- `index.ts` — Barrel exports

## Dependencies
- `@/hooks/useReviewQueue` — review queue data and actions
- `@/components/anchor/IntegrityScoreBadge` — integrity display in review queue
- `@/lib/copy` (ORG_PAGE_LABELS, REVIEW_QUEUE_LABELS) — UI strings

## Do / Don't Rules
- DO: Use "Issue Credential" only for the restricted verified-organization credential issuance flow (SCRUM-1672)
- DO NOT: Use "Issue Credential" for the universal document-securing action — use "Secure Document" instead
- DO: On a data-fetch failure, set an explicit error state and render the error/permission banner instead of `console.error`-ing and falling through to the empty state (SCRUM-1999). Detect permission denials with the `42501` / `insufficient_privilege` predicate (mirrors `useRevokeAnchor.ts`).

## 2026-07-21 SCRUM-2938 S2 — terminology scrub remainder

ReviewQueue confirm prompt scrubbed ("Approve this record?"). IssueCredentialForm untouched except shared FORM_LABELS now render "Document Type" — the SCRUM-1672 "Issue Credential" copy (ISSUE_CREDENTIAL_LABELS) is preserved byte-identical. Internal identifiers (keys, enum values, `credential_type`, API params) are unchanged per §1.3 "internal code may use technical names". Contract test: `src/lib/copy-scrum-2938-terminology-s2.test.ts` (walks every copy.ts string value; SCRUM-1672 `ISSUE_CREDENTIAL_LABELS` carve-out locked byte-identical).

## 2026-08-18 — invite-accept investigation: admin visibility added, no backend bug found

Investigated the founder's "I still cannot invite members" report against prod evidence (5 invitations ever, 3 confirmed EMAIL_SENT via Resend, 0 accepted, 0 `MEMBER_JOINED` audit events). Root-caused the full accept path (`services/worker/src/api/invitations.ts`, `routes/anchor.ts`, `src/pages/AcceptInvitePage.tsx`, `src/hooks/useAcceptInvite.ts`) end to end: token generation, RLS, route registration, CORS, rate-limit scoping, and expiry logic are all correct — confirmed by a NEW router-level integration test (`services/worker/src/routes/anchor-invitation-accept.test.ts`) that drives the real `anchorRouter` handler through the exact new-account, no-session happy path AND the exact real-prod expired-invitation scenario (both green). No accept-path code defect found.

What WAS confirmed broken: the inviting admin had zero visibility into what happened after clicking Send — no status, no resend. `PendingInvitationsList` (this folder) closes that gap. Also documented, not fixed here (DNS/founder-owned per `docs/reference/ENV.md`): all 3 real "pending" invitations are to `@arkova.ai` addresses — same domain as the `noreply@arkova.ai` sender, under `_dmarc.arkova.ai` `p=none` (monitoring only) — the classic pattern mail providers flag as intra-domain spoofing regardless of passing SPF/DKIM. Flagged as the most likely real explanation for non-delivery; not provable without Resend dashboard/mailbox access.
