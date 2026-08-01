# scripts/kpi/agents.md

Partner-KPI reconciliation tooling — read-only prod reporting scripts that
turn a contract's KPI clause into a run-on-demand evidence artifact. Sibling
to `scripts/kpi3/` (KPI #3, independent verification) but a separate
directory: different data source (Arkova's own `anchors` /
`verification_events` tables via PostgREST, not a public Bitcoin explorer)
and a different question.

## Files

- **`haki-weekly-reconciliation.ts` + `.test.ts`** — HakiChain LOI (DocuSign
  envelope `5BE7302F`, Exhibit A §2) KPI #2 "Verification reliability" weekly
  reconciliation. Computes, per org + date window: anchors issued by status,
  how many completed the full issue→fingerprint→anchor→verification cycle,
  completion % vs the 95% target, the exact stage each incomplete anchor
  stopped at, and the delta vs HakiChain's self-reported issued count (only
  when supplied — never inferred). Full usage + output guide:
  `docs/partners/hakichain-kpi-reconciliation.md`.
  - **Read-only, no writes.** Every DB call goes through a single
    `pgrestGet` helper hardcoded to `method: 'GET'`; a repo test greps the
    source for INSERT/UPDATE/DELETE/PATCH/POST and any non-GET fetch method
    literal.
  - **No embedded credentials.** `SUPABASE_URL` +
    `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_ANON_KEY`) come from the
    environment only; a test asserts no hardcoded Supabase URL or JWT-shaped
    key literal in source.
  - **Pure core.** `buildReconciliation()` is a pure function over
    already-fetched rows — no network in unit tests. The only I/O is
    `fetchReconciliationInputs()`, which is a thin, separately-typed wrapper
    around two GET calls.
  - **Honesty labeling (CLAUDE.md §1.5 / R-7):** every result carries a
    `measurementNote` stating explicitly that "verification" here is the
    KPI-2 log-based signal (not KPI-3's stronger non-issuer-independent
    check) and that HakiChain's issued count is never observed or inferred,
    only ever the caller-supplied self-report.
  - **Prod query gotcha (documented in the file):** the org-scoped `anchors`
    query MUST include `deleted_at=is.null` alongside `org_id=eq.<id>` — that
    combination is what matches the `idx_anchors_org_deleted_created` partial
    index. An `org_id`-only filter on this 2.97M-row table seq-scans and can
    time out the query connector (observed live 2026-07-28 verifying KPI-1).
  - **2026-07-31 SonarCloud Quality Gate fix (11 findings, all in this file):**
    `--haki-issued-count-file` is now validated (`resolveIssuedCountFilePath`
    — resolved to an absolute path, confirmed to exist and be a regular
    file) BEFORE the read (`tssecurity:S8707` — an automated/LLM-driven
    invocation could otherwise pass a malicious path). `buildReconciliation`
    was split into `buildAnchorReconciliationRow` /
    `determineStoppedAtStage` / `buildHakiChainComparison` /
    `formatSignedDelta` to bring cognitive complexity from 26 back under the
    15 threshold and eliminate two nested-ternary code smells (`S3776`,
    `S3358` x2) — pure refactor, `buildReconciliation`'s output is unchanged
    (all 24 pre-existing tests plus 3 new path-validation regression tests
    pass). `formatSummary`'s `.sort()` on `Object.entries()` now takes an
    explicit compare function (`S2871` — relying on default coercion-based
    sort for a non-string array is a latent-bug pattern even though it
    happened to sort correctly here), and its consecutive `lines.push()`
    calls were combined (`S7778`). The file-shape validation error is now a
    `TypeError` (`S7786`).

## Conventions

- Read-only against prod by design — these tools answer "what happened,"
  they never provision or mutate. If a KPI tool needs to write (e.g. a
  provisioning planner), it belongs in `scripts/admin/` or gets an explicit,
  loudly-labeled dry-run-only contract like `scripts/kpi3/haki-provision-plan.mjs`.
  Every write-shaped script gets a "module contains no SQL / DB write" repo
  test, mirroring the read-only test here.
- Separate the pure computation (fully unit-testable, mocked rows, no
  network) from the I/O fetch (thin, typed, exercised only via the CLI /
  manual runs). This is the same shape as `scripts/kpi3/external-verify.mjs`'s
  injected `fetchPath`.
- Every number that compares Arkova's own data against a partner's
  self-reported number must state, in the output itself, that it is a
  self-report reconciliation — never imply Arkova independently verified the
  partner's side.
