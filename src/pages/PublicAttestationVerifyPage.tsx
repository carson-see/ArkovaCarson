/**
 * Public Attestation Verification Page
 *
 * Public-facing page for verifying attestations without authentication.
 * Accessed via /verify/attestation/:publicId.
 * Fetches attestation data from the worker API and displays verification result.
 */

import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Shield,
  XCircle,
  Ban,
  FileCheck,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { PUBLIC_ATTESTATION_VERIFY_LABELS, ATTESTATION_LABELS } from '@/lib/copy';
import { ROUTES, verifyPath } from '@/lib/routes';
import { getStatusLabel } from '@/lib/statusDisplay';
import { WORKER_URL } from '@/lib/workerClient';
import { AnchorDisclaimerDark } from '@/components/anchor/AnchorDisclaimer';
import { AttestationStatusCard } from '@/components/attestation/AttestationStatusCard';
import { VerificationResultDisplay } from '@/components/attestation/VerificationResultDisplay';

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
  evidence: Array<{
    public_id: string;
    evidence_type: string;
    description: string | null;
    fingerprint: string;
    mime: string | null;
    size: number | null;
    created_at: string;
  }>;
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
  attestor_credentials?: Array<{
    public_id: string;
    credential_type: string | null;
    status: string;
    fingerprint: string | null;
    version_number: number | null;
    parent_public_id: string | null;
    is_current: boolean;
    chain_proof: {
      tx_id: string;
      block_height: number | null;
      timestamp: string | null;
      explorer_url: string | null;
    } | null;
    record_uri: string;
  }>;
  issued_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  created_at: string;
}

export function PublicAttestationVerifyPage() {
  const { publicId } = useParams<{ publicId: string }>();
  const [attestation, setAttestation] = useState<AttestationVerifyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!publicId) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading/error reset before async fetch
    setLoading(true);
     
    setError(null);

    fetch(`${WORKER_URL}/api/v1/attestations/${encodeURIComponent(publicId)}?include=credentials`)
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


  return (
    <div className="min-h-screen flex flex-col bg-[#0d141b] text-[#dce3ed]">
      {/* Header */}
      <header className="border-b border-[#bbc9cf]/15">
        <div className="container flex h-16 items-center justify-between px-4">
          <Link to={ROUTES.SEARCH} className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#00d4ff]">
              <Shield className="h-5 w-5 text-[#003642]" />
            </div>
            <span className="text-lg font-black text-[#00d4ff] tracking-tighter">{PUBLIC_ATTESTATION_VERIFY_LABELS.BRAND}</span>
          </Link>
          <Link
            to={ROUTES.LOGIN}
            className="text-sm text-[#bbc9cf] hover:text-[#00d4ff] transition-colors"
          >
            {PUBLIC_ATTESTATION_VERIFY_LABELS.SIGN_IN}
          </Link>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 container py-8 md:py-12 px-4">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-black tracking-tighter mb-2">
              {PUBLIC_ATTESTATION_VERIFY_LABELS.PAGE_TITLE}
            </h1>
            <p className="text-[#bbc9cf] text-sm">
              {PUBLIC_ATTESTATION_VERIFY_LABELS.PAGE_SUBTITLE}
            </p>
          </div>

          {loading && (
            <Card className="border-[#00d4ff]/10 bg-[#192028]">
              <CardContent className="flex flex-col items-center justify-center py-16">
                <Loader2 className="h-8 w-8 animate-spin text-[#00d4ff] mb-4" />
                <p className="text-sm text-[#bbc9cf]">{PUBLIC_ATTESTATION_VERIFY_LABELS.VERIFYING}</p>
              </CardContent>
            </Card>
          )}

          {error && (
            <Card className="border-red-500/20 bg-[#192028]">
              <CardContent className="flex flex-col items-center justify-center py-16">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10 mb-4">
                  <AlertTriangle className="h-8 w-8 text-red-400" />
                </div>
                <h2 className="text-xl font-bold mb-2">{PUBLIC_ATTESTATION_VERIFY_LABELS.NOT_FOUND}</h2>
                <p className="text-sm text-[#bbc9cf] mb-6">{error}</p>
                <Link to={ROUTES.VERIFY_FORM}>
                  <Button variant="outline" className="border-[#00d4ff]/20">
                    {PUBLIC_ATTESTATION_VERIFY_LABELS.TRY_ANOTHER}
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}

          {attestation && (
            <div className="space-y-6">
              {/* Status Card */}
              <AttestationStatusCard
                status={attestation.status}
                publicId={attestation.public_id}
                attestationType={attestation.attestation_type.replace(/_/g, ' ')}
              />

              {/* Expiry Notice */}
              {attestation.status === 'EXPIRED' && attestation.expires_at && (
                <Card className="border-muted bg-muted/5">
                  <CardContent className="py-4">
                    <div className="flex items-start gap-3">
                      <XCircle className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
                      <div>
                        <p className="font-semibold text-muted-foreground">{PUBLIC_ATTESTATION_VERIFY_LABELS.EXPIRED_NOTICE}</p>
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
                        <p className="font-semibold text-red-400">{PUBLIC_ATTESTATION_VERIFY_LABELS.REVOKED_NOTICE}</p>
                        {attestation.revocation_reason && (
                          <p className="text-sm text-[#bbc9cf] mt-1">{PUBLIC_ATTESTATION_VERIFY_LABELS.REASON_PREFIX} {attestation.revocation_reason}</p>
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
                    {PUBLIC_ATTESTATION_VERIFY_LABELS.DETAILS_TITLE}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">{ATTESTATION_LABELS.SUBJECT}</span>
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
                      <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">{ATTESTATION_LABELS.ATTESTER}</span>
                      <p className="text-sm font-medium mt-0.5">{attestation.attester.name}</p>
                      {attestation.attester.title && (
                        <p className="text-xs text-[#bbc9cf]">{attestation.attester.title}</p>
                      )}
                    </div>
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">{ATTESTATION_LABELS.ATTESTER_TYPE}</span>
                      <p className="text-sm mt-0.5">{attestation.attester.type.replace(/_/g, ' ')}</p>
                    </div>
                    {attestation.jurisdiction && (
                      <div>
                        <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">{ATTESTATION_LABELS.JURISDICTION}</span>
                        <p className="text-sm mt-0.5">{attestation.jurisdiction}</p>
                      </div>
                    )}
                  </div>

                  <Separator className="bg-[#bbc9cf]/10" />

                  {/* Claims */}
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">
                      {ATTESTATION_LABELS.CLAIMS} ({(attestation.claims ?? []).length})
                    </span>
                    <div className="mt-2 space-y-2">
                      {(attestation.claims ?? []).map((c, i) => (
                        <div key={i} className="rounded-lg border border-[#bbc9cf]/10 px-3 py-2 bg-[#0d141b]/50">
                          <p className="text-sm">{c.claim}</p>
                          {c.evidence && <p className="text-xs text-[#bbc9cf] mt-1">{PUBLIC_ATTESTATION_VERIFY_LABELS.EVIDENCE_PREFIX} {c.evidence}</p>}
                        </div>
                      ))}
                    </div>
                  </div>

                  {attestation.summary && (
                    <>
                      <Separator className="bg-[#bbc9cf]/10" />
                      <div>
                        <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">{ATTESTATION_LABELS.SUMMARY}</span>
                        <p className="text-sm text-[#bbc9cf] mt-1">{attestation.summary}</p>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Verification Result (fingerprint + chain proof) */}
              <VerificationResultDisplay
                status={attestation.status}
                fingerprint={attestation.fingerprint}
                chainProof={attestation.chain_proof}
              />

              {/* Evidence + Lifecycle */}
              {((attestation.evidence ?? []).length > 0 || attestation.evidence_count > 0) && (
                <Card className="border-[#00d4ff]/10 bg-[#192028]">
                  <CardContent className="space-y-4 pt-5">
                    {(attestation.evidence ?? []).length > 0 && (
                      <div>
                        <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">
                          {PUBLIC_ATTESTATION_VERIFY_LABELS.EVIDENCE}
                        </span>
                        <div className="mt-2 space-y-2">
                          {attestation.evidence.map((item) => (
                            <div key={item.public_id} className="rounded-sm border border-[#00d4ff]/10 bg-[#111820] p-3">
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="text-sm text-[#dce3ed]">{item.evidence_type}</p>
                                  <code className="text-[10px] text-[#00d4ff] break-all">{item.fingerprint}</code>
                                </div>
                                <FileCheck className="h-4 w-4 shrink-0 text-emerald-400" />
                              </div>
                              <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-[#bbc9cf]">
                                <span>{item.public_id}</span>
                                {item.mime && <span>{item.mime}</span>}
                                {item.size !== null && <span>{item.size.toLocaleString()}{PUBLIC_ATTESTATION_VERIFY_LABELS.BYTES_SUFFIX}</span>}
                              </div>
                              {item.description && (
                                <p className="mt-1 text-xs text-[#bbc9cf]">{item.description}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Lifecycle */}
                    <Separator className="bg-[#bbc9cf]/10" />
                    <div className="text-xs text-[#bbc9cf] space-y-1">
                      <p>{ATTESTATION_LABELS.ISSUED}: {new Date(attestation.issued_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</p>
                      {attestation.expires_at && (
                        <p>{ATTESTATION_LABELS.EXPIRES}: {new Date(attestation.expires_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</p>
                      )}
                      {attestation.evidence_count > 0 && (
                        <p>{ATTESTATION_LABELS.EVIDENCE_COUNT}: {attestation.evidence_count}</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Linked Credential */}
              {attestation.linked_credential && (
                <Card className="border-[#00d4ff]/10 bg-[#192028]">
                  <CardContent className="py-4">
                    <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">
                      {PUBLIC_ATTESTATION_VERIFY_LABELS.LINKED_CREDENTIAL}
                    </span>
                    <div className="flex items-center justify-between mt-2">
                      <div>
                        <code className="text-sm font-mono text-[#00d4ff]">{attestation.linked_credential.public_id}</code>
                        <div className="flex items-center gap-2 mt-1">
                          {attestation.linked_credential.credential_type && (
                            <Badge variant="secondary" className="text-[10px]">
                              {attestation.linked_credential.credential_type}
                            </Badge>
                          )}
                          <Badge className={attestation.linked_credential.verification_status === 'VERIFIED'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            : 'bg-muted text-muted-foreground'}>
                            {attestation.linked_credential.verification_status}
                          </Badge>
                        </div>
                      </div>
                      <Link to={verifyPath(attestation.linked_credential.public_id)}>
                        <Button variant="outline" size="sm" className="border-[#00d4ff]/20 text-[#00d4ff]">
                          {PUBLIC_ATTESTATION_VERIFY_LABELS.VERIFY_CREDENTIAL}
                        </Button>
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              )}

              {(attestation.attestor_credentials ?? []).length > 0 && (
                <Card className="border-[#00d4ff]/10 bg-[#192028]">
                  <CardContent className="py-4">
                    <span className="text-[10px] uppercase tracking-wider text-[#bbc9cf] font-semibold">
                      {PUBLIC_ATTESTATION_VERIFY_LABELS.ATTESTOR_CREDENTIAL_CHAIN}
                    </span>
                    <div className="mt-2 space-y-2">
                      {(attestation.attestor_credentials ?? []).map((credential) => (
                        <div key={credential.public_id} className="flex items-center justify-between gap-3 rounded border border-[#00d4ff]/10 bg-[#111820] p-3">
                          <div className="min-w-0">
                            <code className="text-xs font-mono text-[#00d4ff]">{credential.public_id}</code>
                            <div className="mt-1 flex flex-wrap gap-2">
                              {credential.credential_type && (
                                <Badge variant="secondary" className="text-[10px]">{credential.credential_type}</Badge>
                              )}
                              <Badge className={credential.is_current
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                : 'bg-muted text-muted-foreground'}>
                                {getStatusLabel(credential.status)}
                              </Badge>
                              {credential.version_number !== null && (
                                <Badge variant="outline" className="text-[10px]">v{credential.version_number}</Badge>
                              )}
                            </div>
                          </div>
                          <Link to={verifyPath(credential.public_id)}>
                            <Button variant="outline" size="sm" className="border-[#00d4ff]/20 text-[#00d4ff]">
                              {PUBLIC_ATTESTATION_VERIFY_LABELS.VERIFY}
                            </Button>
                          </Link>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Platform Disclaimer (IDT WS3) */}
      <div className="container px-4 pb-6">
        <AnchorDisclaimerDark />
      </div>

      {/* Footer */}
      <footer className="border-t border-[#bbc9cf]/15 py-6 px-4">
        <div className="container flex flex-col sm:flex-row justify-between items-center gap-4 text-xs text-[#bbc9cf]">
          <span>{PUBLIC_ATTESTATION_VERIFY_LABELS.FOOTER_TAGLINE}</span>
          <div className="flex gap-4">
            <Link to="/privacy" className="hover:text-[#00d4ff] transition-colors">{PUBLIC_ATTESTATION_VERIFY_LABELS.FOOTER_PRIVACY}</Link>
            <Link to="/terms" className="hover:text-[#00d4ff] transition-colors">{PUBLIC_ATTESTATION_VERIFY_LABELS.FOOTER_TERMS}</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
