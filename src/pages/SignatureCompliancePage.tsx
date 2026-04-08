/**
 * Signature Compliance Center Page (Phase III — PH3-ESIG-03)
 *
 * Customer-facing compliance dashboard showing:
 * - Signature statistics and compliance score
 * - Audit proof downloads
 * - Bulk export (CSV/JSON)
 * - SOC 2 evidence bundle generation
 * - GDPR Article 30 export
 * - eIDAS compliance report
 *
 * Story: PH3-ESIG-03 (SCRUM-424)
 */

import { useState } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Download, FileText, FileCheck, Scale, Lock, BarChart3, AlertCircle, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { workerFetch } from '@/lib/workerClient';

function downloadBlob(data: string, filename: string, type: string) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function SignatureCompliancePage() {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const downloadExport = async (format: 'json' | 'csv') => {
    setLoading(`export-${format}`);
    setError(null);
    try {
      const res = await workerFetch(`/api/v1/signatures/export?format=${format}`);
      if (!res.ok) throw new Error('Export failed');
      const text = await res.text();
      downloadBlob(text, `arkova-signatures.${format}`, format === 'csv' ? 'text/csv' : 'application/json');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setLoading(null);
    }
  };

  const downloadSoc2 = async () => {
    setLoading('soc2');
    setError(null);
    try {
      const now = new Date();
      const from = new Date(now.getFullYear(), 0, 1).toISOString();
      const to = now.toISOString();
      const res = await workerFetch(`/api/v1/signatures/soc2-evidence?from=${from}&to=${to}`);
      if (!res.ok) throw new Error('SOC 2 evidence generation failed');
      const data = await res.json();
      downloadBlob(JSON.stringify(data, null, 2), 'arkova-soc2-evidence.json', 'application/json');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(null);
    }
  };

  const downloadGdpr = async () => {
    setLoading('gdpr');
    setError(null);
    try {
      const res = await workerFetch('/api/v1/signatures/gdpr-article30');
      if (!res.ok) throw new Error('GDPR export failed');
      const data = await res.json();
      downloadBlob(JSON.stringify(data, null, 2), 'arkova-gdpr-article30.json', 'application/json');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(null);
    }
  };

  const downloadEidas = async () => {
    setLoading('eidas');
    setError(null);
    try {
      const now = new Date();
      const from = new Date(now.getFullYear(), 0, 1).toISOString();
      const to = now.toISOString();
      const res = await workerFetch(`/api/v1/signatures/eidas-report?from=${from}&to=${to}`);
      if (!res.ok) throw new Error('eIDAS report failed');
      const data = await res.json();
      downloadBlob(JSON.stringify(data, null, 2), 'arkova-eidas-compliance-report.json', 'application/json');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white flex items-center gap-2">
          <ArkovaIcon className="h-6 w-6 text-cyan-400" />
          Signature Compliance Center
        </h1>
        <p className="text-gray-400 mt-1">
          Audit proofs, compliance exports, and regulatory reporting for your electronic signatures.
        </p>
      </div>

      {error && (
        <Card className="bg-red-500/10 border-red-500/30">
          <CardContent className="py-3 flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-red-400" />
            <span className="text-red-300 text-sm">{error}</span>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Bulk Export */}
        <Card className="bg-[#1A1D2E] border-gray-700">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Download className="h-5 w-5 text-cyan-400" />
              Signature Export
            </CardTitle>
            <CardDescription>Download all signatures as CSV or JSON</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadExport('csv')}
              disabled={loading === 'export-csv'}
            >
              {loading === 'export-csv' ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <FileText className="h-4 w-4 mr-1" />}
              CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadExport('json')}
              disabled={loading === 'export-json'}
            >
              {loading === 'export-json' ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <FileText className="h-4 w-4 mr-1" />}
              JSON
            </Button>
          </CardContent>
        </Card>

        {/* SOC 2 Evidence */}
        <Card className="bg-[#1A1D2E] border-gray-700">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <FileCheck className="h-5 w-5 text-emerald-400" />
              SOC 2 Evidence Bundle
            </CardTitle>
            <CardDescription>CC6.1, CC7.2, CC8.1, PI1.3 control evidence</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadSoc2}
              disabled={loading === 'soc2'}
            >
              {loading === 'soc2' ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Download className="h-4 w-4 mr-1" />}
              Generate Bundle
            </Button>
          </CardContent>
        </Card>

        {/* GDPR Article 30 */}
        <Card className="bg-[#1A1D2E] border-gray-700">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Lock className="h-5 w-5 text-purple-400" />
              GDPR Article 30
            </CardTitle>
            <CardDescription>Record of Processing Activities for signature operations</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadGdpr}
              disabled={loading === 'gdpr'}
            >
              {loading === 'gdpr' ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Download className="h-4 w-4 mr-1" />}
              Export ROPA
            </Button>
          </CardContent>
        </Card>

        {/* eIDAS Report */}
        <Card className="bg-[#1A1D2E] border-gray-700">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Scale className="h-5 w-5 text-blue-400" />
              eIDAS Compliance Report
            </CardTitle>
            <CardDescription>Qualified signatures, QTSP usage, certificate status</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadEidas}
              disabled={loading === 'eidas'}
            >
              {loading === 'eidas' ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <BarChart3 className="h-4 w-4 mr-1" />}
              Generate Report
            </Button>
          </CardContent>
        </Card>
      </div>

      <Separator className="bg-gray-700" />

      {/* Policy Transparency */}
      <Card className="bg-[#1A1D2E] border-gray-700">
        <CardHeader>
          <CardTitle className="text-white">Policy Transparency</CardTitle>
          <CardDescription>How Arkova handles signature data</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-gray-300">
          <div className="flex items-start gap-3">
            <Badge variant="outline" className="text-emerald-400 border-emerald-400/30 shrink-0 mt-0.5">Privacy</Badge>
            <p>Documents never leave your device. Only the SHA-256 fingerprint is transmitted for signing and anchoring.</p>
          </div>
          <div className="flex items-start gap-3">
            <Badge variant="outline" className="text-cyan-400 border-cyan-400/30 shrink-0 mt-0.5">Encryption</Badge>
            <p>All signing keys are stored in HSM (AWS KMS / GCP Cloud HSM). Private key material never enters application memory.</p>
          </div>
          <div className="flex items-start gap-3">
            <Badge variant="outline" className="text-purple-400 border-purple-400/30 shrink-0 mt-0.5">Retention</Badge>
            <p>Signature records and audit events are retained for 10 years per eIDAS Article 24(2) requirements. OCSP responses are cached in-memory for 1 hour.</p>
          </div>
          <div className="flex items-start gap-3">
            <Badge variant="outline" className="text-blue-400 border-blue-400/30 shrink-0 mt-0.5">Standards</Badge>
            <p>Signatures comply with ETSI EN 319 132 (XAdES), EN 319 142 (PAdES), EN 319 122 (CAdES). Algorithm selection enforces ETSI TS 119 312 minimums.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
