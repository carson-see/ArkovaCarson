# agents.md — components/public
_Last updated: 2026-07-21_

## What This Folder Contains
Public-facing (unauthenticated) verification and provenance components.

## Key Files
- `PublicVerifyPage.tsx` — Public verification page: with publicId shows result directly, without publicId shows the verification form
- `ProvenanceTimeline.tsx` — Vertical timeline of credential lifecycle events on the public verification page
- `ProofDownload.tsx` — Download proof package for a verified document
- `index.ts` — Barrel exports

## Dependencies
- `@/components/verify/VerificationForm` — embedded verification form
- `@/components/verification/PublicVerification` — public verification result display
- `@/lib/workerClient` (WORKER_URL) — provenance data API
- `@/lib/copy` (VERIFICATION_LABELS, PROVENANCE_LABELS) — UI strings

## Do / Don't Rules
- DO: These pages are public and cross-tenant by design — never add auth requirements
- DO NOT: Expose internal IDs — only `public_id` fields are used

## 2026-07-21 SCRUM-2938 S2 — terminology scrub remainder

PublicVerifyPage renders scrubbed VERIFICATION_LABELS ("Verify a Document" / "Document Verification"); test assertions updated. Internal identifiers (keys, enum values, `credential_type`, API params) are unchanged per §1.3 "internal code may use technical names". Contract test: `src/lib/copy-scrum-2938-terminology-s2.test.ts` (walks every copy.ts string value; SCRUM-1672 `ISSUE_CREDENTIAL_LABELS` carve-out locked byte-identical).
