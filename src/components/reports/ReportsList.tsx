/**
 * Reports List Component
 *
 * Displays user's generated reports with download options.
 * Entitlement-gated access to report generation.
 */

import { useState, useEffect, useCallback } from 'react';
import { FileText, Download, Loader2, Calendar, AlertCircle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/lib/supabase';

type ReportType = 'anchor_summary' | 'compliance_audit' | 'activity_log' | 'billing_history';
type ReportStatus = 'pending' | 'generating' | 'completed' | 'failed';

interface Report {
  id: string;
  report_type: ReportType;
  status: ReportStatus;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
}

interface ReportsListProps {
  hasReportsEntitlement?: boolean;
}

const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  anchor_summary: 'Record Summary',
  compliance_audit: 'Compliance Audit',
  activity_log: 'Activity Log',
  billing_history: 'Billing History',
};

export function ReportsList({ hasReportsEntitlement = true }: Readonly<ReportsListProps>) {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedType, setSelectedType] = useState<ReportType>('anchor_summary');

  useEffect(() => {
    fetchReports();
  }, []);

  async function fetchReports() {
    setLoading(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from('reports')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('Failed to fetch reports:', error);
    } else {
      setReports(data || []);
    }
    setLoading(false);
  }

  async function generateReport() {
    if (!hasReportsEntitlement) return;

    setGenerating(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setGenerating(false);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from('reports')
      .insert({
        user_id: user.id,
        report_type: selectedType,
        parameters: {},
      })
      .select()
      .single();

    if (error) {
      console.error('Failed to create report:', error);
    } else {
      setReports((prev) => [data, ...prev]);
      setDialogOpen(false);
    }

    setGenerating(false);
  }

  const downloadReport = useCallback(async (reportId: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: artifacts } = await (supabase as any)
      .from('report_artifacts')
      .select('*')
      .eq('report_id', reportId)
      .single();

    if (artifacts) {
      // In production, would generate signed URL from storage
      const reportData = { reportId, ...artifacts };
      const blob = new Blob([JSON.stringify(reportData, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = artifacts.filename || `arkova-report-${reportId}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }
  }, []);

  function getStatusBadge(status: ReportStatus) {
    switch (status) {
      case 'completed':
        return <Badge variant="success">Completed</Badge>;
      case 'generating':
        return <Badge variant="secondary">Generating</Badge>;
      case 'pending':
        return <Badge variant="outline">Pending</Badge>;
      case 'failed':
        return <Badge variant="destructive">Failed</Badge>;
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Reports
          </CardTitle>
          <CardDescription>
            Generate and download lifecycle reports
          </CardDescription>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button disabled={!hasReportsEntitlement}>
              <Plus className="mr-2 h-4 w-4" />
              Generate Report
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Generate New Report</DialogTitle>
              <DialogDescription>
                Select the type of report you want to generate.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Select
                value={selectedType}
                onValueChange={(v) => setSelectedType(v as ReportType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="anchor_summary">Record Summary</SelectItem>
                  <SelectItem value="compliance_audit">Compliance Audit</SelectItem>
                  <SelectItem value="activity_log">Activity Log</SelectItem>
                  <SelectItem value="billing_history">Billing History</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={generateReport} disabled={generating}>
                {generating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Generate
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {!hasReportsEntitlement && (
          <div className="mb-4 rounded-lg border border-warning/50 bg-warning/10 p-4">
            <div className="flex items-center gap-2 text-warning">
              <AlertCircle className="h-4 w-4" />
              <span className="text-sm font-medium">
                Report generation requires a Professional or Organization plan.
              </span>
            </div>
          </div>
        )}

        {reports.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <FileText className="mx-auto h-12 w-12 mb-4 opacity-50" />
            <p>No reports generated yet.</p>
            <p className="text-sm">Click "Generate Report" to create your first report.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((report) => (
                <TableRow key={report.id}>
                  <TableCell className="font-medium">
                    {REPORT_TYPE_LABELS[report.report_type]}
                  </TableCell>
                  <TableCell>{getStatusBadge(report.status)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Calendar className="h-3 w-3" />
                      {new Date(report.created_at).toLocaleDateString()}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => downloadReport(report.id)}
                      disabled={report.status !== 'completed'}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
