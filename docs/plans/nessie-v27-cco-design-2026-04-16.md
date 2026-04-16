# Nessie v27 — Chief Compliance Officer Design

> **Status:** Authoritative design. Supersedes the v6–v26 generalist sprawl.
> **Date:** 2026-04-16
> **Goal:** Build the world's best AI Chief Compliance Officer and auditor. Domain-by-domain mastery, never breadth-without-depth.

## 1. The v26 reality (what we're fixing)

v26 intelligence eval (8 FCRA entries on RunPod endpoint `qgp44409nbsgi0`):

| Metric | v26 | Gemini base | Target | Gap to target |
|---|---|---|---|---|
| Citation Accuracy | **0%** | 0% | >95% | -95pp (catastrophic) |
| Faithfulness | 31% | 16% | >90% | -59pp (v26 wins vs base, both fail) |
| Answer Relevance | 14% | 47% | >85% | -71pp (v26 loses to base) |
| Risk Detection Recall | **0%** | 38% | >80% | -80pp (v26 completely misses risks) |
| Confidence Correlation | **0.895** ✓ | 0.642 | >0.60 | +29pp (v26 wins, target met) |
| Mean Latency | 18s | 44s | <5s | -13s (v26 wins vs base, both fail target) |

**v26 wins:** faithfulness (less hallucination), confidence calibration (knows when wrong), latency.
**v26 loses:** relevance (doesn't address questions), risks (misses everything).
**Both fail:** citations (eval framework also suspicious — both got 0%).

**Why:** v26 was trained on 12+ regulatory domains crammed into one 8B LoRA (Nigeria NDPA + South Africa POPIA in v26 specifically). Generalist sprawl, no depth.

## 2. v27 strategy: One domain at a time, mastered before next

### 2.1 First domain: FCRA (US Fair Credit Reporting Act)

**Why FCRA first:**
- Highest production-volume domain (employment screening, every credential check touches FCRA)
- Largest existing training/eval data → faster iteration loop
- Complex multi-step reasoning (pre-adverse action → adverse action → 5-day waiting period)
- Risk-heavy (every dispute, expired license, unverifiable credential is FCRA-relevant)
- Maps to existing customer use case immediately

**Future domain order:**
1. ✅ FCRA (employment screening) — v27
2. HIPAA (healthcare credential verification) — v28
3. FERPA (education credential verification) — v29
4. SOX (financial credential verification) — v30
5. GDPR (international employer of record) — v31
6. Bank Secrecy Act + KYC (financial advisor + fintech) — v32
7. State-specific privacy laws (CA, NY, IL, TX) — v33
8. International privacy (Kenya, Nigeria, SA, Australia, UK) — v34+

Each version starts from clean Llama 3.1 8B Instruct base + the previous version's training data + new domain. **Never train v_n+1 by re-fine-tuning v_n** — catastrophic forgetting is what killed v6–v26.

### 2.2 v27 success criteria (per FCRA)

| Metric | Target | Stretch |
|---|---|---|
| Citation Accuracy | ≥95% | 99% |
| Faithfulness | ≥90% | 95% |
| Answer Relevance | ≥85% | 92% |
| Risk Detection Recall | ≥80% | 90% |
| Confidence Correlation | ≥0.85 | 0.92 |
| Mean Latency | ≤5s | ≤3s |
| Cost per query | ≤$0.005 | ≤$0.002 |

**Definition of Done:** All 7 metrics meet TARGET on a held-out 50-entry FCRA test set, OR meet 5/7 with no metric below 60% of target. Then move to v28 (HIPAA).

## 3. Training infrastructure (cloud-only, NO local)

### 3.1 The pipeline

```
[Local: dataset curation only — small JSONL text files, MB scale]
         │
         │ together files upload
         ▼
[Together AI: LoRA SFT on Llama 3.1 8B Instruct Reference]
         │
         │ together fine-tuning create
         ▼
[Adapter on Together S3 — non-serverless, can't be served from there]
         │
         │ together SDK fine_tuning.content() → 300MB adapter blob
         ▼
[RunPod GPU pod: download + merge + push to HF]
         │  (peft 0.15 + autocast_adapter_dtype=False, MAX_MODEL_LEN=8192)
         ▼
[HuggingFace: carsonarkova/nessie-v27-fcra (16GB merged)]
         │
         │ runpod template MODEL_NAME update + endpoint provision
         ▼
[RunPod serverless vLLM endpoint — production-ready inference]
         │
         ▼
[Eval via npx tsx scripts/eval-intelligence.ts --provider runpod]
```

**Local disk usage: zero model artifacts.** Only the JSONL training set sits on local (KB-MB), and only briefly before upload.

### 3.2 Training hyperparameters (v27)

Bigger than v26 because compliance reasoning needs more capacity:

| Param | v26 | v27 | Rationale |
|---|---|---|---|
| `lora_r` | 16 | **32** | Citation formatting + multi-doc reasoning needs more rank |
| `lora_alpha` | 32 | **64** | 2× rank, standard |
| `lora_dropout` | 0.05 | 0.05 | Standard regularization |
| `target_modules` | `["q_proj","k_proj","v_proj","o_proj"]` | + `gate_proj`, `up_proj`, `down_proj` | MLP modules help with structured output (citations) |
| `n_epochs` | 3 | **5** | Larger dataset + more epochs for fact memorization |
| `batch_size` | 8 | 8 | Same |
| `learning_rate` | 1e-4 | **5e-5** | Lower LR for stable convergence on more data |
| `warmup_ratio` | 0.05 | 0.1 | More warmup for larger rank |

**Two-stage training:**

1. **SFT stage:** Train on 200+ FCRA Q&A with citations on Together.ai (~$30, 30 min)
2. **DPO stage** (optional v27.1): Train preference pairs preferring properly-formatted citations vs ungrounded answers (~$40, 30 min)

### 3.3 Dataset format (locked for v27 + future versions)

```jsonl
{"messages":[
  {"role":"system","content":"<NESSIE_INTELLIGENCE_PROMPT v2>"},
  {"role":"user","content":"What are the FCRA requirements for pre-adverse action notices?"},
  {"role":"assistant","content":"{\"analysis\":\"Per FCRA §604(b)(3) [15 U.S.C. §1681b(b)(3)], before taking adverse action based in whole or in part on a consumer report, the user must provide the consumer with: (1) a copy of the consumer report, and (2) a written description of the consumer's rights under FCRA. The consumer must have a reasonable opportunity to dispute the accuracy of the report before adverse action is taken (typically 5 business days per FTC guidance).\",\"citations\":[{\"record_id\":\"fcra-adverse-001\",\"quote\":\"15 U.S.C. §1681b(b)(3) requires...\",\"source\":\"FCRA §604(b)(3)\"},{\"record_id\":\"fcra-rights-summary\",\"quote\":\"A Summary of Your Rights Under the Fair Credit Reporting Act\",\"source\":\"CFPB Form\"}],\"risks\":[],\"recommendations\":[\"Provide pre-adverse action notice with copy of report\",\"Wait minimum 5 business days for dispute\",\"Send adverse action notice with consumer rights summary if proceeding\"],\"confidence\":0.95,\"jurisdiction\":\"federal\",\"applicable_law\":\"FCRA\"}"}
]}
```

**Mandatory output structure (every example):**
- `analysis`: prose reasoning citing specific statutes/sections
- `citations`: `[{record_id, quote, source}]` array — strict format for eval matching
- `risks`: `[strings]` — every potential compliance violation, even minor
- `recommendations`: `[strings]` — actionable steps
- `confidence`: 0–1 float reflecting actual certainty (varied, not always 0.9)
- `jurisdiction`: `federal` | state code | country code
- `applicable_law`: shorthand identifier (e.g., `FCRA`, `HIPAA`, `Cal-FCRA`)

## 4. v27 dataset construction plan

### 4.1 Targeted scenarios (200+ examples across 8 categories)

| Category | Count | Sample queries |
|---|---|---|
| Pre-adverse action procedure | 25 | "What's required before taking adverse action?", "Walk through proper notice sequence" |
| Adverse action notices | 25 | "What goes in an adverse action letter?", "Bureau name + dispute rights requirements" |
| Permissible purpose | 20 | "Is X a permissible purpose?", "Can I pull a report for tenant screening?" |
| Background check accuracy + dispute | 20 | "How to handle disputed criminal record?", "Reinvestigation timeline 30 days" |
| Medical/license verification | 25 | "What FCRA rules apply to license verification?", "Disciplinary record disclosure" |
| Education verification + diploma mills | 20 | "FTC enforcement against diploma mills", "Verifying institution accreditation" |
| State variations (CA, NY, IL, TX, MA) | 30 | "Ban-the-box NYC vs CA differences", "California Fair Chance Act" |
| Risk patterns + cross-reference | 35 | "Inconsistent SSN + name", "License expired during background check window" |

### 4.2 Source materials (REAL, citable)

- **15 U.S.C. §1681 et seq.** (FCRA full text)
- **CFPB compliance bulletins** (CFPB Bulletin 2012-09, 2014-01)
- **FTC enforcement actions** (FTC v. Almeda University, FTC v. Belford, etc.)
- **EEOC guidance on background checks** (EEOC Guidance 2012)
- **State statutes** (Cal. Civ. Code §1786, NY Article 23-A, IL HRA, TX BCC ch. 411)
- **Court precedents** (Spokeo v. Robins, Safeco Ins. v. Burr)
- **FTC Summary of Rights** (verbatim text for citation)

### 4.3 Curation script (cloud-friendly)

`services/worker/scripts/build-fcra-intelligence-dataset.ts`:
- Reads source materials JSON (statutes + cases stored as data, not models)
- Generates 200+ Q&A pairs by combining query templates × source documents
- Validates every assistant message is JSON-parseable + matches schema
- Holds out 50 as test set (deterministic IDs)
- Outputs `nessie-v27-fcra-train.jsonl` (~5MB)

## 5. Execution timeline

### Phase 1: Dataset curation (4–6 hours)
- Pull FCRA source materials (free, public)
- Build templates + combinatorial generation
- Manual review of 50 sample outputs (quality gate)
- Schema validation on all entries

### Phase 2: Together training (~1 hour wall time, ~$30)
- Upload JSONL to Together
- Submit fine-tune with v27 hyperparameters
- Monitor via API

### Phase 3: RunPod merge + deploy (~30 min, ~$5)
- Provision RunPod pod (A6000-class, 200GB disk)
- SDK download adapter (use `fine_tuning.content()` — CLI is broken)
- Strip new PEFT keys (corda_config, use_dora, exclude_modules, layer_replication)
- Use peft 0.15 + autocast_adapter_dtype=False (proven working stack from v26)
- Merge with Llama 3.1 8B Instruct
- Push to `carsonarkova/nessie-v27-fcra`
- Update RunPod template + endpoint MODEL_NAME

### Phase 4: Eval (30 min)
- Run `npx tsx scripts/eval-intelligence.ts --provider runpod --dataset v1` on 8 FCRA entries
- If pass: run on the held-out 50-entry FCRA test set
- Compare against v26 + Gemini base
- Document in `docs/eval/eval-intelligence-v27-2026-MM-DD.md`

### Phase 5: Production decision
- If all 7 metrics meet target → wire to production hybrid routing for FCRA queries
- If 5/7 meet target → ship as Nessie v27.0, plan v27.1 DPO for failing metrics
- If < 5/7 → diagnose specific failures, iterate dataset, retrain

### Phase 6: v28 begins (HIPAA)
- Same pipeline with HIPAA dataset
- v28 starts from base Llama 3.1 8B Instruct (NOT from v27 weights)
- Production routes FCRA queries → v27 endpoint, HIPAA queries → v28 endpoint
- Multi-domain expansion via routing, not single-LoRA cramming

## 6. Cost budget (per version)

| Stage | Cost | |
|---|---|---|
| Together SFT | ~$30 | LoRA r=32, 5 epochs, 200 examples |
| Together DPO (optional) | ~$40 | If SFT alone doesn't hit citation target |
| RunPod merge pod | ~$5 | A6000, ~30 min |
| RunPod serving (idle) | $0 | workersMin=0, scales to zero |
| RunPod serving (active) | ~$0.40/hr × usage | ~$0.005 per query estimated |
| Eval | ~$2 | 50-entry test set on warm endpoint |
| **Total per version** | **~$80** | versus v26's ~$200 wasted training |

**Total budget for FCRA→HIPAA→FERPA→SOX→GDPR (5 versions): ~$400.**
Compare to yesterday's $600 with zero deployed value.

## 7. Production routing plan (when v27 ships)

`services/worker/src/ai/factory.ts` HybridProvider extension:

```typescript
const COMPLIANCE_DOMAIN_ROUTING = {
  FCRA: 'projects/.../endpoints/<v27-fcra-endpoint>',
  HIPAA: 'projects/.../endpoints/<v28-hipaa-endpoint>',
  FERPA: 'projects/.../endpoints/<v29-ferpa-endpoint>',
  // ...
};

// For intelligence/RAG queries (NOT extraction):
function routeIntelligenceQuery(domain: string): string {
  return COMPLIANCE_DOMAIN_ROUTING[domain] ?? GEMINI_TUNED_MODEL_DEFAULT;
}
```

Extraction continues to use Gemini Golden v5-reasoning (already in production +3.1pp F1).

## 8. What we're explicitly NOT doing in v27

- ❌ Training Nessie on extraction examples (Gemini's job)
- ❌ Cramming multiple regulations into one LoRA (the v26 mistake)
- ❌ Using local disk for any model artifacts (per user mandate)
- ❌ Training v27 from v26 weights (catastrophic forgetting risk — start fresh from base)
- ❌ Deploying without eval gate (target metrics must pass first)
- ❌ Generating dataset entries without citation source verification (every citation must be traceable to a real document)

## 9. Living document

After v27 ships, update this doc with:
- Actual eval numbers (v27 vs targets)
- Surprises (which categories trained well, which didn't)
- Updated hyperparameters for v28 based on v27 lessons
- Cost actuals vs estimate
