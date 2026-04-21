/**
 * Nessie Insights Panel (NMT-07, Phase G)
 *
 * Proactive compliance intelligence for individual anchor records.
 * Auto-runs a risk_analysis query when viewing a record and shows
 * risks/recommendations inline — turns Nessie from a search tool
 * into a proactive compliance assistant.
 *
 * Displayed within AssetDetailView.
 */

import { useState, useCallback, useEffect } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Brain, AlertTriangle, CheckCircle, Loader2, ChevronDown, ChevronUp, ExternalLink, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { NESSIE_LABELS } from '@/lib/copy';

interface NessieInsightsProps {
  /** The anchor record's credential type */
  credentialType?: string;
  /** The anchor record's issuer name */
  issuerName?: string;
  /** The anchor record's metadata */
  metadata?: Record<string, unknown> | null;
  /** The anchor record's public ID for context */
  publicId?: string;
}

interface InsightResponse {
  answer: string;
  citations: Array<{
    record_id: string;
    source: string;
    title: string | null;
    excerpt: string;
    anchor_proof: {
      explorer_url: string | null;
      verify_url: string | null;
    } | null;
  }>;
  confidence: number;
  risks?: string[];
  recommendations?: string[];
  task_type?: string;
}

export function NessieInsights({ credentialType, issuerName, metadata, publicId: _publicId }: NessieInsightsProps) {
  const [response, setResponse] = useState<InsightResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [hasQueried, setHasQueried] = useState(false);

  const buildQuery = useCallback(() => {
    const parts: string[] = [];
    if (credentialType) parts.push(`credential type: ${credentialType}`);
    if (issuerName) parts.push(`issued by ${issuerName}`);
    const jurisdiction = metadata?.jurisdiction as string | undefined;
    if (jurisdiction) parts.push(`jurisdiction: ${jurisdiction}`);
    const expiryDate = metadata?.expiryDate as string | undefined;
    if (expiryDate) parts.push(`expires: ${expiryDate}`);

    if (parts.length === 0) return null;
    return `Analyze compliance risks for this record: ${parts.join(', ')}`;
  }, [credentialType, issuerName, metadata]);

  const runAnalysis = useCallback(async () => {
    const query = buildQuery();
    if (!query) return;

    setLoading(true);
    setError(null);
    setHasQueried(true);

    try {
      const workerUrl = import.meta.env.VITE_WORKER_URL || 'http://localhost:3001';
      const res = await fetch(
        `${workerUrl}/api/v1/nessie/query?${new URLSearchParams({
          q: query,
          mode: 'context',
          task: 'risk_analysis',
          limit: '5',
        })}`,
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(body.error || `Request failed (${res.status})`);
      }

      const data: InsightResponse = await res.json();
      setResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis unavailable');
    } finally {
      setLoading(false);
    }
  }, [buildQuery]);

  // Auto-run on mount if we have enough context
  useEffect(() => {
    if (!hasQueried && buildQuery()) {
      async function run() { await runAnalysis(); }
      void run();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const query = buildQuery();
  if (!query) return null;

  const hasInsights = response && ((response.risks?.length ?? 0) > 0 || (response.recommendations?.length ?? 0) > 0);
  const riskCount = response?.risks?.length ?? 0;
  const recCount = response?.recommendations?.length ?? 0;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center justify-between w-full text-left"
        >
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Brain className="h-4 w-4 text-[#00d4ff]" />
            {NESSIE_LABELS.INSIGHTS_TITLE}
            {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
            {hasInsights && (
              <span className="flex items-center gap-1.5">
                {riskCount > 0 && (
                  <Badge variant="outline" className="text-xs bg-red-400/10 text-red-400 border-red-400/30">
                    {riskCount} risk{riskCount > 1 ? 's' : ''}
                  </Badge>
                )}
                {recCount > 0 && (
                  <Badge variant="outline" className="text-xs bg-[#00d4ff]/10 text-[#00d4ff] border-[#00d4ff]/30">
                    {recCount} action{recCount > 1 ? 's' : ''}
                  </Badge>
                )}
              </span>
            )}
          </CardTitle>
          {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </button>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-3 pt-0">
          {error && (
            <p className="text-xs text-muted-foreground">{error}</p>
          )}

          {loading && !response && (
            <div className="flex items-center gap-2 py-3">
              <Loader2 className="h-4 w-4 animate-spin text-[#00d4ff]" />
              <span className="text-xs text-muted-foreground">{NESSIE_LABELS.INSIGHTS_LOADING}</span>
            </div>
          )}

          {response && !hasInsights && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <CheckCircle className="h-3.5 w-3.5 text-green-400" />
              No compliance risks identified for this record.
            </div>
          )}

          {/* Risks */}
          {response?.risks && response.risks.length > 0 && (
            <div className="space-y-1.5">
              {response.risks.map((risk, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 text-xs p-2 rounded-md bg-red-400/5 border border-red-400/20"
                >
                  <AlertTriangle className="h-3 w-3 text-red-400 shrink-0 mt-0.5" />
                  <span className="text-foreground">{risk}</span>
                </div>
              ))}
            </div>
          )}

          {/* Recommendations */}
          {response?.recommendations && response.recommendations.length > 0 && (
            <div className="space-y-1.5">
              {response.recommendations.map((rec, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 text-xs p-2 rounded-md bg-[#00d4ff]/5 border border-[#00d4ff]/20"
                >
                  <CheckCircle className="h-3 w-3 text-[#00d4ff] shrink-0 mt-0.5" />
                  <span className="text-foreground">{rec}</span>
                </div>
              ))}
            </div>
          )}

          {/* Citations */}
          {response?.citations && response.citations.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide pt-1">
                Sources ({response.citations.length})
              </p>
              {response.citations.slice(0, 3).map((c) => (
                <div key={c.record_id} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <ArkovaIcon className="h-3 w-3 text-[#00d4ff] shrink-0" />
                  <span className="truncate">{c.title ?? c.record_id.slice(0, 12)}</span>
                  {c.anchor_proof?.explorer_url && (
                    <a
                      href={c.anchor_proof.explorer_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#00d4ff] hover:underline shrink-0"
                    >
                      <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Refresh */}
          <div className="flex justify-end pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={runAnalysis}
              disabled={loading}
              className="h-7 text-xs text-muted-foreground"
            >
              <RefreshCw className={cn('h-3 w-3 mr-1', loading && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
