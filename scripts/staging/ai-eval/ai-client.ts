/**
 * scripts/staging/ai-eval/ai-client.ts — HTTP client + config for the AI soak
 * tooling. Drives the LIVE worker AI endpoints on a staging rig:
 *
 *   POST /api/v1/ai/extract   { strippedText, credentialType, fingerprint, issuerHint? }
 *                             → { fields, confidence, provider, ... }
 *   POST /api/v1/ai/template  { fields, confidence } → { templateType, sections, tags, ... }
 *   POST /api/v1/ai/tags      { fields }            → { tags, category, ... }
 *
 * ── Auth model (verified against services/worker/src/api/v1/router.ts) ───────
 * The `/api/v1/ai/*` routes are mounted `aiExtractionGate()` → `requireAuth`
 * → `aiRateLimiter`. `requireAuth` demands a **Supabase user JWT** in
 * `Authorization: Bearer <jwt>` (an `X-API-Key` or an `ak_`-prefixed bearer is
 * rejected). If the Cloud Run service is `--no-allow-unauthenticated`, the SAME
 * `Authorization` header is also what Cloud Run ingress checks — the app JWT and
 * the gcloud IAM token collide. The runbook resolves this by deploying the AI
 * soak rig `--allow-unauthenticated` (app-layer `requireAuth` still gates every
 * AI call) OR fronting it with an IAP/ESPv2 proxy that injects ingress auth
 * separately. This client sends ONLY the Supabase JWT.
 *
 * ── Rate limits ──────────────────────────────────────────────────────────────
 * `aiRateLimiter` = 30 req/min per authenticated user (keyed by authUserId).
 * The upstream anon limiter is 100 req/min per IP (AI calls carry no API key so
 * they land in the anon bucket). To sustain >= 5k req/hr (~83/min) the client
 * shards across N Supabase JWTs (>= 4 distinct users) and paces each user under
 * 30/min. A single source IP still caps aggregate at ~100/min — see the runbook
 * for the multi-egress-IP note.
 */

export const EXTRACT_PATH = '/api/v1/ai/extract';
export const TEMPLATE_PATH = '/api/v1/ai/template';
export const TAGS_PATH = '/api/v1/ai/tags';

export type AiEndpoint = 'extract' | 'template' | 'tags';

export const AI_PATHS: Record<AiEndpoint, string> = {
  extract: EXTRACT_PATH,
  template: TEMPLATE_PATH,
  tags: TAGS_PATH,
};

export interface ExtractRequestBody {
  strippedText: string;
  credentialType: string;
  fingerprint: string;
  issuerHint?: string;
}

export interface AiCallResult {
  endpoint: AiEndpoint;
  status: number;
  ok: boolean;
  latencyMs: number;
  /** Parsed JSON body when the response was JSON; undefined otherwise. */
  body?: unknown;
  /** Present only on transport error (status 0). */
  transportError?: string;
  /** Retry-After header (seconds) when a 429 was returned. */
  retryAfterSec?: number;
}

export interface FetchLike {
  (url: string, init?: RequestInit): Promise<{
    status: number;
    ok: boolean;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
}

/**
 * A JWT-bearing worker identity. Sharding load across several of these keeps
 * each user under the 30 req/min per-user AI limiter.
 */
export interface WorkerIdentity {
  /** Human label for evidence (e.g. "ai-soak-user-1"). Never a secret. */
  label: string;
  /** Supabase user JWT. Sent as `Authorization: Bearer <jwt>`. */
  jwt: string;
}

/**
 * Parse a colon/comma identity spec from env WITHOUT logging the JWTs.
 * Format: `STAGING_AI_JWTS="label1:eyJ...,label2:eyJ..."` (label optional —
 * bare `eyJ...` gets an auto label). Whitespace-tolerant.
 */
export function parseIdentities(raw: string | undefined): WorkerIdentity[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk, index) => {
      const sep = chunk.indexOf(':');
      // A JWT contains two dots but no colon in its header segment before the
      // first `.`; treat the FIRST colon as the label/jwt separator only when
      // the text before it is a short label (no dots) — otherwise it's a bare JWT.
      if (sep > 0) {
        const maybeLabel = chunk.slice(0, sep);
        if (!maybeLabel.includes('.')) {
          return { label: maybeLabel, jwt: chunk.slice(sep + 1) };
        }
      }
      return { label: `ai-soak-user-${index + 1}`, jwt: chunk };
    })
    .filter((identity) => identity.jwt.length > 0);
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const asSeconds = Number.parseInt(headerValue, 10);
  return Number.isFinite(asSeconds) && asSeconds >= 0 ? asSeconds : undefined;
}

async function safeJson(text: string): Promise<unknown> {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Fire one AI call against the live worker. Never throws — a transport failure
 * is returned as `{ status: 0, ok: false, transportError }` so the caller's
 * stats loop records it (silent catch is how dead-endpoint bugs hid for months).
 */
export async function callAiEndpoint(
  apiBase: string,
  endpoint: AiEndpoint,
  body: unknown,
  identity: WorkerIdentity,
  fetchImpl: FetchLike,
): Promise<AiCallResult> {
  const url = `${apiBase}${AI_PATHS[endpoint]}`;
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${identity.jwt}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return {
      endpoint,
      status: res.status,
      ok: res.ok,
      latencyMs: Date.now() - startedAt,
      body: await safeJson(text),
      retryAfterSec: res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : undefined,
    };
  } catch (err) {
    return {
      endpoint,
      status: 0,
      ok: false,
      latencyMs: Date.now() - startedAt,
      transportError: err instanceof Error ? err.message : String(err),
    };
  }
}
