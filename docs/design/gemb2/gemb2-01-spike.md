# GEMB2-01 — Gemini Embedding 2 Vertex AI Spike

**Jira:** [SCRUM-1050](https://arkova.atlassian.net/browse/SCRUM-1050)
**Parent epic:** [SCRUM-1040 GEMB2](https://arkova.atlassian.net/browse/SCRUM-1040)
**Status:** Reference implementation + benchmark harness landed; live calibration pending a human-run session with GCP creds.
**Owner:** tech-lead.
**Gate:** P0 — blocks all further Nessie + Gemini Golden training work.

> **Why this unblocks training:** The current Gemini Golden eval harness scores against `gemini-embedding-001` exact-string matches. Re-training Nessie (or re-evaling Gemini Golden) against a stale embedder wastes RunPod compute on a ground truth we're about to swap. GEMB2-02/03 will switch the hot path; GEMB2-01 is the feasibility gate that proves the new path is cheap + accurate enough to adopt.

---

## 1. Scope

Feasibility evaluation of Gemini Embedding 2 via Vertex AI. Concretely:

1. **Auth path** — Service-account auth via `google-auth-library` default credentials chain. Cloud Run worker uses the attached SA + workload identity federation; local dev uses `gcloud auth application-default login`. No raw API keys in this path.
2. **Latency + cost benchmark** — p95 latency, p99 latency, $/1M tokens. Baseline against `gemini-embedding-001`.
3. **Multimodal** — text confirmed; PDF and image slots stubbed in `Gemini2Client` for INT-10/INT-12 follow-up.
4. **Matryoshka truncation** — `outputDimensionality = 3072 | 1536 | 768` via Vertex parameter. Two-stage retrieval plan:
   - Hot path: 768d for cheap top-K candidate fetch (Nessie RAG).
   - Re-rank: 3072d re-fetch for top-K cosine re-score.
5. **US-only residency** — hard-pinned to `us-central1-aiplatform.googleapis.com`. The client throws on any other location — no accidental EU/APAC spill.

Out of scope of this spike: wiring up production RAG retrieval (GEMB2-02), semantic eval scoring (GEMB2-03), near-dup anchor detection (GEMB2-04).

---

## 2. What landed in this PR (reference implementation)

| File | Purpose |
|---|---|
| [services/worker/src/ai/embeddings/gemini2.ts](../../services/worker/src/ai/embeddings/gemini2.ts) | Typed `Gemini2Client` with injectable auth + fetch abstractions. US-only residency guard. Matryoshka dim whitelist. |
| [services/worker/src/ai/embeddings/gemini2.test.ts](../../services/worker/src/ai/embeddings/gemini2.test.ts) | 11 unit tests: endpoint URL + bearer token shape, Matryoshka dim respect, residency guard, 429 / dim-mismatch / empty-text / empty-token error paths, latency surfacing. |
| [services/worker/scripts/benchmark-gemini2.ts](../../services/worker/scripts/benchmark-gemini2.ts) | Human-run harness. Reads a small corpus, measures p50/p95/p99 latency, writes a Markdown benchmark table. See §6. |

None of this is wired into a production hot path. `ENABLE_GEMB2` (landing in GEMB2-02) gates the switch-over.

---

## 3. Auth design

```
┌──────────────────────┐      ┌─────────────────────┐
│  Cloud Run worker    │      │  google-auth-library │
│  SA: ...compute@...  │─────▶│  default chain        │
│                      │      │  (metadata → token)   │
└──────────────────────┘      └─────────────┬─────────┘
                                            │
                                            ▼
                            ┌───────────────────────────────┐
                            │  Vertex AI predict endpoint   │
                            │  us-central1-aiplatform...    │
                            │  Bearer <access_token>        │
                            └───────────────────────────────┘
```

**IAM grants needed before rollout (SEC-HARDEN-02 covers this):**

- `roles/aiplatform.user` on project `arkova1` for the worker SA.
- Optional: `roles/aiplatform.serviceAgent` on the Vertex service agent for image/PDF inputs.

**No raw `GEMINI_API_KEY` anywhere in this path.** The existing
`gemini-embedding-001` calls still use API-key auth; those move to Vertex SA
in GEMB2-02.

---

## 4. Model ID pinning

`gemini-embedding-2@001`. The `@001` suffix is **mandatory** — past incident
(2026-03-22): Gemini Golden F1 dropped ~3 pts overnight after a silent
`latest` rotation. Eval reproducibility requires pinned versions.

When Google releases `@002`, the bump goes in an explicit PR with a rerun of
the Confluence benchmark + a Gemini Golden delta report.

---

## 5. Matryoshka truncation rationale

Gemini Embedding 2 is trained with Matryoshka Representation Learning — the
first `k` dimensions carry most of the semantic signal, so truncating to
`k < 3072` is nearly-lossless for the top-K retrieval step.

Recall trade-off (to be measured in §6 benchmark):

| Dim | Relative storage cost | Expected recall@5 on Nessie golden | Use case |
|---|---|---|---|
| 768  | 1.00× | ≥ 95% of 3072 baseline | Nessie RAG hot path |
| 1536 | 2.00× | ≥ 98% of 3072 baseline | Escalation if 768 falls short |
| 3072 | 4.00× | baseline | Top-K re-rank + semantic eval scoring |

If 768d recall lands below 90%, fall back to 1536d hot path. The feature
flag in GEMB2-02 carries the choice so we can switch per-org.

---

## 6. Benchmark harness

Location: `services/worker/scripts/benchmark-gemini2.ts`.

**Prerequisites (human-run):**

```bash
# 1. Auth
gcloud auth application-default login

# 2. Env
export GCP_PROJECT_ID=arkova1

# 3. Fixtures — picks 50 texts from the Nessie golden corpus
#    (see docs/design/gemb2/fixtures/ when GEMB2-02 lands).

# 4. Run
npx tsx services/worker/scripts/benchmark-gemini2.ts --dim=768 --out=bench-768.md
npx tsx services/worker/scripts/benchmark-gemini2.ts --dim=3072 --out=bench-3072.md
```

Output: a Markdown table suitable for pasting into the Confluence
"GEMB2-01 — Gemini Embedding 2 benchmark" page:

```
| Dim | Count | p50 ms | p95 ms | p99 ms | Errors | Est $/1M tokens |
|---|---|---|---|---|---|---|
| 768  | 50 | XX | XX | XX | 0 | $XX |
| 3072 | 50 | XX | XX | XX | 0 | $XX |
```

Cost estimate comes from multiplying token count by the Vertex pricing
sheet entry (caller pastes the current price — benchmark harness does not
fetch pricing to keep it deterministic).

---

## 7. US-only residency verification

The client **throws** if `location !== us-central1`. Unit test
`rejects non-US locations (residency guard)` pins this. For additional
operational confidence:

- Request hostname is logged on every call (`xx-aiplatform.googleapis.com`).
- Response `x-goog-api-client` header is captured in traces.
- Cloud Logging Vertex audit logs show the actual execution region — cross-reference with the worker's logged hostname in a monthly residency audit.

---

## 8. Recommendation

**GO.** Land the reference client + benchmark harness now. Before wiring it
into production:

1. Human runs `benchmark-gemini2.ts` with 50 Nessie golden texts.
2. Paste results into Confluence "GEMB2-01 — Gemini Embedding 2 benchmark".
3. If p95 < 250 ms and 768d recall ≥ 90%, proceed with GEMB2-02 switch-over at `ENABLE_GEMB2=false → true` with a 10% canary.
4. If recall falls short, bump hot path to 1536d.

**NO-GO conditions (any one kills the migration):**
- p95 latency > 500 ms for 768d in `us-central1`.
- 768d recall@5 drops more than 10% vs `gemini-embedding-001` on our golden corpus.
- Per-1M-token pricing exceeds 2× the `gemini-embedding-001` rate.

---

## 9. Links

- Parent epic: [SCRUM-1040](https://arkova.atlassian.net/browse/SCRUM-1040)
- Siblings: [SCRUM-1051](https://arkova.atlassian.net/browse/SCRUM-1051) RAG swap · [SCRUM-1052](https://arkova.atlassian.net/browse/SCRUM-1052) semantic eval harness · [SCRUM-1053](https://arkova.atlassian.net/browse/SCRUM-1053) near-dup supersede spike
- Existing embedder: [`services/worker/src/ai/embeddings.ts`](../../services/worker/src/ai/embeddings.ts)
- Nessie RAG: [`services/worker/src/nessie/rag/`](../../services/worker/src/nessie/rag/)
