# Soak stand-up — batch `mig-docusign-trust` (T3)

Internal engineering notes (CLAUDE.md §0 rule 4 — Confluence is the documentation
source of truth; this file is the operational record of one soak).

## What is under soak

| PR | Migration | Head SHA |
|---|---|---|
| [#2472](https://github.com/carson-see/ArkovaCarson/pull/2472) | `0423_sec_docusign_metadata_key_write_authority.sql` | `b89fdd6acd0a956b3511cefdab52b9e914fb6e81` |
| [#2476](https://github.com/carson-see/ArkovaCarson/pull/2476) | `0424_docusign_webhook_nonces_tenant_scope.sql` | `a7695f3057d2a210eb3417aa27797b4b0180c5e2` |

Stacked on ONE rig per CLAUDE.md §1.12: 0423 installs the write-authority trigger over
the DocuSign provenance key family in `anchors.metadata`; 0424 tenant-scopes the DocuSign
webhook nonce and lights up the inbound path that is the principal writer 0423 guards.
Separate rigs would each have proven half a trust boundary.

## Rig

| Field | Value |
|---|---|
| Soak head | `d22f0e0fbe43aaed7c269f9f37d882028aebc34c` (integration branch `soak/mig-docusign-trust-b2`) |
| Base SHA | `dca9edb401a98f05fee7447dfe068773c6705fbb` |
| Supabase project | `arkova-soak-mig-docusign-trust` / ref `yfqgxycaiwgvvvbzhkma` (us-east-2, PG 17.6.1.166) |
| Cloud Run service | `arkova-worker-mig-docusign-trust-staging` (us-central1, `--no-allow-unauthenticated`) |
| URL | `https://arkova-worker-mig-docusign-trust-staging-270018525501.us-central1.run.app` |
| Serving revision | `arkova-worker-mig-docusign-trust-staging-00003-dbg` |
| Image digest | `sha256:878a569f398cd05c4334b03550f82e3fef629da85b0ead365110f93b530432df` |
| Cloud Build | `1495d35f-054b-42d5-bfd2-18f66f3ddec9` |
| Ledger | 120 rows, head `0424` |
| Preflight | `environment_type=clean_mirror`, exit 0, 7/7 checks, `2026-08-30T22:11:18.272Z` — captured BEFORE any load |
| Soak start | `2026-08-30T22:30:06Z` (revision `creationTimestamp`, FD-CLOCK-1) |
| Soak end | `2026-09-01T22:30:06Z` |

`/health` reports `git_sha = d22f0e0fbe43aaed7c269f9f37d882028aebc34c` — the exact soak head.

## Provisioner deviations (all forecast as known defects)

1. **Step 2 COMING_UP / IPv6 race** — `provision-isolated-rig.sh --apply` created the project,
   then `db push --linked` died with `IPv6 is not supported on your current network: dial tcp:
   lookup db.yfqgxycaiwgvvvbzhkma.supabase.co: no such host`. Continued by the script's own
   printed plan: waited for `ACTIVE_HEALTHY`, bootstrapped extensions, re-linked, pushed.
2. **`IP_HASH_PEPPER` missing from the overlays** — created
   `ip-hash-pepper-mig-docusign-trust-staging` and bound it on the deploy. Without it
   `config.ts`'s production `superRefine` crash-loops the worker at boot.
3. **Scheduler hold schedule** — not hit; the `mock` profile creates no Scheduler jobs. Cron
   paths are driven directly by the load driver instead (`/jobs/drain-connector-artifacts`,
   `/jobs/batch-anchors?force=true`), which is what this batch needs anyway — the `chain`
   profile's Scheduler set does not include the connector drain.
4. **Chain-profile secrets** — not needed. Profile `mock` (`USE_MOCKS=true`,
   `ENABLE_PROD_NETWORK_ANCHORING=false`) is the correct posture: nothing in either PR's
   changed path touches the chain client. Zero real Bitcoin exposure.

Additional deviations, not on the known-defects list:

5. **Nine multi-`CREATE INDEX CONCURRENTLY` migrations** cannot run under `db push`'s pipelined
   execution (`SQLSTATE 25001`). Set aside, pushed the rest, applied them byte-exact via `psql`
   over the **session pooler** (port 5432 — the transaction pooler on 6543 cannot run
   `CONCURRENTLY` either), inserted their ledger rows, restored the files, re-ran `db push`.
   Files: 0313, 0330, 0335, 0342, 0346, 0354, 0366, 0381, 0389. This is the
   `docs/reference/STAGING_RIG.md` 2026-08-19 gotcha 3 procedure; the doc's list is stale
   (it names 2 files, there are now 9).
6. **DocuSign overlay is not emitted by the provisioner.** Added on the deploy:
   `ENABLE_DOCUSIGN_WEBHOOK`, `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE`,
   `ENABLE_CONNECTOR_ARTIFACT_DRAIN`, `ENABLE_DOCUSIGN_INBOUND`, `ENABLE_BATCH_ANCHORING`, and
   a per-rig `docusign-connect-hmac-secret-mig-docusign-trust-staging`.

## Rig fixture repairs before the clock started (data-only, no ledger writes)

| Gap | Symptom | Fix |
|---|---|---|
| No `org_members` owner/admin row | drain `failed: N`, `no org owner/admin actor for connector artifact` | owner row per soak org |
| No `org_credits` | drain requeued rows with `insufficient_credits` (silent — no error log, only an alert) | balance + `anchor_quota` seeded |
| `ENABLE_BATCH_ANCHORING` off | `Batch anchoring disabled — skipping batch run`, even under `?force=true` | switchboard row + env fallback; the registry loads at boot, so this needed the restart that produced revision `-00003-dbg` |

None of these is a defect in either PR. All three are recorded because a green soak that never
reached the drain or the flush would have been hollow.

## What the load actually exercises

Per cycle, every 5 minutes, against the live rig:

- **Trigger A** — outbound HMAC-signed DocuSign Connect delivery → `202`.
- **Trigger B** — inbound (Recipient Connect) delivery, foreign sending account,
  `?customrecipient=true` → `202` flag-ON with 1 nonce consumed; `200 skipped: flag_disabled`
  with 0 nonces flag-OFF.
- **Per-org isolation** — the SAME `(envelope_id, event_id, generated_at)` tuple to two orgs
  (`202` / `202`), then replayed inside one org (`200 duplicate`).
- **0423 guard, 4 assertions** — user-JWT INSERT strips all 8 guarded keys; a non-guarded key
  in the same blob survives; `service_role` INSERT preserves all 8; owner UPDATE tamper reverts.
- **Negative controls** — bad HMAC → `401`; unknown DocuSign account → `200` orphan-ack.
- **Cron** — `drain-connector-artifacts` (`failed: 0`), then forced `batch-anchors` daily flush;
  anchors run PENDING → BROADCASTING → SUBMITTED → SECURED.
- **§1.6A** — a PII canary (`SOAKPII-DoNotLog-Marker`) rides every payload; checked against
  Cloud Run logs and `job_queue.last_error`. Zero hits.

Per-cycle JSON in this directory; the driver is `soak-driver.sh`.

## Finding: 0424's `-- ROLLBACK:` block is not executable once the feature has been used

Running it verbatim failed:

```
ERROR:  could not create unique index "docusign_webhook_nonces_envelope_id_event_id_generated_at_key"
DETAIL:  Key (envelope_id, event_id, generated_at)=(67ff8f3b-…, cyc1-1788129133, 2026-08-30 22:32:15+00) is duplicated.
```

The block re-adds the original global `UNIQUE (envelope_id, event_id, generated_at)`. Tenant
scoping exists precisely so two accounts can hold that tuple, so once that has happened the old
constraint can no longer be created and the whole rollback transaction aborts. 15 such tuples
existed on the rig.

Harmless in prod today (the inbound path has never run, so no duplicates exist), and 0424 was
left intact by the abort — the safe direction. It becomes a live trap the moment
`ENABLE_DOCUSIGN_INBOUND` is switched on: an operator reaching for the documented rollback during
an incident gets a constraint error instead of a rollback.

The corrected form was rehearsed and works — 0424's documented block plus the dedup step it omits
(`DELETE` the later duplicate per tuple, keeping the earliest `received_at`), then reapply 0424
byte-exact. `DELETE 15`; constraint swapped back and forward correctly; `/health` stayed healthy;
ledger untouched. Recommendation: fold the dedup into 0424's `-- ROLLBACK:` comment before the
flag is ever switched on.

0423's rollback is clean and behaviour-verified: with the trigger dropped, a real end-user JWT
successfully persisted a forged `connector_source='docusign'` + `account_id`/`envelope_id`/
`_signers`; after reapplying the migration byte-exact, the identical write came back stripped.

## Not touched

Prod (`vzwyaatejekddvltxyye` / `arkova-worker`) and every other session's in-flight rig. Note
that `arkova-soak-docusign-bilateral` (`aqikotdkmhxmznonwmwk`, service
`arkova-worker-docusign-bilateral-staging`) was already running when this soak started, on RC
head `2a676981c`, which CONTAINS both of these PR heads — another session is soaking a superset
under an RC manifest. Left alone. This rig is separate and its evidence is exact-head-bound to
`d22f0e0fbe43aaed7c269f9f37d882028aebc34c`.

## Status

Window OPEN until `2026-09-01T22:30:06Z`. The load supervisor is DETACHED (`nohup`, 5-minute
cycles) so the clock accrues without an attached session. Neither PR is ready; neither is merged.
Teardown (`scripts/staging/teardown-isolated-rig.sh`) is owed when the window closes and both PRs
are dispositioned — CLAUDE.md §7.
