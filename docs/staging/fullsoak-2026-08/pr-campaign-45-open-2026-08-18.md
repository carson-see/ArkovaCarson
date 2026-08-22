# 45-open-PR campaign — review pipeline + redundancy sweep (2026-08-18)

**Seven parallel review agents ran code-review / debug / simplify over all 39 non-dependabot
open PRs (plus dependabot overlap analysis), with a TLA precheck on the merged chain pair.
All review work was read-only under the freeze. Full cluster reports are session artifacts;
this document records the verdicts and the actions taken.**

## De-bloat verdicts (closures need Carson confirm; nothing closed yet)

| Action | PRs | Basis |
|---|---|---|
| **Close** #2218 | superseded by #2220 | Same FD-P7 fix twice, conflict on all 5 shared files; #2220 alone fixes the frozen v1 response schema and carries the lifecycle test suite. Six unique #2218 items ported into #2220 first. |
| **Close** #2247 at #2252 landing | contained in #2252 | #2252's first commit IS #2247's head (same SHA, same merge-base) — a provable stack, not a re-implementation. |
| **Close** #2223 #2224 #2231 #2238 | superseded by one consolidated T2 PR from `rc/rate-limit-cluster-2026-08` | Verified byte-identical linear stack whose intermediate states are individually wrong to ship; one 12h soak instead of four. |
| **Keep everything else** | — | #2266/#2267 collision was deliberate coordination (byte-identical shared utility, disjoint halves). #2234/#2243 disjoint. Dependabot pairs are lockfile-only, auto-rebase. #2230 is fully contained in #2236 but is #2236's BASE — land #2230 first, #2236 auto-retargets (closing the base instead would orphan/de-CI the child). |

Net: 45 → 40 open (assuming confirms), with one new consolidated draft replacing four.

## Defects found by the review (all being fixed on the draft branches now)

1. **#2216 — GetBlock token leak (MEDIUM-HIGH, §1.4).** `BodyReadTimeoutError` embeds the
   full RPC URL in `.message`; prod's URL contains the access token → warn logs + Sentry
   breadcrumbs. Test-pinned. Fix: sanitized label at both `rpcCall` sites + leak regression test.
2. **#2248 — 0414 over-revokes `authenticated` (BLOCKING).** Prod deliberately grants
   `authenticated` on `get_user_monthly_anchor_count` (useEntitlements) and
   `get_pipeline_stats` (PipelineAdminPage fallback); 0414 would break both UI paths on
   prod-apply. Fix: revoke `anon` everywhere, preserve prod's authenticated axis exactly
   (verified per-function against prod).
3. **#2254 — floor below estimator resolution.** 100-row floor < ~117 minimum expressible
   ANALYZE estimate at prod scale → ~1% of cycles re-arm the fatal storm. Fix: floor 500 +
   regression test.
4. **#2259 ↔ #2231/rc — semantic collision.** #2259's test pins the literal
   `PROD_SERVICE_NAME` source line that the rate-limit work replaces with a re-export;
   green alone, red together (deploy-blackout class). Fix: pin the exported VALUE, not source text.
5. **`python-sdk-tests` gates nothing.** New CI job absent from `.mergify.yml` — the exact
   fictional-coverage trap. Fix: wired into the queue rules on #2252's branch.
6. **v2 rate-limit store permanent lockout (pre-existing, adjacent).** PEXPIRE armed only on
   `count===1`, never self-heals a TTL-less key. Fix folded into the consolidated rc PR.

## CTO rulings recorded

- **#2233 edge kill-switch: fail-closed stands.** The PR flipped `p_default` to true (fresh
  switchboard would fail-OPEN the MCP surface). Reverted: Arkova's posture is switchboard-dark
  on fresh envs; a kill switch must not self-enable on missing config.
- **#2230/#2236 stack:** land #2230 (≈100 code lines + evidence docs) first; #2236
  auto-retargets on base-branch deletion. No manual retarget (drops CI).

## Cleared by review (worth recording)

- **PM-2 defused, verified in merged code:** #2216+#2250's merged provider distinguishes
  leg-errored from leg-empty (`Promise.allSettled`); the timeout-masks-empty-fallback
  scenario throws loudly and is pinned by a merged test. FD-CHAIN-1's silent halt cannot recur.
- **TLA precheck:** `verify:machines` 4/4 PASS on baseline `92ed61cb6` and on the merged
  #2216+#2250 tree; neither PR touches lifecycle states. Known residual: no machine models
  the run lease; #2216's `maxRunMs` detach relies on txid-journal + drain idempotency
  (unit-tested, not model-checked — the drainRunAccounting gap, unchanged).
- **Merged-tree tests:** chain+jobs sweep on #2216+#2250 union: 2,478 pass / 0 fail.
- **#2219 PM-3 fix confirmed present:** `0410_partner_accounts.sql` opens
  `BEGIN; SET LOCAL lock_timeout='5s'` before both hot-table FKs. (The detector gap that
  would have missed it is exactly what #2253 closes.)
- **#2236 cannot activate Nessie** (env-flag fail-closed, deliberately not switchboard-
  controllable, gate mounted before payment gate).
- **copy.ts four-way is a non-conflict** (four disjoint regions, auto-merges all pairings).
- **§1.3/§1.4 sweep clean** across the frontend cluster; #2215 zero residual non-compliant
  UUIDs; #2268 fixes the flake's cause (mis-specified hang-detector deadline), not its symptom.

## Landing-order constraints for the post-freeze wave plan (supplements the 2026-08-17 plan)

- #2243 → #2234 (ratchet then portability). #2235 → #2253 (second lander hand-unions the
  test file; combined gate already executed over all 114 migrations: 0 new violations).
- #2241 → #2255 → #2256; second of #2241/#2255 renames its test file (incompatible
  `vi.mock` strategies). #2246 ∥ #2232; #2236 last in its cluster.
- Dependabot: #2262→#2228 (hono 2.x is a dev-only transitive, land after #2244 so the
  mcp-server suite gates it); #2263→review→#2264 (**KMS 6.0 major touches the dormant GCP
  signing path + a hand-rolled .d.ts shim — real review required**); #2260→#2261.
- Consolidated rate-limit PR soak must measure p95 latency delta under Upstash blackhole
  (Redis is now on the blocking hot path, 2s timeout, no circuit breaker) — known accepted
  risk to revisit.

## Fix commits landed (2026-08-18, all branches remain DRAFT)

| PR | New head | Fix |
|---|---|---|
| #2216 | `a664ee847` | GetBlock token leak — origin-only labels at both bounded-read sites + leak regression (red-first); 677 tests green |
| #2248 | `c993e81cd` | 0414 rewritten no-op-on-prod on both axes (per-function prod sweep); ratchet gains test-pinned 2-member authenticated exemption; body corrected |
| #2254 | `e79737530` | Floor 100→500 with derived-quantum tests (est ≈118 stays warn; 259k still fatal) |
| #2259 | `665e01e27` | Value-resolver test survives literal AND re-export shapes (proven against #2231's real files); order-independence restored |
| #2252 | `4b5a10662` | `Python SDK Tests (packages/arkova-py)` wired into all 3 Mergify queue rules + contract test forbidding a job-level `if:` while gated |
| #2233 | `61d736cd6` | Kill-switch fail-open REVERTED — file byte-identical to main; fail-closed pinned at request-body level; tier note corrected (T2 via worker path) |
| #2220 | `e7cf72c74` | 6 #2218 items ported + both CI defects fixed (staging pins recomputed, append-only heading restored) + `.is('revoked_at', null)` race guard with negative-control test; 90/90 + 218/218 |
| #2221 | `5ec400023` | Manifest `head_sha` rebound to `e7cf72c74` in the same motion; body prose corrected |
| **#2269 (new)** | `2ad3048cf` | Consolidated rate-limit draft (supersedes #2223/#2224/#2231/#2238) + v2 TTL self-heal + fail-open §1.10 headers; 171/171 |

C-cluster review evidence was captured at #2216 head `90ff77071`; the token-leak commit
supersedes exact-head claims — future soak cites `a664ee847`.

## NOT asserted

No PR here has been soaked; verdicts are from diff/merge-tree/local-test analysis. Tier
declarations still resolve through the §1.12 path detector, which wins on disagreement.
Closures and the #2252 SDK-path §1.12 exception are Carson's calls.
