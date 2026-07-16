# agents.md — docs/lane3/

Last updated: 2026-07-15.

Lane 3 (Credential Network & Intelligence / AI) Sprint 3.3 working documents. Internal engineering notes — the audited specs live in Confluence (sprint 3.3 lane plan, pageId 96894977). Per CLAUDE.md §0 rule 4, these `.md` files are NOT documentation of record.

| File | What it is |
|---|---|
| `s33-candidate-packet.md` | L3-S0: tuned-candidate selection (v6-primary + gated v7.1 per CTO R1), Vertex artifact inventory (raw gcloud/REST output, 2026-07-10), v6 eval-number reconciliation, prod-drift/stale-doc list, prompt pairing, responseSchema fairness rule, v6 endpoint-recreate steps (documented, NOT executed) |
| `s33-multimodal-spike-memo.md` | L3-S6: tuned-endpoint multimodal probe (BLOCKED-until-v6-redeploy — zero endpoints deployed; UNCONFIRMED from docs), client WASM transcription feasibility, architecture decision (client-transcription primary per CTO R4), pilot messaging |
| `s33-eval-methodology.md` | Eval design ONLY: paired bootstrap, no-covered-type-regresses floor, confusion matrices, abstention scoring, missing_both caveat; Wave-1 acceptance edits follow the CTO-ratified contract and remain offline-only |
| `s33-wave3-v71-offline-gates.json` | Machine-readable CTO-recommended v7.1 admission registry: exactly 16 all-must-pass offline gates, deterministic B=2,000 paired bootstrap, separate Legal/Financial/Education uplift gates, type floors/regression, efficiency, and calibration. It is a pre-soak contract, not live model evidence or candidate admission. |
| `evidence/s33-public-authority-genesis-receipt.json` | Public-only, `selfPinned:false` founder/CTO genesis receipt binding the canonical roster root, three Ed25519 public identities/signatures, and secret-version resource names (never values); bootstrap-only and grants no live/spend authority. |
| `s33-batch-acceptance-protocol.md` | L3↔L4 interface contract amended by CTO rulings 102498305 + the 2026-07-14 dual-DAG decision: strict manifest/datasheet/corpus provenance, authenticated direct r10→r11′ edge with no hidden history, exact LEAKAGE32 plus disjoint KE-006 transition, r11′ historical rejection, r12 producer-history repair, conflict-free S12+r12 virtual merge and exact F12 materialization, whole-batch post-validation depth plus ≥10% cross-review, GitHub/CI exact-head trust root, machine-readable artifact, normalized exact 6–13-gram leakage scan, offline prod-model replay, diagnostic-only embeddings, reject-and-return, and held-out freeze; no external signing/registry ceremony or live endpoint |
| `s33-ce-escalation-send-packet-draft.md` | Current CE continuation draft: org CTID and Jeanne/Jeff roles established from correspondence, June 24 answer reconciled, sandbox usable access still unverified, September 9 exact instant/timezone unknown, explicitly UNSENT/founder-send-reserved |
| `s33-hakichain-packet-readiness.md` | Internal Haki LOI/Exhibit A readiness index: unresolved pre-pilot $500-in-full billing versus post-success commercial-effect/agreement trigger, Aug 7/Aug 10 clocks, unresolved legal/CTO defects, reviewed-unaccepted Kenya candidate list, explicitly UNSENT/UNSIGNED |

Rules for this folder:

- Historical eval figures MUST carry the contamination caveat (~224/249 stratified entries in training corpus — upper bounds for OOD).
- Do NOT cite the stale v5-reasoning-in-prod docs listed in `s33-candidate-packet.md` §4 for current prod state; prod = public gemini-2.5-flash, Developer-API surface, `GEMINI_TUNED_MODEL` unset (RTE live-verified 2026-07-10).
- PR #1413 has merged. Wave-1 acceptance edits to
  `services/worker/src/ai/eval/*` must implement the CTO-ratified contract and
  remain offline-only; these working docs do not authorize runtime changes.
- Wave-1 acceptance is not complete until the exact #1544 head/tree/manifest is
  bound to a GitHub-approved, CI-green artifact and the whole-batch checks plus
  deterministic human cross-review pass. Wave-2 corpus production must not
  begin before that acceptance closes.
