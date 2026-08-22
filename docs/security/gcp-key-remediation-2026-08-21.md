# GCP downloadable-key remediation — 2026-08-21

**Executed by:** CTO session, under Carson's standing directive to make and execute technical calls.
**Scope:** project `arkova1`. Two P0 items closed, two deferred with reasons, several findings recorded.

## What was done

### 1. Deleted the `arkova-cli` downloadable key — DONE

| | |
|---|---|
| Service account | `arkova-cli@arkova1.iam.gserviceaccount.com` |
| Key ID | `00548b68a6195b5422eb6031a537f9bc07cbaace` |
| Created | 2026-04-16T03:47:34Z (127 days old, `validBeforeTime` 9999 — never expired) |
| Roles held | `aiplatform.user`, `cloudkms.admin`, `run.admin`, **`secretmanager.admin`** |
| Deleted at | 2026-08-21T16:09Z |

**Why this was the P0.** `roles/secretmanager.admin` includes `secretmanager.versions.access`,
so this key could read `bitcoin-treasury-wif` — the live Bitcoin signing key. The private key
sat in `~/.config/gcloud/arkova-cli-key.json` on a laptop, with no expiry.

**Verified before deleting** (not assumed):
- The replacement path already existed and works — `carson@arkova.ai` holds
  `roles/iam.serviceAccountTokenCreator` on `arkova-cli`, and an access token was
  successfully minted via `--impersonate-service-account` before the key was removed.
- The active local gcloud identity was the *compute* SA, not `arkova-cli`, so deleting this
  key could not sever the session performing the deletion.
- Audit trail showed **zero** activity for 83 days (last Admin-Activity entry 2026-05-30).

**Verified after deleting:**
- `keys list --managed-by=user` returns empty for the SA.
- The local cached credential was revoked; `print-access-token` for that account now fails
  with "please activate it first". (A cached access token kept working for a few minutes
  after deletion — expected GCP behaviour, tokens live ~1 h — which is why the local
  credential was revoked rather than relying on the delete alone.)
- All 7 Cloud Run services still reachable; running soaks unaffected.

**Blast radius:** one script. `services/worker/scripts/eval-and-analyze-v6.sh:32` defaults
`GOOGLE_APPLICATION_CREDENTIALS` to that key file. It has not run in 83 days. It needs to
move to `--impersonate-service-account=arkova-cli@arkova1.iam.gserviceaccount.com` — tracked
as a follow-up PR, not a blocker. Nothing in CI, prod, or Cloud Run referenced the key.

**The local file `~/.config/gcloud/arkova-cli-key.json` is now inert** — the key it contains
no longer exists server-side and GCP does not reuse key IDs. Carson can delete it at leisure.

### 2. Enabled Data Access audit logging — DONE

`gcloud projects get-iam-policy arkova1` previously returned **no `auditConfigs` at all**.
Every `AccessSecretVersion` on `bitcoin-treasury-wif`, every KMS sign, and every Vertex
predict was invisible. There was no forensic path to establish who had read the treasury key.

Now configured:

| Service | Log types |
|---|---|
| `secretmanager.googleapis.com` | `DATA_READ`, `DATA_WRITE` |
| `cloudkms.googleapis.com` | `DATA_READ` |

Applied by reading the live policy, adding **only** the `auditConfigs` key, and writing back
with the original `etag` for optimistic concurrency. Verified afterwards: **51 bindings before,
51 after, byte-identical.** No binding was touched.

**This is forward-looking only.** It does not explain the open question below.

## Open question this does NOT resolve

Policy Intelligence reports `lastAuthenticatedTime = 2026-07-28` for the deleted `arkova-cli`
key, but **no audit log entry exists for that date**, because Data Access logging was off. So
what that key authenticated to on 2026-07-28 cannot be determined, and treasury access on that
date cannot be ruled out — only judged unlikely.

**Assessment:** the key file was laptop-local at mode `0600`, never in Secret Manager, never in
git history, never in a GitHub secret. There is no evidence of compromise, and the most likely
explanation is ordinary Vertex eval work by the operator. The exposure was theoretical.

**Not done, deliberately:** rotating `bitcoin-treasury-wif`. That is the only lever that would
convert "unlikely" into "ruled out", and it is a live mainnet signing key — rotating it carries
real operational risk to anchoring and is a decision that deserves a planned change window, not
a same-session reflex. **Recommended, not executed. Carson's call.**

## Deferred, with reasons

### The compute-SA key must NOT be deleted yet
`270018525501-compute@developer.gserviceaccount.com`, key `fd2b4667ee93b9c16644cc4174448cc41d706283`.

It is **actively in use** — 17 authentications in the last 24 h, 1000+ in 30 days. It drives the
isolated-soak-rig standup pipeline (`CloudScheduler.*`, `run.Services.ReplaceService`,
`SecretManager.CreateSecret`, `CloudBuild.CreateBuild`) and it is the **active local gcloud
account**, i.e. the identity every `gcloud` call from this machine — including this session's
soak operations — currently uses. Deleting it now would break soak operations immediately.

Two coupled prerequisites before it can go:
1. `scripts/ops/gcloud-auth-preflight.sh` **rejects** local interactive user accounts by design —
   it passes only for `*.gserviceaccount.com`, or when `GOOGLE_APPLICATION_CREDENTIALS`/`K_SERVICE`/
   `GITHUB_ACTIONS` is set, or `ARKOVA_ALLOW_USER_GCLOUD=breakglass`. So "just use Carson's
   account" trips a guard written to require exactly the key being removed. That script must be
   amended in the same change.
2. One full rig standup must be rehearsed on the new identity **before** deletion.

### Corrections to the prior briefing
- The standing note said `arkova-cli` had a key **and** that the compute key drives CI deploys.
  **Neither is accurate.** CI authenticates as `github-actions-deploy@arkova1` via Workload
  Identity Federation with **no service-account key** (`google-github-actions/auth@v3` +
  `workload_identity_provider`, zero `credentials_json` usage across all workflows). The compute
  key drives *local* operator/rig work, not CI. This changes the migration plan materially.
- A second `arkova-cli` key (`cea7e000…`) had already been deleted before this session.

### Not enforced yet: `constraints/iam.disableServiceAccountKeyCreation`
Currently `restoreDefault` (not enforced). Notably its `updateTime` is
`2026-03-25T14:30:00Z` and the compute key's `validAfterTime` is `2026-03-25T14:30:53Z` —
**the guardrail was disabled 53 seconds before that key was minted.** Enforcement is deliberately
sequenced *after* the compute-key migration so it cannot block that work. Until it is enforced,
any cleanup here can silently regress.

## Other findings recorded, not acted on

- **`roles/owner` on the compute SA remains** (SCRUM-3023). Deleting its key does not address
  this: all 7 Cloud Run services run *as* that SA and obtain credentials from the metadata
  server, so an RCE in the prod worker still reaches Owner. That needs a scoped replacement SA
  and a cutover — a project, not a command.
- **`api-key-hmac-secret` is at v1, created 2026-03-15, never rotated** (§1.4 governs API-key
  HMAC).
- **`arkova-staging-deployer@arkova1` has zero activity in 30 days** — dead SA, candidate for removal.
- **`sekura-deploy@` / `sekura-appliance@` remain enabled** (the former holds
  `compute.instanceAdmin.v1`, `networkAdmin`, `serviceUsageAdmin`). Neither holds a key and
  neither has ever authenticated. **Left enabled deliberately** — whether that vendor engagement
  is finished is a business question, not a technical one, and disabling a live vendor's access
  is not a call to make silently.
- **`docs/security/sekura-known-issues-2026-08-03.md` states "A scoped replacement SA is built."
  No such SA exists** in the live inventory. That is a false external-facing claim and falls under
  the R-7 claims-review gate — it needs correcting or building.
- **~250 of 322 secrets are dead per-PR/per-soak `supabase-*-pr####-staging` artifacts**, each
  readable by anything holding project-wide `secretmanager.secretAccessor`. Hygiene sweep item.

## Recommended next steps, in order

1. PR: move `eval-and-analyze-v6.sh` off the deleted key file to impersonation.
2. Decide on `bitcoin-treasury-wif` rotation (Carson) — the only way to close the 2026-07-28 unknown.
3. Amend `gcloud-auth-preflight.sh`, rehearse a rig standup on the new identity, then delete the
   compute key.
4. Enforce `iam.disableServiceAccountKeyCreation` once (3) is done.
5. Scoped replacement SA for the compute SA's `roles/owner` (SCRUM-3023).
6. Correct the Sekura doc claim; sweep dead secrets and the dead staging-deployer SA.
