# Nessie v8 Retrain — Training Parameters (SKELETON, NVI-gated)

**Confluence mirror:** [Top-10 Sprint Batch 3 — 2026-04-17 §10](https://arkova.atlassian.net/wiki/spaces/A/pages/13795329) — "Nessie v8 Training Parameters Skeleton — NPH-14 (SCRUM-711)"
**Jira:** [SCRUM-711 / NPH-14](https://arkova.atlassian.net/browse/SCRUM-711)
**Last updated:** 2026-04-17
**Owner:** AI Platform (Carson)
**Status:** **BLOCKED by NVI gate (SCRUM-804).** Do not submit the tuning job until the gate is explicitly marked Closed in CLAUDE.md Section 0. This document is a skeleton so that when the gate closes, the training run is a 1-day operation rather than a 1-week rebuild.

---

## How to use this document

This is the dry plan. The plan cannot be executed until:

1. **NVI gate closes** — FCRA passes NVI verification + attorney-reviewed gold-standard benchmark (SCRUM-804 / SCRUM-805–808 / SCRUM-819 / SCRUM-825). Check CLAUDE.md Section 0 for the "NVI GATE ACTIVE" banner; when removed, gate is closed.
2. **NPH-13 complete** — golden dataset expanded to 5,000+ entries with balanced type distribution (currently 1,905).
3. **NPH-12 complete** — fraud signal training data labelled, ≥500 entries.
4. **NPH-01 complete** — type mappings corrected per `docs/plans/nph-phase1-credential-type-audit.md`.
5. **Budget approved** — production RunPod endpoint, not DRY-RUN IDs.

Five concrete steps for the operator (after gate closes):

1. **Regenerate training JSONL** from the expanded golden dataset + fraud labels + corrected type mappings (see §Dataset assembly).
2. **Submit tuning job** to Together.ai using the parameters in §Training parameters.
3. **Merge LoRA on RunPod** (PEFT 0.15, autocast=False, strip 9 incompatible adapter_config keys — lesson from v27.0).
4. **Evaluate** against the 50-entry-per-type eval harness (§Evaluation gates).
5. **Deploy** if gates met; undeploy the previous endpoint within the same session (Vertex endpoint hygiene mandate).

---

## Dataset assembly (NPH-13 prerequisite)

Expected composition at training time:

| Credential type | v5 golden count | v8 target | Delta needed |
|-----------------|-----------------|-----------|--------------|
| MEDICAL | 1 | 50 | +49 |
| IDENTITY | 1 | 50 | +49 |
| RESUME | 2 | 30 | +28 |
| FINANCIAL | 2 | 30 | +28 |
| TRANSCRIPT | 2 | 30 | +28 |
| CLE | 2 | 30 | +28 |
| LEGAL | 3 | 30 | +27 |
| MILITARY | 3 | 50 | +47 |
| PUBLICATION | 3 | 50 | +47 |
| INSURANCE | 4 | 20 | +16 |
| PATENT | 4 | 20 | +16 |
| REGULATION | 4 | 20 | +16 |
| CHARITY | ~0 | 20 | +20 |
| FINANCIAL_ADVISOR | ~0 | 20 | +20 |
| BUSINESS_ENTITY | ~0 | 30 | +30 |
| BADGE | ~20 | 30 | +10 |
| DEGREE | unknown | 50 | — |
| OTHER | dominant | cap at 200 | balance cap |
| **Total** | **1,905** | **5,000+** | **+3,100** |

Fraud signal labels: each of the ≥500 fraud entries should be cross-labelled against a credential type.

---

## Training parameters (base model: Llama 3.1 8B Instruct)

Only change from v5 that's known-safe: **increase LoRA rank**. All other hyperparameters are baselined against v27.3 FCRA (current prod Nessie).

| Parameter | v5 (current) | v8 (proposed) | Reason |
|-----------|-------------|---------------|--------|
| Base model | Llama 3.1 8B Instruct | same | proven |
| Epochs | 2 | **3** | need more fit on rare types; watch for overfit on OTHER |
| LoRA rank (r) | 16 | **32** | higher capacity for long-tail types |
| LoRA alpha | 32 | **64** | scales with r |
| Batch size | 16 | **8** | lower batch for higher r; memory budget |
| Learning rate | 2e-4 | **1.5e-4** | slightly lower to stabilise with r=32 |
| Warmup ratio | 0.03 | same | proven |
| Weight decay | 0.0 | same | proven |
| Dataset packing | off | off | type-balance matters more than packing efficiency |
| Training infra | Together.ai | same | v27.0 → v27.3 deploy path proven; RunPod merge pod (A40, PEFT 0.15, autocast=False, strip 9 keys) |

**Do NOT change:**
- Base model (switching base = full eval rebaseline).
- Response format (JSON schema constraints unchanged).
- Tokenizer (Llama 3.1 tokenizer locked).

---

## Evaluation gates (DoD for v8)

All must be met; one miss = no deploy.

| Metric | v5 current | v8 target | Measured via |
|--------|-----------|-----------|--------------|
| Macro F1 | 75.7% | **≥85%** | 50-entry eval per credential type |
| Weighted F1 | 87.2% | **≥90%** | 50-entry eval per credential type |
| Confidence correlation (Pearson r) | 0.539 | **≥0.70** | calibration test set |
| fraudSignals F1 | 0% | **>30%** | dedicated fraud eval |
| Expected Calibration Error | 11% | **<8%** | reliability-diagram analysis |
| Min per-type F1 | 54.8% (OTHER) | **≥70% every type** | 50-entry eval per credential type |
| Citation accuracy | 57% (v27.3 FCRA) | **>55%** | maintain or improve |

Tooling: `services/worker/scripts/eval/nessie-eval-v8.ts` (write before training submission so the numbers are measured the moment weights land).

---

## Endpoint hygiene (mandatory per CLAUDE.md Section 0)

Vertex endpoint hygiene mandate applies to RunPod endpoints in the same spirit:

**Before submission:** audit existing RunPod + Vertex endpoints. One deployed production endpoint per regulation (FCRA / HIPAA / FERPA / v8-general). Target: ≤4 deployed total.

**After deployment:** within the same session,
- undeploy the previous v7-general endpoint once v8 traffic is proven stable (≥24h with no regressions on the 50-entry eval harness);
- delete empty endpoint shells to save quota;
- record the census in the deploy ticket.

Never keep a cold-spare endpoint "just in case." The HuggingFace model artifact is preserved; a cold redeploy is ~10 minutes.

---

## NVI consultation

This ticket does not close the NVI gate, but the v8 training run is the first Nessie training run where NVI verification will be enforced on training-data JSONL emission (via SCRUM-825 NVI-18 CI guard). Expected:

- Baseline NVI run on 5,000+ golden entries will produce some fraction of `hardFail` / `orphan` records (reference: v7 baseline at 205 sources was 140/39/19).
- Those entries must be fixed or dropped before training JSONL is emitted.
- Plan **+5 days of buffer** for NVI remediation before submission.

---

## Manual-followup email

Per CLAUDE.md MANUAL-FOLLOWUP EMAIL MANDATE, the operator emails `carson@arkova.ai` on training submission with: gate-closure confirmation snippet, Together.ai tuning job ID, expected completion window, and budget delta vs. the NPH-14 authorisation.

---

## Definition of Done for SCRUM-711

- [ ] NVI gate closed (CLAUDE.md Section 0 banner removed).
- [ ] NPH-12 + NPH-13 + NPH-01 all Done.
- [ ] Budget approved for production endpoint.
- [ ] Training JSONL emitted and NVI CI guard passes.
- [ ] Tuning job submitted to Together.ai with parameters from §Training parameters.
- [ ] LoRA merged on RunPod; endpoint deployed.
- [ ] All 7 evaluation gates met on the 50-entry-per-type harness.
- [ ] Endpoint census recorded; previous endpoints undeployed.
- [ ] CLAUDE.md header stats updated (prod model = v8, macro F1 ≥85%).
- [ ] SCRUM-711 transitioned To Do → Done.
