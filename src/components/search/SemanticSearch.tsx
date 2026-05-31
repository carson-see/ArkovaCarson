/**
 * SemanticSearch Component (SCRUM-1958)
 *
 * Natural language ("smart") search across the org's secured documents using
 * AI embeddings. Nordic Vault aesthetic.
 *
 * Mounting is gated behind ENABLE_SEMANTIC_SEARCH — render <SemanticSearchPanel/>
 * (the flag-aware wrapper) on pages; the bare <SemanticSearch/> is the
 * presentational component and assumes the flag is already on.
 *
 * Constitution §1.3: no banned terminology in user-visible copy (match strength
 * is a friendly percentage, never a raw vector score).
 * Constitution §1.6: the browser never POSTs audit/usage events — the worker
 * records AI usage server-side (logAIUsageEvent in ai-search.ts).
 */

import { useState, useCallback, useEffect } from 'react';
import { Search, Sparkles, FileText, Clock, AlertCircle } from 'lucide-react';
import { useSemanticSearch, type SemanticSearchResult } from '../../hooks/useSemanticSearch';
import { Link } from 'react-router-dom';
import { ROUTES } from '../../lib/routes';
import { SEMANTIC_SEARCH_LABELS } from '../../lib/copy';
import { isSemanticSearchEnabled } from '../../lib/switchboard';
import { Card, CardContent } from '@/components/ui/card';

// SCRUM-2003 display contract: status strings mapped to user-visible labels.
// Keep in sync with getStatusDisplay/getStatusLabel in the shared status
// helper once SCRUM-2003 lands. This local table is the interim alignment.
const STATUS_DISPLAY: Record<string, { color: string; label: string }> = {
  SECURED:   { color: 'bg-emerald-500/10 text-emerald-400', label: 'Verified' },
  PENDING:   { color: 'bg-amber-500/10 text-amber-400',     label: 'Processing' },
  SUBMITTED: { color: 'bg-amber-500/10 text-amber-400',     label: 'Awaiting Confirmation' },
  REVOKED:   { color: 'bg-red-500/10 text-red-400',         label: 'Revoked' },
  EXPIRED:   { color: 'bg-gray-500/10 text-gray-400',       label: 'Expired' },
};

/**
 * Map an anchor status string to a display-safe { color, label } object.
 * Labels follow the SCRUM-2003 display contract so this surface stays aligned
 * with the rest of the app.
 */
function getStatusDisplay(status: string): { color: string; label: string } {
  return STATUS_DISPLAY[status] ?? { color: 'bg-gray-500/10 text-gray-400', label: status };
}

/** Map a 0..1 similarity score to a friendly, non-technical strength label. */
function matchStrengthLabel(score: number): string {
  const pct = Math.round(score * 100);
  if (pct >= 90) return SEMANTIC_SEARCH_LABELS.MATCH_STRENGTH_STRONG;
  if (pct >= 75) return SEMANTIC_SEARCH_LABELS.MATCH_STRENGTH_GOOD;
  return SEMANTIC_SEARCH_LABELS.MATCH_STRENGTH_FAIR;
}

function SimilarityBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color =
    pct >= 90
      ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
      : pct >= 75
        ? 'text-amber-400 bg-amber-500/10 border-amber-500/20'
        : 'text-red-400 bg-red-500/10 border-red-500/20';

  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${color}`}
      title={matchStrengthLabel(score)}
      aria-label={matchStrengthLabel(score)}
    >
      {SEMANTIC_SEARCH_LABELS.MATCH_LABEL.replace('{percent}', String(pct))}
    </span>
  );
}

function SearchResultCard({ result }: { result: SemanticSearchResult }) {
  const statusDisplay = getStatusDisplay(result.status);
  return (
    <Link
      to={ROUTES.RECORD_DETAIL.replace(':id', result.anchorId)}
      className="glass-card group block rounded-xl border border-white/10 p-4 transition-all hover:shadow-card-hover hover:-translate-y-0.5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/15 to-primary/5">
            <FileText className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="font-medium text-foreground truncate">
              {result.fileName || result.credentialType || 'Document'}
            </p>
            {result.credentialType && (
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground truncate">
                {result.credentialType}
              </p>
            )}
            {result.metadata?.issuerName && (
              <p className="text-sm text-muted-foreground mt-0.5 truncate">
                {result.metadata.issuerName}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <SimilarityBadge score={result.similarity} />
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusDisplay.color}`}
          >
            {statusDisplay.label}
          </span>
        </div>
      </div>

        <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          {new Date(result.createdAt).toLocaleDateString()}
        </div>
    </Link>
  );
}

/**
 * Presentational semantic search. Assumes the feature flag is already on; use
 * {@link SemanticSearchPanel} to gate the mount.
 */
export function SemanticSearch() {
  const [query, setQuery] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const { results, isSearching, error, creditsRemaining, search, clear } =
    useSemanticSearch();

  const handleSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (query.trim()) {
        setHasSearched(true);
        search(query.trim());
      }
    },
    [query, search],
  );

  const handleClear = useCallback(() => {
    setQuery('');
    setHasSearched(false);
    clear();
  }, [clear]);

  // Empty state should only appear after a completed search returned nothing.
  const showEmptyState =
    hasSearched && !isSearching && results.length === 0 && !error;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Sparkles className="h-4 w-4 text-primary" />
          {SEMANTIC_SEARCH_LABELS.HEADING}
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {SEMANTIC_SEARCH_LABELS.SUBHEADING}
        </p>
      </div>

      {/* Search form */}
      <form onSubmit={handleSearch} className="relative">
        <div className="glass-card flex items-center gap-3 rounded-xl border border-white/10 px-4 py-3">
          <Search className="h-5 w-5 text-primary shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={SEMANTIC_SEARCH_LABELS.PLACEHOLDER}
            aria-label={SEMANTIC_SEARCH_LABELS.HEADING}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-hidden"
          />
          <button
            type="submit"
            disabled={isSearching || !query.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-glow-sm transition-all hover:shadow-glow-md disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Search className="h-3.5 w-3.5" />
            {isSearching
              ? SEMANTIC_SEARCH_LABELS.SEARCHING
              : SEMANTIC_SEARCH_LABELS.SEARCH_BUTTON}
          </button>
        </div>
      </form>

      {/* Credits info */}
      {creditsRemaining !== null && (
        <p className="text-xs text-muted-foreground text-right">
          {SEMANTIC_SEARCH_LABELS.CREDITS_REMAINING
            .replace('{count}', String(creditsRemaining))
            .replace('{plural}', creditsRemaining === 1 ? '' : 's')}
        </p>
      )}

      {/* Error state */}
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-400"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Loading state — skeleton shimmer */}
      {isSearching && (
        <div className="space-y-3" aria-busy="true" aria-live="polite">
          {[1, 2, 3].map((i) => (
            <div key={i} className="shimmer h-20 rounded-xl" />
          ))}
        </div>
      )}

      {/* Results */}
      {!isSearching && results.length > 0 && (
        <div className="space-y-2 animate-in-view" aria-live="polite">
          <p className="text-xs text-muted-foreground">
            {SEMANTIC_SEARCH_LABELS.RESULTS_COUNT
              .replace('{count}', String(results.length))
              .replace('{plural}', results.length === 1 ? '' : 's')}
          </p>
          {results.map((result, i) => (
            <div key={result.anchorId} className={`stagger-${Math.min(i + 1, 8)}`}>
              <SearchResultCard result={result} />
            </div>
          ))}
        </div>
      )}

      {/* Empty state — honest copy; embeddings may legitimately return nothing */}
      {showEmptyState && (
        <div className="text-center py-8 text-muted-foreground text-sm">
          <Search className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="font-medium text-foreground">
            {SEMANTIC_SEARCH_LABELS.EMPTY_TITLE}
          </p>
          <p className="mt-1 text-xs">{SEMANTIC_SEARCH_LABELS.EMPTY_DESC}</p>
          <button
            onClick={handleClear}
            className="mt-3 text-xs text-primary hover:underline"
          >
            {SEMANTIC_SEARCH_LABELS.CLEAR_BUTTON}
          </button>
        </div>
      )}

      {/*
        DEFERRED — filters sidebar (credential type / date / issuer).
        SCRUM-1958 subtask-3 adds server-side filter params to
        GET /api/v1/ai/search. The current endpoint takes no filter params, so
        shipping filter controls here would be dead/fake UI (Constitution: the
        UI must be honest). Do NOT add a filters sidebar until subtask-3 wires
        the params end-to-end.
      */}
    </div>
  );
}

/**
 * Flag-gated mount. Renders nothing until the ENABLE_SEMANTIC_SEARCH flag
 * resolves true. Fail-closed: hidden while the flag is loading or if the
 * lookup fails. Use this wherever semantic search is placed on a page.
 */
export function SemanticSearchPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    isSemanticSearchEnabled()
      .then((on) => {
        if (!cancelled) setEnabled(on);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fail-closed: render nothing while loading (null) or when disabled (false).
  // The Card chrome lives here (not in the page) so that nothing — not even an
  // empty bordered card — renders when the flag is off, which is the prod default.
  if (!enabled) return null;

  return (
    <div className="mb-8">
      <Card className="border-white/[0.06] bg-white/[0.015]">
        <CardContent className="pt-6">
          <SemanticSearch />
        </CardContent>
      </Card>
    </div>
  );
}
