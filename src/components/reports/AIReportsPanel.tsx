/**
 * AIReportsPanel (P8-S16)
 *
 * Reports page with generation trigger and download.
 * Shows report list, generation status, and result viewer.
 *
 * Design: "Nordic Vault" glass cards, stagger animations, shimmer loading.
 */

import { useEffect, useState } from 'react';
import {
  FileBarChart,
  Plus,
  RefreshCw,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  Clock,
  Download,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useAIReports } from '@/hooks/useAIReports';
import type { AIReport, ReportType } from '@/hooks/useAIReports';
import { toast } from 'sonner';

const REPORT_TYPES: { value: ReportType; label: string; description: string }[] = [
  {
    value: 'integrity_summary',
    label: 'Integrity Summary',
    description: 'Score distribution and flagged items across all credentials',
  },
  {
    value: 'extraction_accuracy',
    label: 'Extraction Accuracy',
    description: 'AI suggestion acceptance rates per field and credential type',
  },
  {
    value: 'credential_analytics',
    label: 'Credential Analytics',
    description: 'Issuance volume, type distribution, and timeline',
  },
  {
    value: 'compliance_overview',
    label: 'Compliance Overview',
    description: 'Review queue status and audit trail summary',
  },
];

const STATUS_ICONS: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  QUEUED: { icon: Clock, color: 'text-muted-foreground' },
  GENERATING: { icon: Loader2, color: 'text-primary' },
  COMPLETE: { icon: CheckCircle2, color: 'text-green-600' },
  FAILED: { icon: AlertTriangle, color: 'text-red-600' },
};

function ReportResultViewer({ report }: { report: AIReport }) {
  if (!report.result) return null;

  const downloadJSON = () => {
    const blob = new Blob([JSON.stringify(report.result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${report.title.replace(/\s+/g, '_')}_${report.id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Results
        </h4>
        <button
          type="button"
          onClick={downloadJSON}
          className="inline-flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors"
        >
          <Download className="h-3 w-3" />
          Download JSON
        </button>
      </div>

      {/* Summary stats */}
      {Boolean(report.result.totalCredentials != null) && (
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-muted/50 rounded-md p-2">
            <div className="text-lg font-semibold">{String(report.result.totalCredentials)}</div>
            <div className="text-xs text-muted-foreground">Total Credentials</div>
          </div>
          {report.result.averageScore != null && (
            <div className="bg-muted/50 rounded-md p-2">
              <div className="text-lg font-semibold">{String(report.result.averageScore)}/100</div>
              <div className="text-xs text-muted-foreground">Average Score</div>
            </div>
          )}
          {report.result.overallAcceptanceRate != null && (
            <div className="bg-muted/50 rounded-md p-2">
              <div className="text-lg font-semibold">{String(report.result.overallAcceptanceRate)}%</div>
              <div className="text-xs text-muted-foreground">Acceptance Rate</div>
            </div>
          )}
          {report.result.totalSuggestions != null && (
            <div className="bg-muted/50 rounded-md p-2">
              <div className="text-lg font-semibold">{String(report.result.totalSuggestions)}</div>
              <div className="text-xs text-muted-foreground">Total Suggestions</div>
            </div>
          )}
        </div>
      )}

      {/* Distribution */}
      {Boolean(report.result.distribution) && (
        <div className="space-y-1.5">
          <h5 className="text-xs font-medium text-muted-foreground">Score Distribution</h5>
          {Object.entries(report.result.distribution as Record<string, number>).map(([level, count]) => (
            <div key={level} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{level}</span>
              <span className="font-mono">{count}</span>
            </div>
          ))}
        </div>
      )}

      {/* Review queue stats */}
      {Boolean(report.result.reviewQueue) && (
        <div className="space-y-1.5">
          <h5 className="text-xs font-medium text-muted-foreground">Review Queue</h5>
          {Object.entries(report.result.reviewQueue as Record<string, number>).map(([key, value]) => (
            <div key={key} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground capitalize">{key}</span>
              <span className="font-mono">{value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AIReportsPanel() {
  const { reports, loading, creating, fetchReports, createReport, fetchReport } = useAIReports();
  const [showCreate, setShowCreate] = useState(false);
  const [selectedType, setSelectedType] = useState<ReportType>('integrity_summary');
  const [expandedReport, setExpandedReport] = useState<string | null>(null);
  const [pollingIds, setPollingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  // Poll for generating reports
  useEffect(() => {
    const generating = reports.filter((r) => r.status === 'QUEUED' || r.status === 'GENERATING');
    if (generating.length === 0) return;

    const interval = setInterval(async () => {
      for (const report of generating) {
        if (pollingIds.has(report.id)) continue;
        setPollingIds((prev) => new Set(prev).add(report.id));
        const updated = await fetchReport(report.id);
        if (updated && (updated.status === 'COMPLETE' || updated.status === 'FAILED')) {
          fetchReports();
          setPollingIds((prev) => {
            const next = new Set(prev);
            next.delete(report.id);
            return next;
          });
        } else {
          setPollingIds((prev) => {
            const next = new Set(prev);
            next.delete(report.id);
            return next;
          });
        }
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [reports, fetchReport, fetchReports, pollingIds]);

  const handleCreate = async () => {
    const typeConfig = REPORT_TYPES.find((t) => t.value === selectedType);
    try {
      await createReport(
        selectedType,
        typeConfig?.label ?? selectedType,
        { dateRange: 30 },
      );
      setShowCreate(false);
      toast.success('Report generation started');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create report');
    }
  };

  return (
    <div className="space-y-6 animate-in-view">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-gradient-to-br from-primary/15 to-primary/5">
            <FileBarChart className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold">AI Reports</h2>
            <p className="text-xs text-muted-foreground">
              Generate analytics and compliance reports
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={fetchReports}
            className="p-2 text-muted-foreground hover:text-foreground rounded-md transition-colors"
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => setShowCreate(!showCreate)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg shadow-glow-sm hover:shadow-glow-md transition-all"
          >
            <Plus className="h-4 w-4" />
            Generate Report
          </button>
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="glass-card rounded-xl p-4 space-y-3 border border-primary/20">
          <h3 className="text-sm font-medium">Select Report Type</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {REPORT_TYPES.map((type) => (
              <button
                key={type.value}
                type="button"
                onClick={() => setSelectedType(type.value)}
                className={`text-left p-3 rounded-lg border transition-all ${
                  selectedType === type.value
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                    : 'border-border hover:border-primary/30'
                }`}
              >
                <div className="text-sm font-medium">{type.label}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{type.description}</div>
              </button>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg disabled:opacity-50"
            >
              {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Generate
            </button>
          </div>
        </div>
      )}

      {/* Reports list */}
      {loading && reports.length === 0 ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="shimmer h-16 rounded-lg" />
          ))}
        </div>
      ) : reports.length === 0 ? (
        <div className="glass-card rounded-xl p-8 text-center">
          <FileBarChart className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium">No reports yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Generate your first report to get insights into your credentials
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {reports.map((report, index) => {
            const statusConfig = STATUS_ICONS[report.status] ?? STATUS_ICONS.QUEUED;
            const StatusIcon = statusConfig.icon;
            const isExpanded = expandedReport === report.id;

            return (
              <div
                key={report.id}
                className={`glass-card rounded-lg border transition-all stagger-${Math.min(index + 1, 8)}`}
              >
                <button
                  type="button"
                  className="w-full flex items-center justify-between p-4 text-left"
                  onClick={() => setExpandedReport(isExpanded ? null : report.id)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <StatusIcon
                      className={`h-4 w-4 flex-shrink-0 ${statusConfig.color} ${
                        report.status === 'GENERATING' ? 'animate-spin' : ''
                      }`}
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{report.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(report.createdAt).toLocaleDateString()} · {report.reportType.replace(/_/g, ' ')}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-3">
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-md ${
                        report.status === 'COMPLETE'
                          ? 'bg-green-50 text-green-700 border border-green-200'
                          : report.status === 'FAILED'
                            ? 'bg-red-50 text-red-700 border border-red-200'
                            : 'bg-muted text-muted-foreground border'
                      }`}
                    >
                      {report.status}
                    </span>
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t px-4 py-3">
                    {report.status === 'COMPLETE' && report.result ? (
                      <ReportResultViewer report={report} />
                    ) : report.status === 'FAILED' ? (
                      <div className="text-sm text-red-600">
                        {report.errorMessage ?? 'Report generation failed'}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Generating report...
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
