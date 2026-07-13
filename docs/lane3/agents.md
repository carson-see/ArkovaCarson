# agents.md — docs/lane3/

Last updated: 2026-07-13.

Lane 3 (Credential Network & Intelligence / AI) Sprint 3.3 working documents. Internal engineering notes — the audited specs live in Confluence (sprint 3.3 lane plan, pageId 96894977). Per CLAUDE.md §0 rule 4, these `.md` files are NOT documentation of record.

| File | What it is |
|---|---|
| `s33-candidate-packet.md` | L3-S0: tuned-candidate selection (v6-primary + gated v7.1 per CTO R1), Vertex artifact inventory (raw gcloud/REST output, 2026-07-10), v6 eval-number reconciliation, prod-drift/stale-doc list, prompt pairing, responseSchema fairness rule, v6 endpoint-recreate steps (documented, NOT executed) |
| `s33-multimodal-spike-memo.md` | L3-S6: tuned-endpoint multimodal probe (BLOCKED-until-v6-redeploy — zero endpoints deployed; UNCONFIRMED from docs), client WASM transcription feasibility, architecture decision (client-transcription primary per CTO R4), pilot messaging |
| `s33-eval-methodology.md` | Eval design ONLY (no eval-file edits while #1413 soaks): paired bootstrap, no-covered-type-regresses floor, confusion matrices, abstention scoring, missing_both caveat, post-#1413 landing map |
| `s33-batch-acceptance-protocol.md` | L3↔L4 interface contract: batch format, ≥10% cross-review, prod-model-diff screening under mock-sandwich caps, quality invariants, reject-and-return, held-out freeze |
| `s33-ce-escalation-send-packet-draft.md` | Current CE continuation draft: org CTID and Jeanne/Jeff roles established from correspondence, June 24 answer reconciled, sandbox usable access still unverified, September 9 exact instant/timezone unknown, explicitly UNSENT/founder-send-reserved |
| `s33-hakichain-packet-readiness.md` | Internal Haki LOI/Exhibit A readiness index: unresolved pre-pilot $500-in-full billing versus post-success commercial-effect/agreement trigger, Aug 7/Aug 10 clocks, unresolved legal/CTO defects, reviewed-unaccepted Kenya candidate list, explicitly UNSENT/UNSIGNED |

Rules for this folder:

- Historical eval figures MUST carry the contamination caveat (~224/249 stratified entries in training corpus — upper bounds for OOD).
- Do NOT cite the stale v5-reasoning-in-prod docs listed in `s33-candidate-packet.md` §4 for current prod state; prod = public gemini-2.5-flash, Developer-API surface, `GEMINI_TUNED_MODEL` unset (RTE live-verified 2026-07-10).
- No edits to `services/worker/src/ai/eval/*` or `scripts/staging/ai-eval/*` originate from these docs while PR #1413 soaks.
