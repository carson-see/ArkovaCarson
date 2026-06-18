# API-Key & Secret Expiry Dashboard — Design (deep mechanism)

> **Type:** Design doc / read-only spec. Implementation deferred to Sprint 1.
> **Pre-design feeding:** Sprint-1 epic **KEY-EXPIRY = SCRUM-2507**.
> **Owner persona:** API Engineer + Senior Full-stack — **Lane 2 (Product & Growth)**, PI-1 train.
> **Status:** DRAFT
> **Soak tier:** **T0** (design only; no code/migration/runtime change in this PR).
> **Scope line:** the *deep mechanism* behind key/secret expiry visibility — how each clock is computed, the **T-30 alarm**, alert routing, rotation tracking, and the dedicated key-expiry admin panel. This doc does **not** redesign the 3-signal internal-visibility board (Agent A's `S0-5.1-internal-visibility-dashboard-spec.md` owns that surface; it links here for the expiry signal). It does **not** design the CE-key *move* into Secret Manager (Lane-3 / Carson, S0-7.2) — only its **visibility + T-30 alarm**.
> **Author note:** all paths below are real and were read while authoring; clocks for Lane-1/Lane-3-owned secrets are surfaced (read-only) here, not owned here.

---

## 1. Why this exists (the gap)

There is **no dashboard, cron, or alert** that tells an operator a key or secret is about to expire. Three concrete facts from the current codebase make this a launch risk:

1. **`validate_api_key` ignores `expires_at`.** The auth RPC
   (`supabase/migrations/0299_validate_api_key_rpc.sql`, hardened by
   `0302_…` + `0303_…`) looks up the key by
   `WHERE ak.key_hash = v_hash AND ak.is_active = true` (0299 lines 81-83).
   It **never references `api_keys.expires_at`** (the column exists —
   `00000000000000_baseline_at_main_HEAD.sql:7440`). So an *expired* key
   keeps authenticating until someone manually flips `is_active`. Expiry today
   is a column nobody reads. *(Surfaced here as a flag for Carson — §7. This
   doc designs visibility; closing the auth-path gap is a separate decision.)*
2. **The secret-rotation reminder is a non-firing stub.**
   `services/worker/src/jobs/secret-rotation-reminder.ts` exists with a real
   `checkRotationStatus()` (90-day period, 7-day warning) and Slack formatter —
   but `getSecretInventory()` hardcodes `lastRotatedAt: new Date()` for every
   secret (lines 20-38), so **nothing is ever "expiring soon" or "overdue."**
   And `runSecretRotationCheck()` (line 126) is **not wired to any cron
   endpoint** — `grep` of `services/worker/src/routes/cron.ts` finds no
   `/cron/secret-rotation` registration. It is dead code with a green test.
3. **The CE trial key has a hard ~Sept-2026 clock and no alarm.** The
   Credential Engine live-API trial was signed 2026-06-09 (org-level CTID +
   trial key). That key expires on a fixed PI-1-relevant date with **zero**
   surfacing. This is THE headline T-30 alarm this design must guarantee.

The dedicated key-expiry panel + a T-30 cron mirroring the proven
`db-health-monitor` pattern closes all three.

---

## 2. Inventory of expiring keys / secrets (grounded)

| Secret / key | Clock | Owner lane | Clock source (read-only) | Current gap |
|---|---|---|---|---|
| **CE trial API key** | **~Sept 2026** (hard PI-1 clock; trial signed 2026-06-09) | **L3** | Operator-supplied expiry metadata (no expiry field exists in repo today — see §3.4). Custody move = S0-7.2. | **THE headline T-30 alarm.** No surfacing anywhere today. |
| `api_keys.expires_at` (customer + internal API keys) | per-key `timestamptz`, nullable | **L2** | `public.api_keys.expires_at` (`baseline…:7440`); read via service-role query / new RPC (§3.1). | Column populated but **read by nothing** — not by `validate_api_key`, not by any UI. No per-key expiry list. |
| `API_KEY_HMAC_SECRET` | rotation policy (90-day target per the reminder stub) | **L2** | GCP Secret Manager version metadata (`createTime`) — read-only (§3.3). Mirror row: `private.api_key_settings.updated_at` (`0299…:34-39`). | Rotation clock not surfaced; reminder stub never fires (§1.2). |
| `PROOF_SIGNING_KEY_ID` / proof signing key (Ed25519, KMS-backed) | rotation policy | **L1** | `services/worker/proof-keys.public.json` registry (`created_at` / `retired_at` per key, served by `services/worker/src/api/proof-keys.ts`). | **Reference-only here.** Lane-1 owns rotation; L2 surfaces the clock. |
| WIF treasury signer / GetBlock RPC creds | rotation policy | **L1** | GCP Secret Manager version metadata (read-only). | **Reference-only here.** Lane-1 owns rotation; L2 surfaces the clock. |

**Lane boundary rule for this doc:** L2 *computes and surfaces* every clock above. For **L1** (proof signing, WIF, GetBlock) and **L3** (CE key custody) rows, L2 only *reads metadata and raises the alarm* — the actual rotation/custody action stays with the owning lane. The panel renders an `owner_lane` badge per row so an operator knows who to page.

---

## 3. Data sources & how each clock is read

> **Constitution §1.4 invariant for the whole design:** **no secret VALUE is ever read, returned, logged, or rendered — only expiry/rotation metadata** (timestamps, prefixes, names, status). The HMAC-SHA256 model (raw key shown once at creation, only `key_hash` persisted — `services/worker/src/api/v1/keys.ts` header; `private.api_key_settings.hmac_secret` is service-role-only and `private`-schema-invisible to anon/authenticated) is preserved unchanged. This panel reads *around* the secret, never the secret.

### 3.1 `api_keys.expires_at` (L2 — per-key clock)

- **Source of truth:** `public.api_keys` rows. Relevant columns:
  `expires_at`, `is_active`, `revoked_at`, `revocation_reason`, `last_used_at`,
  `key_prefix`, `name`, `org_id`, `rate_limit_tier`
  (`baseline…:7431-7457`).
- **Read path (Sprint-1 build):** a new SECURITY DEFINER RPC, e.g.
  `get_expiring_api_keys(p_within_days int)`, returning **metadata only** —
  `key_prefix`, `name`, `org_id`, `expires_at`, `is_active`, `revoked_at`,
  days-to-expiry. It **must not** return `key_hash` or any value. Mirror the
  hardening already applied to `validate_api_key`: `SET search_path = public`,
  `REVOKE … FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE … TO
  service_role`, and `NOTIFY pgrst, 'reload schema'` (pattern from
  `0299…:99-107` and the `0303` compensating migration). RLS already forces
  org-scoping on direct `api_keys` SELECT
  (`api_keys_select_own_org`, `baseline…:12505`); the admin panel reads
  cross-org via the service-role worker, never the browser client.
- **Output sanitization mirrors the existing v1 surface:** the worker already
  strips `id` / `org_id` / `key_hash` from outbound key bodies via
  `toPublicKey()` (`services/worker/src/api/v1/keys.ts`). The admin panel is
  internal (cross-org) so it MAY show `org_id` for routing, but **never**
  `key_hash`.

### 3.2 `expires_at` semantics decision (input to Sprint 1)

Because `validate_api_key` ignores `expires_at` today (§1.1), the dashboard
must decide what "expiring" *means* operationally. Two states to render
distinctly:
- **`is_active = true` AND `expires_at` in the past** → **"expired-but-still-valid"**
  (red, highest priority): the key authenticates despite being past its date.
  This is the dangerous state and the panel must call it out loudly.
- **`is_active = true` AND `expires_at` within T-30** → normal pre-expiry warning.
- Keys with `revoked_at` set or `is_active = false` are excluded from the
  alarm (already dead).

### 3.3 `API_KEY_HMAC_SECRET` & other GCP-managed secrets (L2 + L1)

- **Source of truth:** **GCP Secret Manager version metadata** (`createTime`
  of the latest enabled version) — this is the honest "last rotated" clock,
  read-only. The current stub's `lastRotatedAt: new Date()` placeholder
  (`secret-rotation-reminder.ts:20-38`) must be replaced by a real read of
  this metadata (Sprint-1 work; see §6). No secret payload is accessed —
  only the version's create timestamp.
- **Mirror clock available in-DB:** `private.api_key_settings.updated_at`
  (`0299…:37`) is bumped whenever the HMAC secret row is written, so it is a
  secondary "last set" signal the RPC can read without touching GCP.
- **Inventory already enumerated:** the secret list to track is already in
  `getSecretInventory()` (`secret-rotation-reminder.ts:20-38`) — `STRIPE_*`,
  `SUPABASE_SERVICE_ROLE_KEY`, `API_KEY_HMAC_SECRET`, `GEMINI_API_KEY`,
  `CRON_SECRET`, `CLOUDFLARE_*`, etc. Sprint 1 extends this list with the
  CE key (§3.4) and the L1 signing keys (§3.5), and replaces the timestamps
  with real Secret-Manager reads.

### 3.4 CE trial key (L3 — headline) — visibility only

- **No expiry field exists in the repo today.** The CE key has no row in
  `api_keys` and no env-var clock; its ~Sept-2026 date is operator knowledge.
- **Sprint-1 source:** an operator-supplied expiry, stored as **metadata only**
  — recommended as a `getSecretInventory()` entry
  (`{ name: 'CREDENTIAL_ENGINE_API_KEY', category: 'token', expiresAt: <date> }`,
  once the interface gains an `expiresAt`) **or** a dedicated
  `private`-schema metadata row. The **value** of the CE key stays in whatever
  custody S0-7.2 lands (Secret Manager) — **out of scope here**.
- **This doc owns only:** the clock surfacing + the T-30 alarm wiring for that
  date. **Cross-lane handoff → L3 (S0-7.2)** owns the actual custody/move.

### 3.5 Proof signing key / WIF / GetBlock (L1) — reference-only

- **Proof signing key clock** is already legible: the published registry
  `services/worker/proof-keys.public.json` (served by
  `services/worker/src/api/proof-keys.ts`) carries `created_at` and
  `retired_at` per `ProofKey`. The dashboard reads this registry to compute a
  rotation age for the active key — **no KMS round-trip, no key material.**
- **WIF / GetBlock** clocks come from GCP Secret Manager version metadata
  (read-only), same mechanism as §3.3.
- **L2 surfaces these read-only with an `owner_lane: L1` badge.** Rotation
  policy + action are **Lane-1's** (cross-lane handoff). The panel must not
  imply L2 will rotate them.

---

## 4. T-30 alarm mechanism

**Design principle:** clone the **proven** `db-health-monitor` shape
(`services/worker/src/jobs/db-health-monitor.ts` + its cron registration at
`services/worker/src/routes/cron.ts:1498` — `cronRouter.post('/db-health', …)`
wrapped in `withCronMonitoring('db-health-monitor', '*/5 * * * *', …)`).
The expiry monitor is a **once-daily** sibling, not 5-minutely.

### 4.1 New cron job

- **Job:** `runKeyExpiryMonitor()` in a new
  `services/worker/src/jobs/key-expiry-monitor.ts` (Sprint 1). It composes
  two reads: (a) `get_expiring_api_keys(30)` RPC (§3.1), and (b) the
  refactored `checkRotationStatus(getSecretInventory(), now)` from
  `secret-rotation-reminder.ts` (with **real** timestamps, §3.3/§6).
- **Endpoint:** `cronRouter.post('/key-expiry', …)` in `cron.ts`, wrapped:
  `withCronMonitoring('key-expiry-monitor', '0 13 * * *', …)` — daily at
  13:00 UTC (off-peak; one check/day is sufficient for a 30-day horizon).
  Auth reuses the existing `verifyCronAuth` (`cron.ts:161`) —
  X-Cron-Secret / platform-admin Bearer / Google OIDC — no new auth surface.
- **Resilience:** mirror db-health's `Promise.allSettled` fan-out
  (`db-health-monitor.ts:222`) so a failed RPC read doesn't blank the
  secret-rotation read and vice-versa.

### 4.2 Thresholds (3 bands)

Computed as `daysToExpiry = floor((expires_at - now) / 1 day)` per item:

| Band | Condition | Severity | Routing |
|---|---|---|---|
| **T-30** | `0 < daysToExpiry ≤ 30` | `warning` | Sentry + dashboard amber |
| **T-7** | `0 < daysToExpiry ≤ 7` | `error` | Sentry + dashboard red + **CE headline** if CE key |
| **Expired** | `daysToExpiry ≤ 0` (and still `is_active`/in use) | `error` | Sentry + dashboard red, top of list |

(The reminder stub's existing 90-day rotation / 7-day warning window is a
separate, complementary signal for *rotation age*; the T-30/T-7/expired bands
above are for *hard expiry dates* like the CE key and `api_keys.expires_at`.)

### 4.3 Routing

1. **Sentry** — `Sentry.captureMessage(...)` with structured tags, exactly the
   db-health idiom (`db-health-monitor.ts:188-204`): `source:
   'key-expiry-monitor'`, `story: 'SCRUM-2507'`, `alert_type` (one of
   `api_key_expiry` / `secret_rotation_overdue` / `ce_key_expiry`), and
   context tags (`key_prefix`, `secret_name`, `days_to_expiry`,
   `owner_lane`). **No values** — `key_prefix` and `name` only. The Sentry
   `scrubPiiFromEvent` scrubber (`services/worker/src/utils/sentry.ts:75-154`, invoked by `beforeSend` at `sentry.ts:237`) is an
   additional backstop (it redacts `ak_(live|test)_…`, JWTs, emails, UUIDs),
   but the monitor must never *rely* on the scrubber — it passes
   metadata-only by construction.
2. **Admin dashboard** — the daily snapshot is what the panel renders (§5);
   the panel can also call the read RPC directly for a live view.
3. **CE headline** — when the CE-key item enters T-30, additionally emit a
   distinct `alert_type: 'ce_key_expiry'` so a dedicated Sentry alert rule can
   page (and so Agent A's board can render it as the headline signal). This is
   the one alarm that must never be missed before ~Sept 2026.

> **Sentry alert-rule note:** the routing fan-out per `alert_type` is configured
> in `infra/sentry/alert-rules.json` (the same file db-health keys on —
> `db-health-monitor.ts:127`). Adding the three new `alert_type` values there
> is Sprint-1 work; this doc only specifies the values.

### 4.4 Idempotency / no-spam

- **Stable fingerprints per item** so a key that sits in T-30 for 30 days
  collapses into **one** Sentry issue with an incrementing count, not 30 new
  issues — directly reuse the pattern documented for the stuck-anchor monitor
  (`sentry.ts:251-287`, `STUCK_ANCHOR_FINGERPRINT`). Fingerprint =
  `['key-expiry', <stable-id>]` where `<stable-id>` is `key_prefix` for API
  keys or `secret_name` for secrets (never the value).
- **Band-edge only, optionally:** to reduce even the single-issue churn, the
  job may emit at **band transitions** (entering T-30, entering T-7, expiring)
  rather than every daily run; daily re-emit with a stable fingerprint is the
  simpler default and is acceptable because the fingerprint dedupes.
- **Green path is quiet:** like db-health (`db-health-monitor.ts:273-275`) and
  the rotation stub (`secret-rotation-reminder.ts:96-99`), emit nothing /
  `logger.info` when all clocks are healthy.

---

## 5. Admin dashboard design (dedicated key-expiry panel)

### 5.1 Surface & placement

- A dedicated **admin-only** panel — its deep view lives behind the existing
  admin surface alongside `src/pages/SystemHealthPage.tsx` and
  `src/pages/PlatformOverviewPage.tsx`. Agent A's S0-5.1 board renders the
  *summary* expiry signal and **links to this panel** for the per-key detail.
- Reuse the established admin-page shell: `AppShell`, shadcn `Card` /
  `Badge` / `Skeleton`, Lucide icons, copy via `src/lib/copy.ts` — exactly
  what `SystemHealthPage.tsx` already imports (lines 28-37). A new
  `useKeyExpiry()` hook follows the `useSystemHealth()` pattern (same file,
  line 30) and queries the worker (service-role) — **never** Supabase directly
  from the browser for cross-org data.

### 5.2 Contents

- **Headline card — CE key:** big, fixed at the top, showing the ~Sept-2026
  date, days remaining, and an amber/red state once inside T-30. This is the
  panel's reason for existing.
- **Per-key table** (from `get_expiring_api_keys`): columns `key_prefix`,
  `name`, `org_id`, `rate_limit_tier`, `expires_at`, **days-to-expiry**,
  state badge (`active` / `expiring` / **`expired-but-valid`** / `revoked`).
  Sorted soonest-expiry first. The **`expired-but-valid`** badge (§3.2) is
  visually loudest.
- **Secrets-rotation table** (from the refactored `checkRotationStatus`):
  `secret_name`, `category`, last-rotated, age (days), state
  (`healthy` / `expiring-soon` / `overdue`), and an `owner_lane` badge
  (L1 / L2 / L3). L1 rows (proof key, WIF, GetBlock) are clearly marked
  "rotation owned by Lane 1."
- **Manual refresh** button mirroring `SystemHealthPage`'s
  `fetchHealth()` + 30s auto-refresh (`SystemHealthPage.tsx:42,66-74`).

### 5.3 RBAC (authority = worker DB flag)

- **Server-side gate is authoritative:** `isPlatformAdmin(userId)`
  (`services/worker/src/utils/platformAdmin.ts`) — reads the
  `profiles.is_platform_admin` DB flag, **fails secure** when null (SEC-3 /
  ARK-SEC-ADMIN). Every read RPC / worker route behind this panel must call it.
- **Frontend gate is UI-only:** `src/lib/platform.ts isPlatformAdmin(email)`
  is still a hardcoded `PLATFORM_ADMIN_EMAILS` whitelist (and
  `SystemHealthPage.tsx`'s header comment still says "hardcoded Arkova admin
  emails"). That is acceptable for *hiding* the nav entry but is **not** the
  security boundary — the worker DB-flag check is. **Flag for Carson (§7):**
  the frontend whitelist and the worker DB flag have drifted; Sprint 1 should
  align the panel's client gate to the DB flag (or explicitly accept the
  whitelist as cosmetic).

### 5.4 Privacy invariants (hard)

- **No secret values, ever** (§3 preamble; Constitution §1.4).
- **No PII** — no user emails, no document fingerprints. Identify keys by
  `key_prefix` + `name` only; the Sentry scrubber
  (`sentry.ts:19-55`) is the backstop, not the design.
- **Cross-org reads only via service-role worker**, never the browser client
  (RLS would block the browser anyway — `api_keys_select_own_org`).

---

## 6. Sprint-1 handoff → SCRUM-2507 (KEY-EXPIRY)

### 6.1 What to build

1. **RPC** `get_expiring_api_keys(p_within_days int)` — metadata-only,
   SECURITY DEFINER, `search_path = public`, service-role-only, `NOTIFY pgrst`
   (mirror `0299`/`0303`). New numbered migration per CLAUDE.md migration rules
   (NNNN prefix, `-- ROLLBACK:` comment, regen `database.types.ts`, seed,
   `db reset` test). **T3** when it lands (touches `supabase/migrations/`).
2. **Refactor `secret-rotation-reminder.ts`:** replace `lastRotatedAt: new
   Date()` (lines 20-38) with real GCP Secret Manager version-`createTime`
   reads; add an `expiresAt?: Date` to `SecretInventoryItem` for hard-expiry
   secrets (CE key); add the CE key + L1 signing keys to the inventory.
3. **New job** `key-expiry-monitor.ts` composing (1) + (2) with the
   T-30/T-7/expired bands (§4.2) and Sentry routing (§4.3) with stable
   fingerprints (§4.4).
4. **Cron** `cronRouter.post('/key-expiry', …)` wrapped in
   `withCronMonitoring('key-expiry-monitor', '0 13 * * *', …)` behind
   `verifyCronAuth`; register the schedule wherever the other daily crons are
   scheduled (Cloud Scheduler / pg_cron — match existing daily jobs).
5. **Sentry alert rules:** add `api_key_expiry`, `secret_rotation_overdue`,
   `ce_key_expiry` to `infra/sentry/alert-rules.json`; page on `ce_key_expiry`.
6. **Admin panel** + `useKeyExpiry()` hook (§5), linked from Agent A's
   S0-5.1 board.

### 6.2 Acceptance criteria (so Sprint 1 codes, not scopes)

- [ ] `get_expiring_api_keys(30)` returns **only** metadata (asserted: no
      `key_hash`/value in output); service-role-only; RLS unaffected.
- [ ] A key with `expires_at` ≤ now + 30d **and** `is_active = true` produces
      exactly **one** Sentry issue (stable fingerprint) tagged
      `alert_type=api_key_expiry`, `days_to_expiry`, `owner_lane`.
- [ ] An **expired-but-still-`is_active`** key is flagged distinctly (red,
      `expired-but-valid`) in both Sentry and the panel.
- [ ] The CE key inside T-30 emits a distinct `ce_key_expiry` alert that pages.
- [ ] `secret-rotation-reminder` no longer reports all-healthy unconditionally:
      a secret whose real rotation age ≥ 83d shows `expiring-soon`, ≥ 90d
      `overdue` (the thresholds already in the file).
- [ ] Admin panel renders CE headline + per-key table + secrets-rotation table
      with `owner_lane` badges; gated server-side by
      `isPlatformAdmin(userId)`; no values, no PII.
- [ ] Daily cron green-path emits nothing; failure of one read does not blank
      the other (`Promise.allSettled`).
- [ ] Repo green: `typecheck` + `lint` + `test` + `lint:copy`; new RPC tested
      via `db reset --local`.

### 6.3 Explicit cross-lane dependencies

- **→ Lane 3 (S0-7.2):** CE-key **custody/move into Secret Manager** is
  Lane-3/Carson. This design depends on L3 providing (a) the CE key's expiry
  metadata and (b) the Secret-Manager location to read its version metadata.
  L2 builds the alarm; L3 owns the secret.
- **→ Lane 1 (rotation policy):** proof signing key / WIF / GetBlock rotation
  **cadence and action** are Lane-1's. L2 reads `proof-keys.public.json`
  (`created_at`/`retired_at`) + Secret-Manager metadata to surface the clock;
  L1 confirms the rotation-policy thresholds the panel should warn at.
- **→ Agent A (S0-5.1):** A's board links here; agree the summary-signal
  contract (count of items in T-30 + worst band) so the two surfaces agree.

---

## 7. Open questions / decisions for Carson

1. **Does `validate_api_key` need to enforce `expires_at`?** Today it does
   not (§1.1) — an expired key still authenticates. The dashboard makes this
   *visible*; do we also want the auth RPC to **reject** expired keys (a
   separate, security-sensitive **T3** change to `0299`-lineage), or is
   visibility + manual `is_active` flip the intended workflow for now?
2. **CE key expiry — exact date + custody.** What is the precise ~Sept-2026
   expiry, and is the key already (or will it be, via S0-7.2) in GCP Secret
   Manager so the monitor can read its version metadata? Until then the date
   is operator-supplied config.
3. **Rotation-policy thresholds for L1 keys.** Is 90-day (the value baked into
   `secret-rotation-reminder.ts`) the right cadence for the **proof signing
   key** and **WIF**, or do those want a different window? (Lane-1 input.)
4. **Frontend RBAC drift.** Align `src/lib/platform.ts` (hardcoded email
   whitelist) to the worker `profiles.is_platform_admin` DB flag for this
   panel, or formally accept the whitelist as cosmetic-only? (§5.3.)
5. **Alert destination.** db-health routes Sentry → (alert-rules) Slack; the
   rotation stub posts directly to `SLACK_OPS_WEBHOOK_URL`. Standardize the
   expiry monitor on the **Sentry→alert-rules** path (recommended, consistent
   with db-health) and retire the stub's direct-Slack post?

---

## 8. NOT in scope / deferred

- **Implementation.** This is a read-only spec; all code/migration/cron work is
  Sprint 1 (SCRUM-2507).
- **The CE-key move into Secret Manager** — Lane-3 / Carson (**S0-7.2**). This
  doc covers only its visibility + T-30 alarm.
- **Lane-1 secret *rotation* (proof signing key, WIF, GetBlock).** L2 surfaces
  the clocks (read-only); rotation cadence + action stay with Lane 1.
- **The 3-signal internal-visibility board.** Agent A's
  `S0-5.1-internal-visibility-dashboard-spec.md` owns the dashboard-surface
  composition; this doc owns the deep expiry mechanism it links to.
- **Fixing the 0302/0303 duplicate-name migration pair** (known dup, SCRUM-2192)
  — mentioned for context only (§1.1); not touched here.
- **Auto-rotation / auto-renewal of any key.** This design *alerts*; it never
  rotates a secret or mints/renews a key.

---

_Lane 2 (Product & Growth) · API Engineer + Senior Full-stack · PI-1 Sprint 0 pre-design · feeds SCRUM-2507 · DRAFT · tier T0._
