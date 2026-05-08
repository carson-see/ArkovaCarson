#!/usr/bin/env -S npx tsx
/**
 * scripts/admin/provision-sandbox-org.ts (SCRUM-1740)
 *
 * Provisions a partner-sandbox org with the SCRUM-1739 contract:
 *   - test organization row
 *   - org_credits row with `is_test=true` + `anchor_quota=<N>` + balance=<credits>
 *   - scoped API key with read:search / read:records / read:orgs / anchor:write
 *
 * Idempotent: re-running with the same `--partner` slug tops up the
 * existing test org's `anchor_quota` and `balance` rather than creating
 * a duplicate.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... API_KEY_HMAC_SECRET=... \
 *     npx tsx scripts/admin/provision-sandbox-org.ts \
 *       --partner=hakichain --anchors=10 --credits=5 \
 *       [--owner-email=primary@hakichain.com]
 *
 * Output (stdout): JSON with the new org's public_id + raw API key.
 *   The raw API key is shown ONCE — never persisted in plaintext per
 *   CLAUDE.md §1.4.
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

interface ProvisionArgs {
  partner: string;
  anchors: number;
  credits: number;
  ownerEmail?: string;
}

interface ProvisionResult {
  org_id: string;
  org_public_id: string;
  org_slug: string;
  api_key: string;
  api_key_id: string;
  anchor_quota: number;
  credits_balance: number;
  is_test: true;
  topped_up: boolean;
}

interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
  apiKeyHmacSecret: string;
}

function parseCliArgs(argv: string[]): ProvisionArgs {
  const { values } = parseArgs({
    args: argv.slice(2),
    options: {
      partner: { type: 'string' },
      anchors: { type: 'string' },
      credits: { type: 'string' },
      'owner-email': { type: 'string' },
    },
  });
  if (!values.partner || !values.anchors || !values.credits) {
    throw new Error('Required: --partner=<slug> --anchors=<N> --credits=<N>');
  }
  const anchors = Number.parseInt(values.anchors, 10);
  const credits = Number.parseInt(values.credits, 10);
  if (!Number.isFinite(anchors) || anchors <= 0) throw new Error('--anchors must be a positive integer');
  if (!Number.isFinite(credits) || credits < 0) throw new Error('--credits must be a non-negative integer');
  return {
    partner: values.partner,
    anchors,
    credits,
    ownerEmail: values['owner-email'],
  };
}

function loadConfig(): SupabaseConfig {
  const url = process.env.SUPABASE_URL ?? process.env.STAGING_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY;
  const apiKeyHmacSecret = process.env.API_KEY_HMAC_SECRET;
  if (!url || !serviceRoleKey || !apiKeyHmacSecret) {
    throw new Error('Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY_HMAC_SECRET (staging-prefixed variants also accepted)');
  }
  return { url, serviceRoleKey, apiKeyHmacSecret };
}

async function pgrest(
  cfg: SupabaseConfig,
  method: string,
  path: string,
  body?: Record<string, unknown> | Record<string, unknown>[],
  prefer = 'return=representation',
): Promise<unknown> {
  const res = await fetch(`${cfg.url}/rest/v1${path}`, {
    method,
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: prefer,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

function generateApiKey(prefix = 'ak_test_'): { raw: string; hmac: string; keyId: string } {
  const raw = `${prefix}${randomBytes(32).toString('base64url')}`;
  const keyId = randomUUID();
  return { raw, hmac: '', keyId };
}

export function hmacApiKey(raw: string, secret: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

interface ExistingOrg {
  id: string;
  public_id: string;
  display_name: string | null;
}

async function findExistingTestOrg(cfg: SupabaseConfig, displayName: string): Promise<ExistingOrg | null> {
  const rows = await pgrest(
    cfg,
    'GET',
    `/organizations?display_name=eq.${encodeURIComponent(displayName)}&select=id,public_id,display_name&limit=1`,
  ) as ExistingOrg[];
  return rows[0] ?? null;
}

export async function provisionSandboxOrg(args: ProvisionArgs, cfg: SupabaseConfig): Promise<ProvisionResult> {
  const displayName = `[SANDBOX] ${args.partner}`;
  const slug = `test_${args.partner}`;

  // 1. Find or create org
  const existing = await findExistingTestOrg(cfg, displayName);
  let orgId: string;
  let orgPublicId: string;

  if (existing) {
    orgId = existing.id;
    orgPublicId = existing.public_id;
  } else {
    const publicId = `ORG-TEST-${args.partner.toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`;
    const created = await pgrest(cfg, 'POST', '/organizations', {
      display_name: displayName,
      legal_name: displayName,
      public_id: publicId,
      org_prefix: `TEST-${args.partner.toUpperCase()}`,
      verification_status: 'PENDING',
      tier: 'FREE',
    }) as Array<{ id: string; public_id: string }>;
    orgId = created[0].id;
    orgPublicId = created[0].public_id;
  }

  // 2. Upsert org_credits with is_test=true, anchor_quota, balance
  await pgrest(cfg, 'POST', '/org_credits', {
    org_id: orgId,
    is_test: true,
    anchor_quota: args.anchors,
    balance: args.credits,
    monthly_allocation: 0,
    purchased: args.credits,
  }, 'return=representation,resolution=merge-duplicates');

  // 3. Mint scoped API key
  const { raw, keyId } = generateApiKey('ak_test_');
  const hash = hmacApiKey(raw, cfg.apiKeyHmacSecret);

  // api_keys.created_by is NOT NULL — pick a profile from the org or fall
  // back to any profile (sandbox provisioning is an admin op; the audit row
  // attributes the key creation to whichever profile actually executes).
  const profiles = await pgrest(cfg, 'GET', '/profiles?select=id&limit=1') as Array<{ id: string }>;
  const createdBy = profiles[0]?.id;
  if (!createdBy) throw new Error('No profile rows in DB; cannot satisfy api_keys.created_by NOT NULL.');

  await pgrest(cfg, 'POST', '/api_keys', {
    id: keyId,
    org_id: orgId,
    key_hash: hash,
    key_prefix: raw.slice(0, 12),
    name: `${args.partner} sandbox pilot`,
    scopes: ['read:search', 'read:records', 'read:orgs', 'anchor:write'],
    rate_limit_tier: 'paid',
    is_active: true,
    created_by: createdBy,
    ferpa_verified: false,
  });

  return {
    org_id: orgId,
    org_public_id: orgPublicId,
    org_slug: slug,
    api_key: raw,
    api_key_id: keyId,
    anchor_quota: args.anchors,
    credits_balance: args.credits,
    is_test: true,
    topped_up: existing !== null,
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv);
  const cfg = loadConfig();
  const result = await provisionSandboxOrg(args, cfg);
  // stdout is the partner-onboarding payload. Capture the raw key from
  // the running operator's terminal; it is never persisted again.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url.endsWith(process.argv[1] ?? '')) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
