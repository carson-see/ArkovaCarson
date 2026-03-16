# UAT Launch Readiness Report #2 — Organization Admin Flows
_Date: 2026-03-16 | Tester: Claude Code | Login: admin@umich-demo.arkova.io_
_Viewports: Desktop (1280x800), Mobile (375x812)_

---

## Summary

| Severity | Count |
|----------|-------|
| HIGH     | 5     |
| MEDIUM   | 5     |
| LOW      | 4     |
| **Total** | **14** |

---

## HIGH Severity Bugs

### UAT2-01: Revoke action not wired in OrgRegistryTable (HIGH)
- **Steps to reproduce:**
  1. Login as org admin
  2. Navigate to Organization page
  3. Scroll to Organization Records table
  4. Click three-dot menu on a SECURED record
  5. Click "Revoke"
- **Expected:** Revocation dialog opens with reason field
- **Actual:** Menu closes, nothing happens. No dialog, no console errors.
- **Root cause:** `OrganizationPage.tsx:181-184` renders `<OrgRegistryTable>` with only `orgId` and `onViewAnchor` props. The `onRevokeAnchor` callback prop is **not passed**, so the revoke menu item has no handler.
- **Fix:** Wire `onRevokeAnchor` prop in OrganizationPage to open RevokeDialog with the selected anchor.
- **File:** `src/pages/OrganizationPage.tsx:181`
- **Regression test:** None yet

### UAT2-02: Template metadata fields not rendering in Issue Credential form (HIGH)
- **Steps to reproduce:**
  1. Login as org admin
  2. Navigate to Organization > click "+ Issue Credential"
  3. Select "Degree" from Credential Type dropdown
- **Expected:** Dynamic template schema fields render (Student Name, Degree Title, Major, GPA, etc. from DIPLOMA template via MetadataFieldRenderer)
- **Actual:** Only basic fields shown: Label, Issued date, Recipient Email. No template-driven metadata fields appear.
- **Root cause:** `IssueCredentialForm` does not fetch or render template schema fields when a credential type is selected. The `MetadataFieldRenderer` component exists but is not integrated into the issuance form.
- **Fix:** When credential type changes, fetch matching template via `useCredentialTemplate`, render schema fields via `MetadataFieldRenderer`, and include metadata in the anchor insert.
- **File:** `src/components/organization/IssueCredentialForm.tsx`
- **Regression test:** None yet

### UAT2-03: Settings page missing navigation to sub-pages (HIGH)
- **Steps to reproduce:**
  1. Login as org admin
  2. Click "Settings" in sidebar
- **Expected:** Settings page includes links/tabs to Credential Templates, Webhooks, API Keys
- **Actual:** Settings page only shows Profile, Identity, Privacy, and Sign Out. No links to sub-pages. Users must know exact URLs (`/settings/credential-templates`, `/settings/webhooks`, `/settings/api-keys`) to access them.
- **Root cause:** `SettingsPage.tsx` does not render navigation links to the settings sub-routes.
- **Fix:** Add a settings navigation section (tabs or card links) for Credential Templates, Webhooks, and API Keys. Only show for ORG_ADMIN role.
- **File:** `src/pages/SettingsPage.tsx`
- **Regression test:** None yet

### UAT2-04: Bulk Upload not accessible from any page (HIGH)
- **Steps to reproduce:**
  1. Login as org admin
  2. Search all pages for "Bulk Upload" or "CSV Upload" button
- **Expected:** Org admins can access CSV bulk upload wizard from the Organization page or My Records page
- **Actual:** `BulkUploadWizard` and `CSVUploadWizard` components exist in `src/components/upload/` but are not imported or rendered in any page component. No route registered in `App.tsx`.
- **Root cause:** Components were built (CRIT-6 resolved) but never wired into the UI routing.
- **Fix:** Add a "Bulk Upload" button to the Organization Records section that opens the CSVUploadWizard dialog.
- **File:** `src/pages/OrganizationPage.tsx`, `src/App.tsx`
- **Regression test:** None yet

### UAT2-05: Record rows in org table not clickable (HIGH)
- **Steps to reproduce:**
  1. Login as org admin
  2. Navigate to Organization > scroll to records table
  3. Click on a record name (e.g., "UMich_Diploma_Chen_May...")
- **Expected:** Clicking a record name navigates to the record detail page
- **Actual:** Record names are plain text, not links. Only way to navigate to detail is via three-dot menu > "View Details".
- **Root cause:** `OrgRegistryTable` renders document names as `<span>` not `<Link>` or `<a>`.
- **Fix:** Wrap document name in `<Link to={/records/${anchor.id}}>` or make entire row clickable.
- **File:** `src/components/organization/OrgRegistryTable.tsx`
- **Regression test:** None yet

---

## MEDIUM Severity Bugs

### UAT2-06: No "Invite Member" button in Team Members section (MEDIUM)
- **Steps to reproduce:**
  1. Login as org admin
  2. Navigate to Organization page
  3. Look for invite/add member button in Team Members section
- **Expected:** An "Invite Member" button is visible near the Team Members heading
- **Actual:** No invite button exists. Only the member table with existing members is shown.
- **Root cause:** `OrganizationPage` does not render an invite member button or wire the invite flow.
- **Fix:** Add "Invite Member" button that opens the invite form dialog.
- **File:** `src/pages/OrganizationPage.tsx`
- **Regression test:** None yet

### UAT2-07: No "Change Role" action in member dropdown menu (MEDIUM)
- **Steps to reproduce:**
  1. Login as org admin
  2. Navigate to Organization > Team Members
  3. Open three-dot menu on Jordan Lee
- **Expected:** Menu includes "Change role" option (e.g., promote to Admin or demote to Member)
- **Actual:** Menu only shows "Send message" and "Remove member". No role change option.
- **Root cause:** `MembersTable.tsx` DropdownMenu only has "Send message" and "Remove member" items. No role change action implemented.
- **Fix:** Add a "Change Role" menu item with sub-options (Admin / Member) and wire to a role update function.
- **File:** `src/components/organization/MembersTable.tsx:162-174`
- **Regression test:** None yet

### UAT2-08: Member names not clickable — no member detail view (MEDIUM)
- **Steps to reproduce:**
  1. Login as org admin
  2. Navigate to Organization > Team Members
  3. Click on member name "Jordan Lee"
- **Expected:** Navigates to member profile/detail view showing their records and activity
- **Actual:** Member names are plain text (not links). No navigation occurs.
- **Root cause:** `MembersTable.tsx` renders names as `<p>` elements, not links. No member detail page/route exists.
- **Fix:** Create member detail view or link to their records filtered by user, and wrap names in `<Link>`.
- **File:** `src/components/organization/MembersTable.tsx:119-126`
- **Regression test:** None yet

### UAT2-09: Credential Templates page shows empty state despite seed templates (MEDIUM)
- **Steps to reproduce:**
  1. Navigate to `/settings/credential-templates`
- **Expected:** Seed templates (DIPLOMA, CERTIFICATE, LICENSE) appear in the list
- **Actual:** "No templates yet" empty state. Templates may not be associated with this org in seed data, or the query filters by org_id and finds none.
- **Root cause:** Seed SQL likely doesn't insert `credential_templates` rows for the demo org, or the `useCredentialTemplates` hook filters by org_id which has no matching records.
- **Fix:** Add seed template rows for the demo org (org_id = `aaaaaaaa-0000-0000-0000-000000000001`) or ensure templates are visible.
- **File:** `supabase/seed.sql`, `src/hooks/useCredentialTemplates.ts`
- **Regression test:** None yet

### UAT2-10: Mobile records table shows only Document column (MEDIUM)
- **Steps to reproduce:**
  1. Login as org admin on mobile (375px)
  2. Navigate to Organization > scroll to records table
- **Expected:** Records table shows key columns (at minimum: Document, Status, and action button) or uses a card/list layout on mobile
- **Actual:** Table only renders the "Document" column. Status, Created, Type, Fingerprint, and the three-dot action menu are all hidden/clipped. Users cannot see record status or access any actions on mobile.
- **Root cause:** HTML table at 375px width overflows and only the first column is visible. No responsive card layout for mobile.
- **Fix:** Either implement a mobile card layout for records (preferred) or ensure Status column and action button are always visible with horizontal scroll.
- **File:** `src/components/organization/OrgRegistryTable.tsx`
- **Regression test:** None yet

---

## LOW Severity Bugs

### UAT2-11: "Expired" and "Revoked" status badges visually identical (LOW)
- **Steps to reproduce:**
  1. View records table with both Expired and Revoked records
- **Expected:** Per spec: SECURED=green, PENDING=amber, REVOKED=gray, EXPIRED=gray (acceptable if same). But if identical, users can't distinguish at a glance.
- **Actual:** Both use `bg=rgb(218, 234, 241)` (ice blue) and `color=rgb(47, 50, 49)`. They are visually indistinguishable.
- **Fix:** Consider using different icon or subtle color variation between Expired (gray with clock icon) and Revoked (gray with ban icon) for quick visual distinction.
- **File:** `src/components/organization/OrgRegistryTable.tsx` (badge rendering)
- **Regression test:** None yet

### UAT2-12: Template creation uses raw JSON instead of TemplateSchemaBuilder (LOW)
- **Steps to reproduce:**
  1. Navigate to `/settings/credential-templates`
  2. Click "+ Add Template"
  3. View "Default Metadata (JSON)" field
- **Expected:** Visual schema builder (TemplateSchemaBuilder component with 6 field types) for defining template fields
- **Actual:** Raw JSON textarea expecting manual JSON input. Non-technical users would struggle.
- **Root cause:** `CredentialTemplatesManager` uses a textarea for metadata instead of the `TemplateSchemaBuilder` component.
- **Fix:** Replace the JSON textarea with the `TemplateSchemaBuilder` component for field-level visual editing.
- **File:** `src/components/credentials/CredentialTemplatesManager.tsx`
- **Regression test:** None yet

### UAT2-13: No "Recipient" column in org records table (LOW)
- **Steps to reproduce:**
  1. View Organization Records table
- **Expected:** A "Recipient" column showing who the credential was issued to
- **Actual:** Columns are: Document, Status, Created, Type, Fingerprint. No Recipient column.
- **Fix:** Add Recipient column populated from `anchor_recipients` table or metadata.
- **File:** `src/components/organization/OrgRegistryTable.tsx`
- **Regression test:** None yet

### UAT2-14: "Failed to fetch" error on API Keys page (LOW)
- **Steps to reproduce:**
  1. Navigate to `/settings/api-keys`
- **Expected:** API usage dashboard gracefully handles missing worker connection
- **Actual:** Red "Failed to fetch" error banner at bottom of page (ApiUsageDashboard widget tries to fetch from worker API which isn't running in dev mode).
- **Fix:** Add error boundary/fallback in ApiUsageDashboard that shows "Usage data unavailable — worker not connected" instead of raw error.
- **File:** `src/components/ApiUsageDashboard.tsx` or similar
- **Regression test:** None yet

---

## Mobile-Specific Observations

### UAT2-15: Mobile sidebar missing bottom nav items (MEDIUM — included in count above as UAT2-10 covers mobile issues)
- **Observed at:** 375px viewport
- **Detail:** Mobile sidebar drawer only shows Dashboard, My Records, My Credentials, Organization. Missing: Billing & Plans, Settings, Help. These bottom-section items are not visible even when scrolling the sidebar.
- **Note:** Documented here for awareness; tracked separately as it affects all mobile users.

---

## Passing Checks

| Feature | Desktop | Mobile | Notes |
|---------|---------|--------|-------|
| Login flow | PASS | N/A | Redirect to /dashboard after login |
| Dashboard stat cards (org totals) | PASS | PASS | Total Records: 7, Secured: 2, Pending: 3 |
| Sidebar "MANAGING: [Org]" indicator | PASS | PASS | Shows "UMich Registrar" |
| Monthly Usage widget | PASS | PASS | 2/3 records, Free plan |
| Getting Started checklist | PASS | N/A | 1 of 3 steps complete |
| Issue Credential dialog opens | PASS | PASS | Clean mobile sheet layout |
| Credential type dropdown | PASS | PASS | 6 options: Degree, License, Certificate, Transcript, Professional Credential, Other |
| Team Members table (basic) | PASS | PASS | 2 members, role badges, "(You)" indicator |
| Remove member confirmation dialog | PASS | N/A | Shows name, warns about access loss |
| Search filter in records table | PASS | N/A | Filters correctly (tested "Diploma" -> 1 result) |
| Record detail page | PASS | N/A | Full info: fingerprint, timestamps, QR code, proof download |
| Record lifecycle timeline | PASS | N/A | Created -> Issued -> Secured stages with timestamps |
| QR code on record detail | PASS | N/A | Links to /verify/{publicId} |
| Proof download (PDF + JSON) | PASS | N/A | Both buttons visible on detail page |
| Re-verify Document section | PASS | N/A | Drop area + Verify button on detail page |
| Public verification (SECURED) | PASS | PASS | "Document Verified" with full 5-section display |
| Public verification (REVOKED) | PASS | N/A | Shows revocation reason + date in red section |
| Revocation in lifecycle timeline | PASS | N/A | Revoked step with reason text |
| Export CSV button visible | PASS | PASS | In records table header |
| Webhook Settings page | PASS | N/A | Add Endpoint dialog with URL + event checkboxes |
| API Key Settings page | PASS | N/A | Create API Key button, breadcrumb navigation |
| Profile settings | PASS | N/A | Email (readonly), Full Name (editable), Role display |
| Privacy toggle | PASS | N/A | Public Profile on/off with description |
| Org Settings (name/domain) | PASS | PASS | Editable fields with Save button |

---

## Priority Fix Order

1. **UAT2-01** (Revoke not wired) — Blocks core admin workflow. Simple prop wiring fix.
2. **UAT2-02** (Template metadata fields) — Blocks rich credential issuance. Requires integration work.
3. **UAT2-05** (Record rows not clickable) — Poor UX for most common action. Simple link wrapper.
4. **UAT2-04** (Bulk Upload not accessible) — Feature exists but unreachable. Route + button wiring.
5. **UAT2-03** (Settings navigation) — Sub-pages unreachable without URL knowledge. Add nav section.
6. **UAT2-10** (Mobile records table) — Blocks mobile org admin usage. Responsive layout fix.
7. **UAT2-06** (Invite member) — Missing core team management feature.
8. **UAT2-07** (Change role) — Missing role management feature.
9. **UAT2-09** (Empty templates) — Seed data or query fix.
10. **UAT2-08** (Member detail) — Enhancement for org admin visibility.
