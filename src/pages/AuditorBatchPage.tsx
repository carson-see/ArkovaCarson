/**
 * Auditor Batch Verification Page (COMP-06)
 *
 * Frontend for the POST /api/v1/audit/batch-verify endpoint.
 * Accessible in auditor mode only. Supports CSV upload of credential IDs
 * and random sampling with deterministic seeds (ISA 530).
 */

import { useState, useCallback } from 'react';
import { Upload, Download, BarChart3, AlertTriangle, CheckCircle, XCircle, Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AppShell } from '@/components/layout';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { supabase } from '@/lib/supabase';
import { AUDITOR_BATCH_LABELS } from '@/lib/copy';

interface VerifyResult {
  public_id: string;
  status: 'PASS' | 'FAIL' | 'NOT_FOUND';
  anchor_status: string | null;
  fingerprint: string | null;
  secured_at: string | null;
  tx_id: string | null;
  anomalies: string[];
}

interface BatchResponse {
  results: VerifyResult[];
  summary: {
    total_verified: number;
    passed: number;
    failed: number;
    not_found: number;
    anomalies_found: number;
  };
  total_population: number;
  sample_size: number;
  seed: number | null;
  verified_at: string;
}

export function AuditorBatchPage() {
  const { signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const [mode, setMode] = useState<'csv' | 'sample'>('csv');
  const [csvIds, setCsvIds] = useState('');
  const [samplePct, setSamplePct] = useState('10');
  const [seed, setSeed] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BatchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setError('Not authenticated');
        return;
      }

      const workerUrl = import.meta.env.VITE_WORKER_URL || 'http://localhost:3001';
      const body: Record<string, unknown> = {};

      if (mode === 'csv') {
        const ids = csvIds.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
        if (ids.length === 0) {
          setError('Enter at least one credential ID');
          return;
        }
        if (ids.length > 1000) {
          setError('Maximum 1,000 credential IDs per batch');
          return;
        }
        body.credential_ids = ids;
      } else {
        const pct = parseFloat(samplePct);
        if (isNaN(pct) || pct < 0.1 || pct > 100) {
          setError('Sample percentage must be between 0.1 and 100');
          return;
        }
        body.sample_percentage = pct;
        if (seed) body.seed = parseInt(seed, 10);
      }

      const resp = await fetch(`${workerUrl}/api/v1/audit/batch-verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Request failed' }));
        setError(err.error || `HTTP ${resp.status}`);
        return;
      }

      setResult(await resp.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [mode, csvIds, samplePct, seed]);

  const downloadCsv = useCallback(() => {
    if (!result) return;
    const header = 'public_id,status,anchor_status,fingerprint,secured_at,tx_id,anomalies\n';
    const rows = result.results.map(r =>
      `${r.public_id},${r.status},${r.anchor_status || ''},${r.fingerprint || ''},${r.secured_at || ''},${r.tx_id || ''},"${r.anomalies.join('; ')}"`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-batch-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [result]);

  return (
    <AppShell
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={signOut}
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{AUDITOR_BATCH_LABELS.PAGE_TITLE}</h1>
          <p className="text-muted-foreground text-sm mt-1">{AUDITOR_BATCH_LABELS.PAGE_DESCRIPTION}</p>
        </div>

        {/* Mode Selection */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Search className="h-5 w-5" /> {AUDITOR_BATCH_LABELS.SELECT_MODE}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Button
                variant={mode === 'csv' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setMode('csv')}
              >
                <Upload className="h-4 w-4 mr-1" /> {AUDITOR_BATCH_LABELS.MODE_CSV}
              </Button>
              <Button
                variant={mode === 'sample' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setMode('sample')}
              >
                <BarChart3 className="h-4 w-4 mr-1" /> {AUDITOR_BATCH_LABELS.MODE_SAMPLE}
              </Button>
            </div>

            {mode === 'csv' ? (
              <div>
                <Label htmlFor="csv-ids">{AUDITOR_BATCH_LABELS.CSV_LABEL}</Label>
                <textarea
                  id="csv-ids"
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm font-mono min-h-[120px]"
                  placeholder="ARK-2026-001&#10;ARK-2026-002&#10;ARK-2026-003"
                  value={csvIds}
                  onChange={e => setCsvIds(e.target.value)}
                />
                <p className="text-xs text-muted-foreground mt-1">{AUDITOR_BATCH_LABELS.CSV_HINT}</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="sample-pct">{AUDITOR_BATCH_LABELS.SAMPLE_PCT_LABEL}</Label>
                  <Input
                    id="sample-pct"
                    type="number"
                    min="0.1"
                    max="100"
                    step="0.1"
                    value={samplePct}
                    onChange={e => setSamplePct(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="seed">{AUDITOR_BATCH_LABELS.SEED_LABEL}</Label>
                  <Input
                    id="seed"
                    type="number"
                    placeholder={AUDITOR_BATCH_LABELS.SEED_PLACEHOLDER}
                    value={seed}
                    onChange={e => setSeed(e.target.value)}
                    className="mt-1"
                  />
                  <p className="text-xs text-muted-foreground mt-1">{AUDITOR_BATCH_LABELS.SEED_HINT}</p>
                </div>
              </div>
            )}

            {error && (
              <div className="text-sm text-destructive flex items-center gap-1">
                <AlertTriangle className="h-4 w-4" /> {error}
              </div>
            )}

            <Button onClick={handleSubmit} disabled={loading} className="w-full sm:w-auto">
              {loading ? 'Verifying...' : AUDITOR_BATCH_LABELS.SUBMIT}
            </Button>
          </CardContent>
        </Card>

        {/* Results */}
        {result && (
          <>
            {/* Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <Card>
                <CardContent className="pt-4 text-center">
                  <div className="text-2xl font-bold">{result.summary.total_verified}</div>
                  <div className="text-xs text-muted-foreground">Verified</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 text-center">
                  <div className="text-2xl font-bold text-green-500">{result.summary.passed}</div>
                  <div className="text-xs text-muted-foreground">Passed</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 text-center">
                  <div className="text-2xl font-bold text-destructive">{result.summary.failed}</div>
                  <div className="text-xs text-muted-foreground">Failed</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 text-center">
                  <div className="text-2xl font-bold text-muted-foreground">{result.summary.not_found}</div>
                  <div className="text-xs text-muted-foreground">Not Found</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 text-center">
                  <div className="text-2xl font-bold text-amber-500">{result.summary.anomalies_found}</div>
                  <div className="text-xs text-muted-foreground">Anomalies</div>
                </CardContent>
              </Card>
            </div>

            {/* Download */}
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={downloadCsv}>
                <Download className="h-4 w-4 mr-1" /> {AUDITOR_BATCH_LABELS.DOWNLOAD_CSV}
              </Button>
            </div>

            {/* Results Table */}
            <Card>
              <CardContent className="pt-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="pb-2 font-medium">Credential ID</th>
                        <th className="pb-2 font-medium">Status</th>
                        <th className="pb-2 font-medium">Secured At</th>
                        <th className="pb-2 font-medium">Anomalies</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.results.map(r => (
                        <tr key={r.public_id} className="border-b last:border-0">
                          <td className="py-2 font-mono text-xs">{r.public_id}</td>
                          <td className="py-2">
                            {r.status === 'PASS' && <span className="inline-flex items-center gap-1 text-green-500"><CheckCircle className="h-3.5 w-3.5" /> Pass</span>}
                            {r.status === 'FAIL' && <span className="inline-flex items-center gap-1 text-destructive"><XCircle className="h-3.5 w-3.5" /> Fail</span>}
                            {r.status === 'NOT_FOUND' && <span className="text-muted-foreground">Not Found</span>}
                          </td>
                          <td className="py-2 text-muted-foreground text-xs">
                            {r.secured_at ? new Date(r.secured_at).toLocaleString() : '—'}
                          </td>
                          <td className="py-2">
                            {r.anomalies.length > 0 ? (
                              <div className="space-y-1">
                                {r.anomalies.map((a, i) => (
                                  <div key={i} className="text-xs text-amber-500 flex items-center gap-1">
                                    <AlertTriangle className="h-3 w-3 shrink-0" /> {a}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">None</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            {/* Metadata */}
            <div className="text-xs text-muted-foreground text-right">
              Population: {result.total_population} | Sample: {result.sample_size}
              {result.seed !== null && ` | Seed: ${result.seed}`}
              {' | '}Verified at: {new Date(result.verified_at).toLocaleString()}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
