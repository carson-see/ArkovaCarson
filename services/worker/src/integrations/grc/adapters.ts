/**
 * GRC Platform Adapters (CML-05)
 *
 * Implements IGrcAdapter for each supported GRC platform.
 * All HTTP calls use fetch with timeout and error handling.
 *
 * Platform API references:
 *   - Vanta: https://developer.vanta.com/
 *   - Drata: https://developers.drata.com/
 *   - Anecdotes: https://docs.anecdotes.ai/
 *
 * Constitution refs:
 *   - 1.4: OAuth tokens handled server-side only
 */

import { buildVerifyUrl } from '../../lib/urls.js';
import type { IGrcAdapter, GrcPlatform, GrcOAuthTokens, GrcEvidencePayload, GrcPushResult } from './types.js';

const FETCH_TIMEOUT_MS = 15_000;

/** Helper: fetch with timeout */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Vanta Adapter ──────────────────────────────────────

const VANTA_API_BASE = 'https://api.vanta.com';
const VANTA_AUTH_BASE = 'https://app.vanta.com/oauth';

export class VantaAdapter implements IGrcAdapter {
  readonly platform: GrcPlatform = 'vanta';

  constructor(
    private clientId: string,
    private clientSecret: string,
  ) {}

  getAuthUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'connectors.self:write-resource connectors.self:read-resource',
      state,
    });
    return `${VANTA_AUTH_BASE}/authorize?${params}`;
  }

  async exchangeAuthCode(code: string, redirectUri: string): Promise<GrcOAuthTokens> {
    const res = await fetchWithTimeout(`${VANTA_AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Vanta token exchange failed (${res.status}): ${body}`);
    }

    return await res.json() as GrcOAuthTokens;
  }

  async refreshAccessToken(refreshToken: string): Promise<GrcOAuthTokens> {
    const res = await fetchWithTimeout(`${VANTA_AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      throw new Error(`Vanta token refresh failed (${res.status})`);
    }

    return await res.json() as GrcOAuthTokens;
  }

  async pushEvidence(accessToken: string, evidence: GrcEvidencePayload): Promise<GrcPushResult> {
    const payload = {
      resource_id: evidence.verification_id,
      resource_type: 'ARKOVA_VERIFICATION',
      display_name: evidence.title,
      description: `Arkova verification: ${evidence.fingerprint.slice(0, 16)}... (${evidence.credential_type ?? 'CREDENTIAL'})`,
      resource_url: buildVerifyUrl(evidence.verification_id),
      metadata: {
        fingerprint: evidence.fingerprint,
        credential_type: evidence.credential_type,
        network_receipt: evidence.network_receipt,
        block_height: evidence.block_height,
        compliance_controls: evidence.compliance_controls,
        frameworks: evidence.frameworks,
        secured_at: evidence.secured_at,
      },
    };

    const res = await fetchWithTimeout(`${VANTA_API_BASE}/v1/resources`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { success: false, error: `Vanta push failed (${res.status}): ${body}` };
    }

    const data = await res.json() as { id?: string };
    return { success: true, external_evidence_id: data.id, response: data as Record<string, unknown> };
  }

  async testConnection(accessToken: string): Promise<{ valid: boolean; orgName?: string; error?: string }> {
    const res = await fetchWithTimeout(`${VANTA_API_BASE}/v1/organization`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (!res.ok) return { valid: false, error: `HTTP ${res.status}` };

    const data = await res.json() as { name?: string };
    return { valid: true, orgName: data.name };
  }
}

// ─── Drata Adapter ──────────────────────────────────────

const DRATA_API_BASE = 'https://public-api.drata.com';
const DRATA_AUTH_BASE = 'https://app.drata.com/oauth';

export class DrataAdapter implements IGrcAdapter {
  readonly platform: GrcPlatform = 'drata';

  constructor(
    private clientId: string,
    private clientSecret: string,
  ) {}

  getAuthUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'evidence:write evidence:read',
      state,
    });
    return `${DRATA_AUTH_BASE}/authorize?${params}`;
  }

  async exchangeAuthCode(code: string, redirectUri: string): Promise<GrcOAuthTokens> {
    const res = await fetchWithTimeout(`${DRATA_AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Drata token exchange failed (${res.status}): ${body}`);
    }

    return await res.json() as GrcOAuthTokens;
  }

  async refreshAccessToken(refreshToken: string): Promise<GrcOAuthTokens> {
    const res = await fetchWithTimeout(`${DRATA_AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) throw new Error(`Drata token refresh failed (${res.status})`);
    return await res.json() as GrcOAuthTokens;
  }

  async pushEvidence(accessToken: string, evidence: GrcEvidencePayload): Promise<GrcPushResult> {
    const payload = {
      external_id: evidence.verification_id,
      name: evidence.title,
      description: `Blockchain-verified credential (${evidence.credential_type ?? 'CREDENTIAL'}). Fingerprint: ${evidence.fingerprint.slice(0, 16)}...`,
      evidence_url: buildVerifyUrl(evidence.verification_id),
      controls: evidence.compliance_controls.map(c => ({
        control_id: c,
        framework: c.split('-')[0],
      })),
      collected_at: evidence.secured_at ?? evidence.created_at,
      metadata: {
        network_receipt: evidence.network_receipt,
        block_height: evidence.block_height,
        frameworks: evidence.frameworks,
      },
    };

    const res = await fetchWithTimeout(`${DRATA_API_BASE}/evidence`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { success: false, error: `Drata push failed (${res.status}): ${body}` };
    }

    const data = await res.json() as { id?: string };
    return { success: true, external_evidence_id: data.id, response: data as Record<string, unknown> };
  }

  async testConnection(accessToken: string): Promise<{ valid: boolean; orgName?: string; error?: string }> {
    const res = await fetchWithTimeout(`${DRATA_API_BASE}/company-profile`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (!res.ok) return { valid: false, error: `HTTP ${res.status}` };

    const data = await res.json() as { name?: string };
    return { valid: true, orgName: data.name };
  }
}

// ─── Anecdotes Adapter ──────────────────────────────────

const ANECDOTES_API_BASE = 'https://api.anecdotes.ai/v1';
const ANECDOTES_AUTH_BASE = 'https://auth.anecdotes.ai/oauth';

export class AnecdotesAdapter implements IGrcAdapter {
  readonly platform: GrcPlatform = 'anecdotes';

  constructor(
    private clientId: string,
    private clientSecret: string,
  ) {}

  getAuthUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'evidence:write',
      state,
    });
    return `${ANECDOTES_AUTH_BASE}/authorize?${params}`;
  }

  async exchangeAuthCode(code: string, redirectUri: string): Promise<GrcOAuthTokens> {
    const res = await fetchWithTimeout(`${ANECDOTES_AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anecdotes token exchange failed (${res.status}): ${body}`);
    }

    return await res.json() as GrcOAuthTokens;
  }

  async refreshAccessToken(refreshToken: string): Promise<GrcOAuthTokens> {
    const res = await fetchWithTimeout(`${ANECDOTES_AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) throw new Error(`Anecdotes token refresh failed (${res.status})`);
    return await res.json() as GrcOAuthTokens;
  }

  async pushEvidence(accessToken: string, evidence: GrcEvidencePayload): Promise<GrcPushResult> {
    const payload = {
      source: 'arkova',
      external_id: evidence.verification_id,
      title: evidence.title,
      description: `Arkova blockchain-anchored verification for ${evidence.credential_type ?? 'credential'}`,
      evidence_url: buildVerifyUrl(evidence.verification_id),
      controls: evidence.compliance_controls,
      frameworks: evidence.frameworks,
      collected_date: evidence.secured_at ?? evidence.created_at,
      properties: {
        fingerprint: evidence.fingerprint,
        network_receipt: evidence.network_receipt,
        block_height: evidence.block_height,
        chain_timestamp: evidence.chain_timestamp,
        status: evidence.status,
      },
    };

    const res = await fetchWithTimeout(`${ANECDOTES_API_BASE}/evidence`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { success: false, error: `Anecdotes push failed (${res.status}): ${body}` };
    }

    const data = await res.json() as { id?: string };
    return { success: true, external_evidence_id: data.id, response: data as Record<string, unknown> };
  }

  async testConnection(accessToken: string): Promise<{ valid: boolean; orgName?: string; error?: string }> {
    const res = await fetchWithTimeout(`${ANECDOTES_API_BASE}/workspace`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (!res.ok) return { valid: false, error: `HTTP ${res.status}` };

    const data = await res.json() as { name?: string };
    return { valid: true, orgName: data.name };
  }
}

// ─── Factory ────────────────────────────────────────────

/** Platform-specific OAuth2 client credentials from env */
export interface GrcPlatformCredentials {
  vanta?: { clientId: string; clientSecret: string };
  drata?: { clientId: string; clientSecret: string };
  anecdotes?: { clientId: string; clientSecret: string };
}

/** Create an adapter for the given platform */
export function createGrcAdapter(platform: GrcPlatform, creds: GrcPlatformCredentials): IGrcAdapter {
  const platformCreds = creds[platform];
  if (!platformCreds) {
    throw new Error(`No credentials configured for GRC platform: ${platform}`);
  }

  switch (platform) {
    case 'vanta':
      return new VantaAdapter(platformCreds.clientId, platformCreds.clientSecret);
    case 'drata':
      return new DrataAdapter(platformCreds.clientId, platformCreds.clientSecret);
    case 'anecdotes':
      return new AnecdotesAdapter(platformCreds.clientId, platformCreds.clientSecret);
  }
}

/** Load GRC credentials from environment variables */
export function loadGrcCredentials(): GrcPlatformCredentials {
  const creds: GrcPlatformCredentials = {};

  if (process.env.VANTA_CLIENT_ID && process.env.VANTA_CLIENT_SECRET) {
    creds.vanta = { clientId: process.env.VANTA_CLIENT_ID, clientSecret: process.env.VANTA_CLIENT_SECRET };
  }
  if (process.env.DRATA_CLIENT_ID && process.env.DRATA_CLIENT_SECRET) {
    creds.drata = { clientId: process.env.DRATA_CLIENT_ID, clientSecret: process.env.DRATA_CLIENT_SECRET };
  }
  if (process.env.ANECDOTES_CLIENT_ID && process.env.ANECDOTES_CLIENT_SECRET) {
    creds.anecdotes = { clientId: process.env.ANECDOTES_CLIENT_ID, clientSecret: process.env.ANECDOTES_CLIENT_SECRET };
  }

  return creds;
}
