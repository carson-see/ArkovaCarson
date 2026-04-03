/**
 * Nessie Intelligence Panel (NMT-07, Phase F)
 *
 * Lets users ask Nessie compliance intelligence questions.
 * Nessie analyzes documents and returns answers with verified citations
 * backed by Bitcoin-anchored evidence.
 *
 * Calls GET /api/v1/nessie/query?q={query}&mode=context
 */

import { useState, useCallback } from 'react';
import {
  Brain,
  Search,
  ExternalLink,
  ShieldCheck,
  AlertTriangle,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { NESSIE_LABELS } from '@/lib/copy';

// ---------------------------------------------------------------------------
// Types (matching nessie-query.ts response shapes)
// ---------------------------------------------------------------------------

interface NessieCitation {
  record_id: string;
  source: string;
  source_url: string;
  title: string | null;
  relevance_score: number;
  anchor_proof: {
    chain_tx_id: string | null;
    content_hash: string;
    explorer_url: string | null;
    verify_url: string | null;
  } | null;
  excerpt: string;
}

interface NessieContextResponse {
  answer: string;
  citations: NessieCitation[];
  confidence: number;
  model: string;
  query: string;
  tokens_used?: number;
  cached?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NessieIntelligencePanel() {
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState<NessieContextResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleQuery = useCallback(async () => {
    if (!query.trim() || loading) return;

    setLoading(true);
    setError(null);
    setResponse(null);

    try {
      const workerUrl = import.meta.env.VITE_WORKER_URL || 'http://localhost:3001';
      const res = await fetch(
        `${workerUrl}/api/v1/nessie/query?${new URLSearchParams({
          q: query.trim(),
          mode: 'context',
          limit: '10',
        })}`,
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(body.error || `Request failed (${res.status})`);
      }

      const data: NessieContextResponse = await res.json();
      setResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [query, loading]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleQuery();
    }
  };

  const confidenceColor = (confidence: number): string => {
    if (confidence >= 0.85) return 'text-green-400';
    if (confidence >= 0.65) return 'text-yellow-400';
    return 'text-red-400';
  };

  const sourceLabel = (source: string): string => {
    const labels: Record<string, string> = {
      edgar: 'SEC EDGAR',
      courtlistener: 'CourtListener',
      federal_register: 'Federal Register',
      uspto: 'USPTO',
      openalex: 'OpenAlex',
      dapip: 'DAPIP',
    };
    return labels[source] ?? source;
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Brain className="h-5 w-5 text-[#00d4ff]" />
          {NESSIE_LABELS.PANEL_TITLE}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {NESSIE_LABELS.PANEL_SUBTITLE}
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Query input */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={NESSIE_LABELS.INPUT_PLACEHOLDER}
              className="w-full h-10 pl-10 pr-3 rounded-md border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-[#00d4ff]/40"
              disabled={loading}
            />
          </div>
          <Button
            onClick={handleQuery}
            disabled={!query.trim() || loading}
            className="bg-[#00d4ff] hover:bg-[#00d4ff]/90 text-black font-medium"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
          </Button>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 text-sm text-red-400 bg-red-400/10 p-3 rounded-md">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Response */}
        {response && (
          <div className="space-y-4 pt-2">
            {/* Confidence badge */}
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                <span className={cn('font-mono', confidenceColor(response.confidence))}>
                  {(response.confidence * 100).toFixed(0)}%
                </span>
                &nbsp;{NESSIE_LABELS.CONFIDENCE}
              </Badge>
              {response.cached && (
                <Badge variant="secondary" className="text-xs">cached</Badge>
              )}
              {response.tokens_used && (
                <span className="text-xs text-muted-foreground">
                  {response.tokens_used.toLocaleString()} tokens
                </span>
              )}
            </div>

            {/* Analysis text */}
            <div className="text-sm text-foreground leading-relaxed whitespace-pre-wrap bg-muted/30 p-4 rounded-md border border-border">
              {response.answer}
            </div>

            {/* Citations */}
            {response.citations.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {NESSIE_LABELS.CITATIONS_HEADING} ({response.citations.length})
                </p>
                {response.citations.map((citation) => (
                  <div
                    key={citation.record_id}
                    className="flex items-start gap-3 p-3 rounded-md border border-border bg-card hover:bg-muted/30 transition-colors"
                  >
                    <ShieldCheck className="h-4 w-4 text-[#00d4ff] shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-foreground truncate">
                          {citation.title ?? 'Untitled'}
                        </span>
                        <Badge variant="secondary" className="text-xs shrink-0">
                          {sourceLabel(citation.source)}
                        </Badge>
                      </div>
                      {citation.excerpt && (
                        <p className="text-xs text-muted-foreground italic line-clamp-2">
                          &ldquo;{citation.excerpt}&rdquo;
                        </p>
                      )}
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="font-mono">{citation.record_id.slice(0, 12)}...</span>
                        {citation.anchor_proof?.explorer_url && (
                          <a
                            href={citation.anchor_proof.explorer_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[#00d4ff] hover:underline"
                          >
                            <ExternalLink className="h-3 w-3" />
                            {NESSIE_LABELS.VIEW_ON_CHAIN}
                          </a>
                        )}
                        {citation.anchor_proof?.verify_url && (
                          <a
                            href={citation.anchor_proof.verify_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[#00d4ff] hover:underline"
                          >
                            <ShieldCheck className="h-3 w-3" />
                            {NESSIE_LABELS.VERIFY}
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Empty state */}
        {!response && !loading && !error && (
          <div className="text-center py-6">
            <Brain className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">
              {NESSIE_LABELS.EMPTY_STATE}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
