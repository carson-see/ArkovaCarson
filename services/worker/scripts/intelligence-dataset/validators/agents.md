# agents.md — scripts/intelligence-dataset/validators/

_Last updated: 2026-04-17_

## What This Folder Contains

NVI (Nessie Verification Infrastructure) validators. Structural checks that
every citation in the Nessie intelligence-dataset source registry resolves
to an authoritative primary source. The training pipeline
(`../build-dataset.ts`) consults `../verification-status.json` before emitting
training JSONL and refuses to emit on untrusted citations (NVI-18 CI guard).

| File | Purpose | Jira |
|------|---------|------|
| `types.ts` | Shared `Validator` / `VerificationResult` types | — |
| `statute-quote-validator.ts` | Federal statute-quote validator: canonical `§` / U.S.C. / CFR format, quote must reference the cite, URL on federal authority domain | NVI-01 / SCRUM-805 |
| `case-law-validator.ts` | Case-law cite validator: canonical "X v. Y" or "In re X", year, reporter (soft), URL on CourtListener/Justia/uscourts.gov | NVI-02 / SCRUM-806 |
| `agency-bulletin-validator.ts` | CFPB / FTC / HHS OCR / FPCO / EEOC validator: agency-matched identifier + URL on the agency's own domain | NVI-03 / SCRUM-807 |
| `state-statute-validator.ts` | Per-state code-label patterns + section-number label/quote consistency + state-official-host URLs | NVI-04 / SCRUM-808 |
| `index.ts` | Orchestrator: runs every applicable validator over a source, emits a `SourceVerification` aggregate |
| `verification-registry.ts` | JSON-on-disk registry format + trust decision logic (staleness, orphan handling) |
| `verify-sources.ts` | CLI: `npx tsx verify-sources.ts --regulation all [--live] [--strict]` writes `../verification-status.json` |
| `validators.test.ts` | 33 unit tests — offline, deterministic |

## Conventions

- **Offline-first.** Every check is structural — regex + URL-host allowlist.
  Live mode (`--live`) only does HEAD requests. Never fetch quote text in
  CI; authority sites throttle and rate-limit aggressively.
- **Applicability gates.** Every validator returns `{ applicable: false }`
  for sources outside its jurisdiction. A source that no validator claims
  is an ORPHAN and must be routed manually.
- **Hard-fail vs soft-fail.** Hard failures block CI (NVI-18). Soft
  failures (reporter-cite missing on a case cite; agency URL absent when
  identifier exists) WARN only. Use the existing `onlySoftProblem` idiom
  when adding new checks.
- **Deterministic stamps.** Every validator takes a `ValidateOpts.now`
  override so tests are time-stable.

## CI Guard Workflow

1. Edit a source or scenario in `../sources/` or `../scenarios/`.
2. Run `npx tsx validators/verify-sources.ts --regulation <reg>` — this
   updates `../verification-status.json`.
3. Run `npx tsx build-dataset.ts --regulation <reg> --version <ver>`. If any
   cited source is untrusted (stale, failing, orphaned), the CI guard
   exits non-zero.
4. Fix the source (add URL, correct section number, etc.) and loop.
5. Commit the changed sources AND `verification-status.json`.

Escape hatch: `NVI_SKIP_GUARD=1 npx tsx build-dataset.ts ...`. This MUST
NOT be used in CI. It's only for disposable experimental endpoints.

## Adding a New Validator

1. Define `ValidatorKind` in `types.ts`.
2. Implement `Validator` interface in a new file.
3. Register in `index.ts`'s `ALL_VALIDATORS`.
4. Add tests to `validators.test.ts`.
5. Re-run `verify-sources.ts --regulation all` and commit the updated
   `verification-status.json`.

## Related Docs

- `docs/runbooks/nvi-quarantine-2026-04-17.md` — quarantine policy for v28
  HIPAA + v29 FERPA.
- `services/worker/src/ai/nessie-quarantine.ts` — customer-facing caveat
  roster consumed by `org-audit.ts`.
- CLAUDE.md §0 NVI Gate Mandate — hard rule: no new regulation training
  until FCRA passes NVI.
