## 2026-09-12 — SCRUM-5023: `api-key-expiry.ts`

Expiry notice for an API key, in two kinds. **The kinds are not cosmetic**: `expiring` states a
deadline with time to act; `expired` states that requests are ALREADY being refused. A partner reading
"expires soon" about a key that died in July learns nothing actionable — that was the defect.

**This template receives the key PREFIX and NAME, and nothing else (Constitution 1.4).** An email is
the least controllable artifact the system produces: it lands in an inbox, a mail archive, and usually
a support thread. The raw key is unrecoverable by construction (only the HMAC is stored) and the hash
must never leave the worker. `api-key-expiry.test.ts` asserts no 64-hex string of any kind appears in
subject or body, and that a crafted key name cannot inject markup (names are user-supplied and land in
an HTML document — `esc()` from `_template.ts` is mandatory, not decorative).

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
- No banned §1.3 terminology in subjects or bodies. **CI-enforced since 2026-08-20:** this directory is a `WORKER_COPY_ROOT` in `scripts/check-copy-terms.ts` (`npm run lint:copy`); a copy-composing module placed OUTSIDE it (e.g. a digest under `jobs/`) is picked up by the content detector `isEmailCopyComposer`, so there is no path list to remember. See `scripts/agents.md` → "Worker-email scope".
