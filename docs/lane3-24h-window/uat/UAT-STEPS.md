# SCRUM-2938 S1 terminology scrub — UAT steps

_Lane 3 / 24h train-protective window. Draft PR — merges Jul 22 FIRST (copy.ts order rule R10). Do NOT merge in-window._

## Screenshot status: NOT CAPTURED (auth-gated)

Screenshots at 1280px and 375px were **not** captured by the agent. Every scrubbed
surface below is behind `AuthGuard` (and the Compliance dashboard is additionally
`ORG_ADMIN`-gated). This work ran in an isolated git worktree with **no `.env.local`**
and no reachable Supabase backend, so no authenticated session could be established.

What WAS verified locally:

- **Build smoke** — `npm run dev` boots clean (Vite ready, `GET /` → 200). Visiting
  `/my-credentials` unauthenticated correctly redirects to the login page with the
  "Please sign in to access that page" toast (AuthGuard working; edits render at runtime).
- **Rendered-DOM proof (jsdom)** — the vitest suites render the scrubbed components with
  the new copy and pass: `NessieIntelligencePanel.test.tsx` now asserts the panel title
  `Document Intelligence` and the reworded empty state; compliance/scorecard/credentials
  suites all green (56 tests across 6 files).
- `npm run lint:copy` green, `npm run typecheck` green.

The founder (or any run with the UAT demo account wired via a gitignored `.env.local`,
per `memory/project_uat_demo_account.md`: `demo@arkova-uat.dev`, PROD org, ORG_ADMIN)
should run the steps below and drop PNGs next to this file.

## How to run

```bash
npm run dev           # http://localhost:5173
# sign in as demo@arkova-uat.dev (ORG_ADMIN) — see memory/project_uat_demo_account.md
```

Capture each surface at **1280px** and **375px** (Chrome DevTools device toolbar or
`--window-size`). Suggested filenames: `<surface>-1280.png` / `<surface>-375.png`.

## Surfaces + expected scrubbed strings

| # | Route | Surface | MUST now show | MUST NOT show |
|---|-------|---------|---------------|---------------|
| 1 | `/my-credentials` | Imported Records page (header + page title) | **Imported Records**; subtitle "Documents issued to you or imported from public sources." | "My Credentials"; "Credentials issued to you…" |
| 2 | `/my-credentials` (empty account) | Imported Records empty state | "No documents yet"; "When organizations issue documents to your email address…"; "{n} documents" | "No credentials yet"; "…issue credentials…"; "{n} credentials" |
| 3 | `/documents` (empty account) | Merged Documents list empty state | "No documents yet"; "When organizations issue documents to your email address…" | "No credentials yet"; "…issue credentials…" |
| 4 | `/compliance` (Compliance dashboard, ORG_ADMIN) | Dashboard title | **Compliance Dashboard** | "Compliance Intelligence" |
| 5 | `/compliance` viewed as non-admin | Access-restricted card body | "The Compliance dashboard is available to organization administrators." | "The Compliance Intelligence dashboard…" |
| 6 | Search → intelligence panel (`NessieIntelligencePanel`) | Panel title + empty state | **Document Intelligence**; "Ask a question to get answers backed by verified evidence." | "Nessie Intelligence"; "…get compliance intelligence…" |
| 7 | Anchor record → insights (`NessieInsights`) | Insights title | **Document Insights** | "Nessie Insights" |
| 8 | Compliance scorecard (`/compliance` → scorecard) | Scorecard title + empty state | **Audit scorecard**; "Run your first audit to see your results." | "Compliance scorecard"; "…see your compliance score." |

## Explicitly OUT of S1 scope (deferred to S2 — expected to still show old wording)

Per the CTO ruling the 228-occurrence full purge is S2. These are intentionally NOT
changed in this PR and will still show the old terms:

- `CredentialSourceImportDialog` — "Add Credential Source", "Credential source URL", "Credential type".
- `ComplianceScoreCard` dashboard widget — still renders "Compliance Score".
- Pricing page / card feature bullets — "Compliance intelligence access/recommendations".
- `compliancePdf.ts` PDF output — "Overall compliance score" (S2 code removal).
- All other `credential` nouns in Share / LinkedIn / attestation / realtime-toast copy.
- Internal code identifiers/comments (`NESSIE_LABELS`, section comments) — allowed per §1.3.
