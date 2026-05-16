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
