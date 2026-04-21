/**
 * Rules Engine Trigger Evaluator (ARK-106 — SCRUM-1018)
 *
 * Pure decision function: given an event + rule config, decide whether the
 * rule fires and which action to schedule. No I/O — the job runner in
 * `jobs/rules-engine.ts` wraps this with DB reads/writes + dispatch.
 *
 * Trigger types (from schemas.ts):
 *   ESIGN_COMPLETED              — DocuSign/Adobe envelope done
 *   WORKSPACE_FILE_MODIFIED      — Google Drive / SharePoint / OneDrive
 *   CONNECTOR_DOCUMENT_RECEIVED  — ATS / BGC (Veremark/Checkr etc.)
 *   MANUAL_UPLOAD                — user upload via the web UI
 *   SCHEDULED_CRON               — cron string fires the action
 *   QUEUE_DIGEST                 — QueueReview digest on a cron
 *   EMAIL_INTAKE                 — inbound mail → upload
 *
 * Semantic match (`semantic_match` field on some triggers) is an ARK-109
 * optional layer — it's evaluated by a separate async step, so the basic
 * evaluator here ignores it and the runner layers it on when present.
 */

export type TriggerType =
  | 'ESIGN_COMPLETED'
  | 'WORKSPACE_FILE_MODIFIED'
  | 'CONNECTOR_DOCUMENT_RECEIVED'
  | 'MANUAL_UPLOAD'
  | 'SCHEDULED_CRON'
  | 'QUEUE_DIGEST'
  | 'EMAIL_INTAKE';

export interface RuleRow {
  id: string;
  org_id: string;
  name: string;
  enabled: boolean;
  trigger_type: TriggerType;
  trigger_config: Record<string, unknown>;
  action_type: string;
  action_config: Record<string, unknown>;
}

export interface TriggerEvent {
  trigger_type: TriggerType;
  org_id: string;
  /**
   * Vendor tag per trigger type:
   *   ESIGN_COMPLETED: 'docusign' | 'adobe_sign'
   *   WORKSPACE_FILE_MODIFIED: 'google_drive' | 'sharepoint' | 'onedrive'
   *   CONNECTOR_DOCUMENT_RECEIVED: 'veremark' | 'checkr' | 'hireright' | ...
   */
  vendor?: string;
  filename?: string;
  folder_path?: string;
  sender_email?: string;
  subject?: string;
}

export interface EvaluationResult {
  matched: boolean;
  /** Reason code for logging / observability. */
  reason: string;
  /** Whether this trigger requires the ARK-109 semantic-match layer. */
  needs_semantic_match: boolean;
  /** The semantic-match config, if present. Passed through verbatim. */
  semantic_match?: { description: string; threshold: number };
}

function normalizeEmail(v?: string | null): string | undefined {
  return v ? v.trim().toLowerCase() : undefined;
}

function containsCI(haystack: string | undefined, needle: unknown): boolean {
  if (!haystack || typeof needle !== 'string' || !needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function startsWithCI(haystack: string | undefined, needle: unknown): boolean {
  if (!haystack || typeof needle !== 'string' || !needle) return false;
  return haystack.toLowerCase().startsWith(needle.toLowerCase());
}

function readSemanticMatch(
  cfg: Record<string, unknown>,
): { description: string; threshold: number } | undefined {
  const sm = cfg.semantic_match as
    | { description?: unknown; threshold?: unknown }
    | undefined;
  if (!sm || typeof sm.description !== 'string') return undefined;
  const thr =
    typeof sm.threshold === 'number' && sm.threshold >= 0.5 && sm.threshold <= 1
      ? sm.threshold
      : 0.75;
  return { description: sm.description, threshold: thr };
}

export function evaluateRule(rule: RuleRow, event: TriggerEvent): EvaluationResult {
  const skip: EvaluationResult = {
    matched: false,
    reason: 'skip',
    needs_semantic_match: false,
  };

  if (!rule.enabled) return { ...skip, reason: 'rule_disabled' };
  if (rule.org_id !== event.org_id) return { ...skip, reason: 'org_mismatch' };
  if (rule.trigger_type !== event.trigger_type) {
    return { ...skip, reason: 'trigger_type_mismatch' };
  }

  const cfg = rule.trigger_config;
  const semantic = readSemanticMatch(cfg);
  const matchedPre: EvaluationResult = {
    matched: true,
    reason: 'matched',
    needs_semantic_match: Boolean(semantic),
    semantic_match: semantic,
  };

  switch (rule.trigger_type) {
    case 'ESIGN_COMPLETED': {
      const vendors = cfg.vendors as string[] | undefined;
      if (vendors?.length && event.vendor && !vendors.includes(event.vendor)) {
        return { ...skip, reason: 'vendor_filter_rejected' };
      }
      if (cfg.filename_contains && !containsCI(event.filename, cfg.filename_contains)) {
        return { ...skip, reason: 'filename_filter_rejected' };
      }
      if (
        cfg.sender_email_equals &&
        normalizeEmail(event.sender_email) !== normalizeEmail(cfg.sender_email_equals as string)
      ) {
        return { ...skip, reason: 'sender_email_filter_rejected' };
      }
      return matchedPre;
    }

    case 'WORKSPACE_FILE_MODIFIED': {
      const vendors = cfg.vendors as string[] | undefined;
      if (vendors?.length && event.vendor && !vendors.includes(event.vendor)) {
        return { ...skip, reason: 'vendor_filter_rejected' };
      }
      if (
        cfg.folder_path_starts_with &&
        !startsWithCI(event.folder_path, cfg.folder_path_starts_with)
      ) {
        return { ...skip, reason: 'folder_path_filter_rejected' };
      }
      if (cfg.filename_contains && !containsCI(event.filename, cfg.filename_contains)) {
        return { ...skip, reason: 'filename_filter_rejected' };
      }
      return matchedPre;
    }

    case 'CONNECTOR_DOCUMENT_RECEIVED': {
      if (cfg.connector_type && event.vendor && cfg.connector_type !== event.vendor) {
        return { ...skip, reason: 'connector_type_mismatch' };
      }
      return matchedPre;
    }

    case 'MANUAL_UPLOAD':
    case 'SCHEDULED_CRON':
    case 'QUEUE_DIGEST':
      // No additional filtering — caller gates cron by time already.
      return matchedPre;

    case 'EMAIL_INTAKE': {
      if (
        cfg.sender_email_equals &&
        normalizeEmail(event.sender_email) !== normalizeEmail(cfg.sender_email_equals as string)
      ) {
        return { ...skip, reason: 'sender_email_filter_rejected' };
      }
      if (cfg.subject_contains && !containsCI(event.subject, cfg.subject_contains)) {
        return { ...skip, reason: 'subject_filter_rejected' };
      }
      return matchedPre;
    }
  }
}

/**
 * Bulk-evaluate: run every rule against an event. Returns only the rules that
 * matched — `needs_semantic_match` entries must be re-filtered by the caller
 * after the ARK-109 embedding check.
 */
export function evaluateRules(
  rules: RuleRow[],
  event: TriggerEvent,
): Array<{ rule: RuleRow; result: EvaluationResult }> {
  const out: Array<{ rule: RuleRow; result: EvaluationResult }> = [];
  for (const rule of rules) {
    const result = evaluateRule(rule, event);
    if (result.matched) out.push({ rule, result });
  }
  return out;
}
