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
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

/**
 * CodeRabbit PR #738: validate every write path with Zod before DB
 * insertion. `partner` is interpolated into display_name / org_prefix /
 * public_id; constrain it to a slug shape so a malformed CLI value can't
 * inject HTML or whitespace into those columns. anchors/credits as
 * actual integers (z.coerce.number().int()) so "10foo" rejects rather
 * than truncating to 10.
 */
const ProvisionArgsSchema = z.object({
  partner: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,30}$/, 'partner must be a lowercase alphanumeric slug (1–31 chars, _ and - allowed)'),
  anchors: z.coerce.number().int().positive(),
  credits: z.coerce.number().int().nonnegative(),
  ownerEmail: z.string().email().optional(),
});

export type ProvisionArgs = z.infer<typeof ProvisionArgsSchema>;

interface ProvisionResult {
  org_id: string;
  org_public_id: string;
  org_slug: string;
  api_key: string;
  api_key_id: string;
  api_key_reused: boolean;
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

export function parseCliArgs(argv: string[]): ProvisionArgs {
  const { values } = parseArgs({
    args: argv.slice(2),
    options: {
      partner: { type: 'string' },
      anchors: { type: 'string' },
      credits: { type: 'string' },
      'owner-email': { type: 'string' },
    },
  });
  // Zod validates + coerces in one shot. "10foo" → fail; "10" → 10.
  return ProvisionArgsSchema.parse({
    partner: values.partner,
    anchors: values.anchors,
    credits: values.credits,
    ownerEmail: values['owner-email'],
  });
}

/**
 * CodeRabbit PR #738 CRITICAL: fail closed unless the target is explicitly
 * staging. Prefer `STAGING_SUPABASE_*` env vars. Allow non-staging only
 * if `ALLOW_PROD_PROVISIONING=true` is explicitly set — never via accident
 * of a shell that happens to have prod credentials in scope.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig {
  const stagingUrl = env.STAGING_SUPABASE_URL;
  const stagingKey = env.STAGING_SUPABASE_SERVICE_ROLE_KEY;
  const apiKeyHmacSecret = env.API_KEY_HMAC_SECRET;

  if (apiKeyHmacSecret == null || apiKeyHmacSecret === '') {
    throw new Error('Required env: API_KEY_HMAC_SECRET');
  }

  if (stagingUrl && stagingKey) {
    return { url: stagingUrl, serviceRoleKey: stagingKey, apiKeyHmacSecret };
  }

  if (stagingUrl && !stagingKey) {
    throw new Error('STAGING_SUPABASE_URL is set but STAGING_SUPABASE_SERVICE_ROLE_KEY is missing — set both or neither.');
  }
  if (!stagingUrl && stagingKey) {
    throw new Error('STAGING_SUPABASE_SERVICE_ROLE_KEY is set but STAGING_SUPABASE_URL is missing — set both or neither.');
  }

  // Non-staging fallback. Locked behind explicit opt-in to prevent the
  // failure mode where a developer's shell has prod creds loaded and
  // `npx tsx provision-sandbox-org.ts ...` quietly creates sandbox orgs
  // in production. ALLOW_PROD_PROVISIONING=true is the kill-switch.
  if (env.ALLOW_PROD_PROVISIONING !== 'true') {
    throw new Error(
      'STAGING_SUPABASE_URL + STAGING_SUPABASE_SERVICE_ROLE_KEY are required by default. ' +
      'Set both, or set ALLOW_PROD_PROVISIONING=true if you intentionally want to provision against prod.',
    );
  }

  const url = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('ALLOW_PROD_PROVISIONING=true requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${cfg.url}/rest/v1${path}`, {
      method,
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: prefer,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Supabase ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timeout);
  }
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

  // 2. Top-up org_credits — CodeRabbit CRITICAL: previously used
  // resolution=merge-duplicates which OVERWROTE anchor_quota/balance
  // rather than adding. Now we read the existing row first and sum.
  const existingCredits = await pgrest(
    cfg,
    'GET',
    `/org_credits?org_id=eq.${orgId}&select=anchor_quota,balance,purchased,is_test&limit=1`,
  ) as Array<{ anchor_quota: number | null; balance: number; purchased: number; is_test: boolean }>;

  const prevQuota = existingCredits[0]?.anchor_quota ?? 0;
  const prevBalance = existingCredits[0]?.balance ?? 0;
  const prevPurchased = existingCredits[0]?.purchased ?? 0;

  if (existingCredits.length > 0) {
    await pgrest(cfg, 'PATCH', `/org_credits?org_id=eq.${orgId}`, {
      is_test: true,
      anchor_quota: prevQuota + args.anchors,
      balance: prevBalance + args.credits,
      purchased: prevPurchased + args.credits,
    });
  } else {
    await pgrest(cfg, 'POST', '/org_credits', {
      org_id: orgId,
      is_test: true,
      anchor_quota: args.anchors,
      balance: args.credits,
      monthly_allocation: 0,
      purchased: args.credits,
    });
  }

  // 3. Mint scoped API key — CodeRabbit MAJOR: previously inserted a
  // fresh active key on every run AND attributed to an arbitrary profile.
  // Now: prefer ownerEmail for created_by; if an active key already
  // exists with this label, reuse rather than accumulate.
  const existingKeys = await pgrest(
    cfg,
    'GET',
    `/api_keys?org_id=eq.${orgId}&name=eq.${encodeURIComponent(`${args.partner} sandbox pilot`)}&is_active=eq.true&select=id,key_prefix&limit=1`,
  ) as Array<{ id: string; key_prefix: string }>;

  let keyId: string;
  let raw: string;
  let keyReused = false;

  if (existingKeys.length > 0) {
    keyId = existingKeys[0].id;
    raw = `<existing key — re-fetch from your records; not re-derivable from key_prefix=${existingKeys[0].key_prefix}>`;
    keyReused = true;
  } else {
    const minted = generateApiKey('ak_test_');
    keyId = minted.keyId;
    raw = minted.raw;
    const hash = hmacApiKey(raw, cfg.apiKeyHmacSecret);

    // Prefer the partner contact email for created_by attribution. If
    // ownerEmail is provided, find that profile; otherwise fall back to
    // the script-runner's profile via SUPABASE_RUNNER_USER_ID env, then
    // any-profile as last resort (admin context).
    let createdBy: string | undefined;
    if (args.ownerEmail) {
      const byEmail = await pgrest(
        cfg,
        'GET',
        `/profiles?email=eq.${encodeURIComponent(args.ownerEmail)}&select=id&limit=1`,
      ) as Array<{ id: string }>;
      createdBy = byEmail[0]?.id;
    }
    if (!createdBy && process.env.SUPABASE_RUNNER_USER_ID) {
      createdBy = process.env.SUPABASE_RUNNER_USER_ID;
    }
    if (!createdBy) {
      const profiles = await pgrest(cfg, 'GET', '/profiles?select=id&limit=1') as Array<{ id: string }>;
      createdBy = profiles[0]?.id;
    }
    if (!createdBy) {
      throw new Error('No profile rows in DB; cannot satisfy api_keys.created_by NOT NULL.');
    }

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
  }

  return {
    org_id: orgId,
    org_public_id: orgPublicId,
    org_slug: slug,
    api_key: raw,
    api_key_id: keyId,
    api_key_reused: keyReused,
    anchor_quota: prevQuota + args.anchors,
    credits_balance: prevBalance + args.credits,
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
