# Prod → Staging Scrub Classification — 2026-05-04

> **Source artifact for** [`docs/staging/clone-execution-plan-2026-05-04.md`](../staging/clone-execution-plan-2026-05-04.md). Companion to [`prod-column-inventory-2026-05-04.csv`](./prod-column-inventory-2026-05-04.csv) (per-column row) and [`jsonb-scrub-plan-2026-05-04.md`](./jsonb-scrub-plan-2026-05-04.md) (per-key jsonb scrub).
>
> **Status:** DRAFT — awaiting Carson sign-off per Phase 11.1 of the master plan. No prod data has moved.
>
> **Approach:** Option B-Hybrid (confirmed 2026-05-04). Scrubbed real-data clone of small/control-plane tables only; the four giants (`anchors`, `public_records`, `public_record_embeddings`, `audit_events`) plus their derivatives are out-of-scope and handled by Option A's synthetic generator.

---

## Why this matters

CLAUDE.md §1.4 mandates RLS+PII protection on every table; §1.5 / §1.6 establish that documents never leave the user's device and only PII-stripped metadata flows server-side. A prod→staging clone that misses a single PII column violates the constitution and risks GDPR/FERPA/CCPA exposure. The classification below is the contract: every column with rows in prod has an assigned strategy; every strategy has a rationale.

## Classification taxonomy

| Class | Strategy | Examples | Rationale |
|---|---|---|---|
| **PII-DIRECT** | Scrub before any data leaves the dump | email, full_name, phone, address, free-text descriptions, OCR'd document fields | Direct PII under GDPR/CCPA. A single leak = legal exposure. |
| **PII-INDIRECT** | Passthrough | user_id uuid, org_id uuid, anchor_id uuid | UUIDs themselves carry no PII. Linkage exists but staging doesn't expose any join surface to outsiders. |
| **CUSTOMER-INFRA** | Scrub | webhook_endpoints.url, stripe_customer_id, oauth tokens, vendor subscription ids, integration secrets | Replay risk: a real webhook URL fired from staging hits a real customer. A real Stripe customer id in staging Stripe would fail noisily but coupling is unsafe. |
| **PUBLIC-CHAIN** | Passthrough | chain_tx_id, fingerprint sha256, merkle_root | Already public on the Bitcoin chain (txids) or non-reversible (sha256 of a doc). Not PII. |
| **OPERATIONAL** | Passthrough | status enums, timestamps, counters, integer balances, system reference data (jurisdiction_rules, plans, freemail_domains, switchboard_flags) | No personal information. Often required for staging worker logic to behave realistically. |
| **GENERATED** | Regenerate or null | api_keys.key_hash (HMAC), oauth tokens, webhook secret_hash, totp secret, encrypted_password, recovery tokens, refresh_tokens, one_time_tokens.token_hash | Regenerate against a known staging secret so we can authenticate against the rig; never replay prod credentials. |
| **OUT-OF-SCOPE-OPTION-A** | Skip entirely | anchors, public_records, public_record_embeddings, audit_events, audit_events_archive, anchor_chain_index, anchor_proofs | Handled by Option A synthetic generator. NOT cloned in this work. |
| **SCHEMA-ONLY** | No rows to scrub | ~60 tables empty in prod | Schema replay alone covers them; scrubber file can be a no-op or skipped. |
| **VIEW / MV** | Refresh after load | public_org_profiles, mv_anchor_status_counts, mv_public_records_source_counts, v_slow_queries | Derived from underlying tables. Refresh against staging's synthetic giants after Option A's data lands. |

## Tables in scope (have rows in prod, must be scrubbed)

These are the tables where actual scrub work happens. Total in-scope rows: **~700** across all 12 tables.

| Table | Rows | PII columns | Risk |
|---|---|---|---|
| `auth.users` | 21 | email, encrypted_password, phone, raw_user_meta_data, all token columns | **CRITICAL** — emails are the keystone PII; encrypted_password must never replay |
| `public.profiles` | 21 | email, full_name, phone_number, bio, social_links, avatar_url, activation_token, identity_verification_session_id | **CRITICAL** — full identity info. Must scrub in same SALT-batch as auth.users for FK shape |
| `auth.identities` | varies | identity_data jsonb (contains email/sub), email, provider_id | **HIGH** — OAuth subject identifiers are user-linkable |
| `public.extraction_manifests` | 23 | extracted_fields jsonb (OCR'd doc content), confidence_scores | **CRITICAL** — this is the highest-PII column in the in-scope set. Document OCR output of customer credentials. |
| `public.ai_usage_events` | 211 | result_json jsonb, error_message | **HIGH** — extraction output cached for re-replay; null entire result_json |
| `public.credit_transactions` | 122 | reason text | **MED** — reason may contain filenames/labels |
| `public.credential_templates` | 26 | description (org-owned), default_metadata jsonb | **MED** — system templates safe; org-owned templates may carry company names |
| `public.verification_events` | 41 | ip_hash, user_agent, referrer | **MED** — ip_hash is hashed but per-IP linkable; referrer may reveal customer URL |
| `public.organizations` | 1 | legal_name, display_name, domain, ein_tax_id, location, suspended_reason, all OAuth/KYB ids | **HIGH** — single org but full corporate-identity surface |
| `public.api_keys` | 1 | key_hash, name, access_purpose, revocation_reason | **HIGH** — key_hash regen is the authentication-replay control |
| `public.attestations` | 1 | subject_identifier, attester_name, attester_title, claims jsonb, summary, metadata jsonb | **HIGH** — full attestation content |
| `public.compliance_audits` | 9 | per_jurisdiction/gaps/quarantines jsonb, error_message | **MED** — audit findings may reference document fingerprints/titles |

### Tables in scope with no PII (passthrough)

These have rows but contain only operational/reference/chain-public data. Schema-only-equivalent risk:

- `public.switchboard_flags` (20), `switchboard_flag_history` (16) — system feature flag state. Override `ENABLE_PROD_NETWORK_ANCHORING=false` and `USE_MOCKS=true` post-load.
- `public.plans` (10) — system reference; replace `stripe_price_id` with `price_test_NNNN`.
- `public.jurisdiction_rules` (98), `freemail_domains` (46), `org_tier_entitlements` (4) — system reference data. No PII.
- `public.org_members` (2), `org_integrations` (1), `entitlements` (1) — org-uuid linkage only. Encrypted tokens nulled.
- `public.user_notifications` (4) — payload contains `txId/merkleRoot/batchId` only (chain-public).
- `public.cloud_logging_queue` (56), `treasury_cache` (1), `stats_cache` (3), `pipeline_dashboard_cache` (6) — caches/queues. Set `audit_id` FKs to NULL since `audit_events` is out-of-scope.
- `public.organization_rules` (1), `organization_rule_executions` (1) — rule definitions. `trigger_config` jsonb contains folder paths (PII-DIRECT, see jsonb plan); rest is operational.
- `public.ai_reports` (1), `integration_events` (1), `anchor_recipients` (1) — single-row carry-overs. Treat as PII-DIRECT for free-text fields.

### Tables explicitly out-of-scope (Option A handles)

- `public.anchors` (2.9M rows, 21 GB) — high-volume + highest PII concentration in `metadata` jsonb (filename, recipient, label).
- `public.public_records` (2.95M rows, 6.3 GB) — `title` + `metadata` jsonb hold real public-record subject names.
- `public.public_record_embeddings` (352K, 1.5 GB) — embeddings derived from `public_records.title/content`; carry residual PII.
- `public.audit_events` (382K, 141 MB) — `details` text contains user-action context, often emails / public_ids.
- `public.audit_events_archive` (0 rows but same shape) — schema-only.
- `public.anchor_chain_index` (174K, 72 MB), `anchor_proofs` (4K) — derivatives of `anchors`. Synthetic anchor ids drive synthetic indices/proofs.

These tables are re-created (synthetic) by `scripts/staging/load-harness.ts` working from the Option A generator. Out-of-scope here means **not loaded from prod data**, not "ignored" — they are populated, just from a different source.

## FK integrity strategy

Every PII-INDIRECT uuid in a scrubbed (in-scope) row may FK to either:
1. Another in-scope scrubbed row → preserves linkage shape, FK is valid post-load.
2. An out-of-scope (giant-table) row → must be set NULL or remapped to an Option-A synthetic id at scrub time.

Specific remapping cases (handled in scrubbers):
- `extraction_manifests.anchor_id` → NULL (or remapped to a synthetic anchor id by load-harness, depending on whether Option A pre-generates anchors before this load).
- `verification_events.anchor_id` → NULL.
- `attestations.anchor_id` → NULL.
- `anchor_recipients.anchor_id` → NULL (and table is single-row anyway).
- `cloud_logging_queue.audit_id` → NULL.

Determinism: if a scrubber stamps the same scrubbed value for the same input row across re-runs, FK shape is preserved across iterations. Use HMAC(input || SALT) for any value that participates in linkage.

## Scrub-strategy primitives

The scrub script (`scripts/staging/clone/scrub/<table>.ts`) composes from these:

| Primitive | Behavior | When to use |
|---|---|---|
| `passthrough` | Output = input unchanged | OPERATIONAL, PII-INDIRECT, PUBLIC-CHAIN |
| `null` | Output = NULL (column must be nullable) | Free-text, single-use tokens, op-only fields with PII |
| `replace_static(template)` | Output = template with row index substituted | Deterministic placeholders ("Staging User N") |
| `replace_with_fake(faker_method, seed)` | Output = `faker[method]({ seed: hash(input || SALT) })` | Names, phones, addresses |
| `deterministic_email` | Output = `md5(input || SALT)@staging.invalid.test` | Emails (preserves FK shape between auth.users.email and profiles.email) |
| `deterministic_hash` | Output = `md5(input || SALT)` truncated to original length | OAuth subject identifiers, hashed lookups |
| `replace_with_known(value)` | Output = a fixed known-test value | api_keys.key_hash → HMAC of "STAGING_TEST_KEY" |
| `replace_with_known_hash` | Output = HMAC of a fixed known-test recipient | anchor_recipients.recipient_email_hash |
| `force_false`, `force_true` | Boolean override | is_super_admin → false, suspended → false, USE_MOCKS-related flags |
| `regenerate(generator)` | Output = freshly-generated random of correct shape | refresh_token_hmac_key, totp secrets |
| `scrub_per_key` | Recurse into jsonb with per-key plan | See [`jsonb-scrub-plan-2026-05-04.md`](./jsonb-scrub-plan-2026-05-04.md) |

## SALT semantics

- **Single SALT for the whole clone run.** Generated once, stored in `scripts/staging/clone/.salt` (gitignored), passed via env var to every scrubber.
- **Same SALT across the run** = stable mappings within a run (FK shape preserved).
- **New SALT per run** = different scrubbed values across reruns = no cross-clone correlation if a hypothetical attacker gets two staging snapshots.
- **SALT ≥32 bytes random.** Generated by `openssl rand -hex 32`.
- **SALT never logged, never committed.** Treated as treasury-key-equivalent per CLAUDE.md §1.4.

## Auth schema specifics

Supabase manages `auth.*` and `storage.*` schemas internally. The staging Cloud Run worker reads `auth.users.email` for owner lookups and `auth.identities` for OAuth flows. Two non-obvious constraints:

1. **`auth.users.encrypted_password`** must be a valid bcrypt hash if the column is non-null, otherwise the Supabase auth GoTrue server errors on user lookup. Use a known bcrypt of `"staging-test-password-not-real"` for all 21 prod users so a fixture login is possible if needed; never copy the real bcrypt forward.
2. **`auth.users.id` and `public.profiles.id`** share the same UUID by Supabase contract. Both tables must scrub email to the **same** deterministic value (same SALT, same input) so a join still resolves consistently.

## Carson sign-off checkpoint

Per Phase 11.1 of the master plan, this document and the linked CSV must be reviewed and explicitly approved before any Phase 5 prod snapshot extraction begins. Approval = a comment "approved scrub-classification 2026-05-04" on the PR (or main commit) that lands these files. Until that comment exists, the next session does NOT proceed past Phase 4 (dry-run harness).

## Changelog

- **2026-05-04** — initial draft, B-Hybrid scope confirmed by Carson. ~12 tables in active scrub scope; ~60 schema-only; 7 OUT-OF-SCOPE-OPTION-A.
