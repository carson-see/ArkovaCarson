/**
 * NCA-06 — Regulatory Change Impact Cron
 *
 * Nightly job that:
 *   1. Finds orgs with a prior `compliance_audits` row.
 *   2. Detects jurisdiction_rules changes since each org's last audit.
 *   3. Recomputes compliance impact via the pure NCA-06 module.
 *   4. Persists an audit trail row in `compliance_regulatory_change_events`
 *      via metadata of a fresh compliance_audits entry when the impact
 *      severity is not NONE.
 *   5. Fans out notifications — in-app on ≥5 point drop, email via Resend
 *      on ≥10 point drop (opt-out respected).
 *
 * Jira: SCRUM-761 (NCA-06)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendEmail } from '../email/sender.js';
import {
  computeRegulatoryChangeImpact,
  detectRuleChangesSince,
  type RegulatoryChangeImpact,
} from '../compliance/regulatory-change.js';
import {
  calculateOrgAudit,
  type OrgAuditResult,
  type JurisdictionPair,
} from '../compliance/org-audit.js';
import type { JurisdictionRule, OrgAnchor } from '../compliance/score-calculator.js';

export interface RegulatoryChangeCronResult {
  orgs_scanned: number;
  impacted_orgs: number;
  in_app_sent: number;
  emails_sent: number;
  errors: number;
}

export interface RegulatoryChangeCronDeps {
  database?: SupabaseClient;
  sendEmailFn?: typeof sendEmail;
  /** Clock override — used by tests. */
  now?: () => Date;
  /** Scorecard base URL for the in-app + email links. */
  scorecardUrl?: string;
}

const DEFAULT_SCORECARD_URL = 'https://app.arkova.ai/compliance/scorecard';

export async function runRegulatoryChangeCron(
  deps: RegulatoryChangeCronDeps = {},
): Promise<RegulatoryChangeCronResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const database = (deps.database ?? db) as any;
  const sendEmailImpl = deps.sendEmailFn ?? sendEmail;
  const scorecardUrl = deps.scorecardUrl ?? DEFAULT_SCORECARD_URL;

  const result: RegulatoryChangeCronResult = {
    orgs_scanned: 0,
    impacted_orgs: 0,
    in_app_sent: 0,
    emails_sent: 0,
    errors: 0,
  };

  let orgs: Array<{ org_id: string; last_audit_at: string }> = [];
  try {
    const { data } = await database
      .from('compliance_audits')
      .select('org_id, started_at')
      .eq('status', 'COMPLETED')
      .order('started_at', { ascending: false })
      .limit(10_000);

    const seen = new Set<string>();
    for (const row of (data ?? []) as Array<{ org_id: string; started_at: string }>) {
      if (seen.has(row.org_id)) continue;
      seen.add(row.org_id);
      orgs.push({ org_id: row.org_id, last_audit_at: row.started_at });
    }
  } catch (err) {
    logger.error({ err }, 'NCA-06 cron: failed to enumerate audited orgs');
    result.errors += 1;
    return result;
  }

  for (const { org_id, last_audit_at } of orgs) {
    result.orgs_scanned += 1;
    try {
      const impact = await computeImpactForOrg(database, org_id, last_audit_at);
      if (!impact || impact.severity === 'NONE' || impact.severity === 'INFO') continue;

      result.impacted_orgs += 1;

      await persistChangeEvent(database, org_id, impact);

      if (impact.severity === 'IN_APP' || impact.severity === 'EMAIL') {
        const notified = await createInAppNotification(database, org_id, impact, scorecardUrl);
        if (notified) result.in_app_sent += 1;
      }

      if (impact.severity === 'EMAIL') {
        const emailed = await sendImpactEmails(database, sendEmailImpl, org_id, impact, scorecardUrl);
        result.emails_sent += emailed;
      }
    } catch (err) {
      logger.error({ err, org_id }, 'NCA-06 cron: per-org failure (continuing)');
      result.errors += 1;
    }
  }

  logger.info({ ...result }, 'NCA-06 regulatory-change cron complete');
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function computeImpactForOrg(
  database: any,
  orgId: string,
  lastAuditAt: string,
): Promise<RegulatoryChangeImpact | null> {
  // Load previous audit row (the most recent COMPLETED audit).
  const { data: previous } = await database
    .from('compliance_audits')
    .select('*')
    .eq('org_id', orgId)
    .eq('status', 'COMPLETED')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle?.();
  if (!previous) return null;

  // Load current jurisdiction rules.
  const { data: rules } = await database.from('jurisdiction_rules').select('*').limit(2000);
  const ruleChange = detectRuleChangesSince((rules ?? []) as Array<{
    id: string;
    updated_at: string;
    created_at?: string;
    deprecated_at?: string | null;
    regulatory_reference?: string | null;
  }>, lastAuditAt);

  // If nothing moved in the rules table, no work.
  if (
    ruleChange.added_rule_ids.length === 0 &&
    ruleChange.changed_rule_ids.length === 0 &&
    ruleChange.deprecated_rule_ids.length === 0
  ) {
    return null;
  }

  // Org + anchors for a fresh audit pass.
  const { data: org } = await database.from('organizations').select('jurisdictions, industry').eq('id', orgId).maybeSingle?.();
  const jurisdictions = Array.isArray(org?.jurisdictions) ? (org.jurisdictions as string[]) : [];
  const industry = (org?.industry as string | null) ?? 'accounting';
  const pairs: JurisdictionPair[] = jurisdictions.map((j) => ({
    jurisdiction_code: j,
    industry_code: industry,
  }));

  const { data: anchorRows } = await database
    .from('anchors')
    .select('id, credential_type, status, integrity_score, fraud_flags, not_after, title')
    .eq('org_id', orgId)
    .eq('status', 'SECURED')
    .limit(10_000);
  const anchors: OrgAnchor[] = (anchorRows ?? []).map((a: Record<string, unknown>) => ({
    id: a.id as string,
    credential_type: (a.credential_type as string) ?? 'OTHER',
    status: a.status as string,
    integrity_score: (a.integrity_score as number | null) ?? null,
    fraud_flags: (a.fraud_flags as string[]) ?? [],
    expiry_date: (a.not_after as string) ?? null,
    title: (a.title as string) ?? null,
  }));

  const currentAudit: OrgAuditResult = calculateOrgAudit({
    orgId,
    jurisdictions: pairs,
    rules: (rules ?? []) as JurisdictionRule[],
    anchors,
  });

  const previousAudit: OrgAuditResult = {
    overall_score: previous.overall_score as number,
    overall_grade: previous.overall_grade as string,
    per_jurisdiction: (previous.per_jurisdiction ?? []) as OrgAuditResult['per_jurisdiction'],
    gaps: (previous.gaps ?? []) as OrgAuditResult['gaps'],
    quarantines: (previous.quarantines ?? []) as OrgAuditResult['quarantines'],
    recommendations: ((previous.metadata ?? {}) as Record<string, unknown>).recommendations as OrgAuditResult['recommendations']
      ?? { recommendations: [], overflow_count: 0, grouped: { quick_wins: [], critical: [], upcoming: [], standard: [] } },
  };

  return computeRegulatoryChangeImpact(previousAudit, currentAudit, ruleChange);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function persistChangeEvent(
  database: any,
  orgId: string,
  impact: RegulatoryChangeImpact,
): Promise<void> {
  await database.from('compliance_audits').insert({
    org_id: orgId,
    overall_score: impact.new_score,
    overall_grade: gradeFor(impact.new_score),
    status: 'COMPLETED',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: 0,
    metadata: {
      regulatory_change: impact,
      trigger: 'nca-06-cron',
    },
  });
}

function gradeFor(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createInAppNotification(
  database: any,
  orgId: string,
  impact: RegulatoryChangeImpact,
  scorecardUrl: string,
): Promise<boolean> {
  try {
    const { error } = await database.from('notifications').insert({
      org_id: orgId,
      type: 'REGULATORY_CHANGE',
      severity: impact.severity === 'EMAIL' ? 'high' : 'medium',
      title: `Compliance score changed (${impact.delta >= 0 ? '+' : ''}${impact.delta})`,
      body: impact.summary,
      link: scorecardUrl,
      payload: {
        changed_regulations: impact.changed_regulations,
        new_gap_keys: impact.new_gap_keys,
        resolved_gap_keys: impact.resolved_gap_keys,
      },
      read_at: null,
    });
    if (error) throw error;
    return true;
  } catch (err) {
    // When the notifications table does not yet exist (dev/test), log and
    // skip rather than fail the whole cron.
    logger.warn({ err, org_id: orgId }, 'NCA-06 cron: in-app notification insert skipped');
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendImpactEmails(
  database: any,
  sendEmailImpl: typeof sendEmail,
  orgId: string,
  impact: RegulatoryChangeImpact,
  scorecardUrl: string,
): Promise<number> {
  // Load opted-in org admins.
  const { data: admins } = await database
    .from('org_members')
    .select('user_id, role, notification_preferences, users:users(email)')
    .eq('org_id', orgId)
    .in('role', ['OWNER', 'ADMIN']);

  let sent = 0;
  for (const a of (admins ?? []) as Array<{
    user_id: string;
    role: string;
    notification_preferences: Record<string, unknown> | null;
    users?: { email: string } | null;
  }>) {
    const prefs = a.notification_preferences ?? {};
    const regEmailPref = (prefs as Record<string, unknown>)['regulatory_change_email'];
    const optedOut = regEmailPref === false;
    if (optedOut) continue;
    const email = a.users?.email;
    if (!email) continue;

    const subject = `Your compliance score changed (${impact.delta >= 0 ? '+' : ''}${impact.delta} points)`;
    const html = renderImpactEmailHtml(impact, scorecardUrl);
    const result = await sendEmailImpl({
      to: email,
      subject,
      html,
      emailType: 'notification',
      orgId,
      actorId: a.user_id,
    });
    if (result.success) sent += 1;
  }
  return sent;
}

function renderImpactEmailHtml(impact: RegulatoryChangeImpact, scorecardUrl: string): string {
  const regList = impact.changed_regulations.length
    ? `<p>Regulations that changed: <strong>${impact.changed_regulations.join(', ')}</strong></p>`
    : '';
  return `
    <div>
      <h2>Compliance score update</h2>
      <p>${escapeHtml(impact.summary)}</p>
      <p>Previous score: <strong>${impact.previous_score}</strong> → New score: <strong>${impact.new_score}</strong> (delta <strong>${impact.delta >= 0 ? '+' : ''}${impact.delta}</strong>)</p>
      ${regList}
      <p>New gaps opened: ${impact.new_gap_keys.length}. Resolved: ${impact.resolved_gap_keys.length}.</p>
      <p><a href="${scorecardUrl}">View your compliance scorecard</a></p>
      <p style="color:#888;font-size:12px;">You can opt out of regulatory change emails from your notification preferences. In-app notifications are always on.</p>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
