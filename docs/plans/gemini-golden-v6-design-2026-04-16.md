# Gemini Golden v6 — Speed + Bulk + Sub-categorization Design

> **Status:** Authoritative design for the next Gemini extraction-tuning generation.
> **Date:** 2026-04-16
> **Goal:** Gemini Golden v6 should be **faster** (target <2s p95), **bulk-capable** (batch endpoint + async queue), produce **richer descriptions**, and emit **sub-categorization** (e.g., `CERTIFICATE` → `Project Management Certificate` → `PMP`).
> **Predecessor:** Gemini Golden v5-reasoning (currently in production at +3.1pp Macro F1, but slow at 11.4s/req)

## 1. The v5-reasoning reality (what we're optimizing)

Current production Vertex tuned model `arkova-golden-v5-reasoning-pro` (`endpoints/8811908947217743872`) eval results:

| Metric | v5-reasoning (prod) | Base Gemini | Target for v6 |
|---|---|---|---|
| Macro F1 | 73.8% | 70.7% | **≥75%** (preserve gain) |
| Weighted F1 | 80.1% | 77.2% | ≥80% |
| Latency p50 | 11.4s | 1.5s | **<2s** ★ |
| Latency p95 | ~15s | ~3s | **<3s** ★ |
| Cost per query | ~$0.012 | ~$0.001 | **<$0.005** ★ |
| Description quality | minimal | minimal | **rich, 1-2 sentence** ★ |
| Sub-type emission | 0% | 0% | **>80%** ★ |
| Bulk throughput | n/a (synchronous) | n/a | **1000 docs/min** ★ |

**Why v5-reasoning is slow:** It's tuned on `gemini-2.5-pro` (the largest model) with verbose chain-of-thought reasoning output ("OBSERVE → IDENTIFY → CLASSIFY → VERIFY"). Pro is 3x slower than flash. The reasoning trace, while improving accuracy, adds 200-500ms per request.

## 2. v6 strategy: smaller base + structured output + bulk pathway

### 2.1 Base model change: 2.5-pro → 2.5-flash

| Dimension | gemini-2.5-pro (v5) | gemini-2.5-flash (v6) | Impact |
|---|---|---|---|
| Inference latency | 11s | 2-3s | **5x faster** |
| Tuning cost | $15/1M tokens | $5/1M tokens | **3x cheaper to train** |
| Per-request cost | $0.012 | $0.003 | **4x cheaper to serve** |
| Quality on extraction | 73.8% Macro | TBD (target ≥72%) | might drop 1-2pp, acceptable trade for 5x speed |

**Mitigation if flash drops too much accuracy:** keep v5-reasoning available for high-stakes extraction (e.g., medical licenses), route v6-flash for high-volume routine cases. Hybrid routing in `factory.ts`.

### 2.2 Constrained decoding via responseSchema

Vertex Gemini supports `responseMimeType: "application/json"` + `responseSchema` (a JSON schema). When set, the model is FORCED to emit valid JSON matching the schema. This:
- Eliminates the parse-failure path entirely (currently we lose ~5% of responses to JSON parse errors)
- Removes need for the verbose reasoning chain (model knows the shape, doesn't need to think aloud)
- Improves latency (less output tokens because no scaffolding)

**v6 responseSchema (locked):**

```typescript
const v6ResponseSchema = {
  type: 'object',
  required: ['credentialType', 'confidence'],
  properties: {
    credentialType: { type: 'string', enum: CREDENTIAL_TYPES },  // existing 21 types
    subType: { type: 'string' },        // NEW: fine-grained taxonomy (PMP, RN, MD, etc.)
    issuerName: { type: 'string' },
    issuedDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    expiryDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    fieldOfStudy: { type: 'string' },
    degreeLevel: { type: 'string' },
    licenseNumber: { type: 'string' },
    accreditingBody: { type: 'string' },
    jurisdiction: { type: 'string' },
    description: { type: 'string', maxLength: 250 },  // NEW: 1-2 sentence human description
    fraudSignals: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    // CLE fields, CHARITY fields, etc. — existing optional fields
    // NO reasoning, NO confidenceReasoning — they slow down output
  },
};
```

### 2.3 Sub-categorization taxonomy (NEW)

Yes, sub-categories are needed. They unlock:
- Better fraud detection (a "PMP" with random number format is detectable; a generic "CERTIFICATE" isn't)
- Better routing (medical credentials → primary-source verification, IT certs → CredentialNet API)
- Better customer reporting ("This person has 3 PMI certifications" vs "3 certificates")
- Search/filter UX ("Show me all candidates with AWS certifications")

**Taxonomy v1:**

```
DEGREE
├── Bachelor (BS, BA, BBA, etc.)
├── Master (MS, MA, MBA, MS-CS, etc.)
├── Doctorate (PhD, EdD, JD, MD, DDS, etc.)
└── Associate (AA, AS)

CERTIFICATE  
├── Project Management
│   ├── PMP (Project Management Professional)
│   ├── PMI-ACP (Agile Certified Practitioner)
│   ├── CSM (Certified ScrumMaster)
│   └── PRINCE2
├── IT/Cloud
│   ├── AWS (Solutions Architect, Developer, etc.)
│   ├── Azure (Administrator, Developer, etc.)
│   ├── GCP (Cloud Architect, etc.)
│   └── Kubernetes (CKA, CKAD)
├── Security
│   ├── CISSP, CISM, CEH, OSCP
├── Finance
│   ├── CFA, CPA, CMA, FRM
├── Healthcare
│   ├── CPR, BLS, ACLS, PALS
├── Trade
│   ├── electrician, plumber, HVAC
└── Other (catch-all with mandatory description)

LICENSE
├── Medical
│   ├── Physician (MD, DO)
│   ├── Nurse (RN, LPN, NP, CRNA)
│   ├── Pharmacist
│   └── Allied health (PA, OT, PT)
├── Legal
│   └── Attorney (JD-licensed, by state)
├── Trade
│   └── Electrician, Plumber (state-licensed)
├── Real Estate
│   └── Broker, Salesperson (state)
└── Insurance
    └── Producer, Adjuster (state)

(continued for all 21 credential types)
```

Source for taxonomy: existing `services/worker/src/ai/eval/golden-dataset-subtype-backfill.ts` (already has GRE-01 sub-type schema work — leverage and extend).

### 2.4 Description field (NEW)

Every extraction returns a `description` field — 1-2 sentences, plain English, suitable for display in customer reports. Examples:

| credentialType + subType | description |
|---|---|
| DEGREE + Bachelor (BS, Computer Science) | "Bachelor of Science in Computer Science from [issuer], conferred [date]." |
| CERTIFICATE + PMP | "PMI Project Management Professional certification, valid through [expiry], requires 60 PDUs per 3-year cycle." |
| LICENSE + Medical Physician (MD) | "Medical license for [jurisdiction], specialty [field], status [status], renewal [date]." |
| CLE + Ethics | "[Provider] CLE course in Ethics, [credit hours] credit hours, completed [date]." |

The description is auto-generated from extracted fields — predictable structure, low risk of hallucination. Train Gemini to assemble it from the structured data.

## 3. Bulk upload pathway

Currently extraction is one-credential-at-a-time. v6 introduces a bulk pathway:

### 3.1 Vertex AI batch prediction
Vertex supports batch prediction for tuned models — submit a JSONL file in GCS, output goes back to GCS.

```bash
gcloud ai batch-prediction-jobs create \
  --display-name=bulk-extraction-2026-04-16 \
  --model=projects/.../endpoints/<v6-endpoint> \
  --gcs-source-uris=gs://arkova-bulk/inbound/batch-001.jsonl \
  --gcs-destination-output-uri-prefix=gs://arkova-bulk/outbound/batch-001/
```

Cost: same per-request, but ~50% latency saving from infrastructure batching. Throughput target: 1000 docs/min sustained.

### 3.2 Worker async queue (HTTP API)

New worker endpoint: `POST /api/v1/extract/bulk`
- Accepts: array of up to 1000 documents
- Returns: `{job_id, status_url}`
- Worker enqueues to a Cloud Tasks queue
- Background worker submits to Vertex batch endpoint, polls, writes results back to anchor records

### 3.3 Cost guardrails for bulk

- Per-batch cap: 1000 docs (bigger requires admin approval)
- Org daily cap: configurable, default 10,000 docs/day
- Cost-tracker integration: emit `bulk_extraction_completed` event with token count for billing

## 4. Training dataset for v6 (Vertex format)

### 4.1 Source: extend Gemini Golden v3-v4 dataset

Existing Gemini Golden datasets (v3 = 2,000 entries, v4 = ~3,800 entries) are extraction-only and DON'T have:
- `subType` labels
- `description` field

**v6 dataset construction:**
1. Take Gemini Golden v4 dataset (~3,800 entries)
2. **Auto-generate subType labels** using a deterministic rule engine (CERTIFICATE + "PMP" in text → subType="PMP")
3. **Auto-generate description field** using a template (subType-specific)
4. Hand-review 200 samples to verify subType correctness
5. Hand-curate 500 NEW examples specifically for diverse subType coverage (every PMI cert, every AWS cert, etc.)
6. Total target: **5,000+ examples** with subType + description

### 4.2 Vertex tuning hyperparameters

| Param | Value | Rationale |
|---|---|---|
| `source_model` | `gemini-2.5-flash` | Speed-first |
| `epochCount` | 6 | More epochs because broader subType vocabulary |
| `learningRateMultiplier` | 1.0 | Default |
| `adapterSize` | `ADAPTER_SIZE_FOUR` | Default |
| `responseSchema` | locked v6 schema | Force valid JSON |
| `systemInstruction` | NEW v6 prompt | Includes subType taxonomy + description template |

## 5. v6 Definition of Done

| Metric | Target |
|---|---|
| Macro F1 (vs v4 dataset 50-sample) | ≥75% (preserve v5 +3.1pp gain over base) |
| Weighted F1 | ≥80% |
| **Latency p50** | **<2s** |
| **Latency p95** | **<3s** |
| **Cost per query** | **<$0.005** |
| **subType emission rate** | **>80%** (model emits subType when applicable) |
| **subType accuracy** | **>85%** (when emitted, correct) |
| **description rate** | **100%** (always emitted) |
| **JSON parse success** | **100%** (responseSchema enforces) |
| **Bulk throughput** | **>1000 docs/min sustained** |

## 6. Execution plan

### Phase 1: Dataset enrichment (1 day)
- Write `services/worker/scripts/enrich-gemini-golden-v6.ts`:
  - Reads existing Gemini Golden v4 JSONL
  - Adds subType via deterministic rule engine
  - Adds description via templates
  - Outputs `gemini-golden-v6-vertex.jsonl`
- Hand-review 200 samples
- Hand-curate 500 new subType-diverse examples

### Phase 2: Vertex tuning (~$80, 1-2 hours)
- Upload to GCS
- Submit Vertex tuning job:
  - source_model: gemini-2.5-flash
  - epochs: 6
  - responseSchema: v6 locked schema
- Monitor

### Phase 3: Eval (1 hour)
- Run extraction eval against new v6 endpoint
- Compare against v5-reasoning (current prod), Gemini base, fraud-v1
- Document in `docs/eval/eval-gemini-golden-v6-<date>.md`

### Phase 4: Bulk pathway (separate sprint, ~3 days)
- New worker endpoint POST /api/v1/extract/bulk
- Cloud Tasks queue setup
- Vertex batch-prediction-jobs integration
- Cost-tracker billing event

### Phase 5: Production cutover (after eval gate)
- Update Cloud Run env: `GEMINI_TUNED_MODEL=projects/.../endpoints/<v6-endpoint>`
- Smoke test
- Roll back to v5-reasoning if regression detected

## 7. Cost budget

| Phase | Cost | |
|---|---|---|
| Dataset enrichment compute | ~$0 | local script + manual review |
| Vertex tuning v6 (gemini-2.5-flash) | ~$30 | 5K examples × 6 epochs × $5/1M tokens |
| Vertex serving | ~$0.003/query × volume | 4x cheaper than v5-pro |
| Bulk Cloud Tasks infrastructure | ~$10/month | low-volume queue |
| Eval | ~$2 | 50-sample on warm endpoint |
| **Total v6 train + ship** | **~$50** | |

## 8. What v6 explicitly does NOT do

- ❌ Reasoning trace output (slows down — that's what v5-reasoning was for; v6 replaces it for routine cases)
- ❌ Fraud detection (that's v6 fraud stream — separate Vertex tuning, kept distinct)
- ❌ Multi-domain compliance reasoning (that's Nessie's job)
- ❌ PII inference (Constitution 1.6 — never)
- ❌ Generic "OTHER" category dumping ground (force the model to suggest a subType OR explain why "OTHER")

## 9. v6 → v7 evolution roadmap

After v6 ships:
- v6.1: DPO on the subType classification (preference pairs preferring more-specific subType when applicable)
- v6.2: Multi-modal (image input for diploma/license OCR alongside extracted text)
- v7: Multilingual extraction (Spanish, Mandarin, Arabic) — separate Vertex tune

## 10. Living document

After v6 ships, update with:
- Actual latency numbers (was the 5x flash speedup real?)
- subType accuracy by category (PMP works, but "Other CERTIFICATE" might be weak)
- Bulk throughput in production
- Cost actuals
