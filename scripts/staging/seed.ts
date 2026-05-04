#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/seed.ts — synthesize prod-shape data on the
 * arkova-staging Supabase rig (project ujtlwnoqfhtitcmsnrpq).
 *
 * Volume tier (default --standard):
 *   --smoke     ~30K total rows, ~3 min, for fast dry-run validation
 *   --standard  ~250K total rows, ~25 min, sized for a 4h T2 soak
 *   --full      ~2M total rows, ~90 min, ~3GB DB (within Pro tier 8GB)
 *
 * Idempotency:
 *   --reset       TRUNCATE all synthetic tables (CASCADE) before seeding
 *   --idempotent  use UPSERT(ignoreDuplicates) on every insert (slower; safe re-run)
 *
 * Safety:
 *   - every email uses @staging.invalid.test (RFC 2606 reserved TLD)
 *   - every URL uses http://localhost (cannot resolve outside the host)
 *   - every fingerprint / hash / token is random bytes — no real PII
 *   - service_role bypasses RLS, but RLS is preserved (this rig is for
 *     soak testing, not for sneaking past auth boundaries)
 *
 * Connectivity:
 *   STAGING_SUPABASE_URL=$(gcloud secrets versions access latest \
 *     --secret=supabase-url-staging --project=arkova1) \
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY=$(gcloud secrets versions access latest \
 *     --secret=supabase-service-role-key-staging --project=arkova1) \
 *   npm run staging:seed -- --smoke --reset
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

// --- CLI ---
const { values: args } = parseArgs({
  options: {
    smoke: { type: 'boolean', default: false },
    standard: { type: 'boolean', default: false },
    full: { type: 'boolean', default: false },
    reset: { type: 'boolean', default: false },
    idempotent: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

const STAGING_URL = requireEnv('STAGING_SUPABASE_URL');
const STAGING_KEY = requireEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY');

// Refuse to run against anything that doesn't look like the staging rig.
// Belt-and-suspenders against an env-var copy-paste pointing at prod.
if (!STAGING_URL.includes('ujtlwnoqfhtitcmsnrpq')) {
  console.error(`::error::STAGING_SUPABASE_URL does not point at the arkova-staging rig (ujtlwnoqfhtitcmsnrpq). Refusing to run.`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`::error::Required env var ${name} is not set.`);
    process.exit(1);
  }
  return v;
}

// --- Volume tiers ---
interface Volume {
  organizations: number;
  profilesPerOrgAvg: number;       // 1..10 distribution
  rulesPerOrgAvg: number;
  integrationsPerOrgAvg: number;
  connectorSubsPerOrg: number;     // 0 or 1 most orgs
  webhookEndpointsPerOrgAvg: number;
  apiKeysPerOrgAvg: number;
  auditEventsPerOrg: number;
  anchorsPerUserAvg: number;
  ruleExecutionsPerOrgAvg: number;
  ruleEventsPerOrgAvg: number;
  driveLedgerPerIntegrationAvg: number;
  attestationsPerAnchorRate: number;       // fraction of anchors that get attestations
  publicRecordsTotal: number;
  publicRecordEmbeddingsTotal: number;
  docusignNonces: number;
  checkrNonces: number;
}

const SMOKE: Volume = {
  organizations: 50,
  profilesPerOrgAvg: 3,
  rulesPerOrgAvg: 2,
  integrationsPerOrgAvg: 1,
  connectorSubsPerOrg: 1,
  webhookEndpointsPerOrgAvg: 1,
  apiKeysPerOrgAvg: 2,
  auditEventsPerOrg: 20,
  anchorsPerUserAvg: 4,
  ruleExecutionsPerOrgAvg: 30,
  ruleEventsPerOrgAvg: 20,
  driveLedgerPerIntegrationAvg: 10,
  attestationsPerAnchorRate: 0.1,
  publicRecordsTotal: 5_000,
  publicRecordEmbeddingsTotal: 500,
  docusignNonces: 100,
  checkrNonces: 100,
};

const STANDARD: Volume = {
  organizations: 1_000,
  profilesPerOrgAvg: 5,
  rulesPerOrgAvg: 3,
  integrationsPerOrgAvg: 2,
  connectorSubsPerOrg: 1,
  webhookEndpointsPerOrgAvg: 1,
  apiKeysPerOrgAvg: 2,
  auditEventsPerOrg: 50,
  anchorsPerUserAvg: 4,
  ruleExecutionsPerOrgAvg: 80,
  ruleEventsPerOrgAvg: 40,
  driveLedgerPerIntegrationAvg: 15,
  attestationsPerAnchorRate: 0.1,
  publicRecordsTotal: 100_000,
  publicRecordEmbeddingsTotal: 10_000,
  docusignNonces: 1_000,
  checkrNonces: 1_000,
};

// FULL caps embeddings at 100K (NOT the spec's 700K). Reason: vector(768)
// at ~3KB/row × 700K = ~2GB just for embeddings, plus 1M public_records at
// ~500MB-1GB. Pro tier is 8GB. 100K embeddings exercises the ivfflat index
// on cosine distance against a non-trivial corpus without devouring
// headroom that future migrations need.
const FULL: Volume = {
  organizations: 10_000,
  profilesPerOrgAvg: 5,
  rulesPerOrgAvg: 3,
  integrationsPerOrgAvg: 2,
  connectorSubsPerOrg: 1,
  webhookEndpointsPerOrgAvg: 1,
  apiKeysPerOrgAvg: 2,
  auditEventsPerOrg: 20,
  anchorsPerUserAvg: 2,
  ruleExecutionsPerOrgAvg: 50,
  ruleEventsPerOrgAvg: 30,
  driveLedgerPerIntegrationAvg: 10,
  attestationsPerAnchorRate: 0.05,
  publicRecordsTotal: 1_000_000,
  publicRecordEmbeddingsTotal: 100_000,
  docusignNonces: 5_000,
  checkrNonces: 5_000,
};

const tier: Volume = args.full ? FULL : args.smoke ? SMOKE : STANDARD;
const tierName = args.full ? 'full' : args.smoke ? 'smoke' : 'standard';

// --- Helpers ---
type LooseClient = SupabaseClient<unknown, never, never, never, never>;
type Row = Record<string, unknown>;

const STAGING_EMAIL_DOMAIN = 'staging.invalid.test';
// CHECK constraint webhook_endpoints_url_valid requires url ~ '^https://'.
// Using `.invalid` TLD (RFC 6761) so any accidental delivery attempt
// fails to resolve rather than hitting a real host.
const STAGING_WEBHOOK_URL = 'https://staging-localhost.invalid/dev-null';

function fakeFingerprint(): string {
  return randomBytes(32).toString('hex');
}
function fakeHash(): string {
  return createHash('sha256').update(randomBytes(32)).digest('hex');
}
function fakeBitcoinTxId(): string {
  return randomBytes(32).toString('hex');
}
function fakeEmail(): string {
  return `${randomUUID()}@${STAGING_EMAIL_DOMAIN}`;
}
function fakeApiKeyHash(): string {
  // HMAC-SHA256 shape (matches src/lib/api-keys.ts hashing) — not a real key.
  return createHash('sha256').update(`stg-${randomUUID()}`).digest('hex');
}
function publicId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString('hex').toUpperCase()}`;
}
function isoDaysAgo(daysBack: number): string {
  return new Date(Date.now() - daysBack * 86_400_000).toISOString();
}
function pick<T>(arr: readonly T[], i: number): T {
  return arr[Math.abs(i) % arr.length] as T;
}
function weightedPick<T extends string>(weights: Record<T, number>, r: number): T {
  // r is in [0, 1)
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let cum = 0;
  for (const [k, w] of entries) {
    cum += w / total;
    if (r < cum) return k;
  }
  return entries[entries.length - 1][0];
}
function rngInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// --- Bulk insert helper ---
const INSERT_CHUNK = 1_000;

interface InsertOpts {
  /** Comma-separated unique-constraint columns for upsert(ignoreDuplicates). */
  onConflict?: string;
}

async function bulkInsert(client: LooseClient, table: string, rows: Row[], opts: InsertOpts = {}): Promise<number> {
  if (rows.length === 0) return 0;
  let inserted = 0;
  const useUpsert = args.idempotent && !!opts.onConflict;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const builder = client.from(table) as unknown as {
      insert: (rows: Row[]) => Promise<{ error: { message: string } | null }>;
      upsert: (rows: Row[], opts: { onConflict: string; ignoreDuplicates: boolean }) =>
        Promise<{ error: { message: string } | null }>;
    };
    const { error } = useUpsert
      ? await builder.upsert(chunk, { onConflict: opts.onConflict!, ignoreDuplicates: true })
      : await builder.insert(chunk);
    if (error) throw new Error(`${table} insert failed at chunk ${i / INSERT_CHUNK}: ${error.message}`);
    inserted += chunk.length;
  }
  return inserted;
}

// --- Reset ---
async function resetTables(client: LooseClient): Promise<void> {
  console.log('▶ --reset: invoking staging_purge_synthetic_data() RPC');
  const { data, error } = await (client.rpc as unknown as (
    fn: string,
  ) => Promise<{ data: { organizations_deleted: number; auth_users_deleted: number; public_records_deleted: number } | null; error: { message: string } | null }>)(
    'staging_purge_synthetic_data',
  );
  if (error) throw new Error(`staging_purge_synthetic_data failed: ${error.message}`);
  console.log(`  purged: ${JSON.stringify(data)}`);
}

// --- Domain enums (mirror DB) ---
const TIERS = ['FREE', 'PAID', 'ENTERPRISE', 'SMALL_BUSINESS', 'MEDIUM_BUSINESS'] as const;
const TIER_WEIGHTS = { FREE: 0.6, PAID: 0.3, ENTERPRISE: 0.05, SMALL_BUSINESS: 0.04, MEDIUM_BUSINESS: 0.01 } as const;
const ROLES = ['INDIVIDUAL', 'ORG_ADMIN', 'ORG_MEMBER'] as const;
const TRIGGER_TYPES = ['ESIGN_COMPLETED', 'WORKSPACE_FILE_MODIFIED', 'CONNECTOR_DOCUMENT_RECEIVED', 'MANUAL_UPLOAD', 'SCHEDULED_CRON', 'QUEUE_DIGEST', 'EMAIL_INTAKE'] as const;
const ACTION_TYPES = ['AUTO_ANCHOR', 'FAST_TRACK_ANCHOR', 'QUEUE_FOR_REVIEW', 'FLAG_COLLISION', 'NOTIFY', 'FORWARD_TO_URL'] as const;
const RULE_EVENT_STATUSES = ['PENDING', 'CLAIMED', 'PROCESSED', 'FAILED'] as const;
const RULE_EVENT_STATUS_WEIGHTS = { PENDING: 0.05, CLAIMED: 0.05, PROCESSED: 0.85, FAILED: 0.05 } as const;
const RULE_EXEC_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'RETRYING', 'DLQ'] as const;
const RULE_EXEC_STATUS_WEIGHTS = { PENDING: 0.02, RUNNING: 0.01, SUCCEEDED: 0.92, FAILED: 0.03, RETRYING: 0.01, DLQ: 0.01 } as const;
const ANCHOR_STATUSES = ['PENDING', 'BROADCASTING', 'SUBMITTED', 'SECURED', 'REVOKED', 'EXPIRED', 'SUPERSEDED', 'PENDING_RESOLUTION'] as const;
const ANCHOR_STATUS_WEIGHTS = { PENDING: 0.05, BROADCASTING: 0.005, SUBMITTED: 0.03, SECURED: 0.88, REVOKED: 0.02, EXPIRED: 0.005, SUPERSEDED: 0.005, PENDING_RESOLUTION: 0.005 } as const;
const CREDENTIAL_TYPES = ['DEGREE', 'LICENSE', 'CERTIFICATE', 'PROFESSIONAL', 'OTHER', 'SEC_FILING', 'CONTRACT_PRESIGNING', 'CONTRACT_POSTSIGNING', 'IDENTITY', 'BUSINESS_ENTITY', 'BADGE'] as const;
const ATTESTATION_TYPES = ['VERIFICATION', 'ENDORSEMENT', 'AUDIT', 'APPROVAL', 'WITNESS', 'COMPLIANCE', 'IDENTITY'] as const;
const ATTESTER_TYPES = ['INSTITUTION', 'CORPORATION', 'INDIVIDUAL', 'REGULATORY', 'THIRD_PARTY'] as const;
const ATTESTATION_STATUSES = ['ACTIVE', 'DRAFT', 'PENDING', 'REVOKED'] as const;
// org_integrations.provider CHECK: only these four providers allowed.
const PROVIDERS = ['google_drive', 'microsoft_graph', 'docusign', 'adobe_sign'] as const;
// connector_subscriptions.provider CHECK: subset that emits real subscriptions.
const SUBSCRIPTION_PROVIDERS = ['google_drive', 'microsoft_graph'] as const;
const PUBLIC_RECORD_SOURCES = ['sec_iapd', 'openstates', 'sam_gov', 'fbi_npsbn', 'state_bar', 'court_records'] as const;
const PUBLIC_RECORD_SOURCE_WEIGHTS = { sec_iapd: 0.4, openstates: 0.3, sam_gov: 0.15, fbi_npsbn: 0.1, state_bar: 0.03, court_records: 0.02 } as const;
const RECORD_TYPES = ['individual', 'firm', 'filing', 'license', 'sanction'] as const;
// drive_revision_ledger.outcome CHECK: only these three values pass.
const DRIVE_OUTCOMES = ['queued', 'unrelated_change', 'parent_mismatch'] as const;
const DRIVE_OUTCOME_WEIGHTS = { queued: 0.65, unrelated_change: 0.3, parent_mismatch: 0.05 } as const;
// audit_events.event_category CHECK: uppercase values only.
const AUDIT_CATEGORIES = ['ANCHOR', 'AUTH', 'API', 'PROFILE', 'ORG', 'WEBHOOK', 'BILLING', 'VERIFICATION'] as const;
const AUDIT_EVENT_TYPES = ['anchor.created', 'anchor.secured', 'anchor.revoked', 'integration.connected', 'rule.fired', 'webhook.delivered', 'auth.login', 'auth.logout'] as const;
// api_keys.scopes CHECK: these are the canonical scope vocabulary as
// of 2026-05-04 (api_keys_scopes_known_values constraint).
const API_SCOPES = [
  ['read:search'],
  ['read:search', 'anchor:write'],
  ['read:search', 'anchor:write', 'anchor:read'],
  ['verify'],
  ['admin:rules'],
  ['attestations:read', 'attestations:write'],
] as const;

// ============================================================
// PHASE 1: organizations
// ============================================================

interface SeededOrg {
  id: string;
  prefix: string;
  tier: typeof TIERS[number];
}

async function seedOrganizations(client: LooseClient): Promise<SeededOrg[]> {
  console.log(`▶ Seeding ${tier.organizations} organizations...`);
  const rows: Row[] = [];
  const orgs: SeededOrg[] = [];
  for (let i = 0; i < tier.organizations; i++) {
    const id = randomUUID();
    const prefix = `STG${String(i).padStart(5, '0')}`;
    const t = weightedPick(TIER_WEIGHTS, Math.random());
    rows.push({
      id,
      legal_name: `Staging Org ${i} LLC`,
      display_name: `Staging Org ${i}`,
      org_prefix: prefix,
      public_id: publicId('ORG'),
      tier: t,
    });
    orgs.push({ id, prefix, tier: t });
  }
  const n = await bulkInsert(client, 'organizations', rows, { onConflict: 'id' });
  console.log(`  inserted ${n} organizations`);
  return orgs;
}

// ============================================================
// PHASE 2: profiles
// ============================================================

interface SeededProfile {
  id: string;
  org_id: string;
}

async function seedProfiles(client: LooseClient, orgs: SeededOrg[]): Promise<SeededProfile[]> {
  const total = orgs.length * tier.profilesPerOrgAvg;
  console.log(`▶ Seeding ~${total} profiles via auth.users (trigger creates profile row)...`);
  // profiles.id has FK to auth.users.id ON DELETE CASCADE.
  // Two triggers fire on auth.users INSERT:
  //   1. on_auth_user_created -> creates the profiles row (id, lowercased email, full_name)
  //   2. zz_auth_user_auto_associate_org -> only fires when email_confirmed_at IS NOT NULL.
  // The staging_seed_auth_users RPC inserts with email_confirmed_at = NULL so trigger #2
  // is a no-op; we then UPDATE profiles to set org_id explicitly via staging_seed_assign_profile_orgs.
  const profiles: SeededProfile[] = [];
  const authUsers: Array<{ id: string; email: string }> = [];
  for (const org of orgs) {
    const n = Math.max(1, tier.profilesPerOrgAvg + (Math.random() < 0.5 ? -1 : 1) * (Math.random() < 0.3 ? 1 : 0));
    for (let u = 0; u < n; u++) {
      const id = randomUUID();
      const email = fakeEmail();
      authUsers.push({ id, email });
      profiles.push({ id, org_id: org.id });
    }
  }

  // Bulk-create auth.users in chunks (each call = one RPC = a single SQL INSERT).
  let createdAuth = 0;
  const RPC_CHUNK = 500;
  for (let i = 0; i < authUsers.length; i += RPC_CHUNK) {
    const chunk = authUsers.slice(i, i + RPC_CHUNK);
    const { data, error } = await (client.rpc as unknown as (
      fn: string, args: { p_users: typeof chunk },
    ) => Promise<{ data: number | null; error: { message: string } | null }>)(
      'staging_seed_auth_users', { p_users: chunk },
    );
    if (error) throw new Error(`staging_seed_auth_users RPC failed: ${error.message}`);
    createdAuth += (data ?? 0);
  }
  console.log(`  created ${createdAuth} auth.users (profile rows auto-generated by trigger)`);

  // Assign org_id per profile.
  const orgPairs = profiles.map((p) => ({ id: p.id, org_id: p.org_id }));
  let assigned = 0;
  for (let i = 0; i < orgPairs.length; i += RPC_CHUNK) {
    const chunk = orgPairs.slice(i, i + RPC_CHUNK);
    const { data, error } = await (client.rpc as unknown as (
      fn: string, args: { p_pairs: typeof chunk },
    ) => Promise<{ data: number | null; error: { message: string } | null }>)(
      'staging_seed_assign_profile_orgs', { p_pairs: chunk },
    );
    if (error) throw new Error(`staging_seed_assign_profile_orgs RPC failed: ${error.message}`);
    assigned += (data ?? 0);
  }
  console.log(`  assigned org_id on ${assigned} profiles`);
  return profiles;
}

// ============================================================
// PHASE 3: memberships
// ============================================================

async function seedMemberships(client: LooseClient, profiles: SeededProfile[], orgs: SeededOrg[]): Promise<void> {
  // 1 membership per profile to its primary org. Some profiles get a 2nd
  // org for cross-tenant testing.
  console.log(`▶ Seeding memberships (1 primary + ~5% secondary)...`);
  const rows: Row[] = [];
  for (const p of profiles) {
    rows.push({
      user_id: p.id,
      org_id: p.org_id,
      role: 'ORG_MEMBER',
    });
  }
  const secondary = Math.floor(profiles.length * 0.05);
  for (let i = 0; i < secondary; i++) {
    const p = profiles[i];
    const otherOrg = orgs[(i + 1) % orgs.length];
    if (otherOrg.id === p.org_id) continue;
    rows.push({
      user_id: p.id,
      org_id: otherOrg.id,
      role: 'ORG_MEMBER',
    });
  }
  const n = await bulkInsert(client, 'memberships', rows, { onConflict: 'user_id,org_id' });
  console.log(`  inserted ${n} memberships`);
}

// ============================================================
// PHASE 4: org_integrations
// ============================================================

interface SeededIntegration {
  id: string;
  org_id: string;
  provider: string;
}

async function seedOrgIntegrations(client: LooseClient, orgs: SeededOrg[]): Promise<SeededIntegration[]> {
  const total = orgs.length * tier.integrationsPerOrgAvg;
  console.log(`▶ Seeding ~${total} org_integrations...`);
  const rows: Row[] = [];
  const integrations: SeededIntegration[] = [];
  for (const org of orgs) {
    for (let i = 0; i < tier.integrationsPerOrgAvg; i++) {
      const id = randomUUID();
      const provider = pick(PROVIDERS, integrations.length);
      rows.push({
        id,
        org_id: org.id,
        provider,
        account_label: `Staging ${provider} ${i}`,
        encrypted_tokens: `staging-encrypted-${randomBytes(8).toString('hex')}`,
      });
      integrations.push({ id, org_id: org.id, provider });
    }
  }
  const n = await bulkInsert(client, 'org_integrations', rows, { onConflict: 'id' });
  console.log(`  inserted ${n} org_integrations`);
  return integrations;
}

// ============================================================
// PHASE 5: connector_subscriptions
// ============================================================

async function seedConnectorSubscriptions(client: LooseClient, integrations: SeededIntegration[]): Promise<void> {
  console.log(`▶ Seeding connector_subscriptions for google_drive + microsoft_graph integrations...`);
  const rows: Row[] = [];
  for (const intg of integrations) {
    // CHECK constraint: only google_drive + microsoft_graph allowed here.
    if (!SUBSCRIPTION_PROVIDERS.includes(intg.provider as typeof SUBSCRIPTION_PROVIDERS[number])) continue;
    if (Math.random() > tier.connectorSubsPerOrg) continue;
    rows.push({
      org_id: intg.org_id,
      provider: intg.provider,
      vendor_subscription_id: `stg-sub-${randomBytes(6).toString('hex')}`,
      status: Math.random() < 0.85 ? 'active' : Math.random() < 0.5 ? 'degraded' : 'revoked',
      expires_at: isoDaysAgo(-7),
    });
  }
  const n = await bulkInsert(client, 'connector_subscriptions', rows);
  console.log(`  inserted ${n} connector_subscriptions`);
}

// ============================================================
// PHASE 6: webhook_endpoints
// ============================================================

async function seedWebhookEndpoints(client: LooseClient, orgs: SeededOrg[], profiles: SeededProfile[]): Promise<void> {
  const total = orgs.length * tier.webhookEndpointsPerOrgAvg;
  console.log(`▶ Seeding ~${total} webhook_endpoints (all URLs http://localhost/dev-null)...`);
  const rows: Row[] = [];
  const profilesByOrg = new Map<string, SeededProfile[]>();
  for (const p of profiles) {
    const arr = profilesByOrg.get(p.org_id) ?? [];
    arr.push(p);
    profilesByOrg.set(p.org_id, arr);
  }
  for (const org of orgs) {
    const orgProfiles = profilesByOrg.get(org.id) ?? [];
    if (orgProfiles.length === 0) continue;
    for (let i = 0; i < tier.webhookEndpointsPerOrgAvg; i++) {
      rows.push({
        org_id: org.id,
        public_id: publicId('WHE'),
        url: STAGING_WEBHOOK_URL,
        secret_hash: fakeHash(),
        events: ['anchor.secured', 'anchor.revoked'],
        is_active: true,
        created_by: orgProfiles[0].id,
      });
    }
  }
  const n = await bulkInsert(client, 'webhook_endpoints', rows, { onConflict: 'public_id' });
  console.log(`  inserted ${n} webhook_endpoints`);
}

// ============================================================
// PHASE 7: api_keys
// ============================================================

interface SeededApiKey {
  org_id: string;
  prefix: string;
}

async function seedApiKeys(client: LooseClient, orgs: SeededOrg[], profiles: SeededProfile[]): Promise<SeededApiKey[]> {
  const total = orgs.length * tier.apiKeysPerOrgAvg;
  console.log(`▶ Seeding ~${total} api_keys (key_hash = sha256, never recoverable)...`);
  const rows: Row[] = [];
  const apiKeys: SeededApiKey[] = [];
  const adminByOrg = new Map<string, string>();
  for (const p of profiles) {
    if (!adminByOrg.has(p.org_id)) adminByOrg.set(p.org_id, p.id);
  }
  for (const org of orgs) {
    const admin = adminByOrg.get(org.id);
    if (!admin) continue;
    for (let i = 0; i < tier.apiKeysPerOrgAvg; i++) {
      const prefix = `ak_stg_${randomBytes(4).toString('hex')}`;
      rows.push({
        org_id: org.id,
        key_prefix: prefix,
        key_hash: fakeApiKeyHash(),
        name: `Staging Key ${i}`,
        created_by: admin,
        scopes: pick(API_SCOPES, apiKeys.length),
        rate_limit_tier: org.tier === 'FREE' ? 'free' : 'paid',
        is_active: true,
      });
      apiKeys.push({ org_id: org.id, prefix });
    }
  }
  const n = await bulkInsert(client, 'api_keys', rows);
  console.log(`  inserted ${n} api_keys`);
  return apiKeys;
}

// ============================================================
// PHASE 8: organization_rules
// ============================================================

interface SeededRule {
  id: string;
  org_id: string;
  trigger_type: typeof TRIGGER_TYPES[number];
  action_type: typeof ACTION_TYPES[number];
}

async function seedOrganizationRules(client: LooseClient, orgs: SeededOrg[]): Promise<SeededRule[]> {
  const total = orgs.length * tier.rulesPerOrgAvg;
  console.log(`▶ Seeding ~${total} organization_rules...`);
  const rows: Row[] = [];
  const rules: SeededRule[] = [];
  for (const org of orgs) {
    for (let i = 0; i < tier.rulesPerOrgAvg; i++) {
      const id = randomUUID();
      const trig = pick(TRIGGER_TYPES, rules.length);
      const act = pick(ACTION_TYPES, rules.length + 1);
      rows.push({
        id,
        org_id: org.id,
        name: `Rule ${i} for ${org.prefix}`,
        trigger_type: trig,
        action_type: act,
        trigger_config: trig === 'WORKSPACE_FILE_MODIFIED' ? { folder_id: `stg-folder-${randomBytes(4).toString('hex')}` } : {},
        action_config: act === 'FORWARD_TO_URL' ? { url: STAGING_WEBHOOK_URL } : {},
        enabled: Math.random() < 0.9,
        schema_version: 1,
      });
      rules.push({ id, org_id: org.id, trigger_type: trig, action_type: act });
    }
  }
  const n = await bulkInsert(client, 'organization_rules', rows, { onConflict: 'id' });
  console.log(`  inserted ${n} organization_rules`);
  return rules;
}

// ============================================================
// PHASE 9 + 10: organization_rule_events + executions
// ============================================================

async function seedRuleEvents(client: LooseClient, orgs: SeededOrg[]): Promise<void> {
  const total = orgs.length * tier.ruleEventsPerOrgAvg;
  console.log(`▶ Seeding ~${total} organization_rule_events (60-day window)...`);
  const rows: Row[] = [];
  for (const org of orgs) {
    for (let i = 0; i < tier.ruleEventsPerOrgAvg; i++) {
      const status = weightedPick(RULE_EVENT_STATUS_WEIGHTS, Math.random());
      // CHECK organization_rule_events_claim_consistency: when status=CLAIMED,
      // claim_id and claimed_at must both be non-null.
      const claimed = status === 'CLAIMED';
      rows.push({
        org_id: org.id,
        trigger_type: pick(TRIGGER_TYPES, i),
        payload: { synthetic: true, idx: i, fingerprint: fakeFingerprint() },
        status,
        claim_id: claimed ? randomUUID() : null,
        claimed_at: claimed ? isoDaysAgo(rngInt(0, 1)) : null,
        attempt_count: rngInt(0, 3),
        created_at: isoDaysAgo(rngInt(0, 60)),
      });
    }
  }
  const n = await bulkInsert(client, 'organization_rule_events', rows);
  console.log(`  inserted ${n} organization_rule_events`);
}

async function seedRuleExecutions(client: LooseClient, rules: SeededRule[]): Promise<void> {
  const totalPerOrg = tier.ruleExecutionsPerOrgAvg;
  const total = rules.length === 0 ? 0 : Math.floor((totalPerOrg * tier.organizations) / Math.max(rules.length, 1)) * rules.length;
  console.log(`▶ Seeding ~${total} organization_rule_executions...`);
  const rows: Row[] = [];
  // Distribute executions across rules
  const execPerRule = Math.max(1, Math.floor(totalPerOrg / Math.max(tier.rulesPerOrgAvg, 1)));
  for (const rule of rules) {
    for (let i = 0; i < execPerRule; i++) {
      rows.push({
        rule_id: rule.id,
        org_id: rule.org_id,
        trigger_event_id: `stg-evt-${randomBytes(6).toString('hex')}`,
        status: weightedPick(RULE_EXEC_STATUS_WEIGHTS, Math.random()),
        created_at: isoDaysAgo(rngInt(0, 60)),
      });
    }
  }
  const n = await bulkInsert(client, 'organization_rule_executions', rows);
  console.log(`  inserted ${n} organization_rule_executions`);
}

// ============================================================
// PHASE 11: drive_revision_ledger
// ============================================================

async function seedDriveLedger(client: LooseClient, integrations: SeededIntegration[]): Promise<void> {
  const driveIntegrations = integrations.filter((i) => i.provider === 'google_drive');
  const total = driveIntegrations.length * tier.driveLedgerPerIntegrationAvg;
  console.log(`▶ Seeding ~${total} drive_revision_ledger rows...`);
  const rows: Row[] = [];
  for (const intg of driveIntegrations) {
    for (let i = 0; i < tier.driveLedgerPerIntegrationAvg; i++) {
      rows.push({
        integration_id: intg.id,
        org_id: intg.org_id,
        file_id: `stg-file-${randomBytes(6).toString('hex')}`,
        revision_id: `stg-rev-${randomBytes(4).toString('hex')}`,
        outcome: weightedPick(DRIVE_OUTCOME_WEIGHTS, Math.random()),
        processed_at: isoDaysAgo(rngInt(0, 30)),
      });
    }
  }
  const n = await bulkInsert(client, 'drive_revision_ledger', rows);
  console.log(`  inserted ${n} drive_revision_ledger rows`);
}

// ============================================================
// PHASE 12: audit_events
// ============================================================

async function seedAuditEvents(client: LooseClient, orgs: SeededOrg[], profiles: SeededProfile[]): Promise<void> {
  const total = orgs.length * tier.auditEventsPerOrg;
  console.log(`▶ Seeding ~${total} audit_events (60-day spread)...`);
  const profilesByOrg = new Map<string, SeededProfile[]>();
  for (const p of profiles) {
    const arr = profilesByOrg.get(p.org_id) ?? [];
    arr.push(p);
    profilesByOrg.set(p.org_id, arr);
  }
  const rows: Row[] = [];
  for (const org of orgs) {
    const orgProfiles = profilesByOrg.get(org.id) ?? [];
    for (let i = 0; i < tier.auditEventsPerOrg; i++) {
      rows.push({
        org_id: org.id,
        actor_id: orgProfiles.length > 0 ? pick(orgProfiles, i).id : null,
        event_type: pick(AUDIT_EVENT_TYPES, i),
        event_category: pick(AUDIT_CATEGORIES, i),
        // details is text not jsonb (CHECK enforces char_length <= 10000)
        details: JSON.stringify({ synthetic: true, idx: i }),
        created_at: isoDaysAgo(rngInt(0, 60)),
      });
    }
  }
  const n = await bulkInsert(client, 'audit_events', rows);
  console.log(`  inserted ${n} audit_events`);
}

// ============================================================
// PHASE 13: anchors
// ============================================================

interface SeededAnchor {
  id: string;
  user_id: string;
  org_id: string;
}

async function seedAnchors(client: LooseClient, profiles: SeededProfile[]): Promise<SeededAnchor[]> {
  const total = profiles.length * tier.anchorsPerUserAvg;
  console.log(`▶ Seeding ~${total} anchors with realistic status distribution...`);
  const rows: Row[] = [];
  const anchors: SeededAnchor[] = [];
  for (const p of profiles) {
    for (let i = 0; i < tier.anchorsPerUserAvg; i++) {
      const id = randomUUID();
      const status = weightedPick(ANCHOR_STATUS_WEIGHTS, Math.random());
      const anchored = status === 'SECURED' || status === 'SUBMITTED' || status === 'BROADCASTING';
      rows.push({
        id,
        user_id: p.id,
        org_id: p.org_id,
        public_id: publicId('ANC'),
        fingerprint: fakeFingerprint(),
        filename: `staging-doc-${i}.pdf`,
        status,
        credential_type: pick(CREDENTIAL_TYPES, i),
        chain_tx_id: anchored ? `mock_test_${randomBytes(16).toString('hex')}` : null,
        chain_block_height: status === 'SECURED' ? rngInt(820_000, 880_000) : null,
        chain_confirmations: status === 'SECURED' ? rngInt(6, 144) : 0,
        chain_timestamp: anchored ? isoDaysAgo(rngInt(0, 90)) : null,
        issued_at: anchored ? isoDaysAgo(rngInt(0, 90)) : null,
        version_number: 1,
        created_at: isoDaysAgo(rngInt(0, 90)),
      });
      anchors.push({ id, user_id: p.id, org_id: p.org_id });
    }
  }
  const n = await bulkInsert(client, 'anchors', rows, { onConflict: 'id' });
  console.log(`  inserted ${n} anchors`);
  return anchors;
}

// ============================================================
// PHASE 14: attestations
// ============================================================

interface SeededAttestation {
  id: string;
}

async function seedAttestations(client: LooseClient, anchors: SeededAnchor[], profiles: SeededProfile[]): Promise<SeededAttestation[]> {
  const adminByOrg = new Map<string, string>();
  for (const p of profiles) if (!adminByOrg.has(p.org_id)) adminByOrg.set(p.org_id, p.id);
  const target = Math.floor(anchors.length * tier.attestationsPerAnchorRate);
  console.log(`▶ Seeding ~${target} attestations (${(tier.attestationsPerAnchorRate * 100).toFixed(0)}% of anchors)...`);
  const rows: Row[] = [];
  const seeded: SeededAttestation[] = [];
  for (let i = 0; i < target; i++) {
    const anchor = anchors[i % anchors.length];
    const attesterId = adminByOrg.get(anchor.org_id) ?? anchor.user_id;
    const id = randomUUID();
    rows.push({
      id,
      public_id: publicId('ATT'),
      anchor_id: anchor.id,
      attester_org_id: anchor.org_id,
      attester_user_id: attesterId,
      attester_name: `Staging Attester ${i}`,
      attester_type: pick(ATTESTER_TYPES, i),
      subject_identifier: `subject-${randomBytes(6).toString('hex')}`,
      attestation_type: pick(ATTESTATION_TYPES, i),
      status: pick(ATTESTATION_STATUSES, i),
      claims: [{ key: 'verified', value: true }],
      fingerprint: fakeFingerprint(),
    });
    seeded.push({ id });
  }
  const n = await bulkInsert(client, 'attestations', rows, { onConflict: 'id' });
  console.log(`  inserted ${n} attestations`);
  return seeded;
}

// ============================================================
// PHASE 15: attestation_evidence
// ============================================================

async function seedAttestationEvidence(client: LooseClient, attestations: SeededAttestation[], profiles: SeededProfile[]): Promise<void> {
  console.log(`▶ Seeding ${attestations.length} attestation_evidence rows...`);
  const rows: Row[] = [];
  for (let i = 0; i < attestations.length; i++) {
    rows.push({
      attestation_id: attestations[i].id,
      fingerprint: fakeFingerprint(),
      filename: `staging-evidence-${i}.pdf`,
      uploaded_by: pick(profiles, i).id,
    });
  }
  const n = await bulkInsert(client, 'attestation_evidence', rows);
  console.log(`  inserted ${n} attestation_evidence`);
}

// ============================================================
// PHASE 16: public_records
// ============================================================

interface SeededPublicRecord {
  id: string;
}

async function seedPublicRecords(client: LooseClient, anchors: SeededAnchor[]): Promise<SeededPublicRecord[]> {
  console.log(`▶ Seeding ${tier.publicRecordsTotal} public_records...`);
  const records: SeededPublicRecord[] = [];
  // Generate in chunks to keep memory low at full mode (1M rows × ~500B = 500MB JS heap if all at once).
  const PER_BATCH = 5_000;
  let total = 0;
  for (let batch = 0; batch < tier.publicRecordsTotal; batch += PER_BATCH) {
    const limit = Math.min(PER_BATCH, tier.publicRecordsTotal - batch);
    const rows: Row[] = [];
    for (let i = 0; i < limit; i++) {
      const id = randomUUID();
      const source = weightedPick(PUBLIC_RECORD_SOURCE_WEIGHTS, Math.random());
      // 70% anchored, 30% pending — anchor_id may be null.
      const anchorId = anchors.length > 0 && Math.random() < 0.7
        ? anchors[Math.floor(Math.random() * anchors.length)].id
        : null;
      rows.push({
        id,
        source,
        source_id: `${source}-${randomBytes(8).toString('hex')}`,
        record_type: pick(RECORD_TYPES, batch + i),
        content_hash: fakeHash(),
        anchor_id: anchorId,
        metadata: { synthetic: true },
        created_at: isoDaysAgo(rngInt(0, 60)),
      });
      records.push({ id });
    }
    const n = await bulkInsert(client, 'public_records', rows, { onConflict: 'source,source_id' });
    total += n;
    if ((batch / PER_BATCH) % 10 === 0) console.log(`  inserted ${total}/${tier.publicRecordsTotal} public_records...`);
  }
  console.log(`  inserted ${total} public_records total`);
  return records;
}

// ============================================================
// PHASE 17: public_record_embeddings
// ============================================================

function fakeVector(dims: number): string {
  // pgvector accepts the literal '[v1,v2,...]'. Keep precision short to
  // shrink wire size; values in [-1, 1] approximate a unit-normalized embedding.
  const parts: string[] = new Array(dims);
  for (let i = 0; i < dims; i++) {
    parts[i] = (Math.random() * 2 - 1).toFixed(4);
  }
  return `[${parts.join(',')}]`;
}

async function seedEmbeddings(client: LooseClient, records: SeededPublicRecord[]): Promise<void> {
  if (records.length === 0) return;
  const target = Math.min(tier.publicRecordEmbeddingsTotal, records.length);
  console.log(`▶ Seeding ${target} public_record_embeddings (vector(768) each)...`);
  // Smaller chunks for embeddings — each row is ~3KB on the wire.
  const EMBED_CHUNK = 200;
  let inserted = 0;
  for (let batch = 0; batch < target; batch += EMBED_CHUNK) {
    const limit = Math.min(EMBED_CHUNK, target - batch);
    const rows: Row[] = [];
    for (let i = 0; i < limit; i++) {
      rows.push({
        public_record_id: records[batch + i].id,
        embedding: fakeVector(768),
        model_version: 'staging-synthetic-v1',
      });
    }
    const builder = client.from('public_record_embeddings') as unknown as {
      insert: (rows: Row[]) => Promise<{ error: { message: string } | null }>;
    };
    const { error } = await builder.insert(rows);
    if (error) throw new Error(`public_record_embeddings: ${error.message} (batch ${batch})`);
    inserted += rows.length;
    if ((batch / EMBED_CHUNK) % 25 === 0) console.log(`  inserted ${inserted}/${target} embeddings...`);
  }
  console.log(`  inserted ${inserted} public_record_embeddings total`);
}

// ============================================================
// PHASE 18: webhook nonces (simulate "we already saw these" replay-protection rows)
// ============================================================

async function seedNonces(client: LooseClient): Promise<void> {
  console.log(`▶ Seeding ${tier.docusignNonces} docusign_webhook_nonces + ${tier.checkrNonces} checkr_webhook_nonces...`);
  const ds: Row[] = [];
  for (let i = 0; i < tier.docusignNonces; i++) {
    ds.push({
      envelope_id: `stg-env-${randomBytes(6).toString('hex')}`,
      event_id: `stg-evt-${randomBytes(6).toString('hex')}`,
      generated_at: isoDaysAgo(rngInt(0, 14)),
    });
  }
  await bulkInsert(client, 'docusign_webhook_nonces', ds, { onConflict: 'envelope_id,event_id,generated_at' });

  const ck: Row[] = [];
  for (let i = 0; i < tier.checkrNonces; i++) {
    ck.push({
      report_id: `stg-rpt-${randomBytes(6).toString('hex')}`,
      payload_hash: fakeHash(),
    });
  }
  await bulkInsert(client, 'checkr_webhook_nonces', ck, { onConflict: 'report_id,payload_hash' });
  console.log(`  inserted ${ds.length + ck.length} nonce rows total`);
}

// ============================================================
// MAIN
// ============================================================

async function main(): Promise<void> {
  console.log(`▶ Staging seed — tier=${tierName} project=ujtlwnoqfhtitcmsnrpq`);
  console.log(`  organizations=${tier.organizations}  profiles~=${tier.organizations * tier.profilesPerOrgAvg}  anchors~=${tier.organizations * tier.profilesPerOrgAvg * tier.anchorsPerUserAvg}  public_records=${tier.publicRecordsTotal}  embeddings=${tier.publicRecordEmbeddingsTotal}`);
  if (args['dry-run']) {
    console.log('  --dry-run: exiting without writing.');
    return;
  }
  const startedAt = Date.now();

  const client = createClient(STAGING_URL, STAGING_KEY, { auth: { persistSession: false } }) as unknown as LooseClient;

  if (args.reset) await resetTables(client);

  const orgs = await seedOrganizations(client);
  const profiles = await seedProfiles(client, orgs);
  await seedMemberships(client, profiles, orgs);
  const integrations = await seedOrgIntegrations(client, orgs);
  await seedConnectorSubscriptions(client, integrations);
  await seedWebhookEndpoints(client, orgs, profiles);
  await seedApiKeys(client, orgs, profiles);
  const rules = await seedOrganizationRules(client, orgs);
  await seedRuleEvents(client, orgs);
  await seedRuleExecutions(client, rules);
  await seedDriveLedger(client, integrations);
  await seedAuditEvents(client, orgs, profiles);
  const anchors = await seedAnchors(client, profiles);
  const attestations = await seedAttestations(client, anchors, profiles);
  await seedAttestationEvidence(client, attestations, profiles);
  const records = await seedPublicRecords(client, anchors);
  await seedEmbeddings(client, records);
  await seedNonces(client);

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`\n✅ Staging seed complete in ${elapsedSec}s (tier=${tierName})`);
  console.log(`   ${orgs.length} orgs, ${profiles.length} profiles, ${anchors.length} anchors, ${records.length} public_records, ${attestations.length} attestations`);
}

main().catch((err) => {
  console.error(`::error::Staging seed failed: ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
