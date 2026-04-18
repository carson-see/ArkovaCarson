# NCA "Audit My Organization" — Operator UAT Runbook

**Stories:** SCRUM-756..764 (NCA-01..09) + SCRUM-893 (NCA-FU1)
**Scope:** Operator-driven UAT at 1280px desktop + 375px iPhone SE for the full audit → scorecard → PDF flow.
**Owner:** whoever pushes the story to Done after engineering + tests pass.
**Estimated time:** 25 minutes.

---

## 0. Prerequisites

- Access to an ORG_ADMIN account in a non-production Supabase project (or prod with `arkova-qa-*` org).
- `pnpm dev` running for the frontend at http://localhost:5173.
- Worker API reachable at whatever `VITE_API_BASE_URL` points to (staging or local `services/worker`).
- Browser devtools responsive mode available (Chrome: ⌘⇧M, Safari: Develop → Enter Responsive Design Mode).
- A PDF reader (Preview on macOS is fine).

## 1. Seed state

The audit endpoint needs three things in Supabase:

1. **Organization row** with `jurisdictions: ['US-CA', 'US-NY']` (or whatever pair you want to exercise) and a non-null `industry` (e.g. `accounting`).
2. **jurisdiction_rules** entries for those (jurisdiction, industry) pairs — the 2026-04-17 migration 0216 seeds ≥100 rules, so the default prod dataset is fine.
3. **At least one SECURED anchor** on the org (any `credential_type` works; `LICENSE` covers the most rules).

If you're running against a clean local, `supabase db reset` + `npx supabase seed` should give you enough to trigger non-trivial gaps.

## 2. Desktop pass — 1280 × 800

Set the browser to **1280 × 800** via responsive mode.

### 2.1 Trigger the audit

1. Sign in as the ORG_ADMIN.
2. Navigate to the dashboard (`/dashboard`).
3. Click **Audit my organization**.
4. Verify the button transitions through `Preparing…` → `Running…` → `Complete` states and the ARIA live region announces each state.
5. Verify you're redirected to `/compliance/scorecard` automatically when the audit completes.

**Pass criteria**
- No JS console errors.
- Redirect happens within 5 s on a warm audit.

### 2.2 Scorecard — overall

1. Confirm the gauge renders a **progress arc** (not just a number) matching the grade colour.
2. Confirm the score and grade text inside the gauge are legible against any background.
3. Confirm the per-jurisdiction bars render, sorted by the same order as `per_jurisdiction`.
4. Confirm the gap list renders with severity + category badges.
5. Confirm "Recommended actions" appears with at least one recommendation when there are open gaps.

**Screenshot:** save as `uat-2026-XX-XX-nca-scorecard-1280.png` and attach to SCRUM-893.

### 2.3 Gap + jurisdiction filters (NCA-FU1 #2)

1. Open the scorecard with filters applied via URL: `/compliance/scorecard?jurisdiction=US-CA&gap=MISSING`.
2. Verify only gaps that match BOTH filters are shown, and the dropdowns reflect the URL state.
3. Clear each filter individually via the dropdown — URL updates in lock-step, gap list repopulates.

### 2.4 PDF export (NCA-FU1 #3)

1. Click **Export PDF**.
2. Open the downloaded file in Preview.
3. Confirm filename matches `arkova-compliance-audit-<slug>-<YYYY-MM-DD>.pdf`.
4. Confirm page 1 has:
   - Title "Compliance Audit Report"
   - Org name, audit date, audit ID
   - **Vector score gauge** (polyline donut) next to the numeric score
   - Per-jurisdiction list
5. Confirm gap list + recommendations sections render without overflow.
6. Confirm footer on every page has: org name, `Arkova`, disclaimer, page X / Y.

**Screenshot:** save the PDF first-page PNG as `uat-2026-XX-XX-nca-pdf.png`.

### 2.5 Nessie contextual prose (NCA-FU1 #4) — optional

Only run this section if `ENABLE_NESSIE_RAG_RECOMMENDATIONS=true` in the worker env AND you're OK using the flag-gated path (see NVI-12 status).

1. Run a fresh audit.
2. Compare the description text of one recommendation against the `remediation_hint` in the gap. The enriched version should mention the specific jurisdiction + (if present) the regulatory reference.
3. If Nessie is cold, the UI will fall back to the static hint silently — that's the correct behaviour, not a regression.

## 3. Mobile pass — 375 × 667 (iPhone SE)

Switch responsive mode to **375 × 667**.

### 3.1 Trigger + scorecard

1. Sign in and trigger an audit from the mobile dashboard.
2. Confirm the **Audit my organization** button is full-width and remains readable (no truncation).
3. Confirm the scorecard:
   - Gauge + per-jurisdiction bars stack vertically.
   - Gap badges wrap without overflow.
   - Recommendations list renders one column.

**Screenshot:** `uat-2026-XX-XX-nca-scorecard-375.png`.

### 3.2 Filters on mobile

1. Confirm the dropdown controls are ≥44 × 44 CSS px touch targets.
2. Apply a filter; confirm the gap list re-renders without horizontal scroll.

### 3.3 PDF export on mobile

Skip this — PDF generation + download works the same client-side, but mobile browsers open the download in a new tab. No mobile-specific assertions beyond "download fires."

## 4. Accessibility spot-check (optional)

- Run axe DevTools on `/compliance/scorecard` — zero "serious" or "critical" violations is the bar. (Our CI gate enforces this on main.)
- Tab through the page with a keyboard — focus outline is visible on every interactive element.
- Confirm the gauge's `<title>` element (the SVG timeline line chart) is announced by VoiceOver.

## 5. What to file

For each UAT run, comment on [SCRUM-893](https://arkova.atlassian.net/browse/SCRUM-893) with:

- Desktop + mobile screenshots attached.
- Any filter / PDF / Nessie-prose bugs observed (log each one in the [Bug Tracker Spreadsheet](https://docs.google.com/spreadsheets/d/1mOReOXL7cmBNDD77TKVKF3LsdQ3mEcmDbgs5q_pTEk4/edit?gid=0#gid=0) with severity + steps).
- If all 2 passes are clean, transition SCRUM-893 to **Done** and leave a "UAT PASS" comment.
- If any severity-high bug is found, transition SCRUM-893 to **Blocked** and link the follow-up bug tickets.

## 6. Known limitations

- **Nessie prose is flag-gated.** Expect static `remediation_hint` in prod until `ENABLE_NESSIE_RAG_RECOMMENDATIONS=true` lands post-NVI-12.
- **The score gauge in the PDF is vector-approximated**, not a perfect SVG-to-raster. Acceptable trade-off to avoid the `html2canvas` dep.
- **Integrity + fraud severity bumps** flow via the `integrity_scores` + `extraction_manifests` parallel JOIN added in NCA-FU1 #5. If those tables are empty in your test org, the severity stays at the gap-engine default.
