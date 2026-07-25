# docs/release — agents.md

Release Management / Release Train Engineering (RTE) process docs. **Reference
docs, not prod-state assertions** — every live rig / soak / ledger fact defers to
`HANDOFF.md` (cited there with verification) and `docs/reference/STAGING_RIG.md`.

## Files
- `release-management-runbook.md` (SCRUM-2898) — RM/RTE runbook + stop-the-line
  rules: T0–T3 soak gates, clean-mirror contract, migrate-before-merge (§5 / §0
  rule 10), the 72 h massive-soak procedure, merge order, rollback rehearsal,
  stop-the-line triggers.
- `staging-parity-path.md` (SCRUM-2896) — release-grade staging parity: isolated
  prod-shaped rig standup, why shared `arkova-staging` (ledger 0326) is not
  merge-grade, the `clean_mirror` preflight contract.

## Editing rules
- Keep tier tables + required-field lists in sync with
  `scripts/ci/check-staging-evidence.ts` (`TIER_SPECS`) — that script is the
  source of truth; these docs mirror it.
- Do not add prod-state claims (rev / applied / verified) here — `HANDOFF.md`
  owns rolling state, `CLAUDE.md` owns rules.
- Reference existing tooling by path; do not fork the preflight / evidence logic
  into these docs.
