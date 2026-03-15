/**
 * Search Page
 *
 * Public credential discovery page at /search.
 * Supports search by verification ID (redirect) and issuer name (RPC).
 *
 * @see UF-02
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Loader2, Building2, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { IssuerCard } from '@/components/search/IssuerCard';
import { usePublicSearch } from '@/hooks/usePublicSearch';
import { SEARCH_LABELS } from '@/lib/copy';
import { verifyPath } from '@/lib/routes';

type SearchType = 'issuer' | 'id';

export function SearchPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [searchType, setSearchType] = useState<SearchType>('issuer');
  const [hasSearched, setHasSearched] = useState(false);
  const { issuerResults, searching, error, searchIssuers, clearResults } = usePublicSearch();

  const handleSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;

    if (searchType === 'id') {
      // Direct redirect to verification page
      navigate(verifyPath(trimmed));
      return;
    }

    // Issuer search
    setHasSearched(true);
    await searchIssuers(trimmed);
  }, [query, searchType, navigate, searchIssuers]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleSearch();
    },
    [handleSearch],
  );

  const handleSearchTypeChange = useCallback(
    (value: string) => {
      setSearchType(value as SearchType);
      clearResults();
      setHasSearched(false);
    },
    [clearResults],
  );

  return (
    <div className="min-h-screen bg-mesh-gradient">
      <div className="bg-dot-pattern min-h-screen">
        <div className="container max-w-3xl mx-auto px-4 py-12">
          {/* Header */}
          <div className="text-center mb-10 animate-in-view">
            <div className="flex justify-center mb-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/15 to-primary/5">
                <Shield className="h-8 w-8 text-primary" />
              </div>
            </div>
            <h1 className="text-3xl font-semibold tracking-tight">
              {SEARCH_LABELS.PAGE_TITLE}
            </h1>
            <p className="text-muted-foreground mt-2 max-w-md mx-auto">
              {SEARCH_LABELS.PAGE_SUBTITLE}
            </p>
          </div>

          {/* Search form */}
          <Card className="glass-card shadow-card-rest mb-8 animate-in-view stagger-1">
            <CardContent className="p-6">
              <div className="flex flex-col gap-3 sm:flex-row">
                <Select value={searchType} onValueChange={handleSearchTypeChange}>
                  <SelectTrigger className="w-full sm:w-[160px] shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="issuer">
                      <span className="flex items-center gap-2">
                        <Building2 className="h-3.5 w-3.5" />
                        {SEARCH_LABELS.SEARCH_BY_ISSUER}
                      </span>
                    </SelectItem>
                    <SelectItem value="id">
                      <span className="flex items-center gap-2">
                        <Search className="h-3.5 w-3.5" />
                        {SEARCH_LABELS.SEARCH_BY_ID}
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder={SEARCH_LABELS.SEARCH_PLACEHOLDER}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className="pl-9"
                  />
                </div>
                <Button
                  onClick={handleSearch}
                  disabled={searching || !query.trim()}
                  className="shadow-glow-sm hover:shadow-glow-md"
                >
                  {searching ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="mr-2 h-4 w-4" />
                  )}
                  {SEARCH_LABELS.SEARCH_BUTTON}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Error */}
          {error && (
            <Card className="border-destructive/50 mb-6">
              <CardContent className="p-4 text-sm text-destructive">
                {error}
              </CardContent>
            </Card>
          )}

          {/* Issuer results */}
          {searchType === 'issuer' && hasSearched && !searching && (
            <div className="space-y-3">
              {issuerResults.length > 0 ? (
                issuerResults.map((issuer, i) => (
                  <div key={issuer.org_id} className={`stagger-${Math.min(i + 2, 8)}`}>
                    <IssuerCard issuer={issuer} />
                  </div>
                ))
              ) : (
                <Card className="glass-card">
                  <CardContent className="py-12 text-center">
                    <Building2 className="mx-auto h-8 w-8 text-muted-foreground/50 mb-3" />
                    <p className="text-sm font-medium text-muted-foreground">
                      {SEARCH_LABELS.NO_ISSUERS}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {SEARCH_LABELS.NO_ISSUERS_DESC}
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* Loading state */}
          {searching && (
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
