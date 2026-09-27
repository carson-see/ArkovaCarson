import { DRIVE_FOLDER_BINDING_CAP, TriggerConfigWorkspaceFileModified } from '../../rules/schemas.js';
import {
  extractDriveFoldersToMirror, mirrorConnectedDriveFolders, shouldMirrorDriveFoldersForRule,
  type DriveFolderMirrorDb, type MirrorConnectedDriveFolderResult,
} from './drive-folder-mirror.js';

export const DRIVE_FOLDER_RECONCILIATION_PAGE_SIZE = 100;
/** Stops starting another rule after eight minutes of total-run elapsed time.
 * One already-awaited PostgREST request can still outlive Scheduler's 600s deadline. */
export const DRIVE_FOLDER_RECONCILIATION_RUN_BUDGET_MS = 8 * 60_000;

export interface DriveFolderRuleCandidate {
  id: string; org_id: string; created_by_user_id: string | null;
  trigger_config: Record<string, unknown>; action_config: Record<string, unknown>;
}
export interface DriveFolderReconciliationSummary {
  candidates: number; page: number; pages: number; scanned: number; eligible: number;
  created: number; existing: number; skipped: number; errored: number; invalid: number;
  deadlineExceeded: boolean;
}
export class DriveFolderReconciliationError extends Error {
  constructor(public readonly summary: DriveFolderReconciliationSummary) {
    super(`drive_folder_reconciliation_failed: ${summary.errored} errors, ${summary.invalid} invalid rules`);
    this.name = 'DriveFolderReconciliationError';
  }
}
interface Logger { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
interface ReconciliationDeps {
  db: DriveFolderMirrorDb; now?: () => Date; monotonicNowMs?: () => number; deadlineAtMs?: number; logger?: Logger;
  listCandidates?: (args: { page: number; pageSize: number }) => Promise<{ rows: DriveFolderRuleCandidate[]; count: number }>;
  readCurrentRule?: (candidate: DriveFolderRuleCandidate) => Promise<DriveFolderRuleCandidate | null>;
  mirror?: typeof mirrorConnectedDriveFolders;
}

/** Stateless bounded rotation: eventual for a stable population, not fair under sustained churn. */
export function driveFolderReconciliationPage(candidateCount: number, now: Date, pageSize = DRIVE_FOLDER_RECONCILIATION_PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(candidateCount / pageSize));
  return { page: Math.floor(now.getTime() / 3_600_000) % pages, pages };
}

async function listPersistedCandidates(db: DriveFolderMirrorDb, args: { page: number; pageSize: number }) {
  const from = args.page * args.pageSize;
  // eslint-disable-next-line arkova/missing-org-filter -- cross-org service-role scan; each row org scopes writes
  const result = await db.from('organization_rules')
    .select('id, org_id, created_by_user_id, trigger_config, action_config', { count: 'exact' })
    .eq('enabled', true).eq('trigger_type', 'WORKSPACE_FILE_MODIFIED')
    .order('id', { ascending: true }).range(from, from + args.pageSize - 1);
  if (result.error) throw new Error(`drive_folder_rule_scan_failed: ${String(result.error)}`);
  return { rows: (result.data ?? []) as DriveFolderRuleCandidate[], count: result.count ?? 0 };
}

async function readPersistedCurrentRule(db: DriveFolderMirrorDb, candidate: DriveFolderRuleCandidate) {
  const { data, error } = await db.from('organization_rules')
    .select('id, org_id, created_by_user_id, trigger_config, action_config')
    .eq('id', candidate.id).eq('org_id', candidate.org_id).eq('enabled', true)
    .eq('trigger_type', 'WORKSPACE_FILE_MODIFIED').maybeSingle();
  if (error) throw new Error(`drive_folder_rule_reread_failed: ${String(error)}`);
  return (data as DriveFolderRuleCandidate | null) ?? null;
}

interface PreparedDriveFolderRule {
  rule: DriveFolderRuleCandidate;
  folders: ReturnType<typeof extractDriveFoldersToMirror>;
}

async function prepareDriveFolderRule(args: {
  candidate: DriveFolderRuleCandidate;
  reread: (candidate: DriveFolderRuleCandidate) => Promise<DriveFolderRuleCandidate | null>;
  summary: DriveFolderReconciliationSummary;
  logger?: Logger;
}): Promise<PreparedDriveFolderRule | null> {
  let rule: DriveFolderRuleCandidate | null;
  try { rule = await args.reread(args.candidate); } catch (error) {
    args.summary.errored += 1;
    args.logger?.error(
      { error, ruleId: args.candidate.id, orgId: args.candidate.org_id },
      'drive-folder reconciliation: authoritative rule reread failed',
    );
    return null;
  }
  if (!rule || !shouldMirrorDriveFoldersForRule('WORKSPACE_FILE_MODIFIED', rule.action_config)) return null;
  const parsed = TriggerConfigWorkspaceFileModified.safeParse(rule.trigger_config);
  if (!parsed.success) {
    args.summary.invalid += 1; args.summary.errored += 1;
    args.logger?.error(
      { ruleId: rule.id, orgId: rule.org_id, issueCount: parsed.error.issues.length },
      'drive-folder reconciliation: persisted rule config is invalid; refusing partial mirror',
    );
    return null;
  }
  const folders = extractDriveFoldersToMirror(parsed.data);
  if (folders.length === 0) return null;
  if (folders.length > DRIVE_FOLDER_BINDING_CAP) {
    args.summary.invalid += 1; args.summary.errored += 1;
    return null;
  }
  return { rule, folders };
}

function applyDriveFolderMirrorOutcome(
  summary: DriveFolderReconciliationSummary,
  outcome: MirrorConnectedDriveFolderResult,
): void {
  if (outcome.outcome === 'created') summary.created += 1;
  else if (outcome.outcome === 'existing') summary.existing += 1;
  else if (outcome.outcome === 'skipped_no_connection') summary.skipped += 1;
  else summary.errored += 1;
}

async function mirrorPreparedDriveFolderRule(args: {
  db: DriveFolderMirrorDb;
  logger?: Logger;
  mirror: typeof mirrorConnectedDriveFolders;
  prepared: PreparedDriveFolderRule;
  summary: DriveFolderReconciliationSummary;
}): Promise<void> {
  const { rule, folders } = args.prepared;
  let outcomes: MirrorConnectedDriveFolderResult[];
  try {
    outcomes = await args.mirror({ db: args.db, logger: args.logger }, {
      orgId: rule.org_id, actorUserId: rule.created_by_user_id, folders,
    });
  } catch (error) {
    args.summary.errored += folders.length;
    args.logger?.error(
      { error, ruleId: rule.id, orgId: rule.org_id },
      'drive-folder reconciliation: one rule threw; continuing',
    );
    return;
  }
  for (const outcome of outcomes) applyDriveFolderMirrorOutcome(args.summary, outcome);
}

export async function runDriveFolderReconciliation(deps: ReconciliationDeps): Promise<DriveFolderReconciliationSummary> {
  const wallNow = deps.now?.() ?? new Date();
  const monotonicNow = deps.monotonicNowMs ?? (() => performance.now());
  const deadlineAt = deps.deadlineAtMs ?? monotonicNow() + DRIVE_FOLDER_RECONCILIATION_RUN_BUDGET_MS;
  const list = deps.listCandidates ?? ((args) => listPersistedCandidates(deps.db, args));
  const reread = deps.readCurrentRule ?? ((candidate) => readPersistedCurrentRule(deps.db, candidate));
  const mirror = deps.mirror ?? mirrorConnectedDriveFolders;
  if (monotonicNow() >= deadlineAt) {
    throw new DriveFolderReconciliationError({
      candidates: 0, page: 0, pages: 1, scanned: 0, eligible: 0,
      created: 0, existing: 0, skipped: 0, errored: 0, invalid: 0, deadlineExceeded: true,
    });
  }
  let listed = await list({ page: 0, pageSize: DRIVE_FOLDER_RECONCILIATION_PAGE_SIZE });
  const selected = driveFolderReconciliationPage(listed.count, wallNow);
  if (monotonicNow() >= deadlineAt) {
    const remaining = Math.min(
      DRIVE_FOLDER_RECONCILIATION_PAGE_SIZE,
      Math.max(0, listed.count - selected.page * DRIVE_FOLDER_RECONCILIATION_PAGE_SIZE),
    );
    throw new DriveFolderReconciliationError({
      candidates: listed.count, page: selected.page, pages: selected.pages, scanned: 0, eligible: 0,
      created: 0, existing: 0, skipped: 0, errored: remaining, invalid: 0, deadlineExceeded: true,
    });
  }
  if (selected.page !== 0) listed = await list({ page: selected.page, pageSize: DRIVE_FOLDER_RECONCILIATION_PAGE_SIZE });
  const summary: DriveFolderReconciliationSummary = {
    candidates: listed.count, page: selected.page, pages: selected.pages, scanned: 0, eligible: 0,
    created: 0, existing: 0, skipped: 0, errored: 0, invalid: 0, deadlineExceeded: false,
  };
  for (const candidate of listed.rows) {
    if (monotonicNow() >= deadlineAt) {
      summary.deadlineExceeded = true;
      summary.errored += listed.rows.length - summary.scanned;
      break;
    }
    summary.scanned += 1;
    const prepared = await prepareDriveFolderRule({ candidate, reread, summary, logger: deps.logger });
    if (!prepared) continue;
    if (monotonicNow() >= deadlineAt) {
      summary.deadlineExceeded = true;
      summary.errored += listed.rows.length - summary.scanned + 1;
      break;
    }
    summary.eligible += 1;
    await mirrorPreparedDriveFolderRule({ db: deps.db, logger: deps.logger, mirror, prepared, summary });
  }
  deps.logger?.warn({ summary }, 'drive-folder reconciliation pass complete');
  if (summary.errored > 0 || summary.invalid > 0 || summary.deadlineExceeded) {
    throw new DriveFolderReconciliationError(summary);
  }
  return summary;
}
