/**
 * Webhook CRUD Zod schemas — extracted from webhooks.ts so tests can import
 * them without pulling the db/config module graph. Pure validation, no side
 * effects, no Express, no runtime db access.
 */

import { z } from 'zod';

export const VALID_WEBHOOK_EVENTS = [
  // Per-anchor lifecycle (chain-level state of the cryptographic proof).
  // `anchor.submitted` fires from services/worker/src/jobs/anchor.ts after
  // tx broadcast; `anchor.secured` fires from check-confirmations.ts on the
  // per-anchor fan-out; `anchor.revoked` / `anchor.expired` fire from the
  // corresponding state transitions. Schemas live in
  // services/worker/src/webhooks/payload-schemas.ts.
  'anchor.submitted',
  'anchor.secured',
  'anchor.revoked',
  'anchor.expired',
  // Aggregate event for the merkle-batch path. Fires once per merkle TX
  // alongside the per-anchor `anchor.secured` fan-out (SCRUM-1264 / R2-1).
  'anchor.batch_secured',
  // Credential lifecycle (issuer-and-recipient-level state) — SCRUM-1743
  // Phase 1. Schemas defined in payload-schemas.ts; per-event emit-point
  // wiring lands in Phase-2 follow-ups.
  'credential.issued',
  'credential.verified',
  'credential.status_changed',
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
