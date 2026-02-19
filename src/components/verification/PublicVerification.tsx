/**
 * Public Verification Component
 *
 * Displays verification status for public anchor lookups.
 * Shows redacted information - no sensitive data exposed.
 */

import { useState, useEffect } from 'react';
import { CheckCircle, XCircle, AlertCircle, Loader2, FileText, Clock, Hash } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/lib/supabase';

interface PublicAnchorData {
  public_id: string;
  fingerprint: string;
  status: string;
  filename: string;
  file_size: number | null;
  secured_at: string | null;
  network_receipt: string | null;
  verified: boolean;
  error?: string;
}

interface PublicVerificationProps {
  publicId: string;
}

export function PublicVerification({ publicId }: PublicVerificationProps) {
  const [data, setData] = useState<PublicAnchorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchVerification() {
      setLoading(true);
      setError(null);

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: result, error: rpcError } = await (supabase.rpc as any)(
          'get_public_anchor',
          { p_public_id: publicId }
        );

        if (rpcError) {
          setError(rpcError.message);
          return;
        }

        if (result.error) {
          setError(result.error);
          return;
        }

        setData(result as PublicAnchorData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Verification failed');
      } finally {
        setLoading(false);
      }
    }

    if (publicId) {
      fetchVerification();
    }
  }, [publicId]);

  if (loading) {
    return (
      <Card className="max-w-lg mx-auto">
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card className="max-w-lg mx-auto">
        <CardHeader className="text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10 mb-4">
            <XCircle className="h-8 w-8 text-destructive" />
          </div>
          <CardTitle>Verification Failed</CardTitle>
          <CardDescription>
            {error || 'Unable to verify this document'}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          <p className="text-sm text-muted-foreground">
            The document you're looking for may not exist or has not been verified yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }) + ' UTC';
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <Card className="max-w-lg mx-auto">
      <CardHeader className="text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10 mb-4">
          <CheckCircle className="h-8 w-8 text-green-500" />
        </div>
        <Badge variant="default" className="mx-auto mb-2 bg-green-600">
          Verified
        </Badge>
        <CardTitle>Document Verified</CardTitle>
        <CardDescription>
          This document has been secured on the network
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Filename */}
        <div className="flex items-start gap-3 p-3 bg-muted rounded-lg">
          <FileText className="h-5 w-5 text-muted-foreground mt-0.5" />
          <div>
            <p className="text-sm font-medium">Filename</p>
            <p className="text-sm text-muted-foreground break-all">{data.filename}</p>
            {data.file_size && (
              <p className="text-xs text-muted-foreground">{formatFileSize(data.file_size)}</p>
            )}
          </div>
        </div>

        {/* Fingerprint */}
        <div className="flex items-start gap-3 p-3 bg-muted rounded-lg">
          <Hash className="h-5 w-5 text-muted-foreground mt-0.5" />
          <div>
            <p className="text-sm font-medium">Fingerprint (SHA-256)</p>
            <p className="text-xs font-mono text-muted-foreground break-all">{data.fingerprint}</p>
          </div>
        </div>

        {/* Secured At */}
        {data.secured_at && (
          <div className="flex items-start gap-3 p-3 bg-muted rounded-lg">
            <Clock className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div>
              <p className="text-sm font-medium">Observed Time</p>
              <p className="text-sm text-muted-foreground">{formatDate(data.secured_at)}</p>
            </div>
          </div>
        )}

        {/* Network Receipt */}
        {data.network_receipt && (
          <div className="flex items-start gap-3 p-3 bg-muted rounded-lg">
            <AlertCircle className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div>
              <p className="text-sm font-medium">Network Receipt</p>
              <p className="text-xs font-mono text-muted-foreground break-all">
                {data.network_receipt}
              </p>
            </div>
          </div>
        )}

        <div className="pt-4 text-center text-xs text-muted-foreground">
          <p>Verification ID: {data.public_id}</p>
          <p className="mt-1">Secured by Arkova</p>
        </div>
      </CardContent>
    </Card>
  );
}
