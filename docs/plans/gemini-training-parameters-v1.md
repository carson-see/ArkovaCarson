# Gemini Training Parameters v1 — 2026-04-15

> **Status:** authoritative parameters for all Gemini fine-tuning going forward.
> **Companion:** `nessie-training-parameters-v1.md` (separate model, separate purpose, no overlap).
> **Why separate:** Nessie and Gemini do different jobs. Sharing training data or parameters between them defeats the purpose of having two models.

## 1. What Gemini is, and is not

**Gemini is** the strong general-purpose model. Production worker uses base `gemini-2.0-flash` today; we are tuning `gemini-2.5-pro` variants for two specific capabilities:

1. **Fraud signal detection** — diploma mill flags, document tampering, identity mismatch, license forgery
2. **Multi-step compliance reasoning** — "this credential mentions FERPA + a Kenyan jurisdiction; explain the cross-border consent requirement"

**Gemini is NOT:**
- A primary credential extractor (that's Nessie's narrow job)
- A document parser (PDF.js + Tesseract on the client handles that — Constitution 1.6)
- A generic chat agent

When the production worker can't extract reliably with Nessie (low-volume credential type, weak F1), it falls back to Gemini. Otherwise Gemini is the *fraud + reasoning* layer that runs after Nessie extracts.

## 2. Infrastructure (locked)

| Stage | Platform | Why |
|---|---|---|
| Fine-tune (supervised) | **Google Vertex AI** | Only legal way to fine-tune Gemini; supports gemini-2.5-pro/flash/flash-lite |
| Dataset upload | **Google Cloud Storage** | `gs://arkova-training-data/` — required by Vertex |
| Serve | **Vertex AI tuned model endpoints** | Same SDK as base Gemini; auto-scaled |
| Eval | **Local CLI hits Vertex** | `npx tsx run-eval.ts --provider gemini --model <tuned-endpoint>` |

**Important:** Gemini 3 is **not yet available** for tuning on Vertex AI as of 2026-04-15 (Google's docs confirm only 2.5-pro/flash/flash-lite). Use 2.5-pro until 3.0 tuning launches.

## 3. Base model (locked per capability)

| Capability | Base | Why |
|---|---|---|
| Fraud detection | `gemini-2.5-pro` | Higher-quality reasoning; fraud requires nuance |
| Compliance reasoning | `gemini-2.5-pro` | Same — long-context + nuance matters |
| Cheap fallback extraction | `gemini-2.0-flash` (untuned) | Production default; cheap; good enough for messy edge cases |

**Never tune `gemini-2.0-flash` for our pipeline.** It's the production fallback — we want it stable, not specialized.

## 4. Tuning hyperparameters (locked unless ablation justifies change)

Vertex AI exposes fewer knobs than Together (it's a managed service). The defaults are sane.

| Param | Value | Rationale |
|---|---|---|
| `epochCount` | 5 (fraud) / 4 (reasoning) | Vertex default is 4; bump fraud to 5 because the fraud signals are subtle |
| `learningRateMultiplier` | 1.0 | Vertex default; only adjust if loss curve is unstable |
| `adapterSize` | `ADAPTER_SIZE_FOUR` (rank 4) | Vertex's default for gemini-2.5-pro; rank 8 only for >10K examples |
| Validation split | 10% (Vertex auto) | We additionally hold out our own 20% test set |

**Hard rule:** Never train past `epochCount=8`. Vertex pricing is per-epoch and overfitting risk grows fast.

## 5. Dataset format (locked)

Vertex AI expects JSONL with the `contents` schema:

```json
{
  "systemInstruction": {
    "role": "system",
    "parts": [{"text": "<system prompt — different per capability>"}]
  },
  "contents": [
    {
      "role": "user",
      "parts": [{"text": "<input>"}]
    },
    {
      "role": "model",
      "parts": [{"text": "<expected output>"}]
    }
  ]
}
```

**Per-capability system prompts:**

### Fraud detection
> "You are a credential fraud auditor. Given extracted credential metadata, identify fraud signals (diploma mill, license forgery, document tampering, identity mismatch). Return a JSON object: `{\"fraudSignals\":[<list>], \"confidence\":<float 0-1>, \"reasoning\":<short string>}`. Empty list if no fraud."

### Compliance reasoning
> "You are a credential compliance analyst. Given a credential and its jurisdiction context, explain which regulations apply (FERPA, HIPAA, SOX, GDPR, FCRA, state privacy laws) and what consent or disclosure requirements arise. Return a JSON object: `{\"applicableRegulations\":[<list>], \"requirements\":[<list>], \"crossJurisdictionConcerns\":<string>}`."

**Mandatory dataset rules:**
1. Every example must have a verified-correct expected output. Auto-generated fraud examples without manual review are banned (this is what made v26 useless).
2. Datasets stay separate per capability. **Never combine fraud and reasoning examples in one tuning run.** That's how multi-task confusion creeps in.
3. Hold out 20% as a never-touched test set, separate from Vertex's validation split.

## 6. Two distinct tuning streams

### Stream A: `arkova-gemini-fraud-vN`
- Capability: fraud detection
- Dataset: real fraud patterns from FTC enforcement actions, GAO reports, Oregon ODA list, CFPB
- Target: ≥90% precision on the held-out fraud set, ≥75% recall (false negatives are worse than false positives in fraud)
- Endpoint role: called by `services/worker/src/ai/enhanced-fraud-signals.ts` after Nessie extraction

### Stream B: `arkova-gemini-reasoning-vN`
- Capability: compliance reasoning
- Dataset: 1k+ (credential, jurisdiction) → (regulations, requirements) pairs derived from Confluence regulation docs
- Target: ≥85% factual accuracy on a hand-graded 100-example test set; no hallucinated regulations
- Endpoint role: called by intelligence query path (not mainline extraction)

**Streams never share datasets.** Streams never share endpoints. They are two different deployable models.

## 7. Definition of Done (per stream, per version)

| Gate | Threshold (fraud) | Threshold (reasoning) |
|---|---|---|
| Precision on held-out test | ≥ 90% | (semantic match) ≥ 85% |
| Recall on held-out test | ≥ 75% | ≥ 80% |
| Hallucinated regulations / 100 outputs | n/a | 0 |
| JSON parse success rate | 100% | 100% |
| p95 latency | < 4000 ms | < 6000 ms |
| Cost vs base gemini-2.5-pro | ≤ 1.5× | ≤ 1.5× |
| Beats base gemini-2.5-pro on the same test set | required | required |

## 8. Eval workflow per training run

```bash
cd services/worker
# After Vertex job completes, get the endpoint resource name
# Update worker .env GEMINI_TUNED_MODEL=projects/.../endpoints/<id>
npx tsx src/ai/eval/run-eval.ts --provider gemini --sample 50 --output docs/eval/
# Cross-eval against base gemini-2.5-pro on same entries
unset GEMINI_TUNED_MODEL
npx tsx src/ai/eval/run-eval.ts --provider gemini --sample 50 --output docs/eval/
# Diff. If tuned model doesn't beat base, the tuning didn't work — retrain.
```

## 9. Cost guardrails

- **Per fraud tuning run:** ≤ $80 on Vertex (gemini-2.5-pro is ~$15/1M tokens for tuning)
- **Per reasoning tuning run:** ≤ $80
- **Per eval:** ≤ $2 (50 samples)
- **Monthly serving (tuned models):** ≤ $300 baseline. Vertex tuned endpoints have hourly retention costs even at zero traffic.

**Cost-cutting rule:** if a stream's tuned endpoint isn't used in production for 14 days, delete the deployed endpoint (the model artifact stays). No paying for idle.

## 10. Separation from Nessie (explicit)

| Capability | Owner | Why not the other? |
|---|---|---|
| Extract `credentialType`, `issuerName`, `issuedDate`, `fieldOfStudy`, etc. | **Nessie** (narrow LoRA) | 8B is enough; cheaper to serve; we control the LoRA |
| Detect fraud signals | **Gemini fraud stream** | Requires nuanced reasoning over the *combination* of fields + cross-references; 8B isn't strong enough |
| Identify applicable regulations | **Gemini reasoning stream** | Long-context regulatory knowledge; gemini-2.5-pro has it baked in |
| Generate human-readable summary of a credential | **Gemini base (untuned)** | Quality writing matters; tuning isn't worth the cost |
| Embedding generation | **Gemini base (untuned)** | `gemini-embedding-001` is task-specific; tuning embeddings is its own project |

If a feature request needs both extraction AND fraud, the worker calls both models in sequence (Nessie first, then Gemini fraud on the extracted fields). This is what `services/worker/src/ai/factory.ts` already does via `HybridProvider`.

## 11. What we explicitly do NOT do

- **Train Gemini on extraction examples.** That's Nessie's job. If Nessie can't extract a type, fall back to *base* Gemini, don't tune Gemini for it.
- **Train Gemini-3.** Not supported on Vertex tuning yet.
- **Stack tuned models on tuned models.** Each Vertex run starts from `gemini-2.5-pro` base.
- **Mix fraud + reasoning in one dataset.** Confusion → garbage.

## 12. Living parameter changes

Same rules as Nessie:
1. A/B against current
2. Document delta
3. Update this doc + bump `v1`→`v2`
4. No vibes
