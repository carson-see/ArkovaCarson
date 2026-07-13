# S0-7.2 — Credential Engine Key Custody + Rotation (RECONCILED HISTORICAL DESIGN)

**Epic:** SCRUM-1867 (R-LEGAL-01-CTDL) · **Lane 3** (Credential Network & Intelligence) · **Sprint 0** (Foundation & Hardening — design only, no build)
**Mitigates:** Roadmap risk **R-1 (FATAL)** — CE confirmed that the 3-month evaluation ends 2026-09-09; exact expiry instant/timezone is unknown.
**Date:** 2026-06-19 · reconciled 2026-07-13 · **Tier:** T0 historical design / T2 for any live secret or IAM change · **Status:** Historical design; no live action authorized. Current technical decisions route to the CTO and an approved operator.

> Secret hygiene: no secret value was read, printed, or logged. This 2026-07-13 reconciliation performs no gcloud action; the historical 2026-06-19 operator change applied labels and IAM without reading the value.

---

## 0. Current-state reality (verified — read first)

1. **No CE consuming key is wired into the worker today.** Repo-wide grep for `process.env.*(CTDL|CE_|CREDENTIAL_ENGINE|REGISTRY|CONNECTION_TOKEN|PUBLISH)*` → **zero** hits. CTDL is **pull-only**: `GET /api/v1/credentials/:publicId/ctdl` (`services/worker/src/api/v1/credentials-ctdl.ts:141`) emits PII-safe JSON-LD the Registry *crawls*; no outbound auth to CE. The only `credreg.net` reference is the static `@context` URI (`ctdl/ctdl-type-map.ts:9`).
2. **The live Secret Manager secret remains `Credential_Engine`** (project `arkova1`, created `2026-06-10T15:29:58Z`, 1 enabled version, `replication: automatic`, no Secret Manager rotation schedule). On 2026-06-19, an approved operator applied inventory labels `owner=lane3`, `category=api-key`, `service=credential-engine`, `risk=r-1`, and `rotation-cadence-days=90`. Its value was not read. Nothing in the worker currently reads this secret.
3. **Per-secret IAM is applied.** On 2026-06-19, the worker runtime SA `270018525501-compute@developer.gserviceaccount.com` received `roles/secretmanager.secretAccessor` on `Credential_Engine`; the broader project-level accessor grant remained in place. The CE-specific binding is therefore no longer an open action, while any estate-wide removal of the project-level grant remains a separate Lane-1/security decision.
4. **`secret-rotation-reminder.ts` is dead (SCRUM-2536 confirmed).** `runSecretRotationCheck` (`jobs/secret-rotation-reminder.ts:126`) is imported only by its own test — not by `routes/cron.ts`, `routes/scheduled.ts`, or `index.ts`. Inventory hardcodes `lastRotatedAt: new Date()` (lines 21–37) so every secret reads age-0 — it could never fire even if wired. **CE key absent from its inventory.**
5. **CE relationship state (current correspondence):** Arkova's organization CTID is **`ce-cd077a1e-7691-4519-b653-d46d1245687f`**. Jeanne Kitchens owns Credential Engine's Developer Integration Program and is the relationship/continuation contact; Jeff Grann is the technical/CTDL counterpart. CE reported that it copied Arkova's account to sandbox and sent an invite, but receipt, acceptance, usable sandbox access, and credential custody remain unverified.

**Takeaway:** R-1 is a *relationship/access-continuation* risk, not a code-path-down risk. No anchor/verify flow depends on the CE key. The CE secret is inventoried and has CE-specific IAM, but the alerting job remains unwired, the exact expiry instant is unknown, and usable sandbox access is unverified. Any client or live-secret change requires a current CTO decision and an approved operator.

## 0a. UPDATE — 2026-06-19 (executed; supersedes the rename recommendation below)

Arkova's 2026-06-19 operator session verified that the CE key was **already in Secret Manager** as `Credential_Engine` — there was **no "move" to do**. Acting on that:

- **DONE this session (in place; value never read):** added the per-secret `roles/secretmanager.secretAccessor` binding for the worker runtime SA (`270018525501-compute@developer.gserviceaccount.com`, region us-central1) and inventory labels (`owner=lane3, category=api-key, service=credential-engine, risk=r-1, rotation-cadence-days=90`) on `Credential_Engine`. Verified via `gcloud secrets get-iam-policy` + `describe`. The project-level grant is unaffected; this is additive least-privilege.
- **Decision change:** keep `Credential_Engine` as the live secret. The kebab-case rename, two-secret split, value migration, and retirement proposal are **not pursued**. A distinct sandbox secret would require both a distinct credential from CE and a new CTO decision; this document does not prescribe one.
- **2026-07-13 correction:** the permanent-key/sandbox request is no longer open. CE answered on 2026-06-24, confirmed the evaluation ends 2026-09-09, said it copied the account to sandbox and sent an invite, and identified the Developer Agreement plus annual support-tier selection as the continuing-production-access path. Still open: exact expiry instant/timezone, sandbox invite receipt/acceptance and usable access, agreement/tier decision, activation lead time, and rotation-reminder wiring. Doc 04 is historical and must not be sent.

## 0b. UPDATE — 2026-07-13 correspondence reconciliation

- **Confirmed date:** 2026-09-09. Do not downgrade it to “~September” or invent an expiry time.
- **Established identity and roles:** Arkova's organization CTID is `ce-cd077a1e-7691-4519-b653-d46d1245687f`; Jeanne Kitchens owns the Developer Integration Program/relationship path, and Jeff Grann is the technical/CTDL counterpart.
- **Continuation mechanism:** current Developer Agreement plus annual support-tier selection; the reviewed sources do not establish which tier Arkova will choose or the activation lead time.
- **Sandbox:** CE reported that it copied Arkova's account and sent an invite. The reviewed artifacts do not prove receipt, acceptance, working credentials, or which secret—if any—holds them.
- **Consuming options:** direct GET by CTID, Graph Search, and offline download remain available. This design does not assert a live production consuming client.
- **Claims boundary:** an approved production account or organization CTID is not proof that Arkova or any credential is published or listed in the Registry.
- **Authority:** the founder reserves the external partner send. Key custody, alerting, secret/IAM changes, and implementation decisions route to the CTO and require an approved operator; this document authorizes none of them.

## 1. Current-state detail (file:line)

| Concern | Reality | Cite |
|---|---|---|
| CE outbound client | Does not exist; CTDL is a pull projection | `api/v1/credentials-ctdl.ts:141-193` |
| CE key in config schema | Absent from Zod `ConfigSchema` | `services/worker/src/config.ts:23-333` |
| CE key in ENV.md | Absent | `docs/reference/ENV.md` |
| Secret in GCP SM | `Credential_Engine`, v1 enabled, inventory labels applied, no SM rotation schedule, auto-replication; kept in place | `gcloud secrets describe` (RO), 2026-06-19 operator verification |
| Secret IAM | CE-specific worker-SA `secretAccessor` binding applied; project-level grant still exists | `get-iam-policy` (RO), 2026-06-19 operator verification |
| Worker runtime SA | `270018525501-compute@developer.gserviceaccount.com` (default compute SA) | `run services describe arkova-worker` (RO) |
| Rotation reminder | Dead code, not scheduled, age always 0, CE absent | `jobs/secret-rotation-reminder.ts:20-37,126-138` |
| SM access precedent | REST `secretmanager.googleapis.com/v1` + Bearer from ADC/metadata; dep-free | `connectors/docusign-token-store.ts:78-153`, `utils/gcp-auth.ts:46-60` |

## 2. Superseded custody option — historical context only

The original 2026-06-19 draft proposed renaming the secret to kebab-case, splitting trial and permanent credentials, migrating the value, and retiring `Credential_Engine`. Same-day operator verification showed that `Credential_Engine` was already the live Secret Manager entry, and its labels plus CE-specific worker-SA IAM were applied in place. The rename/split/migration/retirement option was therefore superseded and is not an implementation plan.

**Current decision:** keep `Credential_Engine` in place. Do not create a second CE secret, copy a value, disable a version, or retire this entry from this document. If CE later issues a distinct credential or the custody model changes, the CTO must approve a new design and an approved operator must execute it without exposing the value. The estate-wide project-level-versus-per-secret IAM decision remains separate; this CE-specific binding is already present.

## 3. Rotation scheme

| Field | Value |
|---|---|
| Cadence | The `rotation-cadence-days=90` label records the 2026-06-19 inventory assumption; it is not proof of a CE contractual cadence. Evaluation access is **expiry-driven**, with confirmed date **2026-09-09** and exact instant/timezone unknown. |
| Procedure boundary | No rotation is authorized here. After CE supplies a replacement credential, the CTO must approve an in-place version-rotation plan for `Credential_Engine`, and an approved operator must execute and verify it without reading or logging the value. |
| Named owner | Technical decisions route to the **CTO**; execution requires an approved operator. Jeanne Kitchens owns CE's Developer Integration Program; Jeff Grann is the technical/CTDL counterpart. The founder-reserved action is the external send, not secret rotation. |
| Advance alert | Revive + extend the rotation reminder (SCRUM-2536). |

**Fixing SCRUM-2536 (code scoped to Sprint-1; inventory row designed now):** read real `lastRotatedAt` from SM version `createTime` (or a `last-rotated` label), not `new Date()`; add an expiry-aware branch (secrets with an `expires-at` label alert at T-60/T-30); wire to a daily cron (`POST /cron/secret-rotation`) behind a kill-switch flag, fanning to `SLACK_OPS_WEBHOOK_URL` + the Sprint-1 dashboard.

**KEY-EXPIRY dashboard handoff (SCRUM-2507, Sprint-1):** inventory row is the historical data-contract proposal — `{ secret_id, category, owner, cadence_days | expires_at, last_rotated_at, status: healthy|expiring|overdue, risk_tag }`. Any implementation should represent the existing `Credential_Engine` entry and preserve the unknown expiry instant rather than inventing a separate sandbox-secret row. **This document does not build or authorize the dashboard.**

## 4. Historical gcloud sketch — SUPERSEDED; DO NOT EXECUTE

The original draft contained commands to create two kebab-case secrets, copy credential values, add IAM, and disable `Credential_Engine`. Those commands are deliberately removed because the underlying design was superseded and leaving executable migration/retirement steps here creates an unsafe false action path.

**Do not execute a rename, copy, split, disable, destroy, IAM, label, or rotation action from this historical note.** The current secret is `Credential_Engine`; its inventory labels and CE-specific worker-SA binding are already applied. Any future live change requires a fresh CTO-approved plan and an approved operator, with read-only metadata verification and no secret value in chat, tickets, logs, or VCS.

## 5. Historical worker-client design note — current Jira status must be rechecked

Sprint 0 built nothing, and the repository still has no CE consuming client. The original draft tied a future client to SCRUM-1928 and proposed an environment selector plus a Secret Manager reader. This historical note does **not** assert that SCRUM-1928 is currently Blocked or unblocked; verify Jira and its Confluence page before scoping work. Any current implementation design must start from `Credential_Engine` staying in place, usable sandbox access being unverified, no secret-value logging, and the fail-closed claims boundary. Technical design routes to the CTO.

## 6. Lane-1 handoff reconciliation

The original handoff asked Lane 1 to decide broad-versus-per-secret IAM while Lane 3 created two new CE secrets, migrated the value, and retired `Credential_Engine`. That split is superseded.

- **Closed CE-specific action:** `Credential_Engine` already has the worker-SA per-secret accessor binding and inventory labels.
- **Still separate, if pursued:** Lane 1/security owns any estate-wide decision to remove the project-level accessor grant or change replication standards. This note does not direct that work.
- **No Lane-3 migration action:** keep `Credential_Engine`; there is no kebab-case rename, two-secret requirement, selector commitment, or retirement handoff.
- **Shared future alerting:** SCRUM-2536 may still cover the general rotation-reminder defect. Any CE row must use verified metadata and preserve the unknown expiry instant. The CTO owns the technical decision; an approved operator owns live execution.

## 7. Open items / unverified

- **Relationship roles** — Jeanne Kitchens owns the Developer Integration Program; Jeff Grann is the technical/CTDL counterpart. The current packet is addressed to Jeanne with Jeff copied.
- **Exact expiry instant** — the date is confirmed as 2026-09-09; time and timezone remain unknown. The `expires-at` label and alert must not invent an instant.
- **Continuation decision** — Developer Agreement version, annual support tier, decision deadline, and activation lead time remain unresolved.
- **Sandbox state** — CE said it copied the account and sent an invite; receipt, acceptance, usable credentials, and custody are unverified.
- **What `Credential_Engine` holds** (trial vs permanent) — not inspected because the value was never read. Keep it in place; clarify credential purpose through CE correspondence and a CTO-approved custody decision rather than migrating by convention.
- **SCRUM-1928 status** — this historical note does not claim a current Jira status. Recheck Jira/Confluence before planning; the code-level fact is that no CE consuming client is wired today.
