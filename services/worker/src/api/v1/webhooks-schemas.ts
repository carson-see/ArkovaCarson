/**
 * Webhook CRUD Zod schemas — extracted from webhooks.ts so tests can import
 * them without pulling the db/config module graph. Pure validation, no side
 * effects, no Express, no runtime db access.
 */

import { z } from 'zod';

export const VALID_WEBHOOK_EVENTS = [
  'anchor.secured',
  'anchor.revoked',
  'anchor.expired',
] as const;

const DEFAULT_EVENTS: Array<(typeof VALID_WEBHOOK_EVENTS)[number]> = [
  'anchor.secured',
  'anchor.revoked',
];

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
