---
name: surrogate-safe-truncation
description: Never bound persisted text with bare `.slice(0, N)` — a UTF-16 code-unit cut can split a surrogate pair, and the lone surrogate makes the whole PostgREST request body invalid JSON (PGRST102). Use `truncateUtf16Safe`.
type: feedback
---

`String.prototype.slice` / `.substring` / `.substr` cut at UTF-16 **code-unit** boundaries. A cut that lands inside a surrogate pair leaves a lone high surrogate at the end of the string. A lone surrogate cannot be encoded as UTF-8; PostgREST rejects the enclosing request body as invalid JSON (`PGRST102 "Empty or invalid json"`) — the entire insert/update fails, not just the one field.

**Why:** The 2026-08-17 poison-record incident (PR #2266 — its body carries the incident narrative; the prod-repair doc lands with that PR): an OpenAlex abstract with astral-plane math symbols was cut exactly at unit 500 by `publicRecordAnchor.ts`'s `description.slice(0, 500)`, and the resulting lone surrogate PGRST102'd every anchor insert at the head of the public-record queue for 16 days. The follow-up census found the same shape on `job_queue.last_error` (failure bookkeeping fails on a poisoned error message), `webhook_delivery_logs.response_body` (endpoint-controlled bytes), `compliance_audits.error_message`, and the `anchors` insert payloads of the CTDL-registry and credential-source routes. A careful reviewer had passed every one of them; a lint does not get tired (see `feedback_lint_rule_beats_human_census`).

**How to apply:**
- Bound persisted or serialized text with `truncateUtf16Safe(value, N)` from `services/worker/src/utils/utf16-truncate.ts` — same cap, guaranteed well-formed output (drops a trailing split surrogate; no visible U+FFFD; feature-detected `toWellFormed()` guard for already-malformed input).
- `.trim()` does **not** remove a lone surrogate — it is not whitespace. Neither does whitespace collapsing.
- Truly safe slices exist (hex digests, `randomUUID()`, ISO-date `slice(0, 10)`, array `.slice`) — those are fine; the rule's baseline is where such sites are recorded when they sit inside a write span.
- Test the class with `services/worker/src/tests/utf16-poison.ts` (`poisonAt(cap)` builds a string whose slice at `cap` splits a pair; `illFormedStringPaths(payload)` sweeps a whole write payload).

**Enforcement:** CI lint `scripts/ci/feedback-rules/surrogate-safe-truncate.ts` — flags bare truncation calls lexically inside `.insert(`/`.update(`/`.upsert(` argument spans in `services/worker/src` non-test files; ratchet against `surrogate-truncate-baseline.json` (shrink-only burn-down). Merge-time gate is the colocated `surrogate-safe-truncate.test.ts` in `Tests` (Policy Lints is not a Mergify merge condition). Known limit: variable/helper-mediated flows are not lexically detectable — those sites carry their own poison regression tests.

**Override label:** `surrogate-slice-reviewed` — use only when a flagged site provably never persists text; prefer a baseline entry with a reason so the census stays in one file.
