# services/worker/src/email/

Email sending infrastructure powered by Resend SDK. Handles transactional email delivery with audit logging.

## Files

- **index.ts** — Barrel export for the email module (sender + templates).
- **sender.ts** — Wraps Resend SDK for transactional email delivery. All sends are audit-logged. Feature-gated: silently skipped when `RESEND_API_KEY` is not set (allows dev without Resend).
- **sender.test.ts** — Tests for email sending, dev-mode skips, and audit logging.
- **templates.ts** — HTML email templates (activation, anchor secured, revocation, domain verification). Uses inline CSS for email client compatibility.
- **templates.test.ts** — Tests for template rendering and HTML escaping.

## Rules

- No document content in emails (Constitution 1.6 — client-side processing boundary).
- No blockchain terminology in user-facing email copy (Constitution 1.3).
- API keys loaded from env, never logged (Constitution 1.4).
- No PII beyond email address in audit logs.
