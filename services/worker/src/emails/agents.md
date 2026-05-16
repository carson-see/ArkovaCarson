# services/worker/src/emails/

Individual email template modules. Each file builds a specific transactional email using the shared layout from `_template.ts` and sends via the `email/sender.ts` infrastructure.

## Files

- **_template.ts** — Shared Arkova email layout helpers: HTML escaping, branded wrapper, inline CSS styles, UTC date formatting. All per-template files import from here.
- **grace-warning.ts** — Payment grace period warning email. Sent when an organization's payment is overdue and grace expiry is approaching.
- **grace-warning.test.ts** — Tests for grace warning email rendering.
- **parent-delinquent-split.ts** — Parent-delinquent split-off email. Sent to sub-org admins when a parent org's payment state could affect their account.
- **parent-delinquent-split.test.ts** — Tests for parent delinquent split email rendering.

## Rules

- New email templates should import `esc`, `SHARED_STYLES`, `wrapTemplate`, and `formatUtc` from `_template.ts`.
- All sends go through `email/sender.ts` — never call Resend directly from template files.
- No document content or PII beyond email address in email bodies.
