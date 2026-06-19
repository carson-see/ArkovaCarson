# S0-7.2 — Credential Engine Key → Secret Manager Custody + Rotation (DESIGN)

**Epic:** SCRUM-1867 (R-LEGAL-01-CTDL) · **Lane 3** (Credential Network & Intelligence) · **Sprint 0** (Foundation & Hardening — design only, no build)
**Mitigates:** Roadmap risk **R-1 (FATAL)** — CE 3-month trial consuming key expires ~Sept 2026.
**Date:** 2026-06-19 · **Tier:** T0 (this design) / **T2** (the live secret write + IAM = Carson-executes) · **Status:** Draft for Carson review.

> Secret hygiene: no secret value was read, printed, or logged. All gcloud calls were metadata-only (`describe`, `versions list`, `get-iam-policy`, `list`).

---

## 0. Current-state reality (verified — read first)

1. **No CE consuming key is wired into the worker today.** Repo-wide grep for `process.env.*(CTDL|CE_|CREDENTIAL_ENGINE|REGISTRY|CONNECTION_TOKEN|PUBLISH)*` → **zero** hits. CTDL is **pull-only**: `GET /api/v1/credentials/:publicId/ctdl` (`services/worker/src/api/v1/credentials-ctdl.ts:141`) emits PII-safe JSON-LD the Registry *crawls*; no outbound auth to CE. The only `credreg.net` reference is the static `@context` URI (`ctdl/ctdl-type-map.ts:9`).
2. **A Secret Manager secret `Credential_Engine` already exists** (project `arkova1`, created `2026-06-10T15:29:58Z`, 1 enabled version, **no labels**, `replication: automatic`, **no rotation policy**) — verified via read-only `gcloud secrets describe`. Bootstrapped manually but **orphaned**: nothing reads it; its `Title_Case` name diverges from the worker's `kebab-case` convention.
3. **Its IAM policy is EMPTY** (`get-iam-policy` → `{"etag":"ACAB"}`). The worker reads it only because the Cloud Run runtime SA `270018525501-compute@developer.gserviceaccount.com` holds **project-level** `roles/secretmanager.secretAccessor`. `gemini-api-key` likewise has no per-secret binding → today **every secret is project-wide readable**, not least-privilege.
4. **`secret-rotation-reminder.ts` is dead (SCRUM-2536 confirmed).** `runSecretRotationCheck` (`jobs/secret-rotation-reminder.ts:126`) is imported only by its own test — not by `routes/cron.ts`, `routes/scheduled.ts`, or `index.ts`. Inventory hardcodes `lastRotatedAt: new Date()` (lines 21–37) so every secret reads age-0 — it could never fire even if wired. **CE key absent from its inventory.**
5. **CE relationship state (SCRUM-1867 Confluence + memory):** trial/sandbox access gates the **Arkova org CTID** needed for `ceterms:offeredBy`. SCRUM-1928 is **Blocked: "CE API key provisioning (external)."** *Honesty flag:* Confluence names **Jeff Grann** (Credential Solutions Lead) / **Scott Cheney** (CEO); brief + memory say **Jeanne Kitchens (CTSO)**. **Unverified** which is the current renewal owner — confirm with Carson.

**Takeaway:** R-1 is a *relationship/credential-custody* risk, not a code-path-down risk. No anchor/verify flow depends on the CE key. The fatal mode: the trial key expires, the CTID path lapses, and **nobody is alerted** (key not inventoried + reminder dead). Fix custody + alerting now; pre-wire the consuming path for when SCRUM-1928 unblocks.

## 0a. UPDATE — 2026-06-19 (executed; supersedes the rename recommendation below)

Carson confirmed the CE key is **already in Secret Manager** as `Credential_Engine` — there is **no "move" to do**. Acting on that:
- **DONE this session (in place; value never read):** added the per-secret `roles/secretmanager.secretAccessor` binding for the worker runtime SA (`270018525501-compute@developer.gserviceaccount.com`, region us-central1) and inventory labels (`owner=lane3, category=api-key, service=credential-engine, risk=r-1, rotation-cadence-days=90`) on `Credential_Engine`. Verified via `gcloud secrets get-iam-policy` + `describe`. The project-level grant is unaffected; this is additive least-privilege.
- **Decision change:** keep `Credential_Engine` as the live secret. The kebab-case rename + 2-secret split in §2/§4 below is **NOT pursued** — a rename would force an unnecessary value migration. If/when CE issues a distinct sandbox key, add `credential-engine-api-key-sandbox` then; until then the single hardened secret stands. Treat §2/§4's "create/migrate" steps as **superseded**; §4's rotation procedure still applies to `Credential_Engine` in place.
- **Still open (genuinely external):** the permanent-key/sandbox request to CE (drafted in Gmail + doc 04) and the paid Developer Agreement decision before ~2026-09-09. The rotation-reminder code wiring (SCRUM-2536) is a Sprint-1 build.

## 1. Current-state detail (file:line)

| Concern | Reality | Cite |
|---|---|---|
| CE outbound client | Does not exist; CTDL is a pull projection | `api/v1/credentials-ctdl.ts:141-193` |
| CE key in config schema | Absent from Zod `ConfigSchema` | `services/worker/src/config.ts:23-333` |
| CE key in ENV.md | Absent | `docs/reference/ENV.md` |
| Secret in GCP SM | `Credential_Engine`, v1 enabled, no labels, no rotation, auto-replication | `gcloud secrets describe` (RO) |
| Secret IAM | Empty resource policy; relies on project-level grant | `get-iam-policy` (RO) |
| Worker runtime SA | `270018525501-compute@developer.gserviceaccount.com` (default compute SA) | `run services describe arkova-worker` (RO) |
| Rotation reminder | Dead code, not scheduled, age always 0, CE absent | `jobs/secret-rotation-reminder.ts:20-37,126-138` |
| SM access precedent | REST `secretmanager.googleapis.com/v1` + Bearer from ADC/metadata; dep-free | `connectors/docusign-token-store.ts:78-153`, `utils/gcp-auth.ts:46-60` |

## 2. Target Secret Manager custody design

**Two secrets** (trial + permanent live side-by-side so the Sept-2026 cutover is a pointer flip):

| Secret ID (kebab-case) | Holds | Notes |
|---|---|---|
| `credential-engine-api-key` | **Permanent** CE production key | Primary; migrate the existing `Credential_Engine` into this; retire the orphan. |
| `credential-engine-api-key-sandbox` | CE **sandbox/trial** key (the ~Sept-2026 expiring one) | Separate secret, never co-mingled with prod. |

**Conventions:** lowercase-kebab `credential-engine-*` (matches `gemini-api-key`, `stripe-secret-key`); one logical secret, many **versions** (rotation = add-version → flip → disable old, never `-v2` siblings); worker picks trial-vs-prod via a new config flag `credentialEngineEnv: z.enum(['sandbox','production']).default('sandbox')` (env `CREDENTIAL_ENGINE_ENV`), resolving the secret name from the flag — never by swapping contents; replication **US-pinned** (`us-central1,us-east1`) to match US-residency posture; labels `owner=lane3,category=api-key,service=credential-engine,risk=r-1,rotation-cadence-days=90` for the inventory/dashboard.

**IAM — least privilege (the real hardening win):** grant `roles/secretmanager.secretAccessor` **on the specific CE secrets** to the worker SA — not a new project-wide grant. The broad-grant-vs-per-secret estate decision is **Lane 1's** (§6); regardless, the CE secrets MUST carry explicit per-secret bindings. No human/CI SA gets accessor; rotation writes are Carson's, not the worker SA's (worker is read-only on the secret).

## 3. Rotation scheme

| Field | Value |
|---|---|
| Cadence | 90 days for the permanent key (matches `ROTATION_PERIOD_DAYS=90`). Sandbox/trial: **expiry-driven**, hard target **T-60 / T-30 before ~Sept 2026**. |
| Procedure (zero-downtime) | new key from CE portal → `versions add` → flip worker + confirm `/health` → `versions disable <old>` (keep for rollback) → `destroy` after a clean soak. |
| Named owner | **Carson** executes all rotations. CE-relationship renewal owner = **CONFIRM** (Jeff Grann vs Jeanne Kitchens). |
| Advance alert | Revive + extend the rotation reminder (SCRUM-2536). |

**Fixing SCRUM-2536 (code scoped to Sprint-1; inventory row designed now):** read real `lastRotatedAt` from SM version `createTime` (or a `last-rotated` label), not `new Date()`; add an expiry-aware branch (secrets with an `expires-at` label alert at T-60/T-30); wire to a daily cron (`POST /cron/secret-rotation`) behind a kill-switch flag, fanning to `SLACK_OPS_WEBHOOK_URL` + the Sprint-1 dashboard.

**KEY-EXPIRY dashboard handoff (SCRUM-2507, Sprint-1):** inventory row is the data contract — `{ secret_id, category, owner, cadence_days | expires_at, last_rotated_at, status: healthy|expiring|overdue, risk_tag }`. The CE sandbox row is the dashboard's first FATAL-risk (`R-1`) entry; sort to top. **Design the row here; do not build the dashboard.**

## 4. Exact gcloud commands — DRAFTED for Carson

```
>>> CARSON EXECUTES — do not run from the train <<<
# T2: live secret write + IAM change. Operator-only per CLAUDE.md §1.11/§1.12.
# Project: arkova1 | Worker runtime SA: 270018525501-compute@developer.gserviceaccount.com
# Run where YOU hold the CE key value. NEVER paste the key into chat, a ticket, a log, or VCS.
# Pipe from a local file you delete after.

PROJECT=arkova1
WORKER_SA=270018525501-compute@developer.gserviceaccount.com

# 1. PERMANENT key: canonical kebab-case secret (US-pinned, labeled)
gcloud secrets create credential-engine-api-key --project="$PROJECT" \
  --replication-policy=user-managed --locations=us-central1,us-east1 \
  --labels=owner=lane3,category=api-key,service=credential-engine,risk=r-1,rotation-cadence-days=90
printf '%s' "$CE_PROD_KEY" | gcloud secrets versions add credential-engine-api-key --project="$PROJECT" --data-file=-

# 2. SANDBOX / trial key (the ~Sept-2026 expiring one) — separate secret
gcloud secrets create credential-engine-api-key-sandbox --project="$PROJECT" \
  --replication-policy=user-managed --locations=us-central1,us-east1 \
  --labels=owner=lane3,category=api-key,service=credential-engine,risk=r-1,expires-at=2026-09-15
  # ^ set expires-at to the REAL trial expiry from the CE portal before running.
printf '%s' "$CE_SANDBOX_KEY" | gcloud secrets versions add credential-engine-api-key-sandbox --project="$PROJECT" --data-file=-

# 3. Least-privilege IAM: accessor on the SPECIFIC secrets only
for S in credential-engine-api-key credential-engine-api-key-sandbox; do
  gcloud secrets add-iam-policy-binding "$S" --project="$PROJECT" \
    --member="serviceAccount:$WORKER_SA" --role="roles/secretmanager.secretAccessor"
done

# 4. ROTATION (each 90-day cadence / before trial expiry):
# add new version → confirm worker /health → disable old → (later) destroy

# 5. Retire the orphaned Title_Case secret AFTER the new ones are wired + soaked:
# gcloud secrets versions disable 1 --secret=Credential_Engine --project="$PROJECT"
<<< END CARSON BLOCK >>>
```

*Post-execution verification (read-only, train-safe):* `get-iam-policy credential-engine-api-key` shows exactly the worker SA with `secretAccessor`; `versions list` shows one `enabled` version.

## 5. Worker code change (DESIGN → Sprint-1, gated on SCRUM-1928)

Sprint 0 builds nothing. When SCRUM-1928 unblocks: add `credentialEngineEnv` to `config.ts` (default `sandbox`, prod cross-field guard mirroring the Drive/DocuSign pattern `config.ts:410-499`); new `integrations/credential-engine/ce-secret-store.ts` reusing `getGcpAccessToken()` (`utils/gcp-auth.ts:46`) + the dep-free REST `:access` pattern from `docusign-token-store.ts:153` (no new `@google-cloud/secret-manager` dep); never log the value; consuming `ce-registry-client.ts` honors §1.6/§1.6A + §1.5 (no "listed in the Registry" claim). TDD: secret-name resolves per env; reader never logs value; sandbox default; prod+publish-flag without a reachable secret fails closed.

## 6. Lane-1 handoff (CE-key Secret-Manager entry)

> **To Lane 1 (Security / Secret-Manager / IAM hardening):** two cross-cutting items are yours because they touch the whole secret estate:
> 1. **Per-secret IAM vs project-wide grant.** Worker SA `270018525501-compute@...` holds **project-level** `secretAccessor` (every secret readable; `Credential_Engine` + `gemini-api-key` have empty per-secret policies). Lane 3's design requires explicit **per-secret** accessor bindings for the two CE secrets. Fold into the estate decision (keep broad grant + per-secret defense-in-depth, or migrate to per-secret and drop the broad grant) — either way the CE per-secret binding stands.
> 2. **Replication residency.** New CE secrets are `user-managed` US-pinned; the legacy estate (incl. `Credential_Engine`) is `automatic`. Apply any global standard you set.
>
> **Owned by Lane 3 (do not touch):** CE secret naming (`credential-engine-*`), the `CREDENTIAL_ENGINE_ENV` selector, retirement of the orphan `Credential_Engine`, the CE inventory rows.
> **Shared (SCRUM-2536):** reviving `secret-rotation-reminder.ts` is a general fix; Lane 3 needs the CE rows + T-30/T-60 expiry branch. Coordinate the cron wiring so it isn't double-wired.

## 7. Open items / unverified (for Carson)
- **CE contact owner** — Jeff Grann (Confluence) vs Jeanne Kitchens (brief/memory). Unverified; both may be valid CE contacts. Confirm the renewal owner.
- **Exact trial-key expiry date** — "~Sept 2026" approximate; the `expires-at` label + dashboard row need the real CE-portal date.
- **What `Credential_Engine` holds** (trial vs permanent) — not inspected (value never read). Confirm + migrate into the correct kebab-case secret.
- **SCRUM-1928 still externally Blocked** — no CE consuming endpoint to call yet, so §5 client work cannot start regardless of custody readiness.
