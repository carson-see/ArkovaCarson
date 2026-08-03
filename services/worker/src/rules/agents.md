# services/worker/src/rules/

Rules engine: trigger evaluation, config validation, and input sanitization for automated document processing rules.

## Files

- **evaluator.ts** — Pure decision function: given an event + rule config, decides whether a rule fires and which action to schedule. No I/O. Supports triggers: `ESIGN_COMPLETED`, `WORKSPACE_FILE_MODIFIED`, `CONNECTOR_DOCUMENT_RECEIVED`, `MANUAL_UPLOAD`, `SCHEDULED_CRON`, `QUEUE_DIGEST`, `EMAIL_INTAKE`.
- **evaluator.test.ts** — Tests for trigger matching, vendor binding, and rejection reasons.
- **schemas.ts** — Zod schemas for rule trigger + action configs. Validated at write-path (POST/PATCH/draft). Tight validation means malformed configs never reach the DB.
- **schemas.test.ts** — Tests for schema validation edge cases.
- **sanitizer.ts** — Prompt-injection input sanitizer for AI-drafted rules. Strips zero-width/homoglyph/RTL-override chars, caps length, returns structured warnings. Pure function, no I/O.
- **sanitizer.test.ts** — Tests for sanitization of adversarial inputs.

## Rules

- `evaluator.ts` is pure — no DB, no network. The job runner in `jobs/` wraps it with I/O.
- Schema version on the DB row selects which Zod schema applies — bump `schemas.ts` on breaking changes.
- The sanitizer must run before any user input reaches Gemini.

## 2026-08-03 — `INSTANT_SECURE` action (founder directive: "the 'Auto Secure' rule doesn't secure")

`org_rule_action_type` gained a 7th value (migration `0400`, renumbered from `0397` after an independent claim on that prefix merged first as #2001 — **not yet applied to prod as of this PR**). `schemas.ts` gained `ActionConfigInstantSecure` (same shape as `ActionConfigFastTrackAnchor` — optional `tag`/`reason`, kept as a separate object rather than a re-export so the two can diverge independently) and `'INSTANT_SECURE'` in both the `ActionConfig` discriminated union and `CreateOrgRuleInput.action_type` enum. Dispatch logic (credit-funded, idempotent, falls back to the free queue on insufficient credits, plus an immediate per-org batch trigger to make "instant" actually true) lives in `jobs/rule-action-dispatcher.ts` — see that folder's `agents.md` for the full writeup, including why `FAST_TRACK_ANCHOR`'s naming never actually meant "immediate" and the (separately flagged, not fixed here) dead `anchor.fast_track` job-queue consumer gap.

**Dead-rule investigation, same PR:** a hypothesis was raised that the dispatch pipeline only ever runs the FIRST matching rule per event, starving every other enabled rule an org configured on the same trigger. Read end to end (`evaluateRules` here has no `.find()`/early-return — it collects every match) and verified against live prod data (the specifically-named rule cited as evidence, `SCRUM-1655 DocuSign prod sandbox verification`, is the ONLY rule on its org and has SUCCEEDED on all 3 of its lifetime trigger events, not "never once"), no first-match-wins defect exists. `evaluator.test.ts` gained `'returns EVERY enabled rule that matches the same event — no first-match-wins'` as a durable ratchet against a future regression, since the absence of the bug was otherwise only provable by reading the source.
