# MFA Break-Glass — Removing a Lost Device's Factor

**Story:** SCRUM-3584. **Tool:** `scripts/ops/mfa-break-glass.ts`. **Test:** `scripts/ops/mfa-break-glass.test.ts`.
**Status:** operational — service-role-only, no in-app self-service path exists (by design; a self-service path would defeat MFA).

---

## 1. When to use this

A user has a verified TOTP factor and has lost the device that produces its codes — lost phone, uninstalled authenticator, no backup codes. The lockout mechanism is a GoTrue platform rule, not app code, so it applies **today**, independent of whether SCRUM-3167's login-enforcement gate has shipped: unenrolling a VERIFIED factor requires an aal2 session (CTO plan Amendment A3), and nothing in the app today gives a user without their original device a way to reach aal2. Settings' self-service `TwoFactorSetup` unenroll therefore fails closed for them with `insufficient_aal` — there is no in-app bypass. The only way back in is an operator removing the factor server-side via `supabase.auth.admin.mfa.deleteFactor()`.

(Once SCRUM-3167's login-time enforcement gate ships — branch `security/mfa-enforcement-3167`, not yet on `main` at the time this runbook was written — a locked-out user whose role/org requires MFA will also be unable to pass a login-time challenge screen at all. Until then, at this head, a locked-out user can still sign in with just their password and reach the app; they just cannot remove their own lost factor. Either way, this tool's job is the same: make the factor go away so the user can start over.)

Do **not** use this to:
- "Clean up" a stale unverified factor for convenience — an UNVERIFIED factor never requires aal2 to remove, so the user (or anyone with access to their session) can already delete it themselves from Settings today, at aal1.
- Disable or bypass any future org/role MFA enforcement policy (SCRUM-3167 — will live in `src/lib/mfaPolicy.ts` and `organizations.hipaa_mfa_required` once that PR merges; neither exists at this head). Not this tool's concern, and not yet a live policy to work around.
- Work around a future grace-period nudge (SCRUM-3167's proposed `MfaGraceNudge` — does not exist at this head). A nudge is not a lockout.

## 2. Prerequisites

- [ ] A Jira ticket describing why: `--ticket SCRUM-NNNN` or the exact `https://arkova.atlassian.net/browse/SCRUM-NNNN` link. The tool refuses to run without one, and rejects any other URL shape.
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

**If `SUPABASE_URL` points at production, this dry run ALSO needs `ALLOW_PROD_BREAK_GLASS=1`.** The prod-host deny applies to every run, not just `--apply` — the tool refuses to even resolve a user or list factors against prod without the flag, so a "harmless" dry run doesn't accidentally become the first thing that touches prod without a second person aware (see §2).

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

**Deleting with `--all` needs a SECOND confirmation**, `CONFIRM_MFA_BREAK_GLASS_ALL`, also set to the resolved email — every factor this person has is a much bigger blast radius than one `--factor-id`, so one copy-pasted `CONFIRM_MFA_BREAK_GLASS` value alone can never trigger it:

```bash
CONFIRM_MFA_BREAK_GLASS="user@example.com" \
CONFIRM_MFA_BREAK_GLASS_ALL="user@example.com" \
  npx tsx scripts/ops/mfa-break-glass.ts \
    --email user@example.com --all \
    --reason "..." --ticket SCRUM-1234 --operator "carson@arkova.io" --apply
```

If the target is production, you additionally need `ALLOW_PROD_BREAK_GLASS=1` for this apply run too (see §2's second-person requirement — do this *after* Carson is aware, not before; and remember §4 above — the dry run you did first also needed it):

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
| `1` | Validation / precondition failure | **Nothing was written.** Bad args, a repeated flag (e.g. `--email` given twice), user not found, `--factor-id` doesn't belong to the resolved user, `CONFIRM_MFA_BREAK_GLASS` (or, for `--all`, `CONFIRM_MFA_BREAK_GLASS_ALL`) missing or mismatched, or a prod host was denied without `ALLOW_PROD_BREAK_GLASS=1` — including on a dry run. |
| `2` | INTENT audit insert failed | Aborted **before** any delete — no factor was touched. Fix the audit-write problem (check `SUPABASE_SERVICE_ROLE_KEY` has insert rights on `audit_events`, check Supabase isn't down) and re-run from the top. |
| `3` | COMPLETION audit insert failed | One or more deletes were **already attempted**, but the completion row failed to insert. The tool prints the exact row to insert manually to stderr — do that immediately (see §7). This is the loudest failure mode: a delete may have succeeded with no audit trail. |
| `4` | Partial delete failure, audit intact | The COMPLETION row **was** recorded, and it records that one or more factor deletions failed. Read the printed `results[]`, investigate the GoTrue error, and re-run for the remaining factor(s) only. |

## 7. If exit code 3 happens: insert the completion row manually

The tool prints the full row it tried and failed to insert, e.g.:

```json
{
  "event_type": "MFA_BREAK_GLASS_COMPLETED",
  "event_category": "SECURITY",
  "actor_id": null,
  "target_type": "mfa_factor",
  "target_id": "<factor-id-or-comma-joined-ids>",
  "org_id": "<org-id-or-null>",
  "details": "{...user_id, factor_ids, statuses, ticket, operator, host, friendly_names, reason, results...}"
}
```

Insert it via the Supabase SQL editor or MCP `execute_sql` (service-role context) with the printed values verbatim. Do not alter `event_type`/`event_category` — they must match the CHECK constraints (`audit_events_event_category_valid` includes `SECURITY` since migration `0309`).

## 8. What the user sees afterward

- **They are logged out everywhere.** GoTrue invalidates every session below aal2 when a verified factor is deleted (CTO plan Amendment A3) — this is not a bug, it's the point, and it is a GoTrue platform rule that applies regardless of whether SCRUM-3167 has shipped. Warn them before you run `--apply` if you can reach them first; if you can't (that's often why break-glass is needed), tell them when you confirm the fix.
- **At this head (before SCRUM-3167's enforcement gate ships):** they simply sign back in with their password and land in the app — nothing forces re-enrollment. If they want MFA protection again, they enroll a new factor themselves from Settings (`TwoFactorSetup`), same as the first time.
- **Once SCRUM-3167 ships** (branch `security/mfa-enforcement-3167`), a locked-out user whose role or org requires MFA (per that PR's `src/lib/mfaPolicy.ts`) may instead be routed through a mandatory re-enrollment screen at login before reaching the app — always a completable path, never a dead end, per that PR's own design. Update this bullet with the actual component name once that PR is on `main`; do not assume it exists before then.

## 9. Audit rows to expect + verification query

Two rows per successful run, both `event_category = 'SECURITY'`:

```sql
SELECT event_type, event_category, target_type, target_id, org_id, details, created_at
FROM audit_events
WHERE event_type IN ('MFA_BREAK_GLASS_REQUESTED', 'MFA_BREAK_GLASS_COMPLETED')
  AND target_id = '<the factor id(s) you passed>'
ORDER BY created_at DESC
LIMIT 5;
```

Confirm:
- Exactly one `MFA_BREAK_GLASS_REQUESTED` row exists with a `created_at` **before** the matching `MFA_BREAK_GLASS_COMPLETED` row.
- `details` on the completed row's `results` array shows `"status":"deleted"` for every factor you intended to remove (or `"status":"failed"` with an `error` string — this is exit code `4`'s signature; see §6).
- `actor_id` is `null` on both (the operator identity lives in `details.operator`, not `actor_id` — this tool runs with service-role, not an authenticated user session).

## 10. Rollback

**There is no rollback.** Deleting an MFA factor is not reversible from this tool's side — the user re-enrolls a new factor themselves (Settings → "Add authenticator" or the mandatory-enrollment screen on next login). If the wrong factor was deleted, that specific credential is gone; the user re-enrolls the same way. Verify the `--factor-id` in the dry-run table carefully — that's the real safety check, not anything the tool can undo after the fact.

## 11. Never do this

- **Never `--all` "to be safe."** Delete only the specific factor the user actually lost. If they have two working authenticators and only lost one, deleting both forces an unnecessary full re-enrollment and an unnecessary extra logout. `--all --apply` requires a second confirmation (`CONFIRM_MFA_BREAK_GLASS_ALL`, §5) precisely because it should be rare and deliberate, not a default.
- **Never skip `--ticket`.** The tool refuses to run without one, and there's no reason to want it to — this is a security-sensitive admin action against a real account. Only `SCRUM-1234` or the exact `https://arkova.atlassian.net/browse/SCRUM-1234` Jira link are accepted — not an arbitrary doc/Slack URL.
- **Never run this against production without a second person aware.** Message Carson before setting `ALLOW_PROD_BREAK_GLASS=1`. The tool's red banner is a reminder, not a permission check — the actual check is you having had that conversation first.
- **Never paste `SUPABASE_SERVICE_ROLE_KEY` (or any output containing it) into a ticket, chat, or commit.** The tool never prints it; keep it that way in your own shell history too (prefer the `$(gcloud secrets versions access ...)` substitution in §3 over saving it to a file).
- **Never treat a dry run's "no user found" as proof the account doesn't exist elsewhere.** It only checked the target project's `auth.users` (via the `SUPABASE_URL` you provided) — confirm you're pointed at the right project (prod vs. a staging rig) before concluding anything.
