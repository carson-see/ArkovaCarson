# Sprint closure reviewer evidence — 2026-09-27

This directory is the single small reviewer packet for the current source candidate. It contains sanitized summaries and hashes rather than raw logs, package archives, fixtures, credentials, customer data, or local database URLs.

## What is covered

- `0494-review.md`: independent review of agent-key mint/revoke locking and physical-delete safety.
- `drive-review.md`: final Drive recovery source review.
- `fixed-a-review.md`: the compatible fallback worker that blocks agent mutations while continuing reads and durable webhook draining.
- `parts5-6-review.md`: bounded PR #3152 client/MCP/worker corrections.
- `packaged-clients.md`: clean installed TypeScript SDK, API CLI, and stdio MCP localhost qualification.
- `package-source-hashes.txt`: exact source-file hashes used for those client packages.
- `proof-sdk-evidence.md`: prior singleton proof SDK qualification.
- `review-dispositions.md`: round-two PR #3152 review findings and dispositions; proof wording-only follow-up diff `baf00a102ab48c25261bba3d4475ecd6574d18847b7b9f298ba7c0c30554c20e`.
- `app-credential-prior-evidence.md`: bounded app and synthetic academic/technical/CLE/CPE/license rehearsal evidence.

## Exact identities and checks

- 0494 migration SHA-256: `11e3db7802e3636d3225eca1746074f5809fa8eebf38c97735020cdc3a029836`
- 0494 native harness SHA-256: `722c3c162c6b359bfc09a470d4de1e559336aada0b02b3bef5243c3ba86b15ff`
- Fixed-A source commit: `10459180091b9cb4d88313b5e7108ccc297d57f2`
- Client source manifest SHA-256: `d0b6ead5bea883983c380699d64987cc0dd6f0c1556a820a702a1406398d16ef`
- SDK artifact SHA-256 after final wording rebuild: `c93f929813c951ced5f508f392d9e827c137dc51d0f517221f14db9fbb35c4d6`
- Python wheel SHA-256 after final comment-only rebuild: `d47c6131ae008a8ca42f7aa7707427784ad66202a2e2b57b5925a8ef29bde1b4`
- AR20-32 isolated-rig local source commit: `d89e78a71ce429690081e3d0bacc0313d0f79cd5` (161 tests plus 12 shell-harness tests passed; no live rig acceptance).
- API CLI artifact SHA-256: `f3c86e944aa4becd9840cd18496ce5e5569c7d5e4901e1e6f73f1d2d8d5d81f1`
- stdio MCP artifact SHA-256: `bd2c53943eeb74a823d10ff2ebaa764f4f382779977affe3cb143b0a92394078`
- Current working-tree results include 89 focused worker delivery tests after adding the retention call; the historical published-candidate receipt remains 87/87. Package evidence also covers two-page SDK/CLI/MCP execution, CLI authentication failure, and the six-field MCP response projection without private tags.
- Five synthetic credential variants and 70 CTDL mapping assertions were prepared previously.

Typical local commands represented by the receipts were package build/pack, clean `npm install --ignore-scripts`, installed binary execution against a loopback fixture, focused Vitest, TypeScript typecheck, ESLint, and the disposable native PostgreSQL harness. Exact commands and output boundaries are in the individual summaries.

## Status limits

This packet does **not** claim a final candidate head; the release owner must stamp that after integration. It also does not claim registry publication, production migration application, production configuration, deployment, browser acceptance, live customer acceptance, staging acceptance, production soak, or third-party external review. No soak was started in this session.

The 36-hour plain-language report and the complete 137-item recovery ledger remain in the existing canonical roadmap, rather than being duplicated here:

- [Canonical recovery roadmap](https://docs.google.com/document/d/1IrpVfTPehIwIUbAntlsCQjsBq7hEqhN-RFow-8A_9Ac/edit)
- [Confluence recovery roadmap](https://arkova.atlassian.net/wiki/spaces/AR2/pages/156729395)
