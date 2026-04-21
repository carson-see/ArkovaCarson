/**
 * Public Signature Verification Page (Phase III — PH3-ESIG-01)
 *
 * Public-facing page for verifying AdES signatures without authentication.
 * Accessed via /verify/signature/:signaturePublicId.
 * Fetches signature data from worker API and displays verification result.
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

import { useState, useEffect, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArkovaLogo } from '@/components/layout/ArkovaLogo';
import {
  CheckCircle,
  XCircle,
  Clock,
  Ban,
  Copy,
  Check,
  FileSignature,
  AlertTriangle,
  Loader2,
  Stamp,
  Lock,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ROUTES } from '@/lib/routes';
import { WORKER_URL } from '@/lib/workerClient';
import { AnchorDisclaimerDark } from '@/components/anchor/AnchorDisclaimer';

interface SignatureVerifyData {
  signature_id: string;
  status: string;
  format: string;
  level: string;
  jurisdiction: string | null;
  document_fingerprint: string;
  signer: {
    name: string | null;
    organization: string | null;
    certificate_fingerprint: string | null;
  };
  signed_at: string | null;
  ltv: {
    embedded: boolean;
  };
  verification_url: string;
  created_at: string;
}

const STATUS_CONFIG: Record<string, { icon: typeof CheckCircle; color: string; label: string }> = {
  COMPLETE: { icon: CheckCircle, color: 'text-emerald-400', label: 'Verified' },
  SIGNED: { icon: FileSignature, color: 'text-blue-400', label: 'Signed' },
  TIMESTAMPED: { icon: Stamp, color: 'text-blue-400', label: 'Timestamped' },
  LTV_EMBEDDED: { icon: Lock, color: 'text-blue-400', label: 'LTV Embedded' },
  PENDING: { icon: Clock, color: 'text-amber-400', label: 'Pending' },
  FAILED: { icon: XCircle, color: 'text-red-400', label: 'Failed' },
  REVOKED: { icon: Ban, color: 'text-red-400', label: 'Revoked' },
};

const LEVEL_LABELS: Record<string, string> = {
  'B-B': 'Basic',
  'B-T': 'Timestamped',
  'B-LT': 'Long-Term',
  'B-LTA': 'Long-Term Archival',
};

export default function PublicSignatureVerifyPage() {
  const { signaturePublicId } = useParams<{ signaturePublicId: string }>();
  const [data, setData] = useState<SignatureVerifyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchSignature = useCallback(async () => {
    if (!signaturePublicId) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${WORKER_URL}/api/v1/signatures/${signaturePublicId}`);
      if (!res.ok) {
        if (res.status === 404) {
          setError('Signature not found');
        } else {
          setError('Failed to fetch signature');
        }
        return;
      }
      const json = await res.json();
      setData(json);
    } catch {
      setError('Network error — could not reach verification service');
    } finally {
      setLoading(false);
    }
  }, [signaturePublicId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data fetch; setState is post-await
    fetchSignature();
  }, [fetchSignature]);

  const handleCopy = () => {
    if (data?.document_fingerprint) {
      navigator.clipboard.writeText(data.document_fingerprint);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0F1117] flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-[#0F1117] flex items-center justify-center p-4">
        <Card className="max-w-md w-full bg-[#1A1D2E] border-red-500/30">
          <CardContent className="pt-6 text-center">
            <AlertTriangle className="h-12 w-12 text-red-400 mx-auto mb-4" />
            <p className="text-white text-lg font-semibold mb-2">Verification Failed</p>
            <p className="text-gray-400">{error || 'Unknown error'}</p>
            <Link to={ROUTES.VERIFY_FORM}>
              <Button variant="outline" className="mt-4">Try another verification</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const statusConfig = STATUS_CONFIG[data.status] || STATUS_CONFIG.PENDING;
  const StatusIcon = statusConfig.icon;
  const isValid = data.status === 'COMPLETE' || data.status === 'SIGNED' || data.status === 'TIMESTAMPED' || data.status === 'LTV_EMBEDDED';
  const isRevoked = data.status === 'REVOKED';

  return (
    <div className="min-h-screen bg-[#0F1117] p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="text-center">
          <Link to={ROUTES.HOME} className="inline-flex items-center gap-2 text-cyan-400 hover:text-cyan-300 mb-6">
            <ArkovaLogo size={24} />
            <span className="font-semibold">Arkova</span>
          </Link>
        </div>

        {/* Status Card */}
        <Card className={`bg-[#1A1D2E] ${isRevoked ? 'border-red-500/50' : isValid ? 'border-emerald-500/50' : 'border-amber-500/50'}`}>
          <CardHeader className="text-center pb-2">
            <StatusIcon className={`h-16 w-16 mx-auto mb-3 ${statusConfig.color}`} />
            <CardTitle className="text-white text-2xl">
              {isRevoked ? 'Signature Revoked' : isValid ? 'Signature Verified' : 'Signature ' + statusConfig.label}
            </CardTitle>
            <Badge variant="outline" className={`mt-2 ${statusConfig.color} border-current`}>
              {data.format} {data.level} — {LEVEL_LABELS[data.level] || data.level}
            </Badge>
          </CardHeader>

          <CardContent className="space-y-4">
            <Separator className="bg-gray-700" />

            {/* Signer Info */}
            <div>
              <p className="text-gray-400 text-sm mb-1">Signer</p>
              <p className="text-white font-medium">{data.signer.name || 'Unknown'}</p>
              {data.signer.organization && (
                <p className="text-gray-300 text-sm">{data.signer.organization}</p>
              )}
            </div>

            {/* Fingerprint */}
            <div>
              <p className="text-gray-400 text-sm mb-1">Document Fingerprint</p>
              <div className="flex items-center gap-2">
                <code className="text-cyan-300 text-xs bg-[#0F1117] px-2 py-1 rounded font-mono flex-1 truncate">
                  {data.document_fingerprint}
                </code>
                <Button variant="ghost" size="sm" onClick={handleCopy} className="text-gray-400 hover:text-white">
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            {/* Signing Time */}
            {data.signed_at && (
              <div>
                <p className="text-gray-400 text-sm mb-1">Signed At</p>
                <p className="text-white">{new Date(data.signed_at).toLocaleString()}</p>
              </div>
            )}

            {/* Jurisdiction */}
            {data.jurisdiction && (
              <div>
                <p className="text-gray-400 text-sm mb-1">Jurisdiction</p>
                <Badge variant="outline" className="text-gray-300">
                  {data.jurisdiction === 'EU' ? 'European Union (eIDAS)' :
                   data.jurisdiction === 'US' ? 'United States (ESIGN/UETA)' :
                   data.jurisdiction === 'UK' ? 'United Kingdom' :
                   data.jurisdiction === 'CH' ? 'Switzerland' :
                   'International'}
                </Badge>
              </div>
            )}

            {/* Evidence Layers */}
            <div>
              <p className="text-gray-400 text-sm mb-2">Evidence Layers</p>
              <div className="space-y-1.5">
                <EvidenceRow icon={FileSignature} label={`${data.format} ${data.level} electronic signature`} active />
                {['B-T', 'B-LT', 'B-LTA'].includes(data.level) && (
                  <EvidenceRow icon={Stamp} label="RFC 3161 qualified timestamp" active />
                )}
                {data.ltv.embedded && (
                  <EvidenceRow icon={Lock} label="Long-term validation data embedded" active />
                )}
              </div>
            </div>

            <Separator className="bg-gray-700" />

            {/* Signature ID */}
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Signature ID</span>
              <code className="text-gray-300 font-mono">{data.signature_id}</code>
            </div>
          </CardContent>
        </Card>

        <AnchorDisclaimerDark />
      </div>
    </div>
  );
}

function EvidenceRow({ icon: Icon, label, active }: { icon: typeof CheckCircle; label: string; active: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <Icon className={`h-4 w-4 ${active ? 'text-emerald-400' : 'text-gray-500'}`} />
      <span className={active ? 'text-gray-200' : 'text-gray-500'}>{label}</span>
    </div>
  );
}
