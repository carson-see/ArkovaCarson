/**
 * Rule Builder — Frontend validation (CIBA-HARDEN-04 / SCRUM-1117)
 *
 * Lean client-side validator. The worker (services/worker/src/rules/schemas.ts)
 * is authoritative — it re-parses every POST through the full Zod discriminated
 * union and rejects malformed rules. This file exists solely so the wizard can
 * fail fast on the most common admin mistakes (missing cron, unselected
 * connector, raw secret in HMAC field) without a POST round-trip.
 *
 * Intentionally NOT a 1:1 shadow of the worker schema. We only encode the
 * required-fields + secret-handle shape — everything else is caught server-
 * side. Keeping the shadow tight avoids drift: when the worker schema changes,
 * this file's tests still pass as long as required fields stay required.
 */

export type TriggerType =
  | 'ESIGN_COMPLETED'
  | 'WORKSPACE_FILE_MODIFIED'
  | 'CONNECTOR_DOCUMENT_RECEIVED'
  | 'MANUAL_UPLOAD'
  | 'SCHEDULED_CRON'
  | 'QUEUE_DIGEST'
  | 'EMAIL_INTAKE';

export type ActionType =
  | 'AUTO_ANCHOR'
  | 'FAST_TRACK_ANCHOR'
  | 'QUEUE_FOR_REVIEW'
  | 'FLAG_COLLISION'
  | 'NOTIFY'
  | 'FORWARD_TO_URL';

/**
 * Secret Manager handle format. Worker `SecretHandle` Zod regex is the
 * authority; this mirror exists only so the wizard can refuse a raw secret
 * at the `hmac_secret_handle` field before the POST.
 */
const SECRET_HANDLE_RE = /^sm:[a-z0-9_-]{1,64}$/i;

/** Required trigger-config keys per trigger type. Empty array = no required fields. */
const REQUIRED_TRIGGER_FIELDS: Record<TriggerType, readonly string[]> = {
  ESIGN_COMPLETED: [],
  WORKSPACE_FILE_MODIFIED: [],
  CONNECTOR_DOCUMENT_RECEIVED: ['connector_type'],
  MANUAL_UPLOAD: [],
  SCHEDULED_CRON: ['cron', 'timezone'],
  QUEUE_DIGEST: ['cron', 'timezone'],
  EMAIL_INTAKE: [],
} as const;

/** Required action-config keys per action type. Empty array = no required fields. */
const REQUIRED_ACTION_FIELDS: Record<ActionType, readonly string[]> = {
  AUTO_ANCHOR: [],
  FAST_TRACK_ANCHOR: [],
  QUEUE_FOR_REVIEW: [],
  FLAG_COLLISION: [],
  NOTIFY: ['channels'],
  FORWARD_TO_URL: ['target_url', 'hmac_secret_handle'],
} as const;

function isNonEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function checkRequiredFields(
  label: 'Trigger' | 'Action',
  required: readonly string[],
  config: Record<string, unknown>,
): string[] {
  return required
    .filter((key) => !isNonEmpty(config[key]))
    .map((key) => `${label}: ${key} — required`);
}

function validateWorkspaceFileModifiedConfig(config: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (config.type === 'drive_folder' && !isNonEmpty(config.folder_id)) {
    errors.push('Trigger: folder_id — required');
  }

  if (Array.isArray(config.drive_folders)) {
    config.drive_folders.forEach((folder, index) => {
      if (!folder || typeof folder !== 'object') {
        errors.push(`Trigger: drive_folders[${index}] — invalid folder binding`);
        return;
      }
      const folderId = (folder as { folder_id?: unknown }).folder_id;
      if (!isNonEmpty(folderId)) {
        errors.push(`Trigger: drive_folders[${index}].folder_id — required`);
      }
    });
  }

  return errors;
}

/**
 * Validate wizard state before POST. Returns a list of human-readable error
 * messages (empty = valid). Worker re-validates authoritatively on POST.
 */
export function validateWizardConfigs(input: {
  trigger_type: TriggerType | '';
  trigger_config: Record<string, unknown>;
  action_type: ActionType | '';
  action_config: Record<string, unknown>;
}): string[] {
  const errors: string[] = [];

  if (input.trigger_type) {
    errors.push(
      ...checkRequiredFields(
        'Trigger',
        REQUIRED_TRIGGER_FIELDS[input.trigger_type],
        input.trigger_config,
      ),
    );
    if (input.trigger_type === 'WORKSPACE_FILE_MODIFIED') {
      errors.push(...validateWorkspaceFileModifiedConfig(input.trigger_config));
    }
  }

  if (input.action_type) {
    errors.push(
      ...checkRequiredFields(
        'Action',
        REQUIRED_ACTION_FIELDS[input.action_type],
        input.action_config,
      ),
    );
    if (input.action_type === 'FORWARD_TO_URL') {
      const handle = input.action_config.hmac_secret_handle;
      if (typeof handle === 'string' && handle.length > 0 && !SECRET_HANDLE_RE.test(handle)) {
        errors.push(
          'Action: hmac_secret_handle — must be a Secret Manager handle like sm:my_secret_name (not a raw secret).',
        );
      }
    }
  }

  return errors;
}
