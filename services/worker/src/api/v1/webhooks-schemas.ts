/**
 * Webhook CRUD Zod schemas — extracted from webhooks.ts so tests can import
 * them without pulling the db/config module graph. Pure validation, no side
 * effects, no Express, no runtime db access.
 *
 * Single source of truth: `PAYLOAD_SCHEMAS_BY_EVENT_TYPE` keys in
 * `services/worker/src/webhooks/payload-schemas.ts`. The CRUD allowlist
 * (this file) and the dispatch validator (that file) must never diverge —
 * a previous divergence (the worker emitted `anchor.submitted` /
 * `anchor.batch_secured` for months while the CRUD allowlist rejected
 * subscriptions to them) is what SCRUM-1794 was filed to fix.
 */

import { z } from 'zod';
import { PAYLOAD_SCHEMAS_BY_EVENT_TYPE, type WebhookEventType } from '../../webhooks/payload-schemas.js';

// Derived from the dispatch validator's key set so the two cannot drift.
// `as [string, ...string[]]` is needed because `z.enum` wants a non-empty
// tuple type, not a generic string[]. Object.keys preserves insertion order
// for non-integer string keys (ES2015+), so the array order matches the
// declaration order in payload-schemas.ts.
export const VALID_WEBHOOK_EVENTS = Object.keys(
  PAYLOAD_SCHEMAS_BY_EVENT_TYPE,
) as [WebhookEventType, ...WebhookEventType[]];

const DEFAULT_EVENTS: WebhookEventType[] = ['anchor.secured', 'anchor.revoked'];

/**
 * SCRUM-3972 — endpoint delivery scope. Mirrors the DB CHECK added by
 * migration 0454 EXACTLY:
 *
 *   CONSTRAINT webhook_endpoints_scope_known_values
 *     CHECK (scope IN ('self', 'self_and_descendants'))
 *
 * so a request this schema accepts can never be a write the database refuses.
 * `.default('self')` matches the column default, which is what every endpoint
 * created before 0454 has.
 */
export const WEBHOOK_SCOPES = ['self', 'self_and_descendants'] as const;
export type WebhookScope = (typeof WEBHOOK_SCOPES)[number];

export const CreateWebhookSchema = z.object({
  url: z
    .string()
    .url('url must be a valid URL')
    .refine((u) => u.startsWith('https://'), 'url must use HTTPS'),
  events: z
    .array(z.enum(VALID_WEBHOOK_EVENTS))
    .min(1, 'events must contain at least one event type')
    .default(DEFAULT_EVENTS),
  description: z.string().max(500).optional(),
  /** Opt-in: send a verification ping (POST with challenge token) after persisting */
  verify: z.boolean().optional(),
  scope: z.enum(WEBHOOK_SCOPES).optional().default('self'),
});

export const UpdateWebhookSchema = z
  .object({
    url: z
      .string()
      .url('url must be a valid URL')
      .refine((u) => u.startsWith('https://'), 'url must use HTTPS')
      .optional(),
    events: z.array(z.enum(VALID_WEBHOOK_EVENTS)).min(1).optional(),
    description: z.string().max(500).nullable().optional(),
    is_active: z.boolean().optional(),
    // No `.default()` here: on a PATCH an absent field must stay absent so the
    // stored value is preserved. Defaulting would silently reset every
    // endpoint's scope to 'self' on an unrelated description edit.
    scope: z.enum(WEBHOOK_SCOPES).optional(),
  })
  .refine(
    (data) =>
      data.url !== undefined ||
      data.events !== undefined ||
      data.description !== undefined ||
      data.is_active !== undefined ||
      data.scope !== undefined,
    { message: 'At least one field (url, events, description, is_active, scope) must be provided' },
  );

export const ListWebhooksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
