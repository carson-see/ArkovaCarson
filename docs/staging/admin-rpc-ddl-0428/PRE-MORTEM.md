# Pre-mortem — 0428 soak and release

Written **before** the soak starts. Method: assume both the soak and the prod release
have already failed, and work backwards to the cause. Each item is either **addressed
before starting** or **explicitly accepted** as residual risk.

## A. Ways the SOAK fails

### A1. The soak runs 48 h and proves nothing about the change — ADDRESSED
The default failure mode for this repo (`feedback_soaks_must_meet_soc2_type2`,
CLAUDE.md §1.12: "generic synthetic load is supporting worker-health evidence only").
0428 changes three admin RPCs that *no* generic load driver ever calls. A green
worker-health soak would be entirely compatible with 0428 being broken.

**Addressed:** the driver is purpose-built and calls the three changed endpoints
(`change-role`, `promote-admin`, `set-org`) every cycle, plus the four behaviours
that can only regress *because of* this change (A2, A3, A4 below). Worker health is
recorded as *supporting* evidence only.

### A2. The regression the review caught is not re-checked on real infrastructure — ADDRESSED
The over-broad exemption was caught by reading code and proven on a throwaway
cluster. If the flag design is subtly wrong under PostgREST (e.g. PostgREST reuses a
pooled session and the `is_local` flag survives), the 16 prod profiles with
`org_id IS NULL AND role IS NOT NULL` start silently mutating.

**Addressed:** every cycle asserts the worker-shaped direct backfill
(`UPDATE profiles SET org_id=…, role=… WHERE id=… AND org_id IS NULL`) still RAISES
for an INDIVIDUAL, and still succeeds + stamps `role_set_at` when `role IS NULL`.
A single violation fails the soak.

### A3. The flag leaks across requests under connection pooling — ADDRESSED
`set_config(..., is_local => true)` is transaction-scoped, but this has only been
proven on a direct psql connection. Supabase sits behind a pooler; if PostgREST ever
ran the RPC outside a transaction the flag could outlive the call.

**Addressed:** every cycle issues the RPC and then, on a *separate* HTTP request that
is likely to reuse the same pooled backend, attempts a direct role change that must
still be rejected. Also asserted immediately after, within the same connection.

### A4. The lock-barrier improvement is never actually observed — ADDRESSED
The 4.95 s → 0.04 s result came from a controlled experiment, not organic load.
Organic rig load will not reproduce it, so a soak that only watches latency would
show nothing either way and prove nothing.

**Addressed:** the driver re-runs the controlled experiment on the rig periodically —
hold a slow write on `profiles`, fire an admin RPC, time an innocent write to an
*unrelated* row, and read `pg_locks`. Expectation on 0428: no `ShareRowExclusiveLock`
ever appears on `profiles`, and the innocent write is not blocked.

### A5. Chicken-and-egg: the admin endpoints need a platform admin — ADDRESSED
`isPlatformAdmin()` requires `profiles.is_platform_admin = true`, and the RPC that
sets that flag is one of the three under test. A fresh rig has no platform admin.

**Addressed:** seed the first platform admin directly in SQL on the rig (this is
rig seeding, not evidence laundering — it is recorded in the evidence), then use the
endpoint to toggle a *second* user for the actual test.

### A6. Worker crash-loops on the rig for unrelated reasons — ADDRESSED
`config.ts` Zod requires Stripe / HMAC / cron / FRONTEND_URL; a fresh env leaves
`switchboard_flags` empty and `get_flag()` fails closed, which darkens `/api/v1`.
Neither is related to 0428 but either burns the window.

**Addressed:** use the known-good env set from the provisioning script and seed
switchboard flags before starting the clock; verify `/health` before t=0.

### A7. Soak clock reset by touching the rig — ACCEPTED, with a rule
The clock is Cloud Run revision uptime (`feedback_soak_clock_is_worker_uptime`). Any
redeploy restarts it. **Rule for this soak: after t=0, no deploy, no env change, no
schema change on this rig.** Driver runs outside the worker.

### A8. Collision with another session's rig — ADDRESSED
`aqikotdkmhxmznonwmwk` is running the DocuSign RC-2 T3 soak (closes 2026-09-02).
Twelve other rigs stand. **Addressed:** provision a NEW dedicated project; touch no
existing rig; never `--linked` against anything but my own ref.

## B. Ways the RELEASE fails

### B1. Prod apply is hook-blocked — PLANNED
`.claude/hooks/check-prod-migration-apply.sh` blocks a prod `apply_migration` unless
`0428` is on `origin/main` OR listed in `ledger-numeric-exemptions.json`. Applying
without either creates an orphan ledger row that reds **every** migration-touching PR
at once (CLAUDE.md §0 rule 10).
**Plan:** merge first, then apply — no pre-merge prod apply for this one. There is no
urgency justifying migrate-before-merge here (unlike 0388, which was a live
disclosure hole).

### B2. Read-back assertion fires spuriously in prod and breaks admin promotion — MITIGATED
If `protect_platform_admin_flag` ever fails to recognise service_role in prod, the new
assertion converts a silent no-op into a hard error — arguably better, but it *is* a
new way for the endpoint to fail.
**Mitigated:** prod was measured to have `postgres` with BYPASSRLS and the trigger
gating on `current_setting('role')`, which PostgREST sets; the soak exercises the real
PostgREST path. Rollback is one `CREATE OR REPLACE` from the file header.

### B3. Worker deploy is paused, so a code expectation silently does not ship — NOT A RISK HERE
`DEPLOY_WORKER_PAUSED=true`. 0428 is DB-only and the worker diff is comments-only, so
nothing needs to deploy. **Do not claim** any worker behaviour changed in prod.

### B4. PostgREST serves stale function bodies after apply — ADDRESSED
Function bodies changed. **Addressed:** the migration ends with
`NOTIFY pgrst, 'reload schema'`; verify post-apply by calling one RPC.

### B5. Jira cannot transition to Done — ACCEPTED
Rule R1 is reporter ≠ resolver. The story was filed under Carson's account, which is
the same identity this session acts as, so the Done transition may be refused. Flag it
rather than work around it.

### B6. Base drift while the 48 h clock runs — ACCEPTED
`main` moves during a T3 window and exact-head evidence is invalidated by any commit to
tested code. 0428 touches files nothing else is likely to touch; if `main` moves under
it, re-verify rather than re-soak, and say so.

## Kill criteria (stop the soak, do not merge)
1. Any cycle where the worker-shaped backfill of an INDIVIDUAL **succeeds**.
2. Any cycle where a direct role change outside the RPC **succeeds**.
3. Any `ShareRowExclusiveLock` observed on `profiles`.
4. Any admin RPC returning success while the DB shows the write did not land.
5. Any trigger on `profiles` observed with `tgenabled <> 'O'`.
