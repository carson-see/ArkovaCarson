# Sprint closure reviewer evidence — 2026-09-27

This directory is the single small reviewer packet for the current source candidate. It contains sanitized summaries and hashes rather than raw logs, package archives, fixtures, credentials, customer data, or local database URLs.

## Current review state

The final broad external review evaluated candidate checkpoint `1f134fca2a28baec91619d7e3c60d950f6348adf` and fallback checkpoint `041f89157105a57c6602b9d064efbd41eff89b52`. Their bounded corrections and verification are tracked in `final-review-dispositions.md`; the resulting exact source identities and published image checkpoints are recorded below; this candidate includes the test-fixture follow-up and requires a refreshed execution-manifest freeze. Earlier round-3 and historical receipts below remain supporting evidence only. Image publication and pull inspection are recorded, but no deployment, runtime admission or soak is implied, and no additional broad-review cycle is planned.

## Current immutable-image checkpoint — September 28

- Compatible fallback source `0334eee90b1c84842828e42d64d62827ceb6cf79`, tree `85768f5bfe4ffdae256737c3153be96568804902`, is published as `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker-fixed-a@sha256:c839d2073cdc3d941f602324ff236529a5d8ac354c65fc07c55a1a434b6e3868`. Independent digest pull verified `linux/amd64` and the exact embedded `BUILD_SHA`; it has not been deployed or rehearsed. Historical `b79479fea89616b1f20705f478c5ec03c0ecb824` and digest `sha256:21737a0a2faf3c93ee45a6255a0c0eed5d325dd7b8b084badb89dd7624c724ff` are superseded by this test-only exact-head correction.
- Candidate source `a284855bc3be620cd0bbf2ca1bb9dfce57b385f9`, tree `e89d5faaa5aed4eff1501f913bec95fa710f32b0`, was published locally and to Artifact Registry as digest `sha256:68449a933a5dd8e94562f08551a7c6081b851be68877b611f3e049f3b67c3f28`. It is now a historical pre-fixture artifact: this candidate corrects the native-outbox seeded organization UUID collision with a test-SQL-only follow-up. The native failure was reproduced as a duplicate seeded `organizations` primary key. The test-only correction changes exactly two fixture UUIDs (42 and 6 references) without changing assertions; final SQL SHA-256 is `c10d570d16a68a0b17b2381712e59b9c201059ec2fdef7eed703967d3d704c8f`. Seeded and fresh native runs, seeded revoke concurrency, and local real Auth/PostgREST/Storage RLS (34 files / 398 tests) pass. Browser acceptance remains open. The future executable candidate must use the refreshed PR head and frozen execution manifest; no future commit is predicted here.
- Current hosted evidence is incomplete: the candidate native-outbox job failed on that seeded fixture collision and its root job was skipped; this is not a candidate CI pass. Fallback run `36363082828` is still running at this checkpoint. The known count-policy label-context exception remains recorded in `final-review-dispositions.md`.

## What is covered

- `0494-agent-key-delete-lock-evidence.md`: restored historical native receipt, with its original hashes rechecked and the later MFA-census limitation made explicit.
- `round3-release-prerequisites.md`: read-only production legacy-rule count and enabled recipient-secret version check.
- `round3-review-dispositions.md`: item-by-item round-3 corrections, disputed marker behavior, current tests and remaining live gates.
- `0494-review.md`: independent review of agent-key mint/revoke locking and physical-delete safety.
- `drive-review.md`: final Drive recovery source review.
- `fixed-a-review.md`: historical fallback review. Current emergency DELETE and materialization-reporting corrections are identified in the round-3 receipt; register/PATCH/key creation remain blocked.
- `parts5-6-review.md`: bounded PR #3152 client/MCP/worker corrections.
- `packaged-clients.md`: clean installed TypeScript SDK, API CLI, and stdio MCP localhost qualification.
- `package-source-hashes.txt`: exact source-file hashes used for those client packages.
- `proof-sdk-evidence.md`: prior singleton proof SDK qualification.
- `review-dispositions.md`: round-two PR #3152 review findings and dispositions; proof wording-only follow-up diff `baf00a102ab48c25261bba3d4475ecd6574d18847b7b9f298ba7c0c30554c20e`.
- `final-review-dispositions.md`: the final broad external-review findings, bounded corrections, exact verification receipts, and remaining artifact/live gates. No additional broad-review cycle is planned.
- `app-credential-prior-evidence.md`: bounded app and synthetic academic/technical/CLE/CPE/license rehearsal evidence.
- `named-acceptance-matrix.md`: future-session case IDs, actors, prerequisites, expected visible results, negative/recovery cases, evidence owners, and pass/fail/open fields. Its existence does not mean those cases ran.
- `release-soak-plan.md`: combined T3 sequence, decision register, premortem, staging plan, and separately retained production-soak direction.
- `release-candidate-operator-runbook.md`: future production zero-traffic observation commands, blocked until the external review and acceptance prerequisites are met.
- `final-local-qualification.md`: final local source/package qualification boundaries and remaining live gates.

## Historical source checkpoints and package receipts

- 0494 migration SHA-256: `11e3db7802e3636d3225eca1746074f5809fa8eebf38c97735020cdc3a029836`
- 0494 native harness SHA-256: `722c3c162c6b359bfc09a470d4de1e559336aada0b02b3bef5243c3ba86b15ff`
- Historical fixed-A head: `10459180091b9cb4d88313b5e7108ccc297d57f2` — review-only and unready after material findings in [comment 5860117184](https://github.com/carson-see/ArkovaCarson/pull/3154#issuecomment-5860117184). Historical correction `0ff11a14e` is also superseded; the final broad review evaluated checkpoint `041f89157105a57c6602b9d064efbd41eff89b52`, and its test and required-schema source correction is published as `0334eee90b1c84842828e42d64d62827ceb6cf79`.
- Historical pre-round-3 runtime source checkpoint: commit `ce545a2f6315f81e087640d0520d6a6f05e98c95`, tree `8288c37ff07336d0e63d46074f6f7d11d18b54d8`, based on main `d3ebb81f000a81a9cc835118961e06c701fe4da2`. The earlier documentation-only supplements left that runtime unchanged; the round-3 correction now changes it. Use the enclosing correction commit and current disposition receipt for review.
- Draft PR #3154's final broad review evaluated `041f89157105a57c6602b9d064efbd41eff89b52`, superseding historical `10459180091b9cb4d88313b5e7108ccc297d57f2` and `0ff11a14e`. The resulting test and required-schema source correction is published as `0334eee90b1c84842828e42d64d62827ceb6cf79`. Actual image qualification, deployment, quiescence and rehearsal remain open.
- Draft PR #3153 publishes isolated-rig source commit `d89e78a71ce429690081e3d0bacc0313d0f79cd5`; no rig was provisioned and no live isolation acceptance was claimed.
- Client source manifest SHA-256: `d0b6ead5bea883983c380699d64987cc0dd6f0c1556a820a702a1406398d16ef`
- SDK artifact SHA-256 after final wording rebuild: `c93f929813c951ced5f508f392d9e827c137dc51d0f517221f14db9fbb35c4d6`
- Python wheel SHA-256 after final comment-only rebuild: `d47c6131ae008a8ca42f7aa7707427784ad66202a2e2b57b5925a8ef29bde1b4`
- AR20-32 isolated-rig local source commit: `d89e78a71ce429690081e3d0bacc0313d0f79cd5` (161 tests plus 12 shell-harness tests passed; no live rig acceptance).
- API CLI artifact SHA-256: `f3c86e944aa4becd9840cd18496ce5e5569c7d5e4901e1e6f73f1d2d8d5d81f1`
- stdio MCP artifact SHA-256: `bd2c53943eeb74a823d10ff2ebaa764f4f382779977affe3cb143b0a92394078`
- Historical pre-round-3 results included 89 focused worker delivery tests after adding the retention call; the historical published-candidate receipt remains 87/87. Package evidence also covers two-page SDK/CLI/MCP execution, CLI authentication failure, and the six-field MCP response projection without private tags.
- Five synthetic credential variants and 70 CTDL mapping assertions were prepared previously.

Typical local commands represented by the receipts were package build/pack, clean `npm install --ignore-scripts`, installed binary execution against a loopback fixture, focused Vitest, TypeScript typecheck, ESLint, and the disposable native PostgreSQL harness. Exact commands and output boundaries are in the individual summaries.

## Status limits

This packet retains historical source checkpoints and identifies the round-3 corrections separately. It does **not** claim that checkpoint is the future executable release freeze: final finding disposition, targeted verification, publication of the corrected exact identities, immutable image provenance, migration-ledger decisions, and the named acceptance prerequisites still have to bind a final executable candidate. The final broad external review has completed; no additional broad-review cycle is planned. The packet records the two registry image publications above. It does not claim production migration application, production configuration, deployment, browser acceptance, live customer acceptance, staging acceptance, production soak, or final artifact admission. No soak was started in this session.

The 36-hour plain-language report and the complete 137-item recovery ledger remain in the existing canonical roadmap, rather than being duplicated here:

- [Canonical recovery roadmap](https://docs.google.com/document/d/1IrpVfTPehIwIUbAntlsCQjsBq7hEqhN-RFow-8A_9Ac/edit)
- [Confluence recovery roadmap](https://arkova.atlassian.net/wiki/spaces/AR2/pages/156729395)


## Historical fallback correction checkpoint

Fixed-A correction `0ff11a14e4e85ab8c7931b6df3cfe5cca761ca2d` (tree `6deee788a4a0ea73338146e435350345c00317fd`) was an intermediate correction after `10459180091b9cb4d88313b5e7108ccc297d57f2`. It is historical and must not be selected as the rollback artifact. The final broad review evaluated later checkpoint `041f89157105a57c6602b9d064efbd41eff89b52`; the resulting test and required-schema source correction is published as `0334eee90b1c84842828e42d64d62827ceb6cf79` and is the exact source for the published rollback image at digest `sha256:c839d2073cdc3d941f602324ff236529a5d8ac354c65fc07c55a1a434b6e3868`.

Historical evidence: 115 focused lifecycle/delivery tests passed; subsequent affected webhook suites passed 98 tests, with the final prompt-drain suite passing 8 tests. These runs overlap and must not be summed or treated as final exact-head qualification. No new SQL migration or TLA state-machine change was introduced; the transaction model does not prove deployed behavior. An immutable image, configuration checks, quiescence and rehearsal remain required. Emergency DELETE can produce an owned row: stop incompatible old worker/job paths before its first use, not merely before Build B traffic. PR #3154 remains draft and protected by `do-not-merge`; it must never merge into the forward candidate or main.
