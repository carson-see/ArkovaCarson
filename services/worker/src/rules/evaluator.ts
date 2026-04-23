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

const SKIP_BASE: EvaluationResult = {
  matched: false,
  reason: 'skip',
  needs_semantic_match: false,
};

function skip(reason: string): EvaluationResult {
  return { ...SKIP_BASE, reason };
}

/** Vendor allowlist guard reused by e-sign + workspace triggers. */
function vendorRejected(
  cfg: Record<string, unknown>,
  eventVendor: string | undefined,
): boolean {
  const vendors = cfg.vendors as string[] | undefined;
  return Boolean(vendors?.length && eventVendor && !vendors.includes(eventVendor));
}

function filenameRejected(
  cfg: Record<string, unknown>,
  eventFilename: string | undefined,
): boolean {
  return Boolean(cfg.filename_contains && !containsCI(eventFilename, cfg.filename_contains));
}

function senderEmailRejected(
  cfg: Record<string, unknown>,
  eventSender: string | undefined,
): boolean {
  return Boolean(
    cfg.sender_email_equals &&
      normalizeEmail(eventSender) !== normalizeEmail(cfg.sender_email_equals as string),
  );
}

function evaluateEsignCompleted(cfg: Record<string, unknown>, event: TriggerEvent): string | null {
  if (vendorRejected(cfg, event.vendor)) return 'vendor_filter_rejected';
  if (filenameRejected(cfg, event.filename)) return 'filename_filter_rejected';
  if (senderEmailRejected(cfg, event.sender_email)) return 'sender_email_filter_rejected';
  return null;
}

function evaluateWorkspaceFileModified(
  cfg: Record<string, unknown>,
  event: TriggerEvent,
): string | null {
  if (vendorRejected(cfg, event.vendor)) return 'vendor_filter_rejected';
  if (cfg.folder_path_starts_with && !startsWithCI(event.folder_path, cfg.folder_path_starts_with)) {
    return 'folder_path_filter_rejected';
  }
  if (filenameRejected(cfg, event.filename)) return 'filename_filter_rejected';
  return null;
}

function evaluateConnectorDocumentReceived(
  cfg: Record<string, unknown>,
  event: TriggerEvent,
): string | null {
  if (cfg.connector_type && event.vendor && cfg.connector_type !== event.vendor) {
    return 'connector_type_mismatch';
  }
  return null;
}

function evaluateEmailIntake(cfg: Record<string, unknown>, event: TriggerEvent): string | null {
  if (senderEmailRejected(cfg, event.sender_email)) return 'sender_email_filter_rejected';
  if (cfg.subject_contains && !containsCI(event.subject, cfg.subject_contains)) {
    return 'subject_filter_rejected';
  }
  return null;
}

/** Per-trigger-type filter. Returns a rejection reason or null on pass. */
function checkTriggerFilters(rule: RuleRow, event: TriggerEvent): string | null {
  const cfg = rule.trigger_config;
  switch (rule.trigger_type) {
    case 'ESIGN_COMPLETED':
      return evaluateEsignCompleted(cfg, event);
    case 'WORKSPACE_FILE_MODIFIED':
      return evaluateWorkspaceFileModified(cfg, event);
    case 'CONNECTOR_DOCUMENT_RECEIVED':
      return evaluateConnectorDocumentReceived(cfg, event);
    case 'EMAIL_INTAKE':
      return evaluateEmailIntake(cfg, event);
    case 'MANUAL_UPLOAD':
    case 'SCHEDULED_CRON':
    case 'QUEUE_DIGEST':
      return null; // no additional filtering — caller gates cron by time
  }
}

export function evaluateRule(rule: RuleRow, event: TriggerEvent): EvaluationResult {
  if (!rule.enabled) return skip('rule_disabled');
  if (rule.org_id !== event.org_id) return skip('org_mismatch');
  if (rule.trigger_type !== event.trigger_type) return skip('trigger_type_mismatch');

  const rejection = checkTriggerFilters(rule, event);
  if (rejection) return skip(rejection);

  const semantic = readSemanticMatch(rule.trigger_config);
  return {
    matched: true,
    reason: 'matched',
    needs_semantic_match: Boolean(semantic),
    semantic_match: semantic,
  };
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
