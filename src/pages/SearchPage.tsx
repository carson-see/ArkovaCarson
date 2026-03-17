/**
 * Search Page
 *
 * Public credential discovery page at /search.
 * Supports search by verification ID (redirect), issuer name (RPC),
 * and document fingerprint (direct anchor lookup).
 *
 * @see UF-02, GAP-03
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Loader2, Building2, Shield, FileDigit, CheckCircle, XCircle, User } from 'lucide-react';
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
import { SEARCH_LABELS, CREDENTIAL_TYPE_LABELS } from '@/lib/copy';
import { Badge } from '@/components/ui/badge';
import { verifyPath } from '@/lib/routes';
import { supabase } from '@/lib/supabase';

type SearchType = 'issuer' | 'id' | 'fingerprint' | 'person';

interface FingerprintResult {
  verified: boolean;
  status?: 'SECURED' | 'REVOKED';
  fingerprint: string;
  filename?: string;
  securedAt?: string;
  publicId?: string;
}

export function SearchPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [searchType, setSearchType] = useState<SearchType>('issuer');
  const [hasSearched, setHasSearched] = useState(false);
  const { issuerResults, searching, error, searchIssuers, clearResults } = usePublicSearch();

  const [fpResult, setFpResult] = useState<FingerprintResult | null>(null);
  const [fpSearching, setFpSearching] = useState(false);
  const [fpError, setFpError] = useState<string | null>(null);

  // Person search state
  interface PersonResult {
    public_id: string;
    label: string;
    credential_type: string | null;
    status: string;
    created_at: string;
    org_id: string | null;
  }
  const [personResults, setPersonResults] = useState<PersonResult[]>([]);
  const [personSearching, setPersonSearching] = useState(false);
  const [personError, setPersonError] = useState<string | null>(null);

  const searchFingerprint = useCallback(async (fp: string) => {
    const isValid = /^[a-f0-9]{64}$/i.test(fp);
    if (!isValid) {
      setFpError(SEARCH_LABELS.FINGERPRINT_INVALID);
      return;
    }

    setFpSearching(true);
    setFpError(null);
    setFpResult(null);

    try {
      const { data: anchors, error: queryError } = await supabase
        .from('anchors')
        .select('public_id, fingerprint, status, filename, chain_timestamp')
        .eq('fingerprint', fp.toLowerCase())
        .in('status', ['SECURED', 'REVOKED'])
        .is('deleted_at', null)
        .limit(1);

      if (queryError) {
        setFpError('Search failed. Please try again.');
        return;
      }

      if (anchors && anchors.length > 0) {
        const anchor = anchors[0];
        setFpResult({
          verified: anchor.status === 'SECURED',
          status: anchor.status as FingerprintResult['status'],
          fingerprint: fp.toLowerCase(),
          filename: anchor.filename ?? undefined,
          securedAt: anchor.chain_timestamp ?? undefined,
          publicId: anchor.public_id ?? undefined,
        });
      } else {
        setFpResult({ verified: false, fingerprint: fp.toLowerCase() });
      }
    } catch {
      setFpError('Search failed. Please try again.');
    } finally {
      setFpSearching(false);
    }
  }, []);

  const searchPerson = useCallback(async (name: string) => {
    setPersonSearching(true);
    setPersonError(null);
    setPersonResults([]);

    try {
      const { data, error: rpcError } = await (supabase as unknown as { rpc: (fn: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> })
        .rpc('search_public_credentials', { p_query: name, p_limit: 20 });

      if (rpcError) {
        setPersonError('Search failed. Please try again.');
        return;
      }

      setPersonResults((data as PersonResult[]) ?? []);
    } catch {
      setPersonError('Search failed. Please try again.');
    } finally {
      setPersonSearching(false);
    }
  }, []);

  const handleSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;

    if (searchType === 'id') {
      navigate(verifyPath(trimmed));
      return;
    }

    if (searchType === 'fingerprint') {
      setHasSearched(true);
      await searchFingerprint(trimmed);
      return;
    }

    if (searchType === 'person') {
      setHasSearched(true);
      await searchPerson(trimmed);
      return;
    }

    // Issuer search
    setHasSearched(true);
    await searchIssuers(trimmed);
  }, [query, searchType, navigate, searchIssuers, searchFingerprint, searchPerson]);

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
      setFpResult(null);
      setFpError(null);
      setPersonResults([]);
      setPersonError(null);
      setHasSearched(false);
    },
    [clearResults],
  );

  const isSearching = searching || fpSearching || personSearching;
  const displayError = error || fpError || personError;

  const placeholder = searchType === 'fingerprint'
    ? SEARCH_LABELS.FINGERPRINT_PLACEHOLDER
    : searchType === 'person'
      ? SEARCH_LABELS.PERSON_PLACEHOLDER
      : SEARCH_LABELS.SEARCH_PLACEHOLDER;

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
                    <SelectItem value="fingerprint">
                      <span className="flex items-center gap-2">
                        <FileDigit className="h-3.5 w-3.5" />
                        {SEARCH_LABELS.SEARCH_BY_FINGERPRINT}
                      </span>
                    </SelectItem>
                    <SelectItem value="person">
                      <span className="flex items-center gap-2">
                        <User className="h-3.5 w-3.5" />
                        {SEARCH_LABELS.SEARCH_BY_PERSON}
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder={placeholder}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className={searchType === 'fingerprint' ? 'pl-9 font-mono text-sm' : 'pl-9'}
                  />
                </div>
                <Button
                  onClick={handleSearch}
                  disabled={isSearching || !query.trim()}
                  className="shadow-glow-sm hover:shadow-glow-md"
                >
                  {isSearching ? (
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
          {displayError && (
            <Card className="border-destructive/50 mb-6">
              <CardContent className="p-4 text-sm text-destructive">
                {displayError}
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

          {/* Fingerprint results */}
          {searchType === 'fingerprint' && hasSearched && !fpSearching && fpResult && (
            <FingerprintResultCard result={fpResult} onViewRecord={(id) => navigate(verifyPath(id))} />
          )}

          {/* Person results */}
          {searchType === 'person' && hasSearched && !personSearching && (
            <div className="space-y-3">
              {personResults.length > 0 ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    {SEARCH_LABELS.PERSON_CREDENTIALS}
                  </p>
                  {personResults.map((result) => (
                    <Card
                      key={result.public_id}
                      className="glass-card cursor-pointer hover:shadow-card-hover transition-shadow"
                      onClick={() => navigate(verifyPath(result.public_id))}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">
                              {result.label || 'Untitled Record'}
                            </p>
                            <div className="flex items-center gap-2 mt-1">
                              {result.credential_type && (
                                <span className="text-xs text-muted-foreground">
                                  {CREDENTIAL_TYPE_LABELS[result.credential_type as keyof typeof CREDENTIAL_TYPE_LABELS] ?? result.credential_type}
                                </span>
                              )}
                              <span className="text-xs text-muted-foreground">
                                {new Date(result.created_at).toLocaleDateString()}
                              </span>
                            </div>
                          </div>
                          <Badge
                            variant={result.status === 'SECURED' ? 'default' : 'secondary'}
                            className={result.status === 'SECURED' ? 'bg-green-600' : ''}
                          >
                            {result.status === 'SECURED' ? 'Verified' : result.status}
                          </Badge>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </>
              ) : (
                <Card className="glass-card">
                  <CardContent className="py-12 text-center">
                    <User className="mx-auto h-8 w-8 text-muted-foreground/50 mb-3" />
                    <p className="text-sm font-medium text-muted-foreground">
                      {SEARCH_LABELS.NO_PERSONS}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {SEARCH_LABELS.NO_PERSONS_DESC}
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* Loading state */}
          {isSearching && (
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface FingerprintResultCardProps {
  result: FingerprintResult;
  onViewRecord: (publicId: string) => void;
}

function FingerprintResultCard({ result, onViewRecord }: Readonly<FingerprintResultCardProps>) {
  if (result.verified && result.publicId) {
    return (
      <Card className="border-green-500/30 bg-green-500/5 animate-in-view stagger-2">
        <CardContent className="py-8">
          <div className="flex flex-col items-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-500/10 mb-4">
              <CheckCircle className="h-7 w-7 text-green-600" />
            </div>
            <h3 className="text-lg font-semibold text-green-700 dark:text-green-400 mb-1">
              {SEARCH_LABELS.FINGERPRINT_VERIFIED}
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              {SEARCH_LABELS.FINGERPRINT_VERIFIED_DESC}
            </p>

            <div className="w-full max-w-sm space-y-3 text-left mb-4">
              {result.filename && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Filename</span>
                  <span className="font-medium">{result.filename}</span>
                </div>
              )}
              {result.securedAt && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Secured</span>
                  <span className="font-medium">
                    {new Date(result.securedAt).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </span>
                </div>
              )}
              <div className="pt-2">
                <p className="text-xs text-muted-foreground mb-1">Fingerprint</p>
                <p className="text-xs font-mono bg-muted rounded px-2 py-1 break-all">
                  {result.fingerprint}
                </p>
              </div>
            </div>

            <Button
              onClick={() => onViewRecord(result.publicId!)}
              className="shadow-glow-sm hover:shadow-glow-md"
            >
              {SEARCH_LABELS.VIEW_FULL_RECORD}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (result.status === 'REVOKED' && result.publicId) {
    return (
      <Card className="border-muted animate-in-view stagger-2">
        <CardContent className="py-8">
          <div className="flex flex-col items-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 mb-4">
              <XCircle className="h-7 w-7 text-gray-500" />
            </div>
            <h3 className="text-lg font-semibold mb-1">
              {SEARCH_LABELS.FINGERPRINT_REVOKED}
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              {SEARCH_LABELS.FINGERPRINT_REVOKED_DESC}
            </p>
            <Button variant="outline" onClick={() => onViewRecord(result.publicId!)}>
              {SEARCH_LABELS.VIEW_FULL_RECORD}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-muted animate-in-view stagger-2">
      <CardContent className="py-8">
        <div className="flex flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-4">
            <Shield className="h-7 w-7 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-1">
            {SEARCH_LABELS.FINGERPRINT_NOT_FOUND}
          </h3>
          <p className="text-sm text-muted-foreground">
            {SEARCH_LABELS.FINGERPRINT_NOT_FOUND_DESC}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
