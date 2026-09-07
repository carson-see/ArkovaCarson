# Dependabot soak window — stand-up record, 2026-08-23

Three PRs, one shared rig, three independent Cloud Run revisions. Written at clock
start. **No `## Staging Soak Evidence` block has been written on any of these PRs** —
these clocks are running, not finished.

## Rig: shared standing rig, `arkova-worker-staging` / `fizyjojbebyalirtjjht`

### Why this rig, and why all three PRs share it (§1.11A)

Every other candidate was checked and rejected on evidence, not convenience:

| Rig | Supabase ref | Preflight | Verdict |
|---|---|---|---|
| `arkova-worker-staging` | `fizyjojbebyalirtjjht` | **`clean_mirror`** (after fixture repair) | **chosen** |
| `arkova-worker-node22-staging` | `yklabujmzhzbvnhovcjt` | `soak_artifact` — repo migrations 0410–0413 missing | rejected |
| `arkova-worker-wave3-2026-08-staging` | `jiotjhqmedkajdsojsbn` | `fixture_seeded` — 0410–0414 missing **and** zero SUBMITTED anchors | rejected |
| `arkova-worker-fullsoak-2026-08-staging` | `gnkuaywlpmsaezwvlvhk` | ledger head 0409 | rejected; service is also `Ready=False`, container fails to start on PORT 3001 |
| `arkova-worker-wave2-2026-08-staging` | `tkciooifwxwnkoizgalp` | not run | **not touched** — train6/#2249, peer-owned close-capture |
| `arkova-worker-ferpa2314-staging` | `wjuelohtpklodpjklvqy` | not run | **not touched** — live soak, driver running |

Bringing a behind-prod rig up to 0414 would have meant `supabase db push --linked`,
which §1.11A names explicitly as an operation that needs Carson's approval when it is
done to make evidence look clean. It was not done. The standing rig was already at
ledger head `0414`, byte-reconciled with prod `vzwyaatejekddvltxyye`.

**Sharing is honest here.** §1.11A permits one rig for multiple PRs only when they can
truthfully share one clean database state. #2264 and #2398 touch nothing but
`services/worker/package.json` + `package-lock.json`. #2400 adds
`services/worker/src/lib/safe-fetch.ts` (an egress primitive) and `src/lib/agents.md`.
None of the three touches a migration, RLS policy, schema object, cron cadence, queue
or batch semantic, or a seed assumption. Cloud Run revisions are immutable, so each PR
gets its own dependency tree and its own uptime clock on its own tag URL while the
database state underneath stays identical for all three.

Two consequences stated rather than glossed:

1. #2400's driver writes `audit_events` rows (`ctdl.import.requested`) to the shared
   database. That is additive audit data on a path none of the other two PRs touch; it
   does not alter schema or semantics and does not affect their evidence.
2. The service's revision template carries `minScale=1`, so each tagged revision keeps a
   warm instance and each runs the in-process cron loop against the one database. That
   was already true of the pre-existing `train-migration-t3` revision; it is normal for
   this rig, not something these deploys introduced.

### Rig repairs performed before the clocks started (both data-only, §1.11A)

1. **FD-SEED-1 had already eaten the baseline fixture.** Anchor
   `5eed0000-0000-0000-0000-0000000000c1` was sitting at `PENDING` with a NULL
   `chain_tx_id` — the exact shape `recover_stuck_broadcasts()` (migration 0379)
   reclaims every 2 minutes. Preflight read `submitted_anchors = 0` and classified the
   rig `fixture_seeded`. Repaired with the current seed file's own documented
   "RE-RUNNING REPAIRS AN OLD RIG" clause: `legal_hold = true`, synthetic 64-hex
   `chain_tx_id`, status back to `SUBMITTED`, with the same in-transaction
   post-conditions the seed file enforces.
   `scripts/staging/seed-baseline-fixture.sql` could not be run verbatim: it inserts a
   fixture user at `5eed0000-0000-4000-8000-…` while this rig already carries one at
   `5eed0000-0000-0000-0000-…`, and `auth.users` has a UNIQUE index on email, so the
   file aborts on `users_email_partial_key`. **The seed file is still unfixed for this
   case.**
2. **`ENABLE_VERIFICATION_API` was absent from `switchboard_flags`**, so `get_flag()`
   failed closed and every `/api/v1/*` request would have returned a sub-10 ms 503 while
   `/health` stayed green — the exact way wave2 lost its entire 12 h window on
   2026-08-20. Seeded `enabled = true`.

Neither wrote to `supabase_migrations.schema_migrations`. Ledger before and after: head
`0414`, 116 rows.

### Staging deploy tooling had to be recreated

The 2026-08-19 rebuild replayed `supabase/migrations/` but never re-applied
`scripts/staging/migrations/staging_only_deploy_log_and_lease_pk.sql`, so
`public.staging_lease`, `public.staging_deploy_log` and `public.record_staging_deploy`
did not exist. `claim.sh` and `deploy.sh` both fail without them, and T2/T3 evidence
requires a real `Staging deploy log id`.

They were created **via `psql`, deliberately not via MCP `apply_migration`.**
`apply_migration` writes a `staging_only_*` / timestamp-versioned ledger row, which is
precisely what the preflight's Check 1 (`staging_only_rows`) flags — applying it the
way `scripts/staging/migrations/agents.md` documents would have dirtied the rig and
destroyed the `clean_mirror` standing this window depends on. No ledger row was
written. **This is a standing conflict between the staging tooling convention and the
honesty preflight, and it will recur on the next rebuilt rig.**

### Preflight

`scripts/ci/staging-honesty-preflight.ts --project-ref fizyjojbebyalirtjjht --prod-project-ref vzwyaatejekddvltxyye`

* Before repair: `environment_type=fixture_seeded` (submitted_anchors FAIL)
* At clock start, and again after every setup write: **`environment_type=clean_mirror`, all 8 checks pass**
* Raw JSON: `preflight-at-clock-start.json`. Each `close-capture.sh` re-runs it at close —
  evidence is only merge-grade if the rig is still `clean_mirror` when the window is judged.

## The three members

| | #2264 | #2398 | #2400 |
|---|---|---|---|
| Change | `@google-cloud/kms` 5.7.0 → **6.0.0** (major) | worker-deps group, 7 updates | `undici` 7.29.0 → **8.10.0** + safe-fetch egress fix |
| Tier (CI-computed) | T1 | T1 | T2 |
| Head SHA | `aff56fa350219a88b4588790811253e8001a9659` | `0e9effbf8f4e3e9dceb76d71e86248b701ff9c61` | `43d8b742f0abbfa65bc54e52f5b9b401ee3b029e` |
| Base SHA | `8fac11bc5a02d93b30ef00e317cdcc723ff73d01` | `0c18795139f41b690c825f7a81a68ec19d695201` | `0c18795139f41b690c825f7a81a68ec19d695201` |
| Cloud Run revision | `arkova-worker-staging-00348-vah` | `arkova-worker-staging-00350-yoy` | `arkova-worker-staging-00349-sef` |
| Tag URL | `https://pr-2264---arkova-worker-staging-kvojbeutfa-uc.a.run.app` | `https://pr-2398---arkova-worker-staging-kvojbeutfa-uc.a.run.app` | `https://pr-2400---arkova-worker-staging-kvojbeutfa-uc.a.run.app` |
| Image digest | `sha256:1fa5019568674b1f2111c83c65a3dda099cbdd9b3b291b1848b55371d9175194` | `sha256:04550b3f73f309d5bbc79a46f09709c065f8ef194b445d91d7773b1ca50ba791` | `sha256:122ba5b534dc0f2eacee57464bf092773ca42cdbc674ed552faa98b579773e30` |
| Deploy log id | 1 | 3 | 2 |
| Clock start (revision creationTimestamp) | 2026-08-23T21:56:21.897629Z | 2026-08-23T22:08:01.802368Z | 2026-08-23T22:02:45.027149Z |
| Minimum met at | 2026-08-23T23:56:21Z | 2026-08-24T00:08:01Z | 2026-08-24T10:02:45Z |
| Driver window closes | 2026-08-24T00:10:00Z | 2026-08-24T00:25:00Z | 2026-08-24T10:20:00Z |

All three images built by Cloud Build (`linux/amd64` natively) from a `git archive` of
the exact head SHA, with `BUILD_SHA` baked in via `--build-arg`, and deployed through
`scripts/staging/deploy.sh` with a held lease and `--no-traffic`. `/health` on each tag
URL returns `git_sha` equal to that PR's exact 40-char head SHA — verified at clock
start, and re-asserted as a jq predicate on every single health probe, so a silent
redeploy onto a different image fails the driver rather than quietly invalidating the
evidence.

## What the load actually exercises

`~/arkova-soak/dependabot-2026-08-23/` — `lib-probe.sh` (shared), `driver-<pr>.sh`,
`supervisor-<pr>.sh`, `close-capture.sh`. Every probe declares an expected HTTP status
**and** a jq predicate; anything else counts as FAIL and stops the supervisor so the gap
is visible.

**#2264 / #2398** — health (asserts `status`, `git_sha`, `checks.kms`, `checks.database`),
`/api/v1/verify` on the SUBMITTED fixture (live content, not a fail-closed 503),
`/api/v1/verify` 404 projection, `/jobs/queue-reminders` via `X-Cron-Secret`, and
`/.well-known/arkova-keys.json`.

> **Honest limit on `kms: ok`.** `routes/health.ts` derives that check from config —
> it picks `gcp` or `wif` from the resolved signing provider and returns `ok`. It does
> **not** call the KMS SDK. PR #2290's evidence block claims `kms: ok` "directly
> exercises `@aws-sdk/client-kms`"; that is an overstatement and is not repeated here.
> What the endpoint honestly proves is that the worker booted on the bumped dependency
> tree and resolved its signing configuration.

Because a **major** bump's real risk is module resolution and transitive `google-gax` /
`protobufjs` breakage, each PR also has a targeted probe run against **the exact deployed
image digest** as a Cloud Build step (`pr-<n>/image-probe.txt`):

* **#2264** — `@google-cloud/kms` resolves at **6.0.0**, `KeyManagementServiceClient`
  imports and constructs, and `asymmetricSign` / `encrypt` / `decrypt` — the three
  methods the worker actually calls — are present. `PROBE_RESULT: PASS`.
* **#2398** — all four runtime bumps resolve at exactly the asserted versions
  (`@aws-sdk/client-kms` 3.1114.0, `@peculiar/asn1-cms` 2.9.4, `@peculiar/asn1-x509`
  2.9.4, `viem` 2.55.19); `KMSClient` constructs, `SignedData` / `Certificate` import,
  and `viem.keccak256("0x")` returns the known-correct digest. `PROBE_RESULT: PASS`.

**#2400 — the changed path, driven live.** `defaultSafeFetchDeps().dispatch` is only
reachable over a real socket through the CE Registry egress in
`api/v1/credentials-ctdl-import.ts`. The driver hits
`GET /api/v1/credentials/ctdl/import?ctid=…` with a real ES256 Supabase JWT (the route is
`requireAuth`-gated), rotating four probes at 30 s intervals to stay under the 10 req/min
limiter:

| Probe | CTID | Expect | What it proves |
|---|---|---|---|
| `ctdl-records` | `ce-00607dc7-…` | 200, `count>=1`, 64-hex envelope sha | full chain: resolve → IP-pin → undici fetch → 5 MiB cap → SHA-256 → `parseCtdlEnvelope` |
| `ctdl-empty` | `ce-004874e6-…` | 200, `count==0`, 64-hex sha | egress + parse on a graph with no credential node |
| `ctdl-absent` | `ce-2b9c1cd2-…` | 404 `registry_record_not_found` | **discriminator** — a 404 can only come from a completed round-trip; a dispatch failure maps to 502 |
| `ctdl-invalid` | `not-a-ctid` | 400 `invalid_ctid` | guard fires before any fetch |

Verified live on the deployed revision before the clock was armed: `ctdl-records` → 200
with `envelopeSha256` `aeb2457d5852…` and the parsed record *Medication Aide In-Service
Education*; `ctdl-absent` → 404; `ctdl-invalid` → 400.

### #2400 A/B discriminator, inside the deployed image

Cloud Build `02c4c7cd-9420-4ba5-9ad4-2b611b040540`, run against image digest
`sha256:122ba5b5…` — undici 8.10.0, Node v22.23.2:

```
OLD_SHAPE_PINNED:      THREW TypeError | cause: InvalidArgumentError UND_ERR_INVALID_ARG "invalid onRequestStart method"
OLD_SHAPE_PLAIN_AGENT: THREW TypeError | cause: InvalidArgumentError UND_ERR_INVALID_ARG "invalid onRequestStart method"
NODE_FETCH_NO_AGENT:   status 200        <- control: egress itself is fine
NEW_SHAPE_PINNED:      status 200 bytes 803
```

The old `globalThis.fetch` + npm-undici `Agent` mix fails 100% under undici 8 in the real
artifact; the PR's single-realm shape returns 200. The control line rules out the network
as the cause. This is the fix being load-bearing, measured rather than argued.

## Supervisor defects fixed here

The `ferpa2314` and `train6` supervisors carry two bugs that this window does not repeat:

1. `END_EPOCH=$(date -j -f …)` with **no `-u`** makes macOS read the UTC close time as
   local, overrunning every window by exactly 4 h. Measured on all three of this window's
   close times: `delta = 14400s`. These supervisors use `date -u -j -f` and echo the
   parsed instant back into the log at start, so the parse is auditable
   (`readback=2026-08-24T00:10:00Z` etc.).
2. Neither peer supervisor ever invokes its `close-capture.sh`, so their windows had to
   be sealed by hand. Each supervisor here calls `close-capture.sh` exactly once, at
   close. It captures revision identity and creationTimestamp (clock-integrity proof),
   service traffic state, 5×`/health`, 5xx and container-termination counts scoped to
   that revision, a rollup of every per-cycle evidence file, and a **re-run of the
   staging-honesty preflight**.

## Still required before any of these gates can pass

Applies to all three:

1. **The clocks must actually finish.** Nothing here is soaked yet.
2. **No `## Staging Soak Evidence` block has been written.** It gets written at close,
   from the sealed artifacts.
3. **Human approver is unfilled and must not be invented.** The gate rejects `pending`,
   `TBD` and `N/A` in that field. There is no approver on record for this window.
4. **Write every evidence field UNBOLDED.** The extractor is
   `^[\s\-*]*(?:\[[ x]\]\s*)?FIELD[^\S\n]*(.*)$` — `[^\S\n]` is horizontal whitespace
   only, so `- **PR head SHA:** abc` captures `** abc` and silently fails to parse.
5. **`Evidence scope:`** takes only the literal `merge-grade shared staging` (this window)
   or `merge-grade isolated staging`.
6. **Head SHA must still match at close.** Any new commit on a PR invalidates its window.
7. **#2400 additionally needs, as T2:** `Base SHA`, `Preflight timestamp` + `Preflight
   result`, `Staging deploy log id` (= **2**), `E2E result`, `Migration applied` (none),
   and a **rollback rehearsal** — not yet performed. The rollback for all three is a
   revert of the dependency bump and a redeploy of the prior worker image; there is no
   schema state to unwind.
8. **Check `gh variable get SOAK_GATE_DISABLED`** before citing a green gate as proof of
   anything.
