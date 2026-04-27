# agents.md — components
_Last updated: 2026-04-26_

## What This Folder Contains
Domain-specific React components organized by feature area. Each subfolder has a barrel `index.ts` export. `ui/` contains shadcn/ui primitives (do not edit).

`DataErrorBanner.tsx` (root-level) — shared amber "warn + retry" banner for admin-dashboard data-fetch failures. Centralised during the SCRUM-1260 R1-6 /simplify pass after the same shape appeared inline three times across `PipelineAdminPage` (stats + records) and `TreasuryAdminPage` (x402). Copy lives in `DATA_ERROR_LABELS` in `src/lib/copy.ts`.

## Subfolder Map

| Folder | Domain | Key Components |
|--------|--------|----------------|
| `anchor/` | Document anchoring | SecureDocumentDialog, FileUpload, AssetDetailView |
| `auth/` | Authentication | LoginForm, SignUpForm, AuthGuard, RouteGuard |
| `billing/` | Payments | BillingOverview, PricingCard |
| `credentials/` | Credential templates | CredentialTemplatesManager |
| `dashboard/` | Dashboard widgets | StatCard, EmptyState |
| `embed/` | Embeddable widget | VerificationWidget (orphaned — not wired) |
| `layout/` | App shell | AppShell, Header, Sidebar, AuthLayout |
| `onboarding/` | Onboarding flow | RoleSelector, OrgOnboardingForm, ManualReviewGate |
| `organization/` | Org admin | IssueCredentialForm, MembersTable, RevokeDialog, OrgRegistryTable |
| `public/` | Public pages | PublicVerifyPage, ProofDownload |
| `records/` | Records list | RecordsList |
| `reports/` | Reports | ReportsList |
| `seo/` | SEO schema markup | VideoObjectSchema, YouTubeExplainerEmbed (GEO-11 / SCRUM-478) |
| `upload/` | Bulk upload | BulkUploadWizard, CSVUploadWizard, CsvUploader |
| `vault/` | Vault dashboard | VaultDashboard |
| `verification/` | Public verification | PublicVerification (5-section result display) |
| `verify/` | Verification form | VerificationForm |
| `webhooks/` | Webhook config | WebhookSettings |
| `ui/` | shadcn/ui primitives | Do not edit — managed by shadcn CLI |

## Do / Don't Rules
- Recent API key update: `api/ApiKeySettings.tsx` and `api/ApiKeyScopeDisplay.tsx` use the API v2 scope vocabulary (`read:records`, `read:orgs`, `read:search`, `write:anchors`, `admin:rules`) while still displaying legacy v1 scopes on existing keys.
- DO: Place new components in the correct domain subfolder with barrel export
- DO: Use hooks from `@/hooks/` for data — never `useState` for DB-backed data
- DO: Source all UI strings from `@/lib/copy.ts`
- DON'T: Edit files in `ui/` — they are managed by shadcn
- DON'T: Use banned terminology in user-visible strings (see Constitution 1.3)
- DON'T: Hardcode routes — use `@/lib/routes.ts` constants

## MVP Launch Gap Context
- **MVP-02 (Toast System):** Install Sonner, add `<Toaster />` to AppShell. Replace all `console.log`/`alert` feedback with `toast()` calls across components (BUG-AUDIT-01).
- **MVP-05 (Error Boundary):** Create `ErrorBoundary` component wrapping App in `App.tsx`. Create `NotFoundPage` at catch-all `*` route.
- **MVP-07 (Mobile Responsive):** Audit all layout components for mobile breakpoints. Sidebar needs collapsible mobile drawer.
- **MVP-08 (Onboarding Stepper):** Visual progress indicator for `onboarding/` components.

## Dependencies
- `@/hooks/*` — all data fetching hooks
- `@/lib/copy.ts` — UI strings
- `@/lib/routes.ts` — named route constants
- `@/lib/validators.ts` — Zod schemas
- `@/lib/supabase.ts` — Supabase client
