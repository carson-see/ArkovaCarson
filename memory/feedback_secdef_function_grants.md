---
name: secdef-function-grants
description: Every `public` SECURITY DEFINER function's defining migration must explicitly REVOKE EXECUTE from `anon` and `authenticated` after its LAST `CREATE OR REPLACE` — `ALTER DEFAULT PRIVILEGES` grants both roles EXECUTE directly at CREATE time, and `REVOKE ... FROM PUBLIC` does not remove a direct role grant.
type: feedback
---

On Supabase, `ALTER DEFAULT PRIVILEGES` grants `anon` and `authenticated` EXECUTE **directly** at CREATE time — not via the `PUBLIC` pseudo-role. The idiomatic-looking pair

```sql
REVOKE ALL ON FUNCTION public.f(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.f(int) TO service_role;
```

leaves the ACL as `{postgres=X,anon=X,authenticated=X,service_role=X}`. When the function is `SECURITY DEFINER` it also bypasses RLS, so the result is an RLS-bypassing RPC callable by anyone over PostgREST.

**Why:** this exact shape has shipped five times — migrations `0364`, `0377`, `0378`, `0388`, `0406` — which is why it is a CI detector and not a review checklist item. A careful reviewer missed it four times in a row; a lint does not get tired. `CREATE OR REPLACE` also re-triggers default privileges on every replay, so a revoke living in some later migration closes the hole once and re-opens it the next time the defining migration replays — the revoke has to be adjacent to the definition, and it has to be the *last* statement to touch the ACL.

**How to apply:**
- Every `public` `SECURITY DEFINER` function's migration needs, immediately after its last `CREATE OR REPLACE`:
  ```sql
  REVOKE ALL ON FUNCTION <schema>.<fn>(<args>) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION <schema>.<fn>(<args>) TO service_role;
  ```
  Naming both roles explicitly is mandatory — `FROM PUBLIC` alone does not touch a direct grant.
- **Two narrow, named exemption sets**, not a blanket allowlist:
  - `DELIBERATELY_PUBLIC` (`scripts/ci/feedback-rules/secdef-function-grants.ts`) — functions that are anon-callable ON PURPOSE, the public verification surface (`get_public_anchor`, `get_public_anchor_by_fingerprint`, `search_public_credentials`, `get_public_records_page`). Adding to this set is a security decision: the function must be safe to call unauthenticated and must do its own scoping.
  - `DELIBERATELY_AUTHENTICATED` — a parallel exemption on the `authenticated` axis, added by PR #2248 for exactly two functions prod already grants `authenticated` to on purpose: `get_user_monthly_anchor_count` (`useEntitlements`) and `get_pipeline_stats` (`PipelineAdminPage` fallback). #2248 exists because the naive fix for migration `0414` (`0414_sec_replay_missing_anon_revokes.sql`) revoked `authenticated` unconditionally and would have broken both live UI paths on prod-apply — the corrected version revokes `anon` everywhere but preserves prod's `authenticated` grant exactly where prod already relies on it, test-pinned as a 2-member exemption. At time of writing #2248 is still draft/unsoaked; check whether it has merged before assuming this exemption set exists on `main`.
- Pre-existing violations are pinned in `scripts/ci/feedback-rules/secdef-grants-baseline.json` as a burn-down list (188 entries at `_generated: 2026-08-11`). **Grandfathered is not safe** — burning one down means checking the live prod ACL with `has_function_privilege('anon', fn, 'EXECUTE')` and either adding the REVOKE or moving the function into `DELIBERATELY_PUBLIC`/`DELIBERATELY_AUTHENTICATED` with a stated reason. The list may only shrink; a stale entry (one that no longer violates) fails the check in its own right so it cannot silently re-authorise a regression.

**Enforcement:** CI lint `scripts/ci/feedback-rules/secdef-function-grants.ts` (R0-7), auto-loaded by the `scripts/ci/check-feedback-rules.ts` orchestrator's `Policy Lints` job on every PR. Because `Policy Lints` is not itself a Mergify merge condition, the merge-time gate is `secdef-function-grants.test.ts`, which runs in `Tests`.

**Override label:** `secdef-grants-skip`.
