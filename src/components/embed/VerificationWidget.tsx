/**
 * Embeddable Verification Widget
 *
 * STATUS: POST-LAUNCH (MVP-14) — This component exists but is not yet
 * routed or exported. It will be integrated when the embeddable widget
 * feature is prioritized. See docs/BACKLOG.md for MVP-14 status.
 *
 * A self-contained component that can be embedded on third-party websites
 * via an iframe or script tag. Shows verification status for a given publicId.
 *
 * Usage (iframe):
 *   <iframe src="https://app.arkova.io/embed/verify/ABC123" width="400" height="500" />
 *
 * @see P6-TS-03, MVP-14
 * @see MVP-14 — Full embeddable widget integration (post-launch)
 */

import { useState, useEffect } from 'react';
import {
  CheckCircle,
  XCircle,
  Loader2,
  Shield,
  Fingerprint,
  Ban,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { CREDENTIAL_TYPE_LABELS } from '@/lib/copy';
import { logVerificationEvent } from '@/lib/logVerificationEvent';

interface WidgetAnchorData {
  public_id: string;
  fingerprint: string;
  status: string;
  filename: string;
  file_size?: number;
  verified: boolean;
  credential_type?: string;
  issuer_name?: string;
  secured_at?: string;
  error?: string;
}

interface VerificationWidgetProps {
  publicId: string;
  compact?: boolean;
}

export function VerificationWidget({ publicId, compact = false }: Readonly<VerificationWidgetProps>) {
  const [data, setData] = useState<WidgetAnchorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetch() {
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
          logVerificationEvent({ publicId, method: 'embed', result: 'not_found' });
          return;
        }

        if (result?.error) {
          setError(result.error);
          logVerificationEvent({ publicId, method: 'embed', result: 'not_found' });
          return;
        }

        setData(result as WidgetAnchorData);
        const status = (result as WidgetAnchorData).status;
        logVerificationEvent({
          publicId,
          method: 'embed',
          result: status === 'REVOKED' ? 'revoked' : 'verified',
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Verification failed');
      } finally {
        setLoading(false);
      }
    }

    if (publicId) fetch();
  }, [publicId]);

  if (loading) {
    return (
      <WidgetContainer compact={compact}>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-[#82b8d0]" />
        </div>
      </WidgetContainer>
    );
  }

  if (error || !data) {
    return (
      <WidgetContainer compact={compact}>
        <div className="flex flex-col items-center text-center py-6 px-4">
          <XCircle className="h-8 w-8 text-red-500 mb-2" />
          <p className="text-sm font-medium text-gray-900">Not Found</p>
          <p className="text-xs text-gray-500 mt-1">
            This record could not be verified.
          </p>
        </div>
      </WidgetContainer>
    );
  }

  const isRevoked = data.status === 'REVOKED';
  const credentialLabel = data.credential_type
    ? CREDENTIAL_TYPE_LABELS[data.credential_type as keyof typeof CREDENTIAL_TYPE_LABELS] ?? data.credential_type
    : null;

  if (compact) {
    return (
      <WidgetContainer compact>
        <div className="flex items-center gap-3 px-4 py-3">
          {isRevoked ? (
            <Ban className="h-5 w-5 text-gray-500 shrink-0" />
          ) : (
            <CheckCircle className="h-5 w-5 text-green-500 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-900 truncate">
              {isRevoked ? 'Revoked' : 'Verified'}
            </p>
            <p className="text-xs text-gray-500 truncate">{data.filename}</p>
          </div>
          <ArkovaLogo />
        </div>
      </WidgetContainer>
    );
  }

  return (
    <WidgetContainer compact={false}>
      {/* Status */}
      <div className={`px-4 py-4 text-center ${isRevoked ? 'bg-gray-50' : 'bg-green-50'}`}>
        {isRevoked ? (
          <Ban className="h-10 w-10 text-gray-500 mx-auto mb-2" />
        ) : (
          <CheckCircle className="h-10 w-10 text-green-500 mx-auto mb-2" />
        )}
        <p className="text-lg font-semibold text-gray-900">
          {isRevoked ? 'Record Revoked' : 'Verified'}
        </p>
      </div>

      {/* Details */}
      <div className="px-4 py-3 space-y-2">
        <DetailRow label="Document" value={data.filename} />
        {credentialLabel && <DetailRow label="Type" value={credentialLabel} />}
        {data.issuer_name && <DetailRow label="Issuer" value={data.issuer_name} />}
        {data.secured_at && (
          <DetailRow label="Secured" value={new Date(data.secured_at).toLocaleDateString()} />
        )}
        <div className="pt-1">
          <p className="text-[10px] text-gray-400 flex items-center gap-1">
            <Fingerprint className="h-3 w-3" />
            {data.fingerprint.slice(0, 16)}...{data.fingerprint.slice(-8)}
          </p>
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-gray-100 flex items-center justify-between">
        <a
          href={`${location.origin}/verify/${data.public_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-[#82b8d0] hover:underline"
        >
          Full verification details
        </a>
        <ArkovaLogo />
      </div>
    </WidgetContainer>
  );
}

function WidgetContainer({ children, compact }: Readonly<{ children: React.ReactNode; compact: boolean }>) {
  return (
    <div
      className={`bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden ${
        compact ? 'max-w-xs' : 'max-w-sm'
      }`}
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}
    >
      {children}
    </div>
  );
}

function DetailRow({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-900 font-medium text-right truncate ml-4 max-w-[60%]">{value}</span>
    </div>
  );
}

function ArkovaLogo() {
  return (
    <div className="flex items-center gap-1">
      <Shield className="h-3 w-3 text-[#82b8d0]" />
      <span className="text-[10px] text-gray-400 font-medium">Arkova</span>
    </div>
  );
}
