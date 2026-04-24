/**
 * Rule Builder — Frontend Zod Schemas (CIBA-HARDEN-04 / SCRUM-1117)
 *
 * Mirrors services/worker/src/rules/schemas.ts so the wizard can fail
 * client-side on invalid trigger/action configs instead of POSTing and
 * rendering a 400 into the wizard. The worker remains the authoritative
 * validator — this shadow only speeds up the round-trip.
 *
 * Rule for drift: if the worker schemas change, update this file in the
 * same PR. A worker test imports nothing from here; this file imports
 * nothing from the worker. Keep them in sync by hand (reviewed as part of
 * any rules-schema PR).
 */

import { z } from 'zod';

const SecretHandle = z
  .string()
  .regex(
    /^sm:[a-z0-9_-]{1,64}$/i,
    'Use a Secret Manager handle like sm:my_secret_name — not a raw secret.',
  );

const TimezoneString = z.string().min(1).max(64);

const CronString = z
  .string()
  .min(9)
  .max(100)
  .regex(/^[\d*,\-/\s]+$/, 'Use 5 cron fields: minute hour day month weekday.');

const RecipientUserIdList = z.array(z.string().uuid()).max(50).default([]);

const EmailList = z.array(z.string().email().toLowerCase()).max(50).default([]);

const SemanticMatch = z
  .object({
    description: z.string().trim().min(3).max(500),
    threshold: z.number().min(0.5).max(1.0).default(0.75),
  })
  .optional();

export const TriggerConfigEsignCompleted = z.object({
  vendors: z.array(z.enum(['docusign', 'adobe_sign'])).max(2).optional(),
  filename_contains: z.string().max(200).optional(),
  sender_email_equals: z.string().email().toLowerCase().optional(),
  semantic_match: SemanticMatch,
});

export const TriggerConfigWorkspaceFileModified = z.object({
  vendors: z.array(z.enum(['google_drive', 'sharepoint', 'onedrive'])).max(3).optional(),
  folder_path_starts_with: z.string().max(500).optional(),
  filename_contains: z.string().max(200).optional(),
  semantic_match: SemanticMatch,
});

export const TriggerConfigConnectorDocumentReceived = z.object({
  connector_type: z.enum(['veremark', 'checkr', 'hireright', 'goodhire', 'generic']),
  semantic_match: SemanticMatch,
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
  sender_email_equals: z.string().email().toLowerCase().optional(),
  subject_contains: z.string().max(200).optional(),
});

export const TriggerConfig = z.discriminatedUnion('trigger_type', [
  z.object({
    trigger_type: z.literal('ESIGN_COMPLETED'),
    config: TriggerConfigEsignCompleted,
  }),
  z.object({
    trigger_type: z.literal('WORKSPACE_FILE_MODIFIED'),
    config: TriggerConfigWorkspaceFileModified,
  }),
  z.object({
    trigger_type: z.literal('CONNECTOR_DOCUMENT_RECEIVED'),
    config: TriggerConfigConnectorDocumentReceived,
  }),
  z.object({
    trigger_type: z.literal('MANUAL_UPLOAD'),
    config: TriggerConfigManualUpload,
  }),
  z.object({
    trigger_type: z.literal('SCHEDULED_CRON'),
    config: TriggerConfigScheduledCron,
  }),
  z.object({
    trigger_type: z.literal('QUEUE_DIGEST'),
    config: TriggerConfigQueueDigest,
  }),
  z.object({
    trigger_type: z.literal('EMAIL_INTAKE'),
    config: TriggerConfigEmailIntake,
  }),
]);

export const ActionConfigAutoAnchor = z.object({
  tag: z.string().max(50).optional(),
});

export const ActionConfigFastTrackAnchor = z.object({
  tag: z.string().max(50).optional(),
  reason: z.string().max(200).optional(),
});

export const ActionConfigQueueForReview = z.object({
  label: z.string().max(100).optional(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
});

export const ActionConfigFlagCollision = z.object({
  window_minutes: z.number().int().min(1).max(1440).default(5),
});

export const ActionConfigNotify = z.object({
  channels: z.array(z.enum(['email', 'slack'])).min(1).max(2),
  recipient_user_ids: RecipientUserIdList,
  recipient_emails: EmailList,
  slack_webhook_handle: SecretHandle.optional(),
  message_template: z.string().min(1).max(500).optional(),
});

export const ActionConfigForwardToUrl = z.object({
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

export type TriggerType = z.infer<typeof TriggerConfig>['trigger_type'];
export type ActionType = z.infer<typeof ActionConfig>['action_type'];

/**
 * Validate wizard state against the trigger + action config schemas.
 * Returns a list of human-readable error messages (empty = valid).
 */
export function validateWizardConfigs(input: {
  trigger_type: TriggerType | '';
  trigger_config: Record<string, unknown>;
  action_type: ActionType | '';
  action_config: Record<string, unknown>;
}): string[] {
  const errors: string[] = [];

  if (input.trigger_type) {
    const tr = TriggerConfig.safeParse({
      trigger_type: input.trigger_type,
      config: input.trigger_config,
    });
    if (!tr.success) {
      for (const issue of tr.error.issues) {
        errors.push(`Trigger: ${issue.path.slice(1).join('.')} — ${issue.message}`);
      }
    }
  }

  if (input.action_type) {
    const ar = ActionConfig.safeParse({
      action_type: input.action_type,
      config: input.action_config,
    });
    if (!ar.success) {
      for (const issue of ar.error.issues) {
        errors.push(`Action: ${issue.path.slice(1).join('.')} — ${issue.message}`);
      }
    }
  }

  return errors;
}
