# Ops Runbook: Gemini Model Version Upgrade

> **GME-20** | Last updated: 2026-04-12 | Owner: Engineering

## When to Use

- Google announces a new Gemini model version (e.g., `gemini-3-flash-001` GA)
- Deprecation warning fires in Sentry/health check
- Eval results suggest a newer model improves quality

## Pre-Upgrade Checklist

1. **Check deprecation timeline** — `MODEL_DEPRECATION_DATES` in `deprecation-monitor.ts`
2. **Read Google changelog** — note breaking changes in JSON output, token limits, pricing
3. **Verify new model supports required capabilities:**
   - Structured JSON output (`responseMimeType: 'application/json'`)
   - Multimodal vision (image + text input)
   - Embeddings (if upgrading embedding model)
   - Fine-tuning via Vertex AI (if retraining Golden model)

## Upgrade Steps

### 1. Update the Version Pin

Edit `services/worker/src/ai/gemini-config.ts`:

```typescript
// Change the DEFAULT constant:
const DEFAULT_GENERATION_MODEL = 'gemini-3-flash-001';  // was: gemini-3-flash-preview

// Update MODEL_VERSION_PINS:
generation: {
  modelId: 'gemini-3-flash-001',
  pinnedAt: '2026-MM-DD',      // today's date
  verifiedAt: '2026-MM-DD',    // after eval passes
  notes: 'Upgraded from preview to GA',
},
```

### 2. Run the Eval Suite

```bash
# Full golden dataset eval (1,605 entries)
cd services/worker
npx tsx scripts/eval-gemini-golden-v2-full.ts

# Fraud detection eval
npx tsx scripts/eval-fraud-detection.ts

# Embedding benchmark (if embedding model changed)
npx tsx scripts/eval-embedding-benchmark.ts
```

**Pass criteria:**
- Weighted F1: no regression >2pp from baseline
- Macro F1: no regression >3pp
- ECE (calibration): <15%
- Per-type F1: no single type drops >5pp
- Fraud detection: no regression in false positive rate

### 3. Update Tests

```bash
# Run full test suite
npx vitest run

# Verify version pinning tests pass
npx vitest run src/ai/version-pinning.test.ts
npx vitest run src/ai/gemini-config.test.ts
```

### 4. Deploy to Staging

```bash
# Update Cloud Run env var (staging)
gcloud run services update arkova-worker-staging \
  --set-env-vars GEMINI_MODEL=gemini-3-flash-001

# Monitor for 24 hours:
# - Error rates in Sentry
# - Extraction success rate
# - Confidence distribution
```

### 5. Deploy to Production

```bash
# Update Cloud Run env var (production)
gcloud run services update arkova-worker \
  --set-env-vars GEMINI_MODEL=gemini-3-flash-001

# Monitor for 48 hours post-deploy
```

### 6. Update Documentation

- [ ] `gemini-config.ts` — version pin metadata
- [ ] `CLAUDE.md` — model references in env vars section
- [ ] `.env.example` — default model name
- [ ] `docs/eval/` — eval results for new model
- [ ] Confluence: AI Intelligence Suite page

## Rollback

If the new model causes regressions:

```bash
# Immediate: set env var back to previous version
gcloud run services update arkova-worker \
  --set-env-vars GEMINI_MODEL=gemini-3-flash-preview

# The version pin in code is the default — env var override takes precedence
```

## Emergency: Model Deprecated Before Migration

If a model is deprecated and calls start failing:

1. Check `validateVersionPins()` output in health check
2. Update `DEFAULT_GENERATION_MODEL` to the replacement model
3. Deploy immediately (skip full eval — run eval after deploy)
4. Log incident and run eval within 24 hours
