# GEMB2-02 — Swap Nessie RAG embedder to Gemini Embedding 2

**Jira:** [SCRUM-1051](https://arkova.atlassian.net/browse/SCRUM-1051)
**Parent:** [SCRUM-1040](https://arkova.atlassian.net/browse/SCRUM-1040)
**Blocks:** all future Nessie fine-tune rounds.
**Depends on:** GEMB2-01 spike benchmark.
**Status:** Design complete, implementation blocked on benchmark go/no-go.

---

## Goal

Replace the current RAG embedder for Nessie's compliance-intelligence knowledge base with a two-stage retrieval powered by Gemini Embedding 2 via Vertex AI.

## Two-stage retrieval

```
┌────────────────────────┐      ┌───────────────────────┐
│  Query text (question) │─────▶│  embed @ 768d          │
└────────────────────────┘      │  GEMB2_LOCATION=us-... │
                                └──────────┬────────────┘
                                           │ cosine top-K (K=40)
                                           ▼
                              ┌───────────────────────────┐
                              │  rule_embeddings cache    │ ← 768d column
                              │  pgvector ivfflat index   │
                              └──────────┬────────────────┘
                                         │ candidate IDs
                                         ▼
                              ┌───────────────────────────┐
                              │  re-embed candidates @ 3072d │
                              │  + re-rank by cosine       │
                              └──────────┬────────────────┘
                                         │ top-K (K=5)
                                         ▼
                              ┌───────────────────────────┐
                              │  Nessie response with      │
                              │  citations                 │
                              └────────────────────────────┘
```

## Affected modules

| File | Change |
|---|---|
| `services/worker/src/ai/embeddings/gemini2.ts` | Existing — used by provider (GEMB2-01). |
| `services/worker/src/ai/embeddings.ts` | Add `Gemini2Embedder` implementing `IEmbedder`. Feature-flag selection. |
| `services/worker/src/nessie/rag/retrieval.ts` | Switch to two-stage retrieval when `ENABLE_GEMB2_RAG=true`. |
| `supabase/migrations/0237_rule_embeddings_gemb2_columns.sql` | Add `vector_768` + `vector_3072` columns; keep legacy `embedding` for rollback. |
| `services/worker/src/config.ts` | New `ENABLE_GEMB2_RAG` flag, default false. |

## Migration plan (once benchmark passes)

1. Land the new columns + backfill job behind a feature flag (`ENABLE_GEMB2_BACKFILL=false`).
2. Human flips `ENABLE_GEMB2_BACKFILL=true` overnight; the backfill computes Gemini Embedding 2 vectors for every row in `rule_embeddings` — writes to the new columns. Takes ~2–3 hours for the current ~18K corpus at the Vertex `gemini-embedding-2` rate.
3. Once backfill completes, human flips `ENABLE_GEMB2_RAG=true` for a 10% canary.
4. Monitor recall@5 + p95 latency for 48h via `services/worker/src/ai/eval/`.
5. Promote to 100% or revert to flag=false.

## Acceptance criteria (pasted from Jira)

- Hot-path retrieval returns 768-dim vectors from Gemini Embedding 2.
- Re-rank stage fetches 3072-dim vectors for top-K.
- Recall@5 on held-out golden ≥ prior baseline.
- Feature flag for rollback (`ENABLE_GEMB2_RAG`, default false until validated).
- Nessie RAG tests green.

## Rollback

`ENABLE_GEMB2_RAG=false` flips back to the legacy `embedding` column + `gemini-embedding-001`. No data loss — the old column stays populated and is only dropped in the follow-up migration 0238 (landed ≥30 days after GA).

## Cost control

- 768d hot-path keeps retrieval costs aligned with today's `gemini-embedding-001` run rate.
- 3072d re-rank only runs for top-40 candidates per query → ~40 embed calls/query × current QPS.
- Total marginal monthly cost projection (Nessie traffic 300K queries/mo): paste from Confluence after GEMB2-01 pricing sheet.
