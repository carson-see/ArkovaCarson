# agents.md — services/worker/src/compliance/

_Last updated: 2026-06-24_

## What This Folder Contains

Server-side compliance engine for the Nessie Compliance Engine (NCE) and the
"Audit My Organization" feature (NCA). Pure, framework-agnostic scorers —
the API layer (`src/api/v1/compliance-*.ts`) wraps these with auth +
persistence.

| File | Purpose | Jira |
|------|---------|------|
| `score-calculator.ts` | Per-(jurisdiction, industry) compliance score, weighted by credential type, with integrity bonus + expired/fraud penalties | NCE-07 / SCRUM-597 |
| `gap-detector.ts` | Missing required + missing recommended gap analysis with peer-adoption data | NCE-08 / SCRUM-598 |
| `org-audit.ts` | **NCA-03.** Org-level audit rollup across all the org's jurisdictions. Adds EXPIRED / INSUFFICIENT gap categories + attaches NVI quarantine caveats + NCA-05 recommendations | NCA-03 / SCRUM-758 |
| `recommendation-engine.ts` | **NCA-05 NEW.** Turns audit gaps into prioritised recommendations. Dedupes by (type, category), groups by QUICK_WIN / CRITICAL / UPCOMING / STANDARD, scores by severity × jurisdiction penalty risk ÷ effort hours. Pure function — unit tests cover dedup, sort, grouping, overflow. | NCA-05 / SCRUM-760 |
| `expiry-checker.ts` | Cron helper for expiring-credential alerts | NCE-09 |
| `audit-report.ts` | Audit-ready report generation | NCE-18 |
| `benchmarking.ts` | Industry benchmark comparisons | NCE-17 |
| `cross-reference.ts` | Credential × rule cross-reference | NCE-15 |
| `auth-helpers.ts` | Shared `getCallerOrgId(req, res)` — every compliance route uses this. Resolves the caller's org via the canonical precedence: `profiles.org_id` first (delegated to `../api/_org-auth.ts`), then an `org_members` fallback — so org **owners** (linked via `profiles.org_id`) resolve, not just `org_members` rows |
| `professional-education.ts` | Shared CPE/CLE taxonomy, metadata validation, normalization, and PII stripping helpers for R-CPE-01 / R-LEGAL-01 foundation work | SCRUM-1851 / SCRUM-1877 |

## Conventions

- All inputs / outputs are plain TypeScript interfaces — NO Supabase dependencies.
  The API layer loads rows from Supabase and hands them to these functions. This
  keeps the scorers unit-testable and lets tests mock at a data boundary.
- Severity weights + credential-type priorities are in these files (not env
  vars). Changing them is a schema-level decision that needs PR review.
- `org-audit.ts` is the SOLE place quarantine caveats are attached. It reads
  from `../ai/nessie-quarantine.ts` — do not duplicate the policy.

## Testing

- `*.test.ts` alongside each scorer.
- `org-audit.test.ts` covers all 4 gap categories (MISSING / EXPIRED /
  EXPIRING_SOON / INSUFFICIENT), quarantine attachment, severity sort,
  empty-input edge cases.
- API-layer tests in `src/api/v1/compliance-*.test.ts` mock the DB layer
  at the `db.from(table)` level — see `compliance-audit.test.ts` for the
  fluent-builder mock pattern.

## Recent Changes

- **2026-08-10 — DPA clause 4.7(b) LEGAL guard** (`professional-education.ts`):
  `classifyProfessionalEducationAnchor()` now returns `null` (NOT professional
  education) as its FIRST check for any anchor whose `credential_type` normalizes
  to `LEGAL`. This is the ONE automatic anchor -> AI-provider route (the CLE/CPE
  metadata-extraction job), so the exclusion is architectural: it holds
  independent of `ENABLE_PROFESSIONAL_EDUCATION_SCHEMA_READY` and independent of
  any caller-supplied metadata keyword match (`bar association` / `state bar` /
  `continuing legal education` previously fell through to the CLE keyword scan and
  returned `CLE` — routable to Gemini). Scoped to type `LEGAL` **exactly**: `CLE`
  (continuing legal education) is a distinct credential_type and the intended
  professional-education path, so it stays routable — broadening to CLE would
  defeat the feature and is not warranted by the DPA. `credentialType` is now
  `trim()`-ed before `toUpperCase()` so `legal`/` Legal ` are excluded just as
  firmly. Covered by the `professional-education.test.ts` "LEGAL credential type
  is never routed to AI extraction (DPA clause 4.7(b))" suite, including a
  flag-enabled assertion.

- **2026-06-24 — compliance audit owner-org gate** (`auth-helpers.ts`):
  `getCallerOrgId` resolved the caller's org via `org_members` ONLY, so org
  OWNERS — linked via `profiles.org_id` (the "Managing X" header source) and not
  guaranteed an `org_members` 'owner' row — were 403'd "Must belong to an
  organization" on "Audit My Organization" (prod UAT). Now resolves via the
  canonical precedence: `profiles.org_id` first (delegated to `../api/_org-auth.ts`,
  the single source of truth shared with `orgVerification.ts` /
  `get_user_org_id()` / `useCanIssueCredential`), then an `org_members` fallback
  using `limit(1).maybeSingle()` (also fixes a latent `.single()` crash-to-403
  for users in 2+ orgs). Covered by `auth-helpers.test.ts`.

- **2026-05-20 — SCRUM-1851 / SCRUM-1877** (`professional-education.ts`):
  Added pure CPE/CLE metadata schemas, controlled vocabularies, manual-review
  normalization, and shared professional-education PII stripping. Keep adapters
  thin and validate extracted metadata here before persisting to anchors.

- **2026-04-28 — SCRUM-954** (`src/api/v1/compliance-audit.ts`): `loadOrgJurisdictions`
  gained a third fallback. Orgs with no `organizations.jurisdictions` and no
  historical `compliance_scores` ("Arkova default scope") now derive distinct
  `(jurisdiction_code, industry_code)` pairs from `jurisdiction_rules`
  matching the org's industry. Without this, `calculateOrgAudit` produced
  empty `per_jurisdiction` and the `/compliance/scorecard` page showed
  "No jurisdiction data" even after a successful audit. Empty-state is now
  only shown when there are truly no rules for the org's industry.

## Related

- Migration `0194_jurisdiction_rules.sql` (NCE-06): original rule seed.
- Migration `0195_compliance_scores.sql` (NCE-07): score cache.
- Migration `0216_nca01_jurisdiction_rules_expansion.sql` (NCA-01): expands
  seed to ≥100 rules across FERPA/HIPAA/SOX/FCRA/ADA/FLSA/GLBA/GINA + Kenya,
  Australia, EU/UK, Canada, Singapore, Japan, India, South Africa, Nigeria.
- Migration `0217_nca03_compliance_audits.sql` (NCA-03): `compliance_audits`
  table storing full audit history.

## 2026-08-15 — `ExpiryAnchor` fields now match the real schema (BUG-002)

`ExpiryAnchor` declared `id` and `title`. The only caller
(`POST /cron/check-credential-expiry`) selected `anchors.not_after` and
`anchors.document_title` to fill them — **neither column has ever existed**, in
the rig or in prod, so the route 500'd on every run with
`42703 column anchors.document_title does not exist`. The schema's expiry column
is `expires_at` and its human label is `label`; there is no title column.

The interface now reads `public_id` / `label`, and `credential_type` is
`string | null` because the column is nullable. `public_id` rather than
`anchors.id` because this identifier rides an outbound webhook payload
(CLAUDE.md §6) — the pre-fix emit site was shipping the internal UUID.

`categorizeExpiringDocuments` / `groupByOrg` are pure and unchanged; only the
field names moved.
