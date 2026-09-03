# MFA Break-Glass — Removing a Lost Device's Factor

**Story:** SCRUM-3584. **Tool:** `scripts/ops/mfa-break-glass.ts`. **Test:** `scripts/ops/mfa-break-glass.test.ts`.
**Status:** operational — service-role-only, no in-app self-service path exists (by design; a self-service path would defeat MFA).

---

## 1. When to use this

A user is locked out of their account because they can no longer produce a TOTP code — lost phone, uninstalled authenticator, no backup codes — and `AuthGuard`'s `MfaChallenge` screen has no bypass. This is the intended failure mode: the only way back in is an operator removing the factor server-side via `supabase.auth.admin.mfa.deleteFactor()`.

Do **not** use this to:
- "Clean up" a stale unverified factor for convenience — unverified factors never block anyone (`hasVerifiedFactor` stays false), and users can already remove their own unverified factors from Settings at aal1.
- Disable MFA policy for an org or role. That's `src/lib/mfaPolicy.ts` / `organizations.hipaa_mfa_required`, not this tool.
- Work around the grace-period nudge (`MfaGraceNudge`). That's not a lockout.

## 2. Prerequisites

- [ ] A Jira ticket (`SCRUM-NNNN`) or a URL describing why. The tool refuses to run without one (`--ticket`).
- [ ] Your own identity for the audit trail (`--operator "name/email"`).
- [ ] **A concrete reason** (`--reason "..."`) — not "user asked," the actual circumstance (lost phone, device wiped, etc).
- [ ] **A second person aware before running against production.** Message Carson (or whoever is on call) before you set `ALLOW_PROD_BREAK_GLASS=1`. This is a break-glass tool against a live user's account — nobody runs it against prod solo.
- [ ] `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the target project (staging rig or prod), fetched per §3 below — **never pasted into chat, a ticket, or committed anywhere.**
- [ ] Node + `npx tsx` available (already a repo dependency — no separate install).

## 3. Fetching credentials from Secret Manager (without printing them)

Project `arkova1`. The secrets are named `supabase-url` and `supabase-service-role-key`. Load them straight into your shell's environment — never `echo` them, never write them to a file, never paste the value anywhere:

```bash
export SUPABASE_URL="$(gcloud secrets versions access latest --secret=supabase-url --project=arkova1)"
export SUPABASE_SERVICE_ROLE_KEY="$(gcloud secrets versions access latest --secret=supabase-service-role-key --project=arkova1)"
```

Verify they loaded without printing the value:

```bash
[ -n "$SUPABASE_URL" ] && echo "SUPABASE_URL set (host: $(node -e "console.log(new URL(process.env.SUPABASE_URL).host)"))"
[ -n "$SUPABASE_SERVICE_ROLE_KEY" ] && echo "SUPABASE_SERVICE_ROLE_KEY set (length: ${#SUPABASE_SERVICE_ROLE_KEY})"
```

For a staging rig instead of prod, use that rig's own `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (see `docs/reference/STAGING_RIG.md` or the isolated-rig admission JSON) — do not fetch the prod secrets when you only need staging.

## 4. Running it — dry run first, always

Dry run is the default. It resolves the user, lists **every** MFA factor they have, validates your `--factor-id`/`--all` selection against that list, and prints the plan. It writes nothing — no audit row, no delete.

```bash
npx tsx scripts/ops/mfa-break-glass.ts \
  --email user@example.com \
  --factor-id <factor-id-from-the-printed-table> \
  --reason "lost phone, no backup codes, ticket confirmed via support email" \
  --ticket SCRUM-1234 \
  --operator "carson@arkova.io"
```

Read the printed factor table. Confirm the `id` you're about to delete is the right one — if the user has more than one factor, deleting the wrong one accomplishes nothing.

## 5. Applying it — actually deletes

Same command, plus `--apply` and `CONFIRM_MFA_BREAK_GLASS` set to the **exact email the dry run resolved** (case-insensitive, but must otherwise match):

```bash
CONFIRM_MFA_BREAK_GLASS="user@example.com" \
  npx tsx scripts/ops/mfa-break-glass.ts \
    --email user@example.com \
    --factor-id <factor-id> \
    --reason "lost phone, no backup codes, ticket confirmed via support email" \
    --ticket SCRUM-1234 \
    --operator "carson@arkova.io" \
    --apply
```

If the target is production, you additionally need `ALLOW_PROD_BREAK_GLASS=1` (see §2's second-person requirement — do this *after* Carson is aware, not before):

```bash
ALLOW_PROD_BREAK_GLASS=1 CONFIRM_MFA_BREAK_GLASS="user@example.com" \
  npx tsx scripts/ops/mfa-break-glass.ts --email user@example.com --factor-id <factor-id> \
    --reason "..." --ticket SCRUM-1234 --operator "carson@arkova.io" --apply
```

The tool prints a red banner to stderr when this fires — that banner appearing is your own confirmation you're touching prod, not a staging rig.

## 6. Exit codes

| Code | Meaning | What happened |
|---|---|---|
| `0` | Success | Dry run completed, or apply completed with every selected factor deleted and both audit rows recorded. |
| `1` | Validation / precondition failure | **Nothing was written.** Bad args, user not found, `--factor-id` doesn't belong to the resolved user, `CONFIRM_MFA_BREAK_GLASS` missing or mismatched, or a prod host was denied without `ALLOW_PROD_BREAK_GLASS=1`. |
| `2` | INTENT audit insert failed | Aborted **before** any delete — no factor was touched. Fix the audit-write problem (check `SUPABASE_SERVICE_ROLE_KEY` has insert rights on `audit_events`, check Supabase isn't down) and re-run from the top. |
| `3` | COMPLETION audit insert failed | One or more deletes were **already attempted**, but the completion row failed to insert. The tool prints the exact row to insert manually to stderr — do that immediately (see §7). This is the loudest failure mode: a delete may have succeeded with no audit trail. |
| `4` | Partial delete failure, audit intact | The COMPLETION row **was** recorded, and it records that one or more factor deletions failed. Read the printed `results[]`, investigate the GoTrue error, and re-run for the remaining factor(s) only. |

## 7. If exit code 3 happens: insert the completion row manually

The tool prints the full row it tried and failed to insert, e.g.:

```json
{
  "event_type": "mfa_break_glass_completed",
  "event_category": "SECURITY",
  "actor_id": null,
  "target_type": "mfa_factor",
  "target_id": "<factor-id-or-comma-joined-ids>",
  "org_id": "<org-id-or-null>",
  "details": "{...operator, reason, ticket, user_id, factor_ids, results...}"
}
```

Insert it via the Supabase SQL editor or MCP `execute_sql` (service-role context) with the printed values verbatim. Do not alter `event_type`/`event_category` — they must match the CHECK constraints (`audit_events_event_category_valid` includes `SECURITY` since migration `0309`).

## 8. What the user sees afterward

- **They are logged out everywhere.** GoTrue invalidates every session below aal2 when a verified factor is deleted (CTO plan Amendment A3) — this is not a bug, it's the point. Warn them before you run `--apply` if you can reach them first; if you can't (that's often why break-glass is needed), tell them when you confirm the fix.
- **They must re-enroll.** Signing back in with just their password lands them on `MfaChallenge` (if another verified factor remains) or `MfaEnrollmentRequired` (if that was their only factor and their role/org still requires MFA per `src/lib/mfaPolicy.ts`). Either way it's a completable path — there is no dead end.
- If their role requires MFA (`ORG_ADMIN` / platform admin, or an org with `hipaa_mfa_required`), they will be forced through enrollment again before reaching the app. This is expected, not a regression.

## 9. Audit rows to expect + verification query

Two rows per successful run, both `event_category = 'SECURITY'`:

```sql
SELECT event_type, event_category, target_type, target_id, org_id, details, created_at
FROM audit_events
WHERE event_type IN ('mfa_break_glass_requested', 'mfa_break_glass_completed')
  AND target_id = '<the factor id(s) you passed>'
ORDER BY created_at DESC
LIMIT 5;
```

Confirm:
- Exactly one `mfa_break_glass_requested` row exists with a `created_at` **before** the matching `mfa_break_glass_completed` row.
- `details` on the completed row's `results` array shows `"status":"deleted"` for every factor you intended to remove (or `"status":"failed"` with an `error` string — this is exit code `4`'s signature; see §6).
- `actor_id` is `null` on both (the operator identity lives in `details.operator`, not `actor_id` — this tool runs with service-role, not an authenticated user session).

## 10. Rollback

**There is no rollback.** Deleting an MFA factor is not reversible from this tool's side — the user re-enrolls a new factor themselves (Settings → "Add authenticator" or the mandatory-enrollment screen on next login). If the wrong factor was deleted, that specific credential is gone; the user re-enrolls the same way. Verify the `--factor-id` in the dry-run table carefully — that's the real safety check, not anything the tool can undo after the fact.

## 11. Never do this

- **Never `--all` "to be safe."** Delete only the specific factor the user actually lost. If they have two working authenticators and only lost one, deleting both forces an unnecessary full re-enrollment and an unnecessary extra logout.
- **Never skip `--ticket`.** The tool refuses to run without one, and there's no reason to want it to — this is a security-sensitive admin action against a real account.
- **Never run this against production without a second person aware.** Message Carson before setting `ALLOW_PROD_BREAK_GLASS=1`. The tool's red banner is a reminder, not a permission check — the actual check is you having had that conversation first.
- **Never paste `SUPABASE_SERVICE_ROLE_KEY` (or any output containing it) into a ticket, chat, or commit.** The tool never prints it; keep it that way in your own shell history too (prefer the `$(gcloud secrets versions access ...)` substitution in §3 over saving it to a file).
- **Never treat a dry run's "no user found" as proof the account doesn't exist elsewhere.** It only checked the target project's `auth.users` (via the `SUPABASE_URL` you provided) — confirm you're pointed at the right project (prod vs. a staging rig) before concluding anything.
