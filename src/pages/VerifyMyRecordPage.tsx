/**
 * Verify My Record Page
 *
 * Authenticated page for individual users to verify their own documents.
 * Uploads file → computes SHA-256 fingerprint → queries anchors by fingerprint.
 *
 * @see MVP-21
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Shield,
  CheckCircle,
  XCircle,
  Loader2,
  FileText,
  ArrowLeft,
  Download,
} from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { FileUpload } from '@/components/anchor/FileUpload';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { ROUTES } from '@/lib/routes';
import { CREDENTIAL_TYPE_LABELS, ANCHOR_STATUS_LABELS } from '@/lib/copy';
import { ExplorerLink } from '@/components/ui/ExplorerLink';

interface MatchedRecord {
  id: string;
  public_id: string | null;
  filename: string;
  fingerprint: string;
  status: string;
  credential_type: string | null;
  created_at: string;
  chain_tx_id: string | null;
  chain_timestamp: string | null;
  issuer_name?: string;
}

export function VerifyMyRecordPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<MatchedRecord[] | null>(null);
  const [searchedFingerprint, setSearchedFingerprint] = useState<string | null>(null);

  const handleFileSelect = useCallback(async (_file: File, fingerprint: string) => {
    if (!user) return;
    setLoading(true);
    setResult(null);
    setSearchedFingerprint(fingerprint);

    try {
      // Query anchors by fingerprint — RLS will scope to user's accessible records
      const { data, error } = await supabase
        .from('anchors')
        .select('id, public_id, filename, fingerprint, status, credential_type, created_at, chain_tx_id, chain_timestamp')
        .eq('fingerprint', fingerprint.toLowerCase())
        .is('deleted_at', null)
        .order('created_at', { ascending: false });

      if (error) {
        setResult([]);
        return;
      }

      setResult(data ?? []);
    } catch {
      setResult([]);
    } finally {
      setLoading(false);
    }
  }, [user]);

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  return (
    <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
      <div className="space-y-6 max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(ROUTES.RECORDS)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Verify Your Record</h1>
            <p className="text-sm text-muted-foreground">
              Upload a document to verify it matches a secured record
            </p>
          </div>
        </div>

        {/* File Upload */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              Document Verification
            </CardTitle>
            <CardDescription>
              Select or drag a document to verify. Your file never leaves your device — only the
              fingerprint is used for lookup.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FileUpload onFileSelect={handleFileSelect} disabled={loading} />
          </CardContent>
        </Card>

        {/* Loading */}
        {loading && (
          <Card>
            <CardContent className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary mr-2" />
              <span className="text-sm text-muted-foreground">Searching records...</span>
            </CardContent>
          </Card>
        )}

        {/* Results */}
        {result !== null && !loading && (
          <>
            {result.length > 0 ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-5 w-5 text-green-500" />
                  <h2 className="text-lg font-semibold">
                    {result.length} matching {result.length === 1 ? 'record' : 'records'} found
                  </h2>
                </div>

                {result.map((record) => {
                  const statusLabel = (ANCHOR_STATUS_LABELS as Record<string, string>)[record.status] ?? record.status;
                  const credLabel = record.credential_type
                    ? (CREDENTIAL_TYPE_LABELS as Record<string, string>)[record.credential_type] ?? record.credential_type
                    : null;

                  return (
                    <Card key={record.id} className="overflow-hidden">
                      <div className={`px-4 py-3 flex items-center justify-between ${
                        record.status === 'SECURED' ? 'bg-green-50' :
                        record.status === 'REVOKED' ? 'bg-gray-50' : 'bg-amber-50'
                      }`}>
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm font-medium">{record.filename}</span>
                        </div>
                        <Badge variant={record.status === 'SECURED' ? 'default' : 'secondary'}
                          className={record.status === 'SECURED' ? 'bg-green-600' : ''}>
                          {statusLabel}
                        </Badge>
                      </div>
                      <CardContent className="p-4 space-y-3">
                        {credLabel && (
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Credential Type</span>
                            <span>{credLabel}</span>
                          </div>
                        )}
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Created</span>
                          <span>{formatDate(record.created_at)}</span>
                        </div>
                        {record.chain_timestamp && (
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Network Observed</span>
                            <span>{formatDate(record.chain_timestamp)}</span>
                          </div>
                        )}
                        {record.chain_tx_id && (
                          <div className="flex justify-between text-sm items-center">
                            <span className="text-muted-foreground">Network Receipt</span>
                            <ExplorerLink receiptId={record.chain_tx_id} />
                          </div>
                        )}

                        <Separator />

                        <div className="flex gap-2">
                          {record.public_id && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => navigate(`/verify/${record.public_id}`)}
                            >
                              View Details
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => navigate(`/records/${record.id}`)}
                          >
                            <Download className="h-3 w-3 mr-1" />
                            Record
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <Card>
                <CardContent className="py-8">
                  <div className="flex flex-col items-center text-center">
                    <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-4">
                      <XCircle className="h-7 w-7 text-muted-foreground" />
                    </div>
                    <h3 className="text-lg font-semibold mb-1">No Matching Record</h3>
                    <p className="text-sm text-muted-foreground max-w-md">
                      No secured record matches this document. If you received this document from an
                      organization, contact them to verify it was secured with Arkova.
                    </p>
                    {searchedFingerprint && (
                      <div className="mt-4 w-full">
                        <p className="text-xs text-muted-foreground mb-1">Document Fingerprint</p>
                        <p className="text-xs font-mono bg-muted rounded px-3 py-2 break-all">
                          {searchedFingerprint}
                        </p>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
