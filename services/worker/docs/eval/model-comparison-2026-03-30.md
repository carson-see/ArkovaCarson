# Nessie Model Comparison — 2026-03-30

## Setup
- **Hardware:** Apple M4, 16GB RAM (MLX 4-bit quantized inference)
- **Sample:** 50 entries from 1,460-entry golden dataset (deterministic stride sampling)
- **Prompt:** Minimal system prompt (field definitions only, ~600 tokens) — fine-tuned models don't need 25K-token few-shot prompt
- **Concurrency:** 1 (MLX limitation)
- **Quantization:** Q4 (4.5 bits/weight) via mlx-lm

## Results

| Metric | v3 Baseline | Reasoning v1 | DPO v1 | Gemini (prod ref) |
|--------|:-----------:|:------------:|:------:|:-----------------:|
| Macro F1 | **56.4%** | 34.2% | 30.7% | 82.1% |
| Weighted F1 | 58.4% | **63.3%** | 57.8% | ~82% |
| Mean Confidence | 89.1% | 90.6% | 84.7% | ~70% |
| Mean Accuracy | 45.9% | 34.5% | 33.7% | ~80% |
| Conf Correlation (r) | 0.214 | 0.223 | **0.337** | 0.426 |
| ECE | 44.6% | 57.1% | 52.5% | ~10% |
| Mean Latency | 7.2s | 7.8s | 9.4s | ~2s |

## Per-Type F1 (top types)

| Type | v3 Baseline | Reasoning v1 | DPO v1 | n |
|------|:-----------:|:------------:|:------:|:-:|
| DEGREE | 70.8% | **79.5%** | 76.0% | 4 |
| LICENSE | **62.2%** | 59.8% | 63.6% | 4 |
| CERTIFICATE | 54.0% | **56.5%** | 48.4% | 10 |
| PROFESSIONAL | **85.6%** | 70.0% | 69.4% | 3 |
| INSURANCE | 72.2% | **83.3%** | **83.3%** | 2 |
| LEGAL | 83.3% | **100.0%** | 83.3% | 1 |
| ATTESTATION | 46.4% | **52.1%** | 47.9% | 4 |
| SEC_FILING | 44.4% | **55.9%** | 42.9% | 5 |
| OTHER | 52.5% | **78.3%** | 52.5% | 3 |
| CLE | 45.8% | **64.6%** | 62.5% | 2 |

## Key Findings

1. **Reasoning v1 has the best weighted F1 (63.3%)** — it outperforms v3 baseline on most individual types, particularly DEGREE (+8.7pp), LEGAL (+16.7pp), OTHER (+25.8pp), CLE (+18.8pp), and SEC_FILING (+11.5pp).

2. **v3 baseline has best macro F1 (56.4%)** — more consistent across all types, while reasoning v1's macro score is hurt by 0% on RESUME.

3. **All Nessie models are significantly behind Gemini (82.1%)** at 4-bit quantization. Full-precision inference on GPU would likely close some of this gap.

4. **All models are severely overconfident** — 85-90% confidence with 34-46% actual accuracy. The training data confidence scores need recalibration.

5. **DPO v1 has best confidence calibration** (r=0.337) despite lowest F1. DPO training improved the confidence-accuracy relationship but hurt extraction quality.

6. **JSON comments causing parse failures** — reasoning and DPO models output `// comment` in JSON, which needs stripping in the parser.

## Caveats

- **4-bit quantization degrades quality** — these results are a lower bound. GPU inference at full precision (fp16/bf16) would score higher.
- **Minimal prompt** — production uses 25K-token few-shot prompt which provides significant additional context. These eval numbers reflect the model's intrinsic knowledge only.
- **Small sample (n=50)** — per-type breakdowns have n=1-10, so individual type scores have high variance.

## Recommendations

1. **Deploy reasoning v1 to RunPod** as the primary Nessie model — best weighted F1 and strongest on high-value credential types.
2. **Re-run eval at full precision on GPU** (RunPod A5000/4090) with the full 25K-token prompt for production-representative numbers.
3. **Add JSON comment stripping** to the extraction parser to handle `// comment` patterns.
4. **Recalibrate confidence** — all Nessie models need confidence score adjustment (multiply by ~0.45 or retrain with corrected confidence labels).
5. **Gemini remains production default** — Nessie is not yet competitive. Focus on training data quality and quantity for v4.

## Together AI Fine-Tune IDs
- v3 baseline: `ft-f9826e6d-0a55` → `carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-v3-22458d86`
- reasoning v1: `ft-3fd3b5ef-32ac` → `carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-reasoning-v1-54f2324d`
- DPO v1: `ft-b17f012c-fb6a` → `carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-dpo-v1-d81529d8`
