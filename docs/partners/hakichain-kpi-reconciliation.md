# HakiChain KPI-2 weekly reconciliation

Internal engineering notes for `scripts/kpi/haki-weekly-reconciliation.ts`. Per
CLAUDE.md §0 rule 4, this `.md` is **not** the system of record — it documents
how the tool works so the on-call/RTE can run it. If a Confluence page for the
HakiChain partnership exists or is created, mirror the "how to read the
output" section there too.

## Why this exists

The executed HakiChain LOI (DocuSign envelope `5BE7302F`, signed 2026-07-15),
Exhibit A §2, KPI #2 "Verification reliability", reads:

> ≥95% of documents issued via HakiChain complete
> issue → fingerprint → anchor → independent-verification, measured by Arkova
> verification logs reconciled **weekly** against HakiChain's issued count.

Before this tool, there was no HakiChain/pilot-specific reconciliation
anywhere in the repo (confirmed by repo-wide grep, 2026-07-28) — no scheduled
job, no report, no artifact satisfying "reconciled weekly." This tool is that
artifact.

It is a sibling to `scripts/kpi3/` (KPI #3, "independent verification by a
non-issuer party" — a stronger, separately-scoped check with its own
clean-room verifier) but lives in its own `scripts/kpi/` directory because it
answers a different question with different data sources (org-scoped prod
reads vs. a dependency-free public-explorer client).

## What it measures (and what it does NOT)

The org's `anchors` rows for a date window are walked through four stages:

1. **issue** — an `anchors` row exists in the window (true by construction:
   the query already scopes to this).
2. **fingerprint** — `anchors.fingerprint` is a valid 64-hex SHA-256. The
   column is `NOT NULL` in the schema (client-side fingerprinting happens
   before the row is ever inserted, per CLAUDE.md §1.6), so this stage is
   structurally almost-always true; it is still checked explicitly rather
   than assumed, because this tool never trusts upstream state blindly.
3. **anchor** — `anchors.status = 'SECURED'` (on-chain committed).
4. **verification** — at least one `verification_events` row with
   `result = 'verified'` exists for the anchor (matched by `anchor_id`, or by
   `public_id` when the event's `anchor_id` is null).

An anchor is "complete" only if it clears all four. Anything else is reported
in `incomplete[]` with a `stoppedAt` field naming the **first** stage it
failed.

**Honesty boundary (CLAUDE.md §1.5 / R-7 — read this before quoting the
output anywhere):**

- **"Verification" here is the KPI-2 log-based signal only.** A
  `verification_events` row does not currently distinguish HakiChain's own
  dashboard lookup of their own anchor from a genuinely independent,
  non-issuer check. That stronger claim — "independent verification by a
  non-issuer party" — is KPI #3's job (`scripts/kpi3/external-verify.mjs`),
  not this tool's. Never present this tool's `completionPct` as satisfying
  KPI #3.
- **HakiChain's own issued count is not observable by Arkova.** This tool
  never infers or estimates it. `hakiChain.reportedIssuedCount` is `null`
  unless the caller explicitly supplies `--haki-issued-count` /
  `--haki-issued-count-file`, and every output labels that number as
  HakiChain's **self-report**, reconciled against — not verified against —
  Arkova's own count.
- Every JSON output carries a `measurementNote` string restating this
  boundary. Do not strip it when forwarding the JSON to a partner or to
  Jira/Confluence.

## Usage

```bash
SUPABASE_URL=https://vzwyaatejekddvltxyye.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service role key, from Secret Manager — never commit it> \
  npx tsx scripts/kpi/haki-weekly-reconciliation.ts \
    --org-id f52cd07a-6d8a-4387-9346-23babec84e5c \
    --window-start 2026-07-21 --window-end 2026-07-28 \
    [--haki-issued-count 15] \
    [--haki-issued-count-file haki-count.json] \
    [--fail-below-target] \
    [--json]
```

- `--org-id` — the HakiChain **production** org
  (`f52cd07a-6d8a-4387-9346-23babec84e5c`). Do not point this at the
  `[SANDBOX] hakichain` org (`ca1c9a22-5ac7-412e-b501-f48ba1897ded`) for real
  KPI evidence — that org is test-only (`org_credits.is_test = true`).
- `--window-start` / `--window-end` — inclusive `YYYY-MM-DD` UTC date bounds.
  For the weekly cadence, run with a 7-day trailing window.
- `--haki-issued-count` — HakiChain's self-reported issued count for the same
  window, when they have supplied it (email/call/dashboard export — there is
  no automated feed). Omit if not yet supplied; the delta will read `null`
  with an explicit note rather than silently omitting the field.
- `--haki-issued-count-file` — same, but read from a JSON file (a bare number
  or `{"issuedCount": N}`). Useful when the count arrives as a small file
  attachment rather than a single number typed on the command line.
- `--fail-below-target` — exit code 1 when `completionPct < 95`. Off by
  default (this is a reporting tool, not a gate) — opt in if wiring this into
  an alerting job.
- `--json` — machine-readable output only (for piping into another tool or
  attaching to a ticket). Default is the human-readable summary.

Credentials come from the environment only (`SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY`, or `SUPABASE_ANON_KEY` as a narrower fallback).
Nothing is hardcoded in the script; see the "no embedded credentials" test in
`haki-weekly-reconciliation.test.ts`.

## Read-only guarantee

Every database call in this tool goes through a single `pgrestGet` helper
that hardcodes `method: 'GET'` — there is no write path in the module. This
is enforced by a repo test (`haki-weekly-reconciliation.test.ts` →
"module is read-only") that greps the source for INSERT/UPDATE/DELETE SQL and
any non-GET fetch method literal, mirroring the equivalent guard in
`scripts/kpi3/haki-provision-plan.test.mjs`.

## How to read the output

### Human-readable (default)

```
HakiChain KPI-2 weekly reconciliation — org f52cd07a-6d8a-4387-9346-23babec84e5c
  window          : 2026-07-21 .. 2026-07-28
  generated at     : 2026-07-28T15:00:00.000Z
  anchors issued  : 4
    - SECURED: 4
  full-cycle done : 1 / 4
  completion      : 25% (target >= 95%) — BELOW TARGET
  HakiChain delta : HakiChain's issued count was not supplied this run (...)
  incomplete anchors (stopped-at stage):
    - PUB-xxxx [SECURED] stopped at: verification
    - PUB-yyyy [SECURED] stopped at: verification
    - PUB-zzzz [SECURED] stopped at: verification

  ASSERTED vs MEASURED (CLAUDE.md §1.5): ...
```

- **`completion` / MEETS TARGET vs BELOW TARGET** — the headline KPI-2 number
  for the window. Below 95% is a real gap; do not average it away across
  weeks without saying so explicitly.
- **`incomplete anchors`** — every anchor that has NOT completed the full
  cycle, with the exact stage it stopped at (`fingerprint`, `anchor`, or
  `verification`). This is the actionable list — e.g. a run of
  `stopped at: verification` on otherwise-SECURED anchors means the documents
  are safely on-chain but nobody (including HakiChain) has run a verification
  lookup on them yet, which is a very different problem from anchoring
  failures (`stopped at: anchor`).
- **`HakiChain delta`** — read the full sentence, not just the number. It
  always states whether HakiChain's count was supplied and, when it was,
  says explicitly this is "HakiChain's self-report reconciled against
  Arkova's own count, not an independent check of HakiChain-side data."

### JSON (`--json`)

Same fields, machine-readable — see the `ReconciliationResult` type exported
from `haki-weekly-reconciliation.ts` for the exact shape
(`totalIssued`, `byStatus`, `completedFullCycle`, `completionPct`,
`targetPct`, `meetsTarget`, `incomplete[]`, `hakiChain{}`,
`measurementNote`).

## Running it weekly

There is no scheduled job wired up yet (out of scope for this PR — this
delivers the tool + evidence artifact shape, not a Cloud Scheduler entry).
Until one exists:

1. Run the command above with a trailing 7-day window every week (e.g. every
   Monday for the prior Mon–Sun).
2. Save the `--json` output somewhere durable (attach to the weekly HakiChain
   status thread / the relevant Jira ticket) — this is the evidence artifact
   the LOI's "reconciled weekly" clause requires.
3. When HakiChain supplies their issued count for the window, re-run with
   `--haki-issued-count` (or file) so the delta is captured in the same
   artifact rather than reconstructed later from memory.
4. If `completionPct < 95`, treat `incomplete[]` as the punch list — it names
   the exact stage each shortfall anchor stopped at.

## Related tooling

- `scripts/kpi3/` — KPI #3 (independent, non-issuer verification). Different
  question, different data source (public Bitcoin explorer, not Arkova's own
  tables). Do not conflate KPI #2's log-based "verification" signal with
  KPI #3's stronger independent-verification proof.
- `scripts/kpi3/haki-provision-plan.mjs` — the KPI #1 (pilot delivery)
  provisioning planner. As of the live prod check on 2026-07-28
  (`vzwyaatejekddvltxyye`, read-only `execute_sql`), the production HakiChain
  org (`f52cd07a-6d8a-4387-9346-23babec84e5c`) holds **4** `SECURED` anchors
  and a separately **allocated** `org_credits.anchor_quota` of **15** for
  HakiChain to draw on as needed. These are two unrelated numbers, not a
  delivery target with anchors outstanding — do not report this as "4 of 15"
  or as a gap/shortfall anywhere (PR body, Jira, Confluence, bug tracker); see
  `memory/project_hakichain_account_state.md`. None of the 4 anchors has a
  materialized `anchor_proofs` row (0 of 4) — that IS a real, separately
  tracked finding, consistent with the known repo-wide proof-materialization
  gap (see `memory/project_proof_materialization_gap.md`), and unaffected by
  the correction above. With only 4 anchors issued so far, the weekly
  reconciliation window will show a small `totalIssued` until more of the
  allocated quota is drawn on.
