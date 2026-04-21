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

import { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Search, Loader2, Building2, CheckCircle, XCircle, ArrowLeft, Upload } from 'lucide-react';
import { isSearchSubdomain } from '@/App';
import { ArkovaLogo, ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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


export function SearchPage() {
  const navigate = useNavigate();
  const standalone = isSearchSubdomain();

  // BUG-014 + SCRUM-365: Set page title for SEO
  useEffect(() => {
    document.title = 'Arkova Search — Verify Credentials';
  }, []);
  const [query, setQuery] = useState('');
  const [searchType, setSearchType] = useState<SearchType>('issuer');
  const [, setSearchMode] = useState<SearchMode>('issuers');
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
    /** RPC returns anchored_at, mapped to created_at */
    anchored_at?: string;
    issuer_name?: string | null;
    issuer_public_id?: string | null;
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
        // BUG-UAT5-01 root cause was silent catch-blocks hiding RPC
        // failures. Surface the real error to the console so prod triage
        // can see why a search failed without needing to reproduce.
        console.error('[search] fingerprint query failed:', queryError);
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
    } catch (err) {
      console.error('[search] fingerprint search threw:', err);
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
      // The `as any` cast predates the generated `Database` types covering
      // this RPC signature. Kept narrow here (one call-site) rather than
      // regenerating types in this PR — see `npm run gen:types` follow-up.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: rpcError } = await (supabase.rpc as any)(
        'search_public_credentials',
        { p_query: name, p_limit: 20 },
      );

      if (rpcError) {
        console.error('[search] search_public_credentials RPC failed:', rpcError);
        setPersonError('Search failed. Please try again.');
        return;
      }

      // RPC returns rows with anchored_at (not created_at) — normalize field names
      const rows = (data as Record<string, unknown>[]) ?? [];
      const unwrapped: PersonResult[] = rows.map((row) => {
        const inner = (row.search_public_credentials ?? row) as Record<string, unknown>;
        return {
          public_id: inner.public_id as string,
          title: (inner.title as string | null) ?? null,
          credential_type: (inner.credential_type as string | null) ?? null,
          status: inner.status as string,
          created_at: (inner.anchored_at as string) ?? (inner.created_at as string) ?? '',
          org_id: (inner.issuer_public_id as string | null) ?? (inner.org_id as string | null) ?? null,
        };
      });
      setPersonResults(unwrapped);
    } catch (err) {
      // BUG-UAT5-01 surfaced this silently-caught TypeError — log it.
      console.error('[search] search_public_credentials threw:', err);
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
    setSearchMode('issuers');
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

  const isSearching = searching || fpSearching || personSearching || verifyingFile;
  const displayError = error || fpError || personError;

  return (
    <div
      className="min-h-screen bg-background"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="container max-w-2xl mx-auto px-4">
        {/* Back navigation — hidden on standalone search subdomain */}
        {!standalone && (
          <Link
            to={ROUTES.DASHBOARD}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mt-6 mb-4 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Dashboard
          </Link>
        )}

        {/* Google-style centered layout — push down when no results */}
        <div className={`flex flex-col items-center transition-all duration-300 ${
          hasSearched ? 'pt-8' : 'pt-[18vh]'
        }`}>
          {/* Logo + title */}
          <div className="flex flex-col items-center mb-8">
            <ArkovaLogo size={hasSearched ? 48 : 72} className="mb-3" />
            {!hasSearched && (
              <h1 className="text-[22px] font-semibold tracking-tight text-center">
                Search &amp; Verify
              </h1>
            )}
          </div>

          {/* Single search box */}
          <div className="w-full max-w-xl mb-6">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#859398]" />
              <Input
                placeholder="Search issuers, credentials, or paste a verification ID..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
                className="pl-11 pr-14 h-12 bg-[#192028] border-[#3c494e]/30 focus:ring-[#00d4ff]/30 focus:border-[#00d4ff]/50 rounded-full text-sm"
              />
              <Button
                onClick={handleSearch}
                disabled={isSearching || !query.trim()}
                size="icon"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 bg-[#00d4ff] text-[#0d141b] hover:bg-[#00d4ff]/90 rounded-full shadow-glow-sm hover:shadow-glow-md h-9 w-9"
              >
                {isSearching ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
              </Button>
            </div>

            {/* Drag hint + file verify link */}
            {!hasSearched && (
              <div className="flex items-center justify-center gap-3 mt-3 text-xs text-muted-foreground">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1 text-[#00d4ff]/70 hover:text-[#00d4ff] transition-colors"
                >
                  <Upload className="h-3 w-3" />
                  Drop or browse a file to verify
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleFileInput}
                />
              </div>
            )}
          </div>
        </div>

        {/* Drag overlay */}
        {dragActive && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none">
            <div className="flex flex-col items-center gap-3 text-[#00d4ff]">
              <Upload className="h-12 w-12" />
              <p className="text-sm font-medium">Drop to verify document</p>
            </div>
          </div>
        )}

        {/* Verifying file indicator */}
        {verifyingFile && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="h-8 w-8 animate-spin text-[#00d4ff]" />
            <p className="text-sm">Computing fingerprint{verifyFileName ? ` for ${verifyFileName}` : ''}...</p>
          </div>
        )}

        {/* Error */}
        {displayError && (
          <div className="max-w-xl mx-auto mb-6">
            <Card className="border-destructive/50">
              <CardContent className="p-4 text-sm text-destructive">
                {displayError}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Results area */}
        <div className="max-w-xl mx-auto">
          {/* Issuer results */}
          {(searchType === 'issuer' || searchType === 'person') && hasSearched && !searching && !displayError && (
            <div className="space-y-3">
              {issuerResults.length > 0 && issuerResults.map((issuer, i) => (
                <div key={issuer.org_id} className={`stagger-${Math.min(i + 2, 8)}`}>
                  <IssuerCard issuer={issuer} />
                </div>
              ))}
            </div>
          )}

          {/* Fingerprint results */}
          {searchType === 'fingerprint' && hasSearched && !fpSearching && !verifyingFile && fpResult && (
            <FingerprintResultCard result={fpResult} fileName={verifyFileName} onViewRecord={(id) => navigate(verifyPath(id))} />
          )}

          {/* Credential results */}
          {hasSearched && !personSearching && personResults.length > 0 && searchType !== 'fingerprint' && (
            <div className="space-y-3 mt-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">
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
            </div>
          )}

          {/* No results state */}
          {hasSearched && !isSearching && !displayError && searchType === 'issuer'
            && issuerResults.length === 0 && personResults.length === 0 && (
            <div className="text-center py-12">
              <Building2 className="mx-auto h-8 w-8 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">{SEARCH_LABELS.NO_RESULTS}</p>
              <p className="text-xs text-muted-foreground mt-1">{SEARCH_LABELS.NO_RESULTS_DESC}</p>
            </div>
          )}

          {/* Loading state */}
          {isSearching && !verifyingFile && (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-[#00d4ff]" />
            </div>
          )}
        </div>

        {/* Footer links — minimal, always visible */}
        <div className="flex flex-wrap justify-center gap-6 mt-16 mb-8 text-xs text-muted-foreground">
          <Link to={ROUTES.ABOUT} className="hover:text-[#00d4ff] transition-colors">About</Link>
          <Link to={ROUTES.DEVELOPERS} className="hover:text-[#00d4ff] transition-colors">Developer API</Link>
          <Link to={ROUTES.PRIVACY} className="hover:text-[#00d4ff] transition-colors">Privacy</Link>
          <Link to={ROUTES.TERMS} className="hover:text-[#00d4ff] transition-colors">Terms</Link>
        </div>
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
            <ArkovaIcon className="h-7 w-7 text-muted-foreground" />
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
