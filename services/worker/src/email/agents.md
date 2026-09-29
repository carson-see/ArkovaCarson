# services/worker/src/email/

Email sending infrastructure powered by Resend SDK. Handles transactional email delivery with audit logging.

## 2026-09-28 — distinguish rejected sends from uncertain delivery

`sendEmail` retains the `success` contract and adds `failureType` on failures.
Only explicit request/auth/quota rejection responses establish `rejected`.
Transport failures, server errors, idempotency conflicts and a missing provider
message ID are `unknown`: the provider may already have accepted the request.
Bulk activation retains its durable `sending` claim for these outcomes and
does not automatically resend. The real-wrapper boundary test covers this
connection; mocking the sender as throwing does not cover its returned errors.

## 2026-09-11 — provider idempotency for invitation retries

`sendEmail` accepts an optional `idempotencyKey` and passes it through the Resend SDK options.
The UAT-22 admin invitation handler uses `invitation/<invitation-id>`. Resend documents a 24-hour
deduplication window and rejects the same key with a changed payload, so this limits duplicate
delivery during normal retries without asserting permanent exactly-once delivery. Existing callers
that omit the key keep the one-argument SDK call.

## Files

- **index.ts** — Barrel export for the email module (sender + templates).
- **sender.ts** — Wraps Resend SDK for transactional email delivery. All sends are audit-logged. Feature-gated: silently skipped (`success:true`) when `RESEND_API_KEY` is not set — **but only outside production** (SCRUM-3012). In `config.nodeEnv === 'production'` a missing key now returns `success:false` instead of faking a send; this was the root cause that let the org-invite flow report "sent" while zero emails ever left the building.
- **sender.test.ts** — Tests for email sending, dev-mode skips, prod-honesty (no fake success), and audit logging.
- **templates.ts** — HTML email templates (activation, anchor secured, revocation, invitation, account verification, domain verification). Uses inline CSS for email client compatibility.
- **templates.test.ts** — Tests for template rendering and HTML escaping.

## Rules

- No document content in emails (Constitution 1.6 — client-side processing boundary).
- No blockchain terminology in user-facing email copy (Constitution 1.3). **CI-enforced since 2026-08-20:** this whole directory is a `WORKER_COPY_ROOT` in `scripts/check-copy-terms.ts`, so `npm run lint:copy` (ci.yml + the deploy-worker gate) scans every subject and body here. Scope + escape hatch: `scripts/agents.md` → "Worker-email scope".
- API keys loaded from env, never logged (Constitution 1.4).
- No PII beyond email address in audit logs.
- A missing/misconfigured provider must never report a fake success in production — see `sendEmail`'s `nodeEnv` branch above. Any new `emailType` inherits this for free (the guard is provider-level, not per-template).
