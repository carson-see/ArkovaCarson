/**
 * Search Page
 *
 * Public credential discovery page at /search.
 * Supports search by verification ID (redirect), issuer name (RPC),
 * document fingerprint (direct anchor lookup), and drag-to-verify
 * (client-side hashing + auto-search).
 *
 * Session 10: Added search type tabs, drag-to-verify dropzone,
 * and example query placeholders.
 *
 * @see UF-02, GAP-03
 */

import { useState, useCallback, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  Search, Loader2, Building2, Shield, CheckCircle, XCircle, User,
  ArrowLeft, Upload, FileSearch, Building, Hash,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { IssuerCard } from '@/components/search/IssuerCard';
import { usePublicSearch } from '@/hooks/usePublicSearch';
import { SEARCH_LABELS, CREDENTIAL_TYPE_LABELS } from '@/lib/copy';
import { verifyPath, ROUTES } from '@/lib/routes';
import { supabase } from '@/lib/supabase';
import { generateFingerprint } from '@/lib/fileHasher';

type SearchMode = 'issuers' | 'credentials' | 'verify';
type SearchType = 'issuer' | 'id' | 'fingerprint' | 'person';

/** Auto-detect what the user is searching for based on input pattern */
function detectSearchType(query: string): SearchType {
  const trimmed = query.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return 'fingerprint';
  if (/^ARK-/i.test(trimmed)) return 'id';
  return 'issuer';
}

interface FingerprintResult {
  verified: boolean;
  status?: 'SECURED' | 'REVOKED';
  fingerprint: string;
  filename?: string;
  securedAt?: string;
  publicId?: string;
}

const EXAMPLE_QUERIES = [
  { label: 'Harvard University', mode: 'issuers' as SearchMode },
  { label: 'SEC 10-K filing Apple', mode: 'credentials' as SearchMode },
  { label: 'Federal Register healthcare', mode: 'credentials' as SearchMode },
];

export function SearchPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [searchType, setSearchType] = useState<SearchType>('issuer');
  const [searchMode, setSearchMode] = useState<SearchMode>('issuers');
  const [hasSearched, setHasSearched] = useState(false);
  const { issuerResults, searching, error, searchIssuers } = usePublicSearch();

  const [fpResult, setFpResult] = useState<FingerprintResult | null>(null);
  const [fpSearching, setFpSearching] = useState(false);
  const [fpError, setFpError] = useState<string | null>(null);

  // Person search state
  interface PersonResult {
    public_id: string;
    title: string | null;
    credential_type: string | null;
    status: string;
    created_at: string;
    org_id: string | null;
  }
  const [personResults, setPersonResults] = useState<PersonResult[]>([]);
  const [personSearching, setPersonSearching] = useState(false);
  const [personError, setPersonError] = useState<string | null>(null);

  // Drag-to-verify state
  const [dragActive, setDragActive] = useState(false);
  const [verifyingFile, setVerifyingFile] = useState(false);
  const [verifyFileName, setVerifyFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

    const detected = detectSearchType(trimmed);

    if (detected === 'id') {
      navigate(verifyPath(trimmed));
      return;
    }

    setHasSearched(true);

    if (detected === 'fingerprint') {
      setSearchType('fingerprint');
      setSearchMode('verify');
      await searchFingerprint(trimmed);
      return;
    }

    setSearchType('issuer');
    await Promise.all([
      searchIssuers(trimmed),
      searchPerson(trimmed),
    ]);
  }, [query, navigate, searchIssuers, searchFingerprint, searchPerson]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleSearch();
    },
    [handleSearch],
  );

  // Drag-to-verify: hash file client-side, then search fingerprint
  const handleFileDrop = useCallback(async (file: File) => {
    setVerifyingFile(true);
    setVerifyFileName(file.name);
    setSearchMode('verify');
    setHasSearched(true);
    setSearchType('fingerprint');
    setFpResult(null);
    setFpError(null);

    try {
      const fingerprint = await generateFingerprint(file);
      setQuery(fingerprint);
      await searchFingerprint(fingerprint);
    } catch {
      setFpError('Failed to compute document fingerprint.');
    } finally {
      setVerifyingFile(false);
    }
  }, [searchFingerprint]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileDrop(file);
  }, [handleFileDrop]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileDrop(file);
    // Reset input so same file can be re-selected
    e.target.value = '';
  }, [handleFileDrop]);

  const handleExampleClick = (example: typeof EXAMPLE_QUERIES[0]) => {
    setQuery(example.label);
    setSearchMode(example.mode);
  };

  const isSearching = searching || fpSearching || personSearching || verifyingFile;
  const displayError = error || fpError || personError;

  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-3xl mx-auto px-4 py-8">
        {/* Back navigation */}
        <Link
          to={ROUTES.DASHBOARD}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Dashboard
        </Link>

        {/* Header */}
        <div className="text-center mb-10 animate-in-view">
          <div className="flex justify-center mb-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#192028]">
              <Shield className="h-8 w-8 text-[#00d4ff]" />
            </div>
          </div>
          <h1 className="text-4xl font-black tracking-tighter">
            {SEARCH_LABELS.PAGE_TITLE}
          </h1>
          <p className="text-[#bbc9cf] mt-2 max-w-md mx-auto font-mono text-xs uppercase tracking-widest">
            Search by issuer name, verification ID, or document fingerprint
          </p>
        </div>

        {/* Search type tabs */}
        <Tabs value={searchMode} onValueChange={(v) => setSearchMode(v as SearchMode)} className="mb-4">
          <TabsList className="w-full grid grid-cols-3">
            <TabsTrigger value="issuers" className="gap-1.5">
              <Building className="h-3.5 w-3.5" />
              Issuers
            </TabsTrigger>
            <TabsTrigger value="credentials" className="gap-1.5">
              <Hash className="h-3.5 w-3.5" />
              Credentials
            </TabsTrigger>
            <TabsTrigger value="verify" className="gap-1.5">
              <FileSearch className="h-3.5 w-3.5" />
              Verify Document
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Search form (for issuers + credentials tabs) */}
        {searchMode !== 'verify' && (
          <Card className="bg-transparent border-[#00d4ff]/15 mb-4 animate-in-view stagger-1">
            <CardContent className="p-6">
              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#859398]" />
                  <Input
                    placeholder={searchMode === 'issuers'
                      ? 'Search by issuer name...'
                      : 'Search by name, verification ID, or fingerprint...'
                    }
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className="pl-9 bg-[#192028] border-[#3c494e]/30 focus:ring-[#00d4ff]/30 rounded-full"
                  />
                </div>
                <Button
                  onClick={handleSearch}
                  disabled={isSearching || !query.trim()}
                  className="bg-[#00d4ff] text-[#0d141b] hover:bg-[#00d4ff]/90 rounded-full shadow-glow-sm hover:shadow-glow-md font-semibold"
                >
                  {isSearching ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="mr-2 h-4 w-4" />
                  )}
                  {SEARCH_LABELS.SEARCH_BUTTON}
                </Button>
              </div>

              {/* Example queries */}
              {!hasSearched && (
                <div className="flex flex-wrap gap-2 mt-3">
                  <span className="text-xs text-muted-foreground">Try:</span>
                  {EXAMPLE_QUERIES.map((ex) => (
                    <button
                      key={ex.label}
                      onClick={() => handleExampleClick(ex)}
                      className="text-xs text-[#00d4ff] hover:text-[#00d4ff]/80 border border-[#00d4ff]/20 rounded-full px-2.5 py-0.5 hover:bg-[#00d4ff]/5 transition-colors"
                    >
                      {ex.label}
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Drag-to-verify dropzone (for verify tab) */}
        {searchMode === 'verify' && (
          <Card
            className={`mb-4 transition-all duration-200 ${
              dragActive
                ? 'border-[#00d4ff] bg-[#00d4ff]/5 shadow-glow-md'
                : 'bg-transparent border-[#00d4ff]/15 border-dashed'
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <CardContent className="flex flex-col items-center justify-center py-12 px-6">
              {verifyingFile ? (
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="h-10 w-10 animate-spin text-[#00d4ff]" />
                  <p className="text-sm font-medium">Computing fingerprint...</p>
                  {verifyFileName && (
                    <p className="text-xs text-muted-foreground">{verifyFileName}</p>
                  )}
                </div>
              ) : (
                <>
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#192028] mb-4">
                    <Upload className="h-8 w-8 text-[#00d4ff]" />
                  </div>
                  <p className="text-sm font-medium mb-1">
                    Drop a document here to verify
                  </p>
                  <p className="text-xs text-muted-foreground mb-4 text-center max-w-sm">
                    Your document never leaves your device. We compute a cryptographic fingerprint
                    locally and search our records for a match.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    className="rounded-full"
                  >
                    <Upload className="mr-2 h-3.5 w-3.5" />
                    Browse files
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={handleFileInput}
                  />
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Error */}
        {displayError && (
          <Card className="border-destructive/50 mb-6">
            <CardContent className="p-4 text-sm text-destructive">
              {displayError}
            </CardContent>
          </Card>
        )}

        {/* Issuer results (shown for text queries) */}
        {(searchType === 'issuer' || searchType === 'person') && hasSearched && !searching && (
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
        {searchType === 'fingerprint' && hasSearched && !fpSearching && !verifyingFile && fpResult && (
          <FingerprintResultCard result={fpResult} fileName={verifyFileName} onViewRecord={(id) => navigate(verifyPath(id))} />
        )}

        {/* Person results (shown for text queries alongside issuer results) */}
        {hasSearched && !personSearching && personResults.length > 0 && searchType !== 'fingerprint' && (
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
                            {result.title || result.public_id || 'Untitled Record'}
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
        {isSearching && !verifyingFile && (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        )}
      </div>
    </div>
  );
}

interface FingerprintResultCardProps {
  result: FingerprintResult;
  fileName?: string | null;
  onViewRecord: (publicId: string) => void;
}

function FingerprintResultCard({ result, fileName, onViewRecord }: Readonly<FingerprintResultCardProps>) {
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
              {fileName
                ? `"${fileName}" matches a secured document on Arkova.`
                : SEARCH_LABELS.FINGERPRINT_VERIFIED_DESC}
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
            {fileName
              ? `"${fileName}" does not match any secured document on Arkova.`
              : SEARCH_LABELS.FINGERPRINT_NOT_FOUND_DESC}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
