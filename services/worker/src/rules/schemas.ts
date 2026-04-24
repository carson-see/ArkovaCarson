/**
 * Rules Engine Zod Schemas (ARK-105 — SCRUM-1017)
 *
 * Trigger + action config shapes validated at the write-path (POST /rules,
 * PATCH /rules/:id, POST /rules/draft). Tight Zod coupling means malformed
 * configs never reach the DB and the execution worker (ARK-106) can trust
 * every row in organization_rules.
 *
 * schema_version on the row selects which schema applies — bump this file
 * when a breaking change lands and leave older versions in a switch.
 */

import { z } from 'zod';

// =============================================================================
// Shared primitives
// =============================================================================

const SafeName = z.string().trim().min(1).max(100);
const SafeDescription = z.string().trim().max(1000).optional();

// UUID list, capped to prevent pathological notification fan-out.
const RecipientUserIdList = z.array(z.string().uuid()).max(50).default([]);

// Emails for NOTIFY action. Capped; lowercase; no display-name form (keeps
// templating simple and avoids header-injection surfaces).
const EmailList = z
  .array(z.string().email().toLowerCase())
  .max(50)
  .default([]);

// Slack webhook URLs live in Secret Manager keyed by handle, never raw in the
// config. The rule references the handle, not the secret.
const SecretHandle = z.string().regex(/^sm:[a-z0-9_-]{1,64}$/i);

// IANA timezone (cron reminders). We validate length/shape but defer hard
// check to runtime (workers use `Intl.DateTimeFormat` availability).
const TimezoneString = z.string().min(1).max(64);
const DriveFolderId = z.string().trim().min(1).max(500);

// Standard 5-field cron expression. Very loose regex — runtime parser in the
// worker (cron-parser) does the real validation.
const CronString = z
  .string()
  .min(9)
  .max(100)
  .regex(/^[\d*,\-/\s]+$/);

// =============================================================================
// Trigger configs (one schema per trigger_type)
// =============================================================================

export const TriggerConfigEsignCompleted = z.object({
  // Optional per-vendor filter; empty = all vendors.
  vendors: z
    .array(z.enum(['docusign', 'adobe_sign']))
    .max(2)
    .optional(),
  // Optional filename-contains filter; empty = all.
  filename_contains: z.string().max(200).optional(),
  sender_email_equals: z.string().email().toLowerCase().optional(),
  // Toggle ARK-109 semantic match. Description + threshold are validated
  // against the Zod schema below when present.
  semantic_match: z
    .object({
      description: z.string().trim().min(3).max(500),
      threshold: z.number().min(0.5).max(1.0).default(0.75),
    })
    .optional(),
});

export const TriggerConfigWorkspaceFileModified = z.object({
  vendors: z
    .array(z.enum(['google_drive', 'sharepoint', 'onedrive']))
    .max(3)
    .optional(),
  folder_path_starts_with: z.string().max(500).optional(),
  filename_contains: z.string().max(200).optional(),
  // SCRUM-1100: Drive-specific binding. `type/folder_id/watch_channel_id`
  // keeps compatibility with the single-folder AC shape, while
  // `drive_folders[]` supports multiple folder bindings per rule.
  type: z.literal('drive_folder').optional(),
  folder_id: DriveFolderId.optional(),
  watch_channel_id: z.string().trim().min(1).max(500).optional(),
  drive_folders: z
    .array(
      z.object({
        type: z.literal('drive_folder'),
        folder_id: DriveFolderId,
        folder_name: z.string().trim().max(500).optional(),
        folder_path: z.string().trim().max(2000).optional(),
        watch_channel_id: z.string().trim().min(1).max(500).optional(),
      }),
    )
    .max(20)
    .optional(),
  semantic_match: TriggerConfigEsignCompleted.shape.semantic_match,
}).superRefine((cfg, ctx) => {
  if (cfg.type === 'drive_folder' && !cfg.folder_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['folder_id'],
      message: 'folder_id is required when type is drive_folder',
    });
  }
});

export const TriggerConfigConnectorDocumentReceived = z.object({
  connector_type: z.enum([
    'veremark',
    'checkr',
    'hireright',
    'goodhire',
    'generic',
  ]),
  semantic_match: TriggerConfigEsignCompleted.shape.semantic_match,
});

export const TriggerConfigManualUpload = z.object({
  apply_to: z.enum(['all', 'org_admins', 'specific_users']).default('all'),
  specific_user_ids: RecipientUserIdList.optional(),
});

export const TriggerConfigScheduledCron = z.object({
  cron: CronString,
  timezone: TimezoneString,
});

export const TriggerConfigQueueDigest = z.object({
  cron: CronString,
  timezone: TimezoneString,
  send_when_empty: z.boolean().default(false),
});

export const TriggerConfigEmailIntake = z.object({
  // The intake address is auto-generated per org; the config only carries
  // optional sender filtering.
  sender_email_equals: z.string().email().toLowerCase().optional(),
  subject_contains: z.string().max(200).optional(),
});

// Discriminated union across all trigger types. Keeps the worker's type
// narrowing clean.
export const TriggerConfig = z.discriminatedUnion('trigger_type', [
  z.object({ trigger_type: z.literal('ESIGN_COMPLETED'), config: TriggerConfigEsignCompleted }),
  z.object({ trigger_type: z.literal('WORKSPACE_FILE_MODIFIED'), config: TriggerConfigWorkspaceFileModified }),
  z.object({ trigger_type: z.literal('CONNECTOR_DOCUMENT_RECEIVED'), config: TriggerConfigConnectorDocumentReceived }),
  z.object({ trigger_type: z.literal('MANUAL_UPLOAD'), config: TriggerConfigManualUpload }),
  z.object({ trigger_type: z.literal('SCHEDULED_CRON'), config: TriggerConfigScheduledCron }),
  z.object({ trigger_type: z.literal('QUEUE_DIGEST'), config: TriggerConfigQueueDigest }),
  z.object({ trigger_type: z.literal('EMAIL_INTAKE'), config: TriggerConfigEmailIntake }),
]);

// =============================================================================
// Action configs
// =============================================================================

export const ActionConfigAutoAnchor = z.object({
  // Optional tag added to the anchor record for reporting.
  tag: z.string().max(50).optional(),
});

export const ActionConfigFastTrackAnchor = z.object({
  // SCALE-01 gates this to Paid+ tier at runtime. Flag present for auditability.
  tag: z.string().max(50).optional(),
  reason: z.string().max(200).optional(),
});

export const ActionConfigQueueForReview = z.object({
  // ARK-101 queue metadata — surfaces on /queue dashboard.
  label: z.string().max(100).optional(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
});

export const ActionConfigFlagCollision = z.object({
  // Minutes. If >1 version arrives within this window, flag as collision.
  // Matches the ARK-101 AC default of 5 min.
  window_minutes: z.number().int().min(1).max(1440).default(5),
});

export const ActionConfigNotify = z.object({
  channels: z.array(z.enum(['email', 'slack'])).min(1).max(2),
  recipient_user_ids: RecipientUserIdList,
  recipient_emails: EmailList,
  slack_webhook_handle: SecretHandle.optional(),
  // Plain-text template; `{{}}` variables resolved by the worker at send time
  // from the triggering event payload.
  message_template: z.string().min(1).max(500).optional(),
});

export const ActionConfigForwardToUrl = z.object({
  // Allowlist enforced at runtime against org settings. Config carries the
  // allowlisted target — the worker refuses anything that doesn't match.
  target_url: z.string().url().max(500),
  hmac_secret_handle: SecretHandle,
  timeout_ms: z.number().int().min(1000).max(30000).default(5000),
});

export const ActionConfig = z.discriminatedUnion('action_type', [
  z.object({ action_type: z.literal('AUTO_ANCHOR'), config: ActionConfigAutoAnchor }),
  z.object({ action_type: z.literal('FAST_TRACK_ANCHOR'), config: ActionConfigFastTrackAnchor }),
  z.object({ action_type: z.literal('QUEUE_FOR_REVIEW'), config: ActionConfigQueueForReview }),
  z.object({ action_type: z.literal('FLAG_COLLISION'), config: ActionConfigFlagCollision }),
  z.object({ action_type: z.literal('NOTIFY'), config: ActionConfigNotify }),
  z.object({ action_type: z.literal('FORWARD_TO_URL'), config: ActionConfigForwardToUrl }),
]);

// =============================================================================
// Rule (combined) — what the API accepts on POST / PATCH
// =============================================================================

export const CreateOrgRuleInput = z.object({
  org_id: z.string().uuid(),
  name: SafeName,
  description: SafeDescription,
  trigger_type: z.enum([
    'ESIGN_COMPLETED',
    'WORKSPACE_FILE_MODIFIED',
    'CONNECTOR_DOCUMENT_RECEIVED',
    'MANUAL_UPLOAD',
    'SCHEDULED_CRON',
    'QUEUE_DIGEST',
    'EMAIL_INTAKE',
  ]),
  trigger_config: z.record(z.unknown()),
  action_type: z.enum([
    'AUTO_ANCHOR',
    'FAST_TRACK_ANCHOR',
    'QUEUE_FOR_REVIEW',
    'FLAG_COLLISION',
    'NOTIFY',
    'FORWARD_TO_URL',
  ]),
  action_config: z.record(z.unknown()),
  enabled: z.boolean().default(false),
});

export type CreateOrgRuleInputT = z.infer<typeof CreateOrgRuleInput>;

// Secondary validation pass — ensures trigger_config matches trigger_type and
// action_config matches action_type. Called after the first parse.
export function validateRuleConfigs(input: CreateOrgRuleInputT): void {
  TriggerConfig.parse({
    trigger_type: input.trigger_type,
    config: input.trigger_config,
  });
  ActionConfig.parse({
    action_type: input.action_type,
    config: input.action_config,
  });
}

// =============================================================================
// Reject obvious secret leakage in config values
// =============================================================================

// Match field-name followed by colon-or-equals (with optional quotes/whitespace
// from JSON.stringify) then the start of a non-empty value. Keeps the false-
// positive surface narrow (prose mentioning "tokens" won't trip the check).
const SECRET_LEAK_PATTERN = /["']?(api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?[a-z0-9]/i;

export function assertNoInlineSecrets(config: Record<string, unknown>): void {
  const serialized = JSON.stringify(config);
  if (SECRET_LEAK_PATTERN.test(serialized)) {
    throw new Error(
      'Inline secret detected in rule config. Use a Secret Manager handle (sm:name) instead.',
    );
  }
}
