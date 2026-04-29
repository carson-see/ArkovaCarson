/**
 * Middesk KYB client (SCRUM-1162)
 *
 * Minimal, dependency-free HTTP client for Middesk's Business Verification API
 * v1. Focused on the two flows Arkova needs right now:
 *
 *   1. Submit a business for verification → POST /v1/businesses
 *   2. Verify inbound webhook signatures → `verifyMiddeskSignature`
 *
 * Per 2026-04-24 user decision, this is NOT gated behind a feature flag for
 * testing. Sandbox vs production is controlled by `MIDDESK_SANDBOX` env
 * (default true). Missing `MIDDESK_API_KEY` surfaces as a 503 at the route
 * layer, never a silent success.
 *
 * Constitution refs:
 *   - 1.4: API key + webhook secret from Secret Manager, never logged.
 *   - 1.4: EIN + address are sensitive — never log, never attach to Sentry.
 *   - 1.7: Real network calls are mocked in tests; this module is pure HTTP
 *          plus a pure crypto function so stubs fit into vi.mock cleanly.
 */
import { z } from 'zod';
import { verifyHmacSha256Hex } from '../oauth/hmac.js';

const MIDDESK_BASE_SANDBOX = 'https://api-sandbox.middesk.com';
const MIDDESK_BASE_PROD = 'https://api.middesk.com';

/** Minimum info Middesk needs to start a verification. */
export interface MiddeskBusinessInput {
  /** Legal name as registered with the Secretary of State. */
  name: string;
  /** EIN / Federal Tax ID (9 digits, no hyphen). Never log. */
  ein: string;
  /** Registered business address. Never log. */
  address: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postal_code: string;
    country?: string;
  };
  /** Arkova-side org UUID, echoed back via webhook `external_id`. */
  external_id: string;
}

const MiddeskBusinessResponse = z.object({
  object: z.literal('business').optional(),
  id: z.string().min(1),
  status: z.string().optional(),
  external_id: z.string().optional().nullable(),
});

export type MiddeskBusinessResponseT = z.infer<typeof MiddeskBusinessResponse>;

const MiddeskWebhookEvent = z.object({
  object: z.literal('event').optional(),
  id: z.string().min(1),
  type: z.string().min(1),
  created_at: z.string().optional(),
  data: z
    .object({
      object: z
        .object({
          id: z.string().min(1),
          external_id: z.string().optional().nullable(),
          status: z.string().optional(),
        })
        .passthrough(),
    })
    .passthrough(),
});

export type MiddeskWebhookEventT = z.infer<typeof MiddeskWebhookEvent>;

export class MiddeskConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MiddeskConfigError';
  }
}

export class MiddeskApiError extends Error {
  status: number;
  // Keep Middesk's error body opaque — Arkova routes re-serialize a safe copy.
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'MiddeskApiError';
    this.status = status;
    this.body = body;
  }
}

export interface MiddeskClientDeps {
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override for tests. Defaults to reading process.env at call time. */
  env?: NodeJS.ProcessEnv;
}

export function getMiddeskBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  // Default sandbox. Only a literal 'false' flips to prod, so a missing or
  // mis-typed var is always the safer sandbox path.
  const sandbox = (env.MIDDESK_SANDBOX ?? 'true').toLowerCase() !== 'false';
  return sandbox ? MIDDESK_BASE_SANDBOX : MIDDESK_BASE_PROD;
}

function requireApiKey(env: NodeJS.ProcessEnv): string {
  const key = env.MIDDESK_API_KEY;
  if (!key || key.trim() === '') {
    throw new MiddeskConfigError('MIDDESK_API_KEY not set — provision it in Secret Manager before calling KYB endpoints.');
  }
  return key;
}

/**
 * Submit a business for KYB verification.
 *
 * Returns the Middesk `business.id`, which Arkova persists as
 * `organizations.kyb_reference_id`. Downstream webhooks arrive with the same
 * ID so the handler can look the org up via `kyb_reference_id`.
 *
 * Does NOT log `input` — it contains EIN + address.
 */
export async function submitBusiness(
  input: MiddeskBusinessInput,
  deps: MiddeskClientDeps = {},
): Promise<MiddeskBusinessResponseT> {
  const env = deps.env ?? process.env;
  const apiKey = requireApiKey(env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = getMiddeskBaseUrl(env);

  const res = await fetchImpl(`${base}/v1/businesses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: input.name,
      tax_id: input.ein,
      addresses: [
        {
          address_line1: input.address.line1,
          address_line2: input.address.line2 ?? null,
          city: input.address.city,
          state: input.address.state,
          postal_code: input.address.postal_code,
          country: input.address.country ?? 'US',
        },
      ],
      external_id: input.external_id,
    }),
  });

  const bodyText = await res.text();
  let bodyJson: unknown = null;
  try {
    bodyJson = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    // Body not JSON — leave as null; we still want to surface the HTTP error.
  }

  if (!res.ok) {
    throw new MiddeskApiError(
      `Middesk submitBusiness failed (HTTP ${res.status})`,
      res.status,
      bodyJson,
    );
  }

  const parsed = MiddeskBusinessResponse.safeParse(bodyJson);
  if (!parsed.success) {
    throw new MiddeskApiError('Middesk response failed schema validation', 502, bodyJson);
  }
  return parsed.data;
}

/**
 * Verify a Middesk webhook signature.
 *
 * Middesk signs outbound webhooks with HMAC-SHA256 over the raw request body
 * using a per-project `webhook_secret`. The signature arrives as a hex string
 * in the `x-middesk-signature` header.
 *
 * Returns `true` if the signature matches using a constant-time compare. Any
 * missing input yields `false` — the route treats that as 401.
 */
export function verifyMiddeskSignature(args: {
  rawBody: Buffer | string;
  signature: string | undefined;
  secret: string;
}): boolean {
  // SCRUM-1282 (R3-9): delegate to the canonical helper so all webhook
  // handlers share one constant-time HMAC implementation. Behavior is
  // identical (raw-body, hex-digest, length check, timingSafeEqual).
  return verifyHmacSha256Hex({
    rawBody: args.rawBody,
    signature: args.signature,
    secret: args.secret,
  });
}

/** Parse + validate the JSON body of a webhook payload. Throws on malformed input. */
export function parseMiddeskWebhookPayload(rawBody: Buffer | string): MiddeskWebhookEventT {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  const json = JSON.parse(text);
  return MiddeskWebhookEvent.parse(json);
}

/**
 * Map a Middesk event type to a coarse Arkova status. Full event type strings
 * still land in `kyb_events.event_type` for precise reporting.
 */
export function mapMiddeskEventToStatus(eventType: string): 'pending' | 'verified' | 'requires_input' | 'rejected' | 'error' {
  switch (eventType) {
    case 'business.updated':
      // Most common — fallback to pending; handler re-reads business.status.
      return 'pending';
    case 'business.verified':
      return 'verified';
    case 'business.requires_review':
    case 'business.manual_review':
      return 'requires_input';
    case 'business.rejected':
    case 'business.failed':
      return 'rejected';
    default:
      return 'error';
  }
}
