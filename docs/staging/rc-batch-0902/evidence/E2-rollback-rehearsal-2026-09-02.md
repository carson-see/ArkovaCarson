# E2 — T2 rollback rehearsal on the RC batch rig (no-traffic revision of the production image)

**Why this shape.** The four RC PRs are code-only (no migration), so rollback in prod is an image swap back to the running production image. Rehearsing it on the rig as a **zero-traffic tagged revision** exercises exactly that path (pull the prod image, boot it against the rig's config and database, pass health) without moving traffic off the soaking revision or restarting its instance — the soak clock is Cloud Run worker uptime and must not reset.

**Run (2026-09-02, UTC).**
- Prod image at the time: `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:8147ed3a719c93112ddbfcee3889ec30bc26f4ec` (`gcloud run services describe arkova-worker`).
- 20:32:51 — `gcloud run deploy arkova-worker-rc-batch-0902-staging --image <prod image> --no-traffic --tag rollback` → revision `arkova-worker-rc-batch-0902-staging-00002-ker`, 0 % traffic.
- Traffic after deploy: `100 % → 00001-p4l` (soaking revision), `00002-ker` reachable only via the `rollback` tag.
- Tagged `/health` (`https://rollback---arkova-worker-rc-batch-0902-staging-kvojbeutfa-uc.a.run.app/health`): `{"status":"healthy","git_sha":"8147ed3a719c93112ddbfcee3889ec30bc26f4ec","checks":{"database":"ok","anchoring":"ok","kms":"ok"}}` — the production build boots and passes its own health checks against this rig's schema (ledger 0419 + 0417, i.e. the RC head's schema).
- Serving `/health` before and after: `git_sha=78621249…`, uptime 2597 s → 2650 s. The soaking instance was not restarted.
- Tear-down: tag removed and revision `00002-ker` deleted after the check (below), traffic still 100 % on `00001-p4l`.

**What this proves / does not prove.** Proves the rollback image starts, wires its secrets, and passes health on the RC schema; proves a rollback can be staged without touching the live revision. Does not exercise a traffic shift under load, and does not test schema rollback (none needed — no migration in the batch).
