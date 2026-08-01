# Nessie CAIO Audit Handoff - 2026-07-30

> **Status:** Safe stop. No paid model call was made.
>
> **Scope:** Nessie Intelligence only. This document does not describe Gemini
> Golden extraction and does not authorize changes to Arkova product code,
> production, customer data, existing RunPod endpoints/templates, rigs,
> databases, queues, schedulers, or deployment systems.
>
> **Current wedge:** Legal Record Proof-Packet Readiness in the United States
> and Kenya.

## Executive state

Nessie is the conversational compliance-intelligence system. Her intended job
is to reason over Arkova-verified records, explain an organization's
proof-packet readiness, identify evidence gaps, refuse unsafe record
manipulation, recommend next steps, and eventually cite Arkova-verifiable
sources. Gemini Golden remains the extraction system.

The current work is an isolated evaluation lane. It is not deployed,
customer-facing, legally activated, or connected to Arkova production. The
sealed holdout remains unopened. Authority projection, citations, automatic
admission, customer data, and production access remain disabled.

No paid Together request was made in this session. The one-attempt lock is
absent, Together and RunPod balances were not consumed by the final preflight,
and no existing RunPod endpoint was changed.

## What was proven

### v3.6.1 rejected

The v3.6.1 unified validator was rejected after independent reproduction of
semantic-closure and malformed-type failures. Examples included accepting
unknown action support, accepting orphan controls, under-enforcing required
control alternatives, and throwing unhandled type errors. It must not be used
for provider evaluation or promotion.

### v3.6.2 validator technically passed

Local package:

`/tmp/nessie-v3_6_2-unified-validator-candidate`

Binding:

- `SHA256SUMS` SHA-256:
  `54638916e7cc3b3b4fa1012900da14d25558e19d5d394aa82f232152a08b4e91`
- 30/30 package tests passed normally and under `python -O`
- 300/300 malformed vectors rejected in each mode
- 9/9 v3.6.1 regressions closed
- 5,000/5,000 additional deterministic invalid mutations rejected
- 1,134/1,134 cross-case substitutions rejected
- 45/45 capability-ledger entries validated
- authority, citations, holdout access, and automatic admission disabled

Known deliberate limitation: `MASK_DERIVED_REVIEW_COPY` and
`EXCLUDE_DERIVED_REVIEW_COPY` fail closed because there is no honest protective
privacy action lane yet. `CONDITIONAL_REVIEW` remains the valid privacy path.

### Current Kenya source recovered and mechanically verified

The exact current official Kenya regulations PDF was recovered and verified:

- PDF bytes: 473,162
- PDF SHA-256:
  `8bbf3cf6d0e126e31e0f45d4a44a90700b6354ee19b16fbe1187c26fbb9ba122`
- old incorrect source SHA-256:
  `d76bdef62ae1fb1d4deac45a9ae4fa7d78adee680760877b1c3d0c1cd803120b`
- all 18 required locators recovered
- 17 numbered regulations match after presentation-only normalization
- the Third Schedule changed from four images to structured text; semantic
  equivalence was not inferred

Corrected current-source span package:

`/tmp/nessie-v3_6_2-kenya-regulations-current-spans-candidate`

Binding:

- 183 mechanically extracted candidate units
- 36 structured Third Schedule units
- 8/8 tests passed normally and under `python -O`
- 22/22 mutation cases rejected in both modes
- 26/26 checksum entries passed
- package `SHA256SUMS` SHA-256:
  `3dff193c3123e08873e0931c5ea37459bd3bf6955451a7ace2bf891d7bc7195f`

Technical source identity, extraction, offsets, provenance, and reproducibility
are GO. Legal usability, authority, claims, citations, admission, and
automation are NO-GO pending qualified Kenyan legal/privacy review.

### KE-027 paid preflight is sealed but not authorized for execution

Frozen package:

`/tmp/nessie-v3_6_2-ke027-preflight-main`

Bindings:

- preflight `SHA256SUMS` SHA-256:
  `6f46a2dc40d4b75ceedba2709f33df8b484b59f51bdd394b8631ec74ddc0a3f2`
- exact SDK request SHA-256:
  `673ac78684c4db425f3ea0266ece97fd68cc1760b20376328efbe49a1c140aab`
- response schema SHA-256:
  `64174842e824ea6e115d8cbe01e0411e501a96762af1339d597b9be4e83f1d98`
- exact witness SHA-256:
  `a038b5d0ced8d256ca6bb733d5a97bd2d18579474142ee52d77f4fa6406a5534`
- 23/23 tests passed normally and under `python -O`
- 31/31 checksum entries passed
- JSON Schema Draft 2020-12 validation passed
- the exact witness satisfies the response schema, semantic validator, and
  materializer
- Qwen tokenizer count: 14,534 prompt tokens against a 65,536-token cap
- canonical witness count: 1,766 tokens against a 4,096-token completion cap
- maximum estimated request cost: $0.01216512 against a $0.02 ceiling
- one request, zero retries, no judge, no holdout, no citations

Arize project:

- name: `nessie-evaluation-2026-07-29`
- project ID: `TW9kZWw6OTAxNjM4Mjk1OTpnd3dX`
- space ID: `U3BhY2U6NDMxMjM6NDYzag==`
- collector: `https://otlp.arize.com/v1`
- verified readiness trace:
  `ce8ecf572ef13f9747a7d4310e2db7d5`

## Why the call remains NO-GO

The strictest independent review controls. It found two defects after the
package otherwise passed:

1. The external GO receipt binds the upstream validator ledger
   `54638916...`, but does not bind the final preflight ledger `6f46a2dc...`.
   Recording the preflight hash in a later execution receipt is audit evidence,
   not authorization.
2. The attempt lock is reserved before Arize initialization. An Arize
   initialization failure would consume the local one-attempt admission without
   producing the execution receipt. A trace-export flush failure can also occur
   after a provider success without forcing the recorded overall outcome to
   FAIL.

Another independent reviewer issued a limited one-call GO and confirmed the
schema, validator, byte guard, cost cap, and privacy settings. Its own stated
limitation agrees that Arize initialization can consume the attempt lock.
Because the two remaining defects affect authorization and audit completeness,
the final CAIO disposition is NO-GO until repaired and rebound.

## Exact restart sequence

1. Copy the frozen preflight package to a new versioned working directory.
   Never mutate the frozen `6f46a2dc...` package in place.
2. Create a final admission receipt that binds both:
   - validator ledger `54638916...`
   - new preflight ledger produced after the runner correction
3. Move Arize initialization before the attempt reservation, while keeping
   admission validation before all secret reads.
4. Put Arize initialization, the provider request, validation, force-flush, and
   shutdown inside one outer evidence path that always writes an execution
   receipt.
5. Make trace readiness part of the final outcome. A flush/export failure must
   not produce an overall PASS.
6. Rebuild deterministically, rerun normal and optimized tests, re-run the
   zero-network SDK byte capture, and independently review the exact final
   ledger.
7. Only then execute one English KE-027 Together request with
   `Qwen/Qwen3.5-9B`, zero retries, and the sealed venv:
   `/tmp/nessie-v3_6-ke027-preflight-venv/bin/python`.
8. Preserve raw response, parsed candidate, semantic validation,
   materialization, exact usage/cost, request ID, trace ID, and Arize arrival
   evidence. Do not open the holdout or enable authority/citations.

## Drive evidence state

Dedicated Nessie Drive root:

https://drive.google.com/drive/folders/1FB1G2LzPMg7MS0jUnG4O-88b0AeMN8F0

Evaluation Evidence:

https://drive.google.com/drive/folders/1GJWQ1fpf5NhpjLGaXYaA1AWbBPY3LhNj

The earlier current-Kenya source-recovery package and reports are already in
Drive. The following final local archives are staged but were not uploaded
because the Drive connector became unavailable and the fallback browser was
not authenticated:

- `/tmp/nessie-v3.6.2-unified-validator-candidate-verified-2026-07-30.tar.gz`
  - SHA-256:
    `9054b32c8ceed8d8776e25927f2f1fd49946189823fcddd3e67976ad233a12f1`
- `/tmp/nessie-v3.6.2-independent-main-review-2026-07-30.tar.gz`
  - SHA-256:
    `233b64f2965a233189ea1dc1c4cd0dfe1944cc264cd8a6f0a98fcf8bd9334239`
- `/tmp/nessie-v3.6.2-ke027-preflight-sealed-2026-07-30.tar.gz`
  - SHA-256:
    `9e753c1a8327f6d76ecb6a839266d0b555bd6a39d622127073cbb8a48b399a50`
- `/tmp/nessie-v3.6.2-kenya-current-spans-2026-07-30.tar.gz`
  - SHA-256:
    `26c9e0742d328ba28eefff4f60c34f62925eefbf75eaecdbab81bde53dfd3ff9`

Upload these four files to Evaluation Evidence before relying on Drive as the
complete record. Append this handoff to the canonical audit:

https://docs.google.com/document/d/11z9zYMTeJW42B7uzn0AsPhBqLPuXWs_T3qfGgCdA9pM

## Provider and secret boundaries

Secret names confirmed in GCP Secret Manager project `arkova1` without
printing values:

- `together-api-key`
- `runpod-api-key`
- `Arize_API_Admin`
- `Huggingface`
- `nessie-audit-anchor-api-key`

The PayPal secret was not needed and was not accessed. No secret value was
printed or persisted.

## Final stop state

- paid provider calls this final preflight: 0
- attempt lock: absent
- Together retry count: 0
- RunPod changes: 0
- Arkova product-code changes: 0
- production/customer/rig changes: 0
- sealed holdout access: 0
- safe restart point: authorization binding plus Arize evidence-path repair
- terminal Supermemory checkpoint:
  `qEQaFYkHWFt8UxyGbKYifH`

The recurring heartbeat
`nessie-30-minute-evidence-checkpoint` still showed `ACTIVE` at stop time.
Multiple attempts to pause it through the app automation interface failed
because the interface had no registered handler. Treat any later heartbeat as
a documentation-only reminder; it must not resume paid work until both NO-GO
defects above are repaired and independently rebound.
