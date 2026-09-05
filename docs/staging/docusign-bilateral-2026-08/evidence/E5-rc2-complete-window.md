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

---

## Mid-window invariant checkpoint — RC-3, ~19 h in (2026-08-31)

Probes prove HTTP behaviour; these are the DB-level invariants re-verified under sustained
load rather than at t=0.

| Invariant | Value |
|---|---|
| anchors, all `SECURED` | **129 / 129** |
| connector artifacts, all terminal `anchored` | **126 / 126** |
| inbound anchors carrying `fingerprint_source='issuer_record_attestation'` | **126**, all correct |
| nonces tenant-scoped (migration 0424) | **508 / 508 = 100 %** |
| PII leakage across anchors + artifacts + rule events | **0** |
| cross-org attribution leakage | **0** |
| unresolved provenance conflicts | **0** |

### One row needs explaining so the final manifest does not misread it
A "DocuSign-claiming anchor with no backing connector_artifact" count returns **1**:
`ARK-DOC-Y3Y2VA` / `real-docusign.pdf`, created 2026-08-30T16:18:20Z — **before any soak
window opened**. It is the E2 fixture: a service_role row inserted directly via SQL to prove
the 0423 guard *permits* legitimate worker writes. It has no artifact because it never went
through the drain, and it carries `fingerprint_source: null` because it predates that field
being stamped. It was later swept into the first forced batch and is now SECURED.

**It is a test fixture, not a forged record.** Exclude it when counting connector-produced
anchors in the RC manifest; the 126 artifact-linked anchors are the real population.

---

## RC-3 late-window review — the 2 probe failures, explained (2026-09-01T18:35Z)

At 150 cycles the window shows **898 probes OK / 2 failed, 150/150 health checks healthy,
145 anchors confirmed, one distinct worker SHA (`2302e815e`) throughout.** The two failures
are not averaged away — here is what they were.

### Both failures are in cycle 142 (2026-09-01T16:56:22Z)
`outbound_A` and `inbound` returned curl code **`000`** (no HTTP response). The other four
probes in that same cycle passed (202 / 200-duplicate / 401 / 200-orphan), and cycles 141
and 143 are fully clean.

**Cause, from the Cloud Run log at 16:55:49Z:**
`"The request was aborted because there was no available instance."`
That cycle's health read shows `uptime: 92` — the container had just been replaced. It is a
Cloud Run instance-availability gap during container recycling, **not** an OOM, a crash, or
a fault in the code under test (no OOM/SIGKILL entries exist in the window; the startup TCP
probe succeeded on first attempt each time).

### Container recycling vs. the soak clock
Three container recycles were detected by uptime going backwards (15:23Z, 16:24Z, 16:56Z),
clustered after ~34 h of stability. Only the third produced probe failures.

**The soak clock is unaffected.** The clock basis is the serving *revision*, and
`arkova-worker-docusign-bilateral-staging-00005-ss6` has served continuously since
2026-08-31T04:55:06Z — verified by `gcloud run services describe`. Cloud Run replacing a
container within a revision is routine and is not a redeploy; no revision change occurred.

### The recurring WARNING entries are our own adversarial probe
Cloud Run logs a WARNING roughly every 15 minutes. Verified by pulling the full entries:
each is a POST from the driver host at the exact cycle cadence with identical request size —
the deliberate **wrong-HMAC probe being correctly rejected 401**. Their presence is positive
evidence the adversarial family is firing every cycle, not a defect signal.

### Disposition
0.22 % probe-failure rate, fully attributed to a platform instance gap, self-recovered
within one cycle, no revision change, no data-integrity impact. Record it in the RC manifest
as an observed platform deviation rather than a code failure.
