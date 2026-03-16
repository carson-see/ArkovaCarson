/**
 * AI Report Generation Service (P8-S16)
 *
 * Generates analytics reports for organizations:
 *   - Integrity summary: score distribution, flagged items
 *   - Extraction accuracy: acceptance rates per field
 *   - Credential analytics: issuance volume, type distribution
 *   - Compliance overview: review queue status, audit trail
 *
 * Reports are stored as JSON in the ai_reports table.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getExtractionAccuracy } from './feedback.js';
import { getReviewQueueStats } from './review-queue.js';
import { z } from 'zod';

// =============================================================================
// TYPES
// =============================================================================

export type ReportType = 'integrity_summary' | 'extraction_accuracy' | 'credential_analytics' | 'compliance_overview';
export type ReportStatus = 'QUEUED' | 'GENERATING' | 'COMPLETE' | 'FAILED';

export const CreateReportSchema = z.object({
  reportType: z.enum(['integrity_summary', 'extraction_accuracy', 'credential_analytics', 'compliance_overview']),
  title: z.string().min(1).max(200),
  parameters: z.object({
    dateRange: z.number().min(1).max(365).default(30),
    credentialType: z.string().optional(),
  }).optional(),
});

export interface ReportRecord {
  id: string;
  orgId: string;
  requestedBy: string;
  reportType: ReportType;
  status: ReportStatus;
  title: string;
  parameters: Record<string, unknown>;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

// =============================================================================
// CREATE REPORT
// =============================================================================

/**
 * Create a new report record and start generation.
 */
export async function createReport(
  orgId: string,
  userId: string,
  reportType: ReportType,
  title: string,
  parameters: Record<string, unknown> = {},
): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('ai_reports')
      .insert({
        org_id: orgId,
        requested_by: userId,
        report_type: reportType,
        status: 'QUEUED',
        title,
        parameters,
      })
      .select('id')
      .single();

    if (error) {
      logger.error({ error }, 'Failed to create report');
      return null;
    }

    return data?.id ?? null;
  } catch (err) {
    logger.error({ error: err }, 'Failed to create report');
    return null;
  }
}

// =============================================================================
// GENERATE REPORT DATA
// =============================================================================

/**
 * Generate the report content. Updates the report record with results.
 */
export async function generateReport(reportId: string): Promise<boolean> {
  try {
    // Fetch report record
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: report, error: fetchErr } = await (db as any)
      .from('ai_reports')
      .select('*')
      .eq('id', reportId)
      .single();

    if (fetchErr || !report) {
      logger.error({ reportId, error: fetchErr }, 'Report not found');
      return false;
    }

    // Mark as generating
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)
      .from('ai_reports')
      .update({ status: 'GENERATING', started_at: new Date().toISOString() })
      .eq('id', reportId);

    const orgId = report.org_id;
    const params = report.parameters ?? {};
    const dateRange = (params.dateRange as number) ?? 30;

    let result: Record<string, unknown>;

    switch (report.report_type) {
      case 'integrity_summary':
        result = await generateIntegritySummary(orgId);
        break;
      case 'extraction_accuracy':
        result = await generateExtractionAccuracyReport(orgId, dateRange, params.credentialType as string | undefined);
        break;
      case 'credential_analytics':
        result = await generateCredentialAnalytics(orgId, dateRange);
        break;
      case 'compliance_overview':
        result = await generateComplianceOverview(orgId);
        break;
      default:
        throw new Error(`Unknown report type: ${report.report_type}`);
    }

    // Mark as complete
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)
      .from('ai_reports')
      .update({
        status: 'COMPLETE',
        result,
        completed_at: new Date().toISOString(),
      })
      .eq('id', reportId);

    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ error: err, reportId }, 'Report generation failed');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)
      .from('ai_reports')
      .update({
        status: 'FAILED',
        error_message: errorMessage,
        completed_at: new Date().toISOString(),
      })
      .eq('id', reportId);

    return false;
  }
}

// =============================================================================
// REPORT GENERATORS
// =============================================================================

async function generateIntegritySummary(orgId: string): Promise<Record<string, unknown>> {
  // Get score distribution
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: scores } = await (db as any)
    .from('integrity_scores')
    .select('overall_score, level, flags')
    .eq('org_id', orgId);

  const distribution = { HIGH: 0, MEDIUM: 0, LOW: 0, FLAGGED: 0 };
  const allFlags: Record<string, number> = {};
  let totalScore = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const score of (scores ?? []) as any[]) {
    distribution[score.level as keyof typeof distribution]++;
    totalScore += Number(score.overall_score);
    for (const flag of (score.flags ?? []) as string[]) {
      allFlags[flag] = (allFlags[flag] ?? 0) + 1;
    }
  }

  const total = scores?.length ?? 0;
  const avgScore = total > 0 ? Math.round(totalScore / total) : 0;

  // Top flags
  const topFlags = Object.entries(allFlags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([flag, count]) => ({ flag, count }));

  return {
    generatedAt: new Date().toISOString(),
    totalCredentials: total,
    averageScore: avgScore,
    distribution,
    topFlags,
  };
}

async function generateExtractionAccuracyReport(
  orgId: string,
  days: number,
  credentialType?: string,
): Promise<Record<string, unknown>> {
  const accuracy = await getExtractionAccuracy(credentialType, orgId, days);

  let totalAccepted = 0;
  let totalRejected = 0;
  let totalEdited = 0;

  for (const stat of accuracy) {
    totalAccepted += stat.acceptedCount;
    totalRejected += stat.rejectedCount;
    totalEdited += stat.editedCount;
  }

  const totalSuggestions = totalAccepted + totalRejected + totalEdited;
  const overallAcceptanceRate = totalSuggestions > 0
    ? Math.round((totalAccepted / totalSuggestions) * 100)
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    dateRangeDays: days,
    totalSuggestions,
    totalAccepted,
    totalRejected,
    totalEdited,
    overallAcceptanceRate,
    byField: accuracy,
  };
}

async function generateCredentialAnalytics(
  orgId: string,
  days: number,
): Promise<Record<string, unknown>> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  // Get credential counts by type and status
  const { data: anchors } = await db
    .from('anchors')
    .select('credential_type, status, created_at')
    .eq('org_id', orgId)
    .gte('created_at', since.toISOString());

  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byDay: Record<string, number> = {};

  for (const anchor of (anchors ?? [])) {
    const ct = (anchor.credential_type as string) ?? 'OTHER';
    byType[ct] = (byType[ct] ?? 0) + 1;

    const status = anchor.status as string;
    byStatus[status] = (byStatus[status] ?? 0) + 1;

    const day = (anchor.created_at as string).slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    dateRangeDays: days,
    totalCredentials: anchors?.length ?? 0,
    byType,
    byStatus,
    issuanceTimeline: Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count })),
  };
}

async function generateComplianceOverview(orgId: string): Promise<Record<string, unknown>> {
  const queueStats = await getReviewQueueStats(orgId);

  // Get recent audit events
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: auditEvents } = await (db as any)
    .from('audit_events')
    .select('event_type, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(100);

  const eventTypes: Record<string, number> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const event of (auditEvents ?? []) as any[]) {
    const type = event.event_type as string;
    eventTypes[type] = (eventTypes[type] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    reviewQueue: queueStats,
    recentAuditEvents: {
      total: auditEvents?.length ?? 0,
      byType: eventTypes,
    },
  };
}

// =============================================================================
// LIST REPORTS
// =============================================================================

/**
 * List reports for an org.
 */
export async function listReports(
  orgId: string,
  limit: number = 20,
  offset: number = 0,
): Promise<ReportRecord[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('ai_reports')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error || !data) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return data.map((row: any) => ({
      id: row.id,
      orgId: row.org_id,
      requestedBy: row.requested_by,
      reportType: row.report_type,
      status: row.status,
      title: row.title,
      parameters: row.parameters ?? {},
      result: row.result,
      errorMessage: row.error_message,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    }));
  } catch (err) {
    logger.error({ error: err }, 'Failed to list reports');
    return [];
  }
}

/**
 * Get a single report by ID.
 */
export async function getReport(reportId: string): Promise<ReportRecord | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('ai_reports')
      .select('*')
      .eq('id', reportId)
      .single();

    if (error || !data) return null;

    return {
      id: data.id,
      orgId: data.org_id,
      requestedBy: data.requested_by,
      reportType: data.report_type,
      status: data.status,
      title: data.title,
      parameters: data.parameters ?? {},
      result: data.result,
      errorMessage: data.error_message,
      startedAt: data.started_at,
      completedAt: data.completed_at,
      createdAt: data.created_at,
    };
  } catch (err) {
    logger.error({ error: err }, 'Failed to get report');
    return null;
  }
}
