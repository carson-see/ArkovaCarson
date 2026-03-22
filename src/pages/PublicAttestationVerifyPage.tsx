/**
 * Public Attestation Verification Page
 *
 * Public-facing page for verifying attestations without authentication.
 * Accessed via /verify/attestation/:publicId.
 * Fetches attestation data from the worker API and displays verification result.
 */

import { useState, useEffect, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Shield,
  CheckCircle,
  XCircle,
  Clock,
  Ban,
  Copy,
  Check,
  ExternalLink,
  FileCheck,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ROUTES } from '@/lib/routes';
import { WORKER_URL } from '@/lib/workerClient';

interface AttestationVerifyData {
  public_id: string;
  attestation_type: string;
  status: string;
  subject_type: string;
  subject_identifier: string;
  attester: {
    name: string;
    type: string;
    title: string | null;
  };
  claims: Array<{ claim: string; evidence?: string }>;
  summary: string | null;
  jurisdiction: string | null;
  fingerprint: string | null;
  evidence_fingerprint: string | null;
  evidence_count: number;
  chain_proof: {
    tx_id: string;
    block_height: number | null;
    timestamp: string | null;
    explorer_url: string | null;
  } | null;
  linked_credential: {
    public_id: string;
    credential_type: string;
    verification_status: string;
    verify_url: string;
  } | null;
  issued_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  created_at: string;
}

const STATUS_CONFIG: Record<string, { icon: typeof CheckCircle; color: string; bg: string; label: string }> = {
  ACTIVE: { icon: CheckCircle, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', label: 'Verified & Active' },
  PENDING: { icon: Clock, color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20', label: 'Anchoring in Progress' },
  REVOKED: { icon: Ban, color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20', label: 'Revoked' },
  EXPIRED: { icon: XCircle, color: 'text-muted-foreground', bg: 'bg-muted', label: 'Expired' },
  CHALLENGED: { icon: AlertTriangle, color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/20', label: 'Challenged' },
  DRAFT: { icon: Clock, color: 'text-muted-foreground', bg: 'bg-muted', label: 'Draft' },
};

export function PublicAttestationVerifyPage() {
  const { publicId } = useParams<{ publicId: string }>();
  const [attestation, setAttestation] = useState<AttestationVerifyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    if (!publicId) return;

    setLoading(true);
    setError(null);

    fetch(`${WORKER_URL}/api/v1/attestations/${encodeURIComponent(publicId)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Attestation not found`);
        }
        return res.json();
      })
      .then((data) => setAttestation(data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [publicId]);

  const handleCopy = useCallback((text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }, []);

  const statusConfig = attestation ? STATUS_CONFIG[attestation.status] ?? STATUS_CONFIG.PENDING : null;

  return (
    <div className="min-h-screen flex flex-col bg-[#0d141b] text-[#dce3ed]">
      {/* Header */}
      <header className="border-b border-[#bbc9cf]/15">
        <div className="container flex h-16 items-center justify-between px-4">
          <Link to={ROUTES.SEARCH} className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#00d4ff]">
              <Shield className="h-5 w-5 text-[#003642]" />
            </div>
            <span className="text-lg font-black text-[#00d4ff] tracking-tighter">Arkova</span>
          </Link>
          <Link
            to={ROUTES.LOGIN}
            className="text-sm text-[#bbc9cf] hover:text-[#00d4ff] transition-colors"
          >
            Sign in
          </Link>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 container py-8 md:py-12 px-4">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-black tracking-tighter mb-2">
              Attestation Verification
            </h1>
            <p className="text-[#bbc9cf] text-sm">
              Verify the authenticity and status of an attestation
            </p>
          </div>

          {loading && (
            <Card className="border-[#00d4ff]/10 bg-[#192028]">
              <CardContent className="flex flex-col items-center justify-center py-16">
                <Loader2 className="h-8 w-8 animate-spin text-[#00d4ff] mb-4" />
                <p className="text-sm text-[#bbc9cf]">Verifying attestation...</p>
              </CardContent>
            </Card>
          )}

          {error && (
            <Card className="border-red-500/20 bg-[#192028]">
              <CardContent className="flex flex-col items-center justify-center py-16">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10 mb-4">
                  <AlertTriangle className="h-8 w-8 text-red-400" />
                </div>
                <h2 className="text-xl font-bold mb-2">Attestation Not Found</h2>
                <p className="text-sm text-[#bbc9cf] mb-6">{error}</p>
                <Link to={ROUTES.VERIFY_FORM}>
                  <Button variant="outline" className="border-[#00d4ff]/20">
                    Try Another Verification
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}

          {attestation && statusConfig && (
            <div className="space-y-6">
              {/* Status Banner */}
              <Card className={`border ${statusConfig.bg}`}>
                <CardContent className="flex items-center gap-4 py-5">
                  <div className={`flex h-12 w-12 items-center justify-center rounded-full ${statusConfig.bg}`}>
                    <statusConfig.icon className={`h-6 w-6 ${statusConfig.color}`} />
                  </div>
                  <div>
                    <p className={`font-bold text-lg ${statusConfig.color}`}>{statusConfig.label}</p>
                    <p className="text-sm text-[#bbc9cf]">
                      ID: <code className="font-mono text-[#00d4ff]">{attestation.public_id}</code>
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* Expiry Notice */}
              {attestation.status === 'EXPIRED' && attestation.expires_at && (
                <Card className="border-muted bg-muted/5">
                  <CardContent className="py-4">
                    <div className="flex items-start gap-3">
                      <XCircle className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
                      <div>
                        <p className="font-semibold text-muted-foreground">This attestation has expired</p>
                        <p className="text-xs text-[#bbc9cf] mt-1">
                          Expired: {new Date(attestation.expires_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Revocation Notice */}
              {attestation.status === 'REVOKED' && (
                <Card className="border-red-500/20 bg-red-500/5">
                  <CardContent className="py-4">
                    <div className="flex items-start gap-3">
                      <Ban className="h-5 w-5 text-red-400 mt-0.5 shrink-0" />
                      <div>
                        <p className="font-semibold text-red-400">This attestation has been revoked</p>
                        {attestation.revocation_reason && (
                          <p className="text-sm text-[#bbc9cf] mt-1">Reason: {attestation.revocation_reason}</p>
                        )}
                        {attestation.revoked_at && (
                          <p className="text-xs text-[#bbc9cf] mt-1">
                            Revoked: {new Date(attestation.revoked_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                          </p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Subject & Attester */}
              <Card className="border-[#00d4ff]/10 bg-[#192028]">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileCheck className="h-5 w-5 text-[#00d4ff]" />
                    Attestation Details
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">Subject</span>
                    <p className="text-sm font-medium mt-0.5">{attestation.subject_identifier}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge variant="secondary" className="text-[10px]">
                        {attestation.subject_type}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px]">
                        {attestation.attestation_type.replace(/_/g, ' ')}
                      </Badge>
                    </div>
                  </div>

                  <Separator className="bg-[#bbc9cf]/10" />

                  <div className="grid gap-3 sm:grid-cols-3">
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">Attester</span>
                      <p className="text-sm font-medium mt-0.5">{attestation.attester.name}</p>
                      {attestation.attester.title && (
                        <p className="text-xs text-[#bbc9cf]">{attestation.attester.title}</p>
                      )}
                    </div>
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">Attester Type</span>
                      <p className="text-sm mt-0.5">{attestation.attester.type.replace(/_/g, ' ')}</p>
                    </div>
                    {attestation.jurisdiction && (
                      <div>
                        <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">Jurisdiction</span>
                        <p className="text-sm mt-0.5">{attestation.jurisdiction}</p>
                      </div>
                    )}
                  </div>

                  <Separator className="bg-[#bbc9cf]/10" />

                  {/* Claims */}
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">
                      Claims ({(attestation.claims ?? []).length})
                    </span>
                    <div className="mt-2 space-y-2">
                      {(attestation.claims ?? []).map((c, i) => (
                        <div key={i} className="rounded-lg border border-[#bbc9cf]/10 px-3 py-2 bg-[#0d141b]/50">
                          <p className="text-sm">{c.claim}</p>
                          {c.evidence && <p className="text-xs text-[#bbc9cf] mt-1">Evidence: {c.evidence}</p>}
                        </div>
                      ))}
                    </div>
                  </div>

                  {attestation.summary && (
                    <>
                      <Separator className="bg-[#bbc9cf]/10" />
                      <div>
                        <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">Summary</span>
                        <p className="text-sm text-[#bbc9cf] mt-1">{attestation.summary}</p>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Cryptographic Proof */}
              <Card className="border-[#00d4ff]/10 bg-[#192028]">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Shield className="h-5 w-5 text-[#00d4ff]" />
                    Cryptographic Proof
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {attestation.fingerprint && (
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">Fingerprint</span>
                      <div className="flex items-center gap-2 mt-0.5">
                        <code className="text-xs font-mono text-[#00d4ff] break-all">{attestation.fingerprint}</code>
                        <button
                          onClick={() => handleCopy(attestation.fingerprint!, 'fp')}
                          className="text-[#bbc9cf] hover:text-[#dce3ed] shrink-0"
                        >
                          {copiedField === 'fp' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </div>
                  )}

                  {attestation.chain_proof && (
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">Network Receipt</span>
                      <div className="flex items-center gap-2 mt-0.5">
                        {attestation.chain_proof.explorer_url && attestation.chain_proof.explorer_url.startsWith('https://') ? (
                          <a
                            href={attestation.chain_proof.explorer_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-mono text-[#00d4ff] hover:text-[#a8e8ff] flex items-center gap-1"
                          >
                            <ExternalLink className="h-3 w-3" />
                            {attestation.chain_proof.tx_id.slice(0, 20)}...
                          </a>
                        ) : (
                          <code className="text-xs font-mono text-[#bbc9cf]">{attestation.chain_proof.tx_id.slice(0, 20)}...</code>
                        )}
                        <button
                          onClick={() => handleCopy(attestation.chain_proof!.tx_id, 'tx')}
                          className="text-[#bbc9cf] hover:text-[#dce3ed] shrink-0"
                        >
                          {copiedField === 'tx' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                      {attestation.chain_proof.block_height && (
                        <p className="text-xs text-[#bbc9cf] mt-1">
                          Block: {attestation.chain_proof.block_height.toLocaleString()}
                        </p>
                      )}
                    </div>
                  )}

                  {!attestation.chain_proof && attestation.status === 'PENDING' && (
                    <div className="flex items-center gap-2 text-sm text-amber-400">
                      <Clock className="h-4 w-4" />
                      <span>Anchoring in progress — network receipt will appear once confirmed</span>
                    </div>
                  )}

                  {/* Lifecycle */}
                  <Separator className="bg-[#bbc9cf]/10" />
                  <div className="text-xs text-[#bbc9cf] space-y-1">
                    <p>Issued: {new Date(attestation.issued_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</p>
                    {attestation.expires_at && (
                      <p>Expires: {new Date(attestation.expires_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</p>
                    )}
                    {attestation.evidence_count > 0 && (
                      <p>Supporting evidence files: {attestation.evidence_count}</p>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Linked Credential */}
              {attestation.linked_credential && (
                <Card className="border-[#00d4ff]/10 bg-[#192028]">
                  <CardContent className="py-4">
                    <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">Linked Credential</span>
                    <div className="flex items-center justify-between mt-2">
                      <div>
                        <code className="text-sm font-mono text-[#00d4ff]">{attestation.linked_credential.public_id}</code>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="secondary" className="text-[10px]">
                            {attestation.linked_credential.credential_type}
                          </Badge>
                          <Badge className={attestation.linked_credential.verification_status === 'VERIFIED'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            : 'bg-muted text-muted-foreground'}>
                            {attestation.linked_credential.verification_status}
                          </Badge>
                        </div>
                      </div>
                      <Link to={`/verify/${attestation.linked_credential.public_id}`}>
                        <Button variant="outline" size="sm" className="border-[#00d4ff]/20 text-[#00d4ff]">
                          Verify Credential
                        </Button>
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-[#bbc9cf]/15 py-6 px-4">
        <div className="container flex flex-col sm:flex-row justify-between items-center gap-4 text-xs text-[#bbc9cf]">
          <span>Arkova — Secure document verification platform</span>
          <div className="flex gap-4">
            <Link to="/privacy" className="hover:text-[#00d4ff] transition-colors">Privacy</Link>
            <Link to="/terms" className="hover:text-[#00d4ff] transition-colors">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
