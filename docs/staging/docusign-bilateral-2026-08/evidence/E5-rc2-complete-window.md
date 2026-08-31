# Evidence E5 — RC-2 (complete feature set) soak window

## Window
- **Rig:** Supabase `aqikotdkmhxmznonwmwk`, ledger head `0424`.
- **Worker:** `arkova-worker-docusign-bilateral-staging` rev **00004-xpn**, image
  `sha256:edca3f401ddde4aa96c81dc01062cb836166eb14eb0ae064a83ba8f69f835d6b`,
  source head **`2302e815e61fca5af449ba53a7ccca2fac49606e`** (branch `rc/docusign-bilateral-2026-08-30`).
- **Clock basis = Cloud Run revision ready 2026-08-31T00:46:58Z → T3 closes 2026-09-02T00:46:58Z.**
- Driver: `~/arkova-soak/docusign-bilateral/supervisor.sh`, detached (PPID 1), 15-min cycles.

## What RC-2 adds over RC-1
RC-1 (`2a676981`) covered PRs #2472/#2473/#2474/#2476 + harness #2479. RC-2 adds:
#2489 (DECLARED_UNVERIFIED disclosure on 6 surfaces, incl. the `oracle_batch_verify`
live-registration fix), #2518 (0424 rollback made executable), #2520 (F1 provenance
auto-heal), #2521 (signer backfill), #2516 (seed fixture), #2485 (16KB rule-event bound).

**RC-1's 35 sealed cycles are preserved in `~/arkova-soak/docusign-bilateral/round1-sealed/`
and are NOT counted toward the RC-2 window.** The clock restarted deliberately so a single
48 h window covers the complete feature rather than a partial RC.

## Live state (first cycles of RC-2)
| Assertion | Value |
|---|---|
| connector artifacts, all `materialized` | **37 / 37** |
| inbound artifacts correctly classified | **37** |
| anchors carrying `fingerprint_source='issuer_record_attestation'` | **37** |
| nonces account-scoped (migration 0424 live) | **152 / 152 (100%)** |
| unresolved provenance conflicts | **0** |
| PII leakage across anchors + artifacts + job payloads | **0** |
| per-org isolation (all artifacts to the receiving org) | holds — Soak Org A only |

## Honest coverage limits of a synthetic rig (residual risk, not defects)
1. **The OUTBOUND document-fetch leg cannot be exercised here.** Synthetic orgs have no real
   DocuSign OAuth grant, so `docusign.envelope_completed` jobs fail at
   `docusign_integration_missing_refresh_token_secret` and never materialize an anchor.
   Consequence: `fingerprint_source='document_bytes'` anchor count is **0** on this rig, and
   signer capture (#2474) is proven **at the webhook/job layer** (`_signers` present on job
   payloads, GUIDs only, mis-slotted PII rejected) but **not** end-to-end onto an anchor.
   Closing this requires a real DocuSign-connected account — it is NOT closable synthetically.
2. **The F1 auto-heal (#2520) is not exercised by this driver's mix.** The forgery-collision
   family exists in harness #2479 but the running supervisor drives 6 families, not all 15.
   The auto-heal's guarantee is carried by its formally verified TLA invariant
   (`outboundNeverSilentlyAcceptsForgery`, 121 states / 374 edges, independently re-run) plus
   unit tests — not by this window's live load.
3. **The signer backfill (#2521) is flag-enabled on the rig but has no eligible candidates**,
   because eligibility requires outbound anchors, which limit (1) prevents.

These three go in the RC manifest as explicit deviations. A green window here does NOT
substitute for the SCRUM-3818 go-live gate.
