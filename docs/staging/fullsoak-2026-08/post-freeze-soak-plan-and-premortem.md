# Post-freeze soak of the 30 open PRs — plan and pre-mortem

**Written 2026-08-17 while the fullsoak window is still open (closes 2026-08-19T15:51:30Z).
Nothing here may be executed before the clock closes — every one of these PRs is a draft
and the freeze is what makes the current window's evidence exact-head valid.**

Inputs: the xhigh code review of 20 code-bearing PRs (14,789 code lines; #2217 and #2230
are overwhelmingly evidence docs and are excluded from code scope), plus the file-overlap
map below.

---

## 1. The constraint nobody has stated yet: these PRs are not independent

Eight source files are touched by more than one open PR. **This, not tier, is what
determines soak structure** — a "soak everything together" wave produces a merged tree that
no individual PR's tests ever exercised.

| Shared file | PRs | Why it matters |
|---|---|---|
| `services/worker/src/index.ts` | **#2219 #2224 #2232 #2238** | worker bootstrap; mount ORDER is load-bearing (#2224 exists because of a double-mount) |
| `services/worker/src/utils/upstashRateLimit.ts` | #2223 #2231 | both rewrite key derivation |
| `services/worker/src/utils/rateLimit.ts` | #2223 #2224 | both change counting |
| `services/worker/src/api/v1/keys.ts` + `middleware/apiKeyAuth.ts` + `keys-sanitizer.test.ts` + `src/hooks/useApiKeys.ts` | #2218 #2220 | API-key auth/revocation surface, 4 files deep |
| `services/worker/src/chain/utxo-provider.ts` | #2216 #2250 | both T3 chain; auto-merges cleanly and that is the danger |
| `services/worker/src/routes/cron.ts` | #2233 #2235 | error contract vs cleanup behaviour |
| `services/worker/src/utils/verifyCache.ts` | #2238 #2246 | key shape vs cached proof content |
| `src/lib/copy.ts` | #2235 #2236 #2246 | §1.3-enforced shared file, three-way |
| `services/edge/src/mcp-tools.ts` | #2232 #2236 | edge tool surface |

## 2. Wave structure

Waves are **serialised by shared file**, parallel across disjoint clusters. Within a wave,
PRs merge in the stated order and the next one rebases before its own soak.

**Wave 0 — unblock, no shared files, T0/T1.** `#2243` `#2244` `#2247` `#2252` `#2215`
`#2221`. Tooling, SDK-drift, seed fixtures, CI gating. No worker runtime surface. These can
merge on CI alone and should, to shrink the queue before anything risky moves.

**Wave 1 — rate limiting, STRICTLY SERIAL.** `#2223` → `#2224` → `#2231` → `#2238`.
All four touch the limiter and/or `index.ts`. #2223 fixes the prod P0 (5/min auth limiter
behaving as ~50/min at maxScale=10); #2224 fixes double-counting; #2231 namespaces the
keyspace; #2238 namespaces verify-cache and idempotency. **Do not parallelise.** Each needs
its own T2 soak on a rebased head, because the failure mode of a bad merge here is silent —
a limiter that counts wrong looks healthy.

**Wave 2 — API keys, SERIAL.** `#2218` → `#2220`. Four shared files on the auth path.
§1.4 (raw keys never persisted/returned) is the invariant to re-verify after the rebase, not
just after each PR.

**Wave 3 — chain, SERIAL, T3.** `#2216` → `#2250`. See pre-mortem PM-2: these auto-merge
cleanly and interact anyway.

**Wave 4 — data/cron/migrations, T3.** `#2235` (3 migrations) → `#2233` (shares `cron.ts`).
`#2219` is **blocked** pending the lock_timeout fix (finding 1).

**Wave 5 — claims/proof/UI.** `#2236` → `#2246` → `#2232`, sharing `copy.ts` and
`mcp-tools.ts`. `#2211` `#2241` `#2245` `#2249` are independent and can run parallel to this.

**#2228** (dependabot, non-draft, `do-not-merge`) — decide explicitly: it is the only
non-draft PR and the only thing Mergify can act on the moment the freeze lifts.

## 3. Pre-mortem — it is 2026-09-01 and the post-freeze soak failed. Why?

**PM-1 — We soaked the union and shipped a tree nobody tested.**
Most likely failure. Thirty PRs, eight shared files, one "soak everything" wave. Every PR is
individually green; the merged tree has a middleware order, a limiter key derivation and a
cache key shape that no test run ever saw. *Control:* the serial waves above. A wave is not
done when its PRs are green — it is done when the **rebased head** is green.

**PM-2 — The chain PRs auto-merge cleanly and reintroduce FD-CHAIN-1 through a side door.**
#2216 and #2250 do not overlap textually, so git merges them silently. But #2250's fix works
only because the mempool fallback returns UTXOs, and #2216 wraps that fallback's body reads
in a new timeout that converts a slow body into an error. A fallback that times out is an
empty fallback, which is the exact FD-CHAIN-1 symptom — anchoring halted behind HTTP 200s.
*Control:* soak #2216 and #2250 on the same rig **in series**, and assert the A18
treasury-visibility check stays green across a full flush after both land.

**PM-3 — #2219's FK locks `organizations` in prod and reproduces the 2026-08-11 outage.**
`0410_partner_accounts.sql` has two `REFERENCES public.organizations(id)` and zero
`lock_timeout`. The CI gate cannot catch it (no `REFERENCES` pattern). Applied while a long
reader holds a conflicting lock, the FK queues, and FIFO lock ordering puts it in front of
PostgREST's schema-cache introspection. That is 11m39s of `service_unavailable` on
`/api/v1/verify`, again. *Control:* fix the migration **and** the gate before #2219 soaks.

**PM-4 — The quota fix makes anchor-create slower and more fragile than the bug it fixed.**
#2251 adds a SELECT before every atomic increment: two round-trips per accepted request on
the hottest write path, plus three new 503 branches on a table with one row of production
read history. Under a 10,000-anchor batch the added latency and the new failure surface cost
more than FD-RL-2 ever did. *Control:* move the evaluation into `increment_org_usage` as a
conditional reserve, so the success path stays one round-trip.

**PM-5 — We soak against a rig whose orgs are ENTERPRISE and prod's are not.**
Both rig orgs were bumped FREE → ENTERPRISE on 2026-08-17 to remove the 100/day cap. That is
correct for volume testing and **wrong as a default assumption**: the FREE-tier quota path —
the one a real first customer hits — is now unexercised on this rig. *Control:* keep one org
FREE. Test both tiers, or state plainly that FREE-tier quota behaviour is NOT asserted.

**PM-6 — Mergify churn eats the queue.**
`copy.ts` (3 PRs), `index.ts` (4 PRs), `agents.md` (many). Each merge invalidates the
embarked train's pinned base, CI restarts from zero, and the board never drains — the
documented livelock. *Control:* land the shared-file PRs in the stated order, one at a time,
and do not push to a queued PR.

**PM-7 — The soak proves availability again instead of behaviour.**
This window's own lesson: days 0–3 ran 12 anchors total and every health signal was green.
A post-freeze soak that watches `/health` and cron exit codes will repeat it. *Control:*
every wave declares which **changed behaviour** its evidence exercises, per §1.12's rule
that generic synthetic load is supporting evidence only.

**PM-8 — Evidence is collected against a head that has already moved.**
Exact-head binding is the recurring failure. *Control:* capture the PR head SHA at soak
start and re-verify it at soak end; any commit in between invalidates the window.

## 4. What is NOT asserted here

This plan is derived from diff and file-overlap analysis, not from running any of these PRs.
No PR in it has been soaked. The wave ordering is a hypothesis about interaction risk backed
by the shared-file map; it is not a claim that each wave is independently safe. Tier
assignments follow §1.12's path detector, which fails closed to the highest tier — where this
document and the detector disagree, **the detector wins**.
