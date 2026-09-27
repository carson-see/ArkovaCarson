# Round-two packaged client qualification — 2026-09-27

## Boundary

Local, synthetic, localhost-only qualification of the frozen working sources after the PR #3152 Parts 5/6 repairs. Nothing was published, pushed, deployed, or sent to a hosted service. Preview versions remain unreleased.

The deterministic fixture listened only on `127.0.0.1:18765`. It contained synthetic anchor identifiers and an arbitrary synthetic organization tag. No private customer data, production key, or secret appears in this receipt.

## Fresh artifacts

- `arkova-3.3.0.tgz` after final proof wording: `c93f929813c951ced5f508f392d9e827c137dc51d0f517221f14db9fbb35c4d6`
- `arkova-api-cli-0.3.0.tgz`: `f3c86e944aa4becd9840cd18496ce5e5569c7d5e4901e1e6f73f1d2d8d5d81f1`
- `arkova-mcp-server-3.3.0.tgz`: `bd2c53943eeb74a823d10ff2ebaa764f4f382779977affe3cb143b0a92394078`

The three tarballs were rebuilt from current sources and installed with `--ignore-scripts` into new consumer directories. The source-file hash manifest for SDK, API CLI, and stdio MCP is `7dbad84d9be006b159b54fbff652fdcfa670c02789831f9c667309783b5563b8`.

## Executed package behavior

- The installed TypeScript SDK performed two real localhost HTTP pages using the same absolute `since`, arbitrary `organization` tag, and returned cursor. It mapped the six-field wire projection and surfaced the synthetic 503 as `ArkovaError(anchor_list_unavailable, 503)`.
- The installed `arkova` CLI performed page 1 and page 2 with stable absolute dates and the arbitrary tag. Page 1 returned the exact reusable `nextPageOptions`; page 2 returned no cursor. A wrong API key produced bounded JSON with status 401 and exit code 1.
- A real MCP client spawned the installed `arkova-mcp-server` binary over stdio. Discovery returned 18 tools including `arkova_list_anchors`. Two real `tools/call` requests forwarded the same filters and cursor. Each returned only `public_id`, `status`, `created_at`, `updated_at`, `filename`, and `description`; the private tag was absent.

Result hashes are recorded in `result-hashes.txt`. The fixture process was stopped after qualification.

## Preserved earlier evidence

Python 2.6.0 sync/async wheel qualification and verifier CLI proof-unavailable/malformed/valid qualification remain inherited from `packaged-client-qualification-20260927/qualification-receipt.md`; those sources were not changed by this repair. They were not rerun or represented as fresh evidence here.

## Result

PASS for clean local installation and the bounded package behaviors above. Registry publication, hosted MCP, deployed API behavior, browser behavior, production data, and live acceptance remain unverified.


## Final wording-only rebuild

The final proof follow-up changed TypeScript SDK type/client wording and Python model comments only (diff `baf00a102ab48c25261bba3d4475ecd6574d18847b7b9f298ba7c0c30554c20e`). Rebuilt artifacts: SDK `c93f929813c951ced5f508f392d9e827c137dc51d0f517221f14db9fbb35c4d6`; Python wheel `d47c6131ae008a8ca42f7aa7707427784ad66202a2e2b57b5925a8ef29bde1b4`; Python sdist `9b2a3267e943bc2751a8882c1854580f166b5988ba69275bcae1e4b7ca5c4620`. Earlier installed-package behavior evidence is inherited because executable behavior did not change; it was not represented as a fresh rerun.
