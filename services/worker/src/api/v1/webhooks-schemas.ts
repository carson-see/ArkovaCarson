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
  })
  .refine(
    (data) =>
      data.url !== undefined ||
      data.events !== undefined ||
      data.description !== undefined ||
      data.is_active !== undefined,
    { message: 'At least one field (url, events, description, is_active) must be provided' },
  );

export const ListWebhooksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
