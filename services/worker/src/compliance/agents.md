# agents.md — services/worker/src/compliance/

_Last updated: 2026-04-17_

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
| `auth-helpers.ts` | Shared `getCallerOrgId(req, res)` — every compliance route uses this |

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

## Related

- Migration `0194_jurisdiction_rules.sql` (NCE-06): original rule seed.
- Migration `0195_compliance_scores.sql` (NCE-07): score cache.
- Migration `0216_nca01_jurisdiction_rules_expansion.sql` (NCA-01): expands
  seed to ≥100 rules across FERPA/HIPAA/SOX/FCRA/ADA/FLSA/GLBA/GINA + Kenya,
  Australia, EU/UK, Canada, Singapore, Japan, India, South Africa, Nigeria.
- Migration `0217_nca03_compliance_audits.sql` (NCA-03): `compliance_audits`
  table storing full audit history.
