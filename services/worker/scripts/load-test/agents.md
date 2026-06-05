# services/worker/scripts/load-test

k6 load-test profiles for SCRUM-1024 SCALE-02 (10K DAU target). Requires `k6` installed (`brew install k6`).

## Files

- `baseline.js` — Current production traffic mix (~5 rps, 60s). Establishes a baseline before scaling tests.
- `10k-dau.js` — 10K DAU-equivalent: 100 rps sustained + 500 rps burst, 5 min. p99 < 500ms, zero 5xx.
- `backpressure.js` — Sustained webhook ingestion at 200 rps, 90s. Verifies 503 + Retry-After when queue exceeds 10K pending, and clean recovery after drain.
- `docusign-volume.js` — DocuSign Connect volume profile (SCRUM-2094): 100 rps, 30 min, 15% signed-webhook mix. DocuSign-leg p99 < 300ms, err < 0.1%. Refuses to start without `DOCUSIGN_HMAC_KEY`.
- `lib/docusign-synth.js` — Pure, runtime-agnostic synthetic Connect-payload generator (mix selection + `envelope-completed` payload + canonical serialization). Imported by BOTH the k6 harness and Vitest. No crypto/clock/RNG — caller supplies ids/timestamps so output is byte-deterministic.
- `lib/docusign-synth.test.ts` — Vitest cross-validation: synthetic payloads are accepted by the REAL receiver (`parseDocusignConnectPayload`, `verifyDocusignConnectHmacMultiKey`, `extractNotaryData`). Guards against the generator drifting from the webhook schema.
- `lib/k6-docusign.js` — k6-only glue (imports `k6/http` + `k6/crypto`): signs `lib/docusign-synth.js` output and assembles the HMAC-signed POST. Not unit-tested (k6-only); the payload+HMAC contract it depends on is covered by the Vitest suite.
- `README.md` — Target profiles, running instructions, threshold definitions, DocuSign env vars.

## Constraints

- Set `WORKER_URL` env to target (local / staging / prod).
- Never run `10k-dau`, `backpressure`, or `docusign-volume` against prod outside a coordinated maintenance window.
- `docusign-volume.js` POSTs real signed envelopes through the full ingestion path — run it **only against an isolated staging rig** (CLAUDE.md §1.11/§1.11A) seeded with a matching DocuSign integration. Never shared staging mid-soak.
- The DocuSign leg degrades to `/health` when `DOCUSIGN_HMAC_KEY` is unset, so a default `10k-dau` run never POSTs unsigned webhook traffic. (The old `loadTestGuard.ts` drop-middleware never shipped — see README "Notes".)
- `lib/docusign-synth.js` must stay dependency-free ESM so both runtimes import it. If you change the payload shape, the Vitest suite must still pass against the real receiver.
