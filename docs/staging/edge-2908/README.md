# PR #2908 edge-deploy.yml — isolated rig soak evidence (durable copy)

Durable copy of the merge-grade evidence artifacts referenced from PR #2908's
`## Staging Soak Evidence` body. The PR body is the authoritative, gate-parsed
copy; this directory exists so the artifacts survive PR-body edits and rig
teardown, per the pattern already used under `docs/staging/batch-b-2026-08/evidence/`.

- Rig: Cloudflare Worker `arkova-edge-cto-2908` (workers.dev only; production
  `arkova-edge` / `edge.arkova.ai` untouched).
- Final sealed head: `07da6aca894d4a18dc8820bf9344c42171b94106`.
- Soak window used for evidence: `window6` (2026-09-13T21:24:00Z ->
  2026-09-14T01:25:09Z, 48/48 cycles green). Windows 1-5 in the rig's own
  `/Volumes/Extreme/offload/cto-soak-2026-09-12/edge-2908/` tree are VOID
  (superseded by fix commits made mid-soak: Dependency Scanning
  `--ignore-scripts`, an agents.md append-only conflict, and three rounds of
  SonarCloud hardening) and are not cited as evidence anywhere.

## Files

- `evidence/window6-summary.json` — final soak summary (cycle/health/parity counts).
- `evidence/window6-supervisor.log` — full per-cycle log for the sealed window.
- `evidence/final-deploy.log` — `wrangler deploy` output for the sealed head.
- `evidence/final-parity-check.log` — `check-edge-deployed-version.ts --strict` result.
- `evidence/final-health.json` — a `/health` snapshot confirming the deployed git_sha.

## Known gap: Image digest

`scripts/ci/check-staging-evidence.ts`'s `validateImageDigestEvidence()` requires
a literal `sha256:<64 hex>` OCI image digest, which does not exist for a
Cloudflare Worker deploy. The PR body's `Image digest:` field is `N/A` with this
explanation; the `Staging Soak Evidence Gate` required check is expected to stay
red on this one field until a gate change (proposed to Carson, not implemented
here per directive) adds an edge/Cloudflare-Worker-specific accepted value.
