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
- `72h-soak-runbook-2026-08.md` (SCRUM-2980) — executable runbook for the single
  72h isolated-rig soak covering the 2026-08 launch wave (~40 PRs, T1/T2/T3
  mixed in one window): go/no-go checklist, rig provisioning + build-at-head,
  Cloud Scheduler wiring, the R17 flag-matrix divergence
  (`ENABLE_ORG_CREDIT_ENFORCEMENT`/`ENABLE_OUTBOUND_WEBHOOKS` ON in the rig
  only), the 4-pillar evidence standard mapped to this wave's changed
  surfaces, daily observation checklist, abort criteria, SOC2/ISO evidence
  artifact list. Companion manifest:
  `docs/staging/rc-manifests/rc-2026-08-launch-72h.json` (draft, not approved).
- `wave-merge-choreography-2026-08.md` — the G→M→D→F→S merge order for the same
  wave: gate fixes first/alone, the migration trio serial with mandatory
  post-merge `agents.md` content verification, DocuSign, folders/deps
  housekeeping, then new sprint PRs. Covers `covered_main_shas` manifest
  maintenance and Mergify batch discipline (batch_size 10, don't touch a
  queued PR, refresh doesn't reliably force embark, a CANCELLED check on a
  queued PR is usually a superseded speculative run).

## Editing rules
- Keep tier tables + required-field lists in sync with
  `scripts/ci/check-staging-evidence.ts` (`TIER_SPECS`) — that script is the
  source of truth; these docs mirror it.
- Do not add prod-state claims (rev / applied / verified) here — `HANDOFF.md`
  owns rolling state, `CLAUDE.md` owns rules.
- Reference existing tooling by path; do not fork the preflight / evidence logic
  into these docs.
