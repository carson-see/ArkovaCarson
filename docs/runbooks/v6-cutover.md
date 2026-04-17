# Gemini Golden v6 Production Cutover Runbook

> **Written:** 2026-04-16 | **Jira:** SCRUM-772 (GME2) | **Model:** `endpoints/740332515062972416`
> **Prerequisite:** v6 code committed (Phase B of the 2026-04-16 execution plan).
> **Audience:** on-call engineer executing the flip.

---

## What this does

Flips the worker from the v5-reasoning tuned Gemini Golden (`endpoints/8811908947217743872`) to v6 (`endpoints/740332515062972416`). v6 is a strictly-better endpoint on all production metrics:

| Metric | v5-reasoning | v6 | Δ |
|---|---|---|---|
| Weighted F1 (50-sample) | 80.1% | **83.6%** | +3.5pp |
| Macro F1 (50-sample) | 73.8% | **77.1%** | +3.3pp |
| Macro F1 (stratified, n=10/type) | — | **79.3%** | — |
| Mean latency | 11.4s | **3.38s** | **-70%** |
| Tokens per request | 35,881 | **1,741** | **-95%** |
| Known weaknesses (F1) | — | RESUME 53.1%, ACCREDITATION 42.9% | (v7 fixes these) |

**Cost impact:** Flash-tuned endpoints bill per-request, not per-hour-idle. Tokens/req down 95% means **unit cost ≈ -95%** on every extraction after the flip.

---

## Pre-flip checklist

- [ ] Phase B commit merged (`services/worker/src/ai/gemini.ts` has `EXTRACTION_V6_SYSTEM_PROMPT` + `buildV6UserPrompt` imports, `services/worker/src/ai/schemas.ts` has the `description` field, `services/worker/src/ai/prompts/extraction-v6.ts` exists)
- [ ] Cloud Run current revision identified (for rollback): `gcloud run revisions list --service arkova-worker --region us-central1 --limit 1`
- [ ] Sentry dashboard open to monitor error rate after flip
- [ ] `gcloud ai endpoints list --region=us-central1 --project=arkova1` shows `endpoints/740332515062972416` deployed
- [ ] Announce in #engineering — "flipping v6 in 5 min, monitor for 15"

---

## The flip

```bash
gcloud run services update arkova-worker \
  --region us-central1 \
  --project arkova1 \
  --update-env-vars GEMINI_V6_PROMPT=true,GEMINI_TUNED_MODEL=projects/arkova1/locations/us-central1/endpoints/740332515062972416
```

Cloud Run will roll a new revision. Health checks must pass before traffic shifts.

### Expected log evidence (first minute after flip)

On the first extraction call after rollout, worker logs should show:

```
[ai.gemini] v6 prompt active (GEMINI_V6_PROMPT=true)
[ai.gemini] tunedModelActivated=true endpoint=projects/arkova1/locations/us-central1/endpoints/740332515062972416
[ai.gemini] extraction complete latencyMs=<expected 1800-4500>
```

If `latencyMs > 10000` on the first call, that's a cold-start for v6 — second call should be <4500ms.

---

## Post-flip monitoring (15 minutes)

Watch for any of these → rollback immediately:

1. **Extraction error rate spikes above baseline** — Sentry `ai.gemini.extraction` errors, per-minute count
2. **JSON parse failures** — `[ai.gemini] JSON parse failed` in worker logs
3. **Unexpected schema mismatch** — Zod validation errors on `description` or `subType` fields
4. **p95 latency > 8s** — Cloud Run service latency graph. v6 expected <5s p95.

### Sample monitoring commands

```bash
# Tail worker logs
gcloud logging read 'resource.type=cloud_run_revision resource.labels.service_name=arkova-worker' \
  --project arkova1 --limit 50 --format 'value(textPayload)' | grep -i 'gemini\|error'

# Check latency percentiles
gcloud monitoring metrics-scopes describe --project arkova1  # confirm monitoring scope
# Open: console.cloud.google.com → Cloud Run → arkova-worker → Metrics tab → Request latencies
```

---

## Rollback (single command)

```bash
gcloud run services update arkova-worker \
  --region us-central1 \
  --project arkova1 \
  --remove-env-vars GEMINI_V6_PROMPT,GEMINI_TUNED_MODEL
```

This removes both env vars. Worker falls back to the v5-reasoning endpoint baked into code defaults (`process.env.GEMINI_TUNED_MODEL ?? null`). Cold start ≤30s, then back to baseline.

**After rollback:**
- [ ] Post incident notes in #engineering
- [ ] Update SCRUM-772 with the failure signature
- [ ] Investigate root cause before re-attempting — do not re-flip without a fix

---

## Next steps after successful cutover

Once v6 has been serving for 24h with no regressions:

1. **Unstick v7 training** (separate story) — 190-entry dataset expansion + isotonic calibration + `responseSchema`
2. **SCRUM-794 / GME2-03 isotonic calibration** — use v6 eval results to fit knots; ship as `calibration-v6.json`. Can ship same day as cutover.
3. **Cost cleanup** — 24h after stable v6, undeploy the v5-reasoning endpoint (keep artifacts) per Vertex cost discipline in CLAUDE.md

---

## References

- v6 design: `docs/plans/gemini-golden-v6-design-2026-04-16.md`
- v6 eval (50-sample): `services/worker/docs/eval/eval-gemini-golden-v6-2026-04-16.md`
- v6 eval (stratified): `services/worker/docs/eval/eval-gemini-golden-v6-stratified-2026-04-16.md`
- Switchboard doc: `docs/confluence/13_switchboard.md`
- Jira epic: SCRUM-772
