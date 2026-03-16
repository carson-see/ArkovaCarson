/**
 * SemanticSearch Component (P8-S12)
 *
 * Natural language search across org's credentials using AI embeddings.
 * Nordic Vault aesthetic. Gated behind ENABLE_SEMANTIC_SEARCH.
 *
 * Constitution 4A: Only PII-stripped metadata is searched/returned.
 */

import { useState, useCallback } from 'react';
import { Search, Sparkles, FileText, Clock, AlertCircle } from 'lucide-react';
import { useSemanticSearch, type SemanticSearchResult } from '../../hooks/useSemanticSearch';
import { Link } from 'react-router-dom';
import { ROUTES } from '../../lib/routes';

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
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${color}`}
    >
      {pct}% match
    </span>
  );
}

function SearchResultCard({ result }: { result: SemanticSearchResult }) {
  return (
    <Link
      to={ROUTES.RECORD_DETAIL.replace(':id', result.anchorId)}
      className="glass-card group block rounded-xl border border-white/10 p-4 transition-all hover:shadow-card-hover hover:-translate-y-0.5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary/15 to-primary/5">
            <FileText className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="font-medium text-foreground truncate">
              {result.fileName || result.credentialType || 'Credential'}
            </p>
            {result.credentialType && (
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {result.credentialType}
              </p>
            )}
            {result.metadata?.issuerName && (
              <p className="text-sm text-muted-foreground mt-0.5">
                {result.metadata.issuerName}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <SimilarityBadge score={result.similarity} />
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
              result.status === 'SECURED'
                ? 'bg-emerald-500/10 text-emerald-400'
                : result.status === 'PENDING'
                  ? 'bg-amber-500/10 text-amber-400'
                  : 'bg-gray-500/10 text-gray-400'
            }`}
          >
            {result.status}
          </span>
        </div>
      </div>
      {result.createdAt && (
        <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          {new Date(result.createdAt).toLocaleDateString()}
        </div>
      )}
    </Link>
  );
}

export function SemanticSearch() {
  const [query, setQuery] = useState('');
  const { results, isSearching, error, creditsRemaining, search, clear } =
    useSemanticSearch();

  const handleSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (query.trim()) {
        search(query.trim());
      }
    },
    [query, search],
  );

  return (
    <div className="space-y-4">
      {/* Search form */}
      <form onSubmit={handleSearch} className="relative">
        <div className="glass-card flex items-center gap-3 rounded-xl border border-white/10 px-4 py-3">
          <Sparkles className="h-5 w-5 text-primary shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search credentials with natural language..."
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          <button
            type="submit"
            disabled={isSearching || !query.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-glow-sm transition-all hover:shadow-glow-md disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Search className="h-3.5 w-3.5" />
            {isSearching ? 'Searching...' : 'Search'}
          </button>
        </div>
      </form>

      {/* Credits info */}
      {creditsRemaining !== null && (
        <p className="text-xs text-muted-foreground text-right">
          {creditsRemaining} AI credit{creditsRemaining !== 1 ? 's' : ''} remaining
        </p>
      )}

      {/* Error state */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Loading state */}
      {isSearching && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="shimmer h-20 rounded-xl" />
          ))}
        </div>
      )}

      {/* Results */}
      {!isSearching && results.length > 0 && (
        <div className="space-y-2 animate-in-view">
          <p className="text-xs text-muted-foreground">
            {results.length} result{results.length !== 1 ? 's' : ''} found
          </p>
          {results.map((result, i) => (
            <div key={result.anchorId} className={`stagger-${Math.min(i + 1, 8)}`}>
              <SearchResultCard result={result} />
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isSearching && results.length === 0 && query && !error && (
        <div className="text-center py-8 text-muted-foreground text-sm">
          <Search className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>No matching credentials found</p>
          <button
            onClick={clear}
            className="mt-2 text-xs text-primary hover:underline"
          >
            Clear search
          </button>
        </div>
      )}
    </div>
  );
}
