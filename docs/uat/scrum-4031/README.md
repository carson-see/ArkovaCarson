# UAT-01 / SCRUM-4031 — internal verification evidence

Canonical specification, test plan and pre-mortem: [Confluence](https://arkova.atlassian.net/wiki/spaces/A/pages/137134081).

## Scope and results

The retired browser beta gate prevented access to email and social registration. It is removed from source, along with unused copy/configuration/types. The existing auth hook, backend confirmation policy, organization invitation flow, API, webhooks, hosted/stdio MCP and SDK contracts are unchanged.

- Red regression on baseline `fdcddeea68a67b87f11c3632a5b5ebc336360a72`: 7 failed, 9 passed. Failures showed the beta invite gate when a legacy value was set.
- Focused registration/auth/invitation coverage: 111 passed across 10 files (including 24 signup cases across absent/stale configuration). Tests cover no-session confirmation, active-session callback, errors, validation, provider handlers and loading controls.
- Both root and build-config TypeScript checks passed. Full frontend ESLint passed with one pre-existing warning in `useAcceptInvite.test.ts`; changed files lint clean. Copy terminology check passed.
- Vite production bundle built with `VITE_BETA_INVITE_CODE=RETIRED-BETA-CODE`; the bundled JavaScript contains the updated signup subtitle and neither the retired code nor the closed-beta prompt.
- Playwright public-entry checks: 2 passed, at 1280px and 375px. Real Google Chrome against the task's production bundle at private port 5199; no request mocking or account writes. Keyboard navigation, password mismatch/recovery, sign-in navigation and overflow checked. Served entry asset matched the worktree build by SHA-256.

## Screenshots

Before images show logged-out production `/signup` on 2026-09-05. After images show this task's locally built page, not a deployed production fix.

| Width | Before | After |
|---|---|---|
| Desktop 1280px | [Before](signup-before-1280.png) | [After](signup-after-1280px.png) |
| Mobile 375px | [Before](signup-before-375.png) | [After](signup-after-375px.png) |

## Review and remaining release work

Manual React/security review found no new data flows, secrets, authorization changes, raw HTML rendering, or injection paths. PR #2637 remains a separate MFA change; its shared copy/env edits were inspected for overlap and do not replace this gate-removal work.

Real confirmation-required signup against an owned auth backend remains pending; the local Docker daemon did not answer its read-only inventory query. Component tests establish the frontend's session response handling, and `e2e/auth.spec.ts` contains the real signup/user-row assertion. This evidence does not claim email delivery or OAuth provider branding is fixed (separate UAT items).

T2 release classification applies to auth UI. This PR contains frontend source, tests and evidence; removal of the retired `.env.example` sample variable is owned by the parallel auth-configuration change. The signup runtime ignores legacy values regardless of that sample cleanup. No RM approval, staging soak, full PR CI result or production verification is asserted by this document. Rollback: revert the frontend commit or restore its previous deployment (restores the reported beta barrier; no database rollback).

## Packaging and evidence identity

The initial verified runtime was commit `d1e1199c733b694d0401b28e77acb3c0575afb9d`. After verification, the branch was rebased onto main `598ed62f8093e61e3760e5d6d35b7864f036fe88`, the inert root `.env.example` cleanup was assigned to the parallel auth-configuration change, and this evidence note was updated. The signup implementation, auth hooks, signup copy and signup E2E assertions remain unchanged. Prior screenshots and the 20-case concurrent run describe that unchanged signup runtime; they are not silently relabeled as execution on a new head. Fresh CI must pass on the final PR head.

The protected Vercel preview of the initial tested runtime (`dpl_H7B8UFS1N3bXS4vWjMZmoPFHvUDb`) also passed the two existing public signup cases, headless, at 1280px and 375px: 2/2 in 7.484 seconds, no account writes, no failed/flaky/skipped cases or runner errors. The temporary scoped preview cookie was loaded only into isolated contexts and deleted after testing; no storage-state file was created. This is preview deployment evidence, not production release proof. Raw runner evidence is attached to the canonical Confluence story.
