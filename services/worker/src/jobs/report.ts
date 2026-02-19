/**
 * Report Generation Job
 *
 * Generates lifecycle reports for users.
 * Entitlement-gated via the reports schema.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

type ReportType = 'anchor_summary' | 'compliance_audit' | 'activity_log' | 'billing_history';

interface ReportData {
  id: string;
  user_id: string;
  org_id: string | null;
  report_type: ReportType;
  parameters: Record<string, unknown>;
}

/**
 * Generate anchor summary report
 */
async function generateAnchorSummary(userId: string, orgId: string | null): Promise<Record<string, unknown>> {
  // Fetch anchor statistics
  const { data: anchors } = await db
    .from('anchors')
    .select('id, status, created_at')
    .eq('user_id', userId)
    .is('deleted_at', null);

  const total = anchors?.length || 0;
  const secured = anchors?.filter((a) => a.status === 'SECURED').length || 0;
  const pending = anchors?.filter((a) => a.status === 'PENDING').length || 0;
  const revoked = anchors?.filter((a) => a.status === 'REVOKED').length || 0;

  return {
    report_type: 'anchor_summary',
    generated_at: new Date().toISOString(),
    summary: {
      total_records: total,
      secured: secured,
      pending: pending,
      revoked: revoked,
    },
    org_id: orgId,
  };
}

/**
 * Generate compliance audit report
 */
async function generateComplianceAudit(userId: string, orgId: string | null): Promise<Record<string, unknown>> {
  // Fetch audit events
  const { data: events } = await db
    .from('audit_events')
    .select('*')
    .eq('actor_id', userId)
    .order('timestamp', { ascending: false })
    .limit(1000);

  return {
    report_type: 'compliance_audit',
    generated_at: new Date().toISOString(),
    event_count: events?.length || 0,
    events: events || [],
    org_id: orgId,
  };
}

/**
 * Generate activity log report
 */
async function generateActivityLog(userId: string, orgId: string | null): Promise<Record<string, unknown>> {
  // Fetch recent activity
  const { data: activity } = await db
    .from('audit_events')
    .select('event_type, event_category, timestamp, details')
    .eq('actor_id', userId)
    .order('timestamp', { ascending: false })
    .limit(500);

  return {
    report_type: 'activity_log',
    generated_at: new Date().toISOString(),
    activity: activity || [],
    org_id: orgId,
  };
}

/**
 * Generate billing history report
 */
async function generateBillingHistory(userId: string, _orgId: string | null): Promise<Record<string, unknown>> {
  // Fetch billing events
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: events } = await (db as any)
    .from('billing_events')
    .select('*')
    .eq('user_id', userId)
    .order('processed_at', { ascending: false })
    .limit(100);

  return {
    report_type: 'billing_history',
    generated_at: new Date().toISOString(),
    billing_events: events || [],
  };
}

/**
 * Process a single report
 */
export async function processReport(report: ReportData): Promise<boolean> {
  logger.info({ reportId: report.id, type: report.report_type }, 'Processing report');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updateError } = await (db as any)
    .from('reports')
    .update({
      status: 'generating',
      started_at: new Date().toISOString(),
    })
    .eq('id', report.id);

  if (updateError) {
    logger.error({ reportId: report.id, error: updateError }, 'Failed to update report status');
    return false;
  }

  try {
    let reportContent: Record<string, unknown>;

    switch (report.report_type) {
      case 'anchor_summary':
        reportContent = await generateAnchorSummary(report.user_id, report.org_id);
        break;
      case 'compliance_audit':
        reportContent = await generateComplianceAudit(report.user_id, report.org_id);
        break;
      case 'activity_log':
        reportContent = await generateActivityLog(report.user_id, report.org_id);
        break;
      case 'billing_history':
        reportContent = await generateBillingHistory(report.user_id, report.org_id);
        break;
      default:
        throw new Error(`Unknown report type: ${report.report_type}`);
    }

    // Store the report artifact
    const filename = `arkova-${report.report_type}-${report.id}.json`;
    const storagePath = `reports/${report.user_id}/${filename}`;
    const content = JSON.stringify(reportContent, null, 2);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).from('report_artifacts').insert({
      report_id: report.id,
      filename,
      mime_type: 'application/json',
      file_size: content.length,
      storage_path: storagePath,
    });

    // Mark report as completed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)
      .from('reports')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
      })
      .eq('id', report.id);

    logger.info({ reportId: report.id }, 'Report generated successfully');
    return true;
  } catch (error) {
    logger.error({ reportId: report.id, error }, 'Failed to generate report');

    // Mark as failed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)
      .from('reports')
      .update({
        status: 'failed',
        error_message: error instanceof Error ? error.message : 'Unknown error',
      })
      .eq('id', report.id);

    return false;
  }
}

/**
 * Process all pending reports
 */
export async function processPendingReports(): Promise<{ processed: number; failed: number }> {
  logger.info('Starting pending report processing');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: reports, error } = await (db as any)
    .from('reports')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(10);

  if (error) {
    logger.error({ error }, 'Failed to fetch pending reports');
    return { processed: 0, failed: 0 };
  }

  if (!reports || reports.length === 0) {
    logger.debug('No pending reports to process');
    return { processed: 0, failed: 0 };
  }

  logger.info({ count: reports.length }, 'Found pending reports');

  let processed = 0;
  let failed = 0;

  for (const report of reports) {
    const success = await processReport(report);
    if (success) {
      processed++;
    } else {
      failed++;
    }
  }

  logger.info({ processed, failed }, 'Finished processing pending reports');
  return { processed, failed };
}
