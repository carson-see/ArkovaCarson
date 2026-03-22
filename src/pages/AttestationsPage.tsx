/**
 * Attestations Page (Phase II)
 *
 * Create, view, and manage immutable attestations anchored to Bitcoin.
 * Available to both ORG_ADMIN and INDIVIDUAL users.
 *
 * Attestation types: VERIFICATION, ENDORSEMENT, AUDIT, APPROVAL,
 * COMPLIANCE, SUPPLY_CHAIN, IDENTITY, WITNESS, CUSTOM.
 */

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Shield,
  Plus,
  FileCheck,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  ExternalLink,
  Copy,
  Check,
  Trash2,
  X,
  Ban,
  Link2,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/lib/supabase';

const ATTESTATION_TYPES = [
  { value: 'VERIFICATION', label: 'Verification', desc: 'Verify a credential or document is authentic' },
  { value: 'ENDORSEMENT', label: 'Endorsement', desc: 'Endorse a qualification or competency' },
  { value: 'AUDIT', label: 'Audit', desc: 'Audit finding or compliance assessment' },
  { value: 'APPROVAL', label: 'Approval', desc: 'Regulatory or institutional approval' },
  { value: 'COMPLIANCE', label: 'Compliance', desc: 'SOX, ESG, or regulatory compliance attestation' },
  { value: 'SUPPLY_CHAIN', label: 'Supply Chain', desc: 'Provenance or chain-of-custody attestation' },
  { value: 'IDENTITY', label: 'Identity', desc: 'Identity verification attestation' },
  { value: 'WITNESS', label: 'Witness', desc: 'Witnessed credential presentation' },
  { value: 'CUSTOM', label: 'Custom', desc: 'Custom attestation type' },
] as const;

const ATTESTER_TYPES = [
  { value: 'INSTITUTION', label: 'Institution' },
  { value: 'CORPORATION', label: 'Corporation' },
  { value: 'INDIVIDUAL', label: 'Individual' },
  { value: 'REGULATORY', label: 'Regulatory Body' },
  { value: 'THIRD_PARTY', label: 'Third Party' },
] as const;

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  PENDING: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  ACTIVE: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  REVOKED: 'bg-red-500/10 text-red-400 border-red-500/20',
  EXPIRED: 'bg-muted text-muted-foreground',
  CHALLENGED: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
};

interface Attestation {
  id: string;
  public_id: string;
  attestation_type: string;
  status: string;
  subject_type: string;
  subject_identifier: string;
  attester_name: string;
  attester_type: string;
  attester_title: string | null;
  claims: Array<{ claim: string; evidence?: string }>;
  summary: string | null;
  jurisdiction: string | null;
  fingerprint: string | null;
  chain_tx_id: string | null;
  issued_at: string;
  expires_at: string | null;
  created_at: string;
}

interface ClaimInput {
  claim: string;
  evidence: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = supabase as any;

export function AttestationsPage() {
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();

  // List state
  const [attestations, setAttestations] = useState<Attestation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [attestationType, setAttestationType] = useState('VERIFICATION');
  const [attesterType, setAttesterType] = useState('INSTITUTION');
  const [attesterName, setAttesterName] = useState('');
  const [attesterTitle, setAttesterTitle] = useState('');
  const [subjectType, setSubjectType] = useState('credential');
  const [subjectIdentifier, setSubjectIdentifier] = useState('');
  const [summary, setSummary] = useState('');
  const [jurisdiction, setJurisdiction] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [claims, setClaims] = useState<ClaimInput[]>([{ claim: '', evidence: '' }]);

  // Detail state
  const [selectedAttestation, setSelectedAttestation] = useState<Attestation | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Revoke state
  const [revokeTarget, setRevokeTarget] = useState<Attestation | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeConfirm, setRevokeConfirm] = useState('');
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const fetchAttestations = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await dbAny
        .from('attestations')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (!error && data) {
        setAttestations(data as Attestation[]);
      }
    } catch {
      // Fetch failed
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAttestations();
  }, [fetchAttestations]);

  const handleCopy = useCallback((text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }, []);

  const handleRevoke = useCallback(async () => {
    if (!revokeTarget || revokeConfirm.toLowerCase() !== 'revoke') return;
    setRevoking(true);
    setRevokeError(null);
    try {
      const workerUrl = import.meta.env.VITE_WORKER_URL ?? 'https://arkova-worker-270018525501.us-central1.run.app';
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setRevokeError('Authentication required'); setRevoking(false); return; }

      const response = await fetch(`${workerUrl}/api/v1/attestations/${encodeURIComponent(revokeTarget.public_id)}/revoke`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ reason: revokeReason.trim() }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Revocation failed' }));
        setRevokeError(err.error || 'Revocation failed');
        setRevoking(false);
        return;
      }

      setRevokeTarget(null);
      setRevokeReason('');
      setRevokeConfirm('');
      setSelectedAttestation(null);
      await fetchAttestations();
    } catch {
      setRevokeError('Network error — please try again');
    } finally {
      setRevoking(false);
    }
  }, [revokeTarget, revokeConfirm, revokeReason, fetchAttestations]);

  const addClaim = () => {
    setClaims((prev) => [...prev, { claim: '', evidence: '' }]);
  };

  const removeClaim = (index: number) => {
    setClaims((prev) => prev.filter((_, i) => i !== index));
  };

  const updateClaim = (index: number, field: 'claim' | 'evidence', value: string) => {
    setClaims((prev) => prev.map((c, i) => i === index ? { ...c, [field]: value } : c));
  };

  const resetForm = () => {
    setAttestationType('VERIFICATION');
    setAttesterType('INSTITUTION');
    setAttesterName('');
    setAttesterTitle('');
    setSubjectType('credential');
    setSubjectIdentifier('');
    setSummary('');
    setJurisdiction('');
    setExpiresAt('');
    setClaims([{ claim: '', evidence: '' }]);
    setFormError(null);
  };

  const handleSubmit = async () => {
    setFormError(null);

    // Validation
    if (!attesterName.trim()) { setFormError('Attester name is required'); return; }
    if (!subjectIdentifier.trim()) { setFormError('Subject identifier is required'); return; }
    const validClaims = claims.filter((c) => c.claim.trim());
    if (validClaims.length === 0) { setFormError('At least one claim is required'); return; }

    setSubmitting(true);

    try {
      const workerUrl = import.meta.env.VITE_WORKER_URL ?? 'https://arkova-worker-270018525501.us-central1.run.app';
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setFormError('Authentication required'); setSubmitting(false); return; }

      const response = await fetch(`${workerUrl}/api/v1/attestations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          attestation_type: attestationType,
          attester_name: attesterName.trim(),
          attester_type: attesterType,
          attester_title: attesterTitle.trim() || undefined,
          subject_type: subjectType,
          subject_identifier: subjectIdentifier.trim(),
          claims: validClaims.map((c) => ({
            claim: c.claim.trim(),
            evidence: c.evidence.trim() || undefined,
          })),
          summary: summary.trim() || undefined,
          jurisdiction: jurisdiction.trim() || undefined,
          expires_at: expiresAt || undefined,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Failed to create attestation' }));
        setFormError(err.error || 'Failed to create attestation');
        setSubmitting(false);
        return;
      }

      resetForm();
      setShowForm(false);
      await fetchAttestations();
    } catch {
      setFormError('Network error — please try again');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppShell user={user ?? undefined} onSignOut={signOut} profile={profile ?? undefined} profileLoading={profileLoading}>
      <div className="space-y-6 p-4 md:p-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold font-display tracking-tight">Attestations</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Create and manage immutable attestations anchored to the network
            </p>
          </div>
          <Button
            onClick={() => { setShowForm(!showForm); if (!showForm) resetForm(); }}
            className={showForm ? 'bg-muted text-muted-foreground hover:bg-muted/80' : ''}
          >
            {showForm ? (
              <><X className="mr-2 h-4 w-4" /> Cancel</>
            ) : (
              <><Plus className="mr-2 h-4 w-4" /> New Attestation</>
            )}
          </Button>
        </div>

        {/* Create Form */}
        {showForm && (
          <Card className="border-[#00d4ff]/20 bg-[#0d141b]/80 animate-in fade-in slide-in-from-top-2 duration-200">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileCheck className="h-5 w-5 text-[#00d4ff]" />
                Create New Attestation
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {formError && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                  {formError}
                </div>
              )}

              {/* Attestation Type */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Attestation Type</Label>
                  <Select value={attestationType} onValueChange={setAttestationType}>
                    <SelectTrigger className="bg-transparent border-[#00d4ff]/20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ATTESTATION_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          <span className="font-medium">{t.label}</span>
                          <span className="text-xs text-muted-foreground ml-2">— {t.desc}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Subject Type</Label>
                  <Select value={subjectType} onValueChange={setSubjectType}>
                    <SelectTrigger className="bg-transparent border-[#00d4ff]/20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="credential">Credential</SelectItem>
                      <SelectItem value="entity">Entity / Organization</SelectItem>
                      <SelectItem value="process">Process / Procedure</SelectItem>
                      <SelectItem value="asset">Asset / Document</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Subject */}
              <div className="space-y-2">
                <Label>Subject *</Label>
                <Input
                  placeholder={subjectType === 'credential' ? 'e.g., Bachelor of Science in Computer Science' :
                    subjectType === 'entity' ? 'e.g., Acme Corporation, University of Michigan' :
                    subjectType === 'process' ? 'e.g., SOC 2 Type II Audit, ISO 27001 Certification' :
                    'e.g., Patent Application #12345, Financial Statement Q4 2026'}
                  value={subjectIdentifier}
                  onChange={(e) => setSubjectIdentifier(e.target.value)}
                  className="bg-transparent border-[#00d4ff]/20"
                />
                <p className="text-xs text-muted-foreground">
                  What is being attested — a unique attestation ID will be auto-generated (e.g., ARK-UMI-VER-A3F2B1)
                </p>
              </div>

              {/* Attester Info */}
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label>Attester Name *</Label>
                  <Input
                    placeholder="Your name or organization"
                    value={attesterName}
                    onChange={(e) => setAttesterName(e.target.value)}
                    className="bg-transparent border-[#00d4ff]/20"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Attester Type</Label>
                  <Select value={attesterType} onValueChange={setAttesterType}>
                    <SelectTrigger className="bg-transparent border-[#00d4ff]/20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ATTESTER_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Title / Role</Label>
                  <Input
                    placeholder="e.g., General Counsel, CPA"
                    value={attesterTitle}
                    onChange={(e) => setAttesterTitle(e.target.value)}
                    className="bg-transparent border-[#00d4ff]/20"
                  />
                </div>
              </div>

              {/* Claims */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Claims *</Label>
                  <Button variant="outline" size="sm" onClick={addClaim} className="border-[#00d4ff]/20 text-xs">
                    <Plus className="h-3 w-3 mr-1" /> Add Claim
                  </Button>
                </div>
                {claims.map((claim, i) => (
                  <div key={i} className="flex gap-2">
                    <div className="flex-1 space-y-1">
                      <Input
                        placeholder="Claim statement (e.g., 'This document has been independently verified')"
                        value={claim.claim}
                        onChange={(e) => updateClaim(i, 'claim', e.target.value)}
                        className="bg-transparent border-[#00d4ff]/20"
                      />
                      <Input
                        placeholder="Supporting evidence (optional)"
                        value={claim.evidence}
                        onChange={(e) => updateClaim(i, 'evidence', e.target.value)}
                        className="bg-transparent border-[#00d4ff]/20 text-xs"
                      />
                    </div>
                    {claims.length > 1 && (
                      <Button variant="ghost" size="sm" onClick={() => removeClaim(i)} className="text-muted-foreground h-8 w-8 p-0 mt-1">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>

              {/* Summary + Jurisdiction */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Summary</Label>
                  <Input
                    placeholder="Brief description of this attestation"
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    className="bg-transparent border-[#00d4ff]/20"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Jurisdiction</Label>
                  <Input
                    placeholder="e.g., US, EU, UK"
                    value={jurisdiction}
                    onChange={(e) => setJurisdiction(e.target.value)}
                    className="bg-transparent border-[#00d4ff]/20"
                  />
                </div>
              </div>

              {/* Expiry */}
              <div className="w-full sm:w-1/3">
                <div className="space-y-2">
                  <Label>Expires At (optional)</Label>
                  <Input
                    type="datetime-local"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                    className="bg-transparent border-[#00d4ff]/20"
                  />
                </div>
              </div>

              {/* Submit */}
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={() => { setShowForm(false); resetForm(); }} className="border-[#00d4ff]/20">
                  Cancel
                </Button>
                <Button onClick={handleSubmit} disabled={submitting}>
                  {submitting ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating...</>
                  ) : (
                    <><Shield className="mr-2 h-4 w-4" /> Create Attestation</>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Detail Panel */}
        {selectedAttestation && (
          <Card className="border-[#00d4ff]/20 bg-[#0d141b]/80 animate-in fade-in slide-in-from-top-2 duration-200">
            <CardHeader>
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-base">{selectedAttestation.subject_identifier}</CardTitle>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge className={STATUS_COLORS[selectedAttestation.status] ?? ''}>
                      {selectedAttestation.status}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px]">
                      {selectedAttestation.attestation_type.replace(/_/g, ' ')}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{selectedAttestation.subject_type}</span>
                  </div>
                </div>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setSelectedAttestation(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Attester */}
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Attester</span>
                  <p className="text-sm font-medium mt-0.5">{selectedAttestation.attester_name}</p>
                  {selectedAttestation.attester_title && (
                    <p className="text-xs text-muted-foreground">{selectedAttestation.attester_title}</p>
                  )}
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Type</span>
                  <p className="text-sm mt-0.5">{selectedAttestation.attester_type}</p>
                </div>
                {selectedAttestation.jurisdiction && (
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Jurisdiction</span>
                    <p className="text-sm mt-0.5">{selectedAttestation.jurisdiction}</p>
                  </div>
                )}
              </div>

              {/* Claims */}
              <div>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Claims</span>
                <div className="mt-2 space-y-2">
                  {(selectedAttestation.claims ?? []).map((c, i) => (
                    <div key={i} className="rounded-lg border border-border/50 px-3 py-2">
                      <p className="text-sm">{c.claim}</p>
                      {c.evidence && <p className="text-xs text-muted-foreground mt-1">Evidence: {c.evidence}</p>}
                    </div>
                  ))}
                </div>
              </div>

              {/* Summary */}
              {selectedAttestation.summary && (
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Summary</span>
                  <p className="text-sm text-muted-foreground mt-1">{selectedAttestation.summary}</p>
                </div>
              )}

              {/* Fingerprint + Chain */}
              <div className="grid gap-3 sm:grid-cols-2 border-t border-border/50 pt-3">
                {selectedAttestation.fingerprint && (
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Fingerprint</span>
                    <div className="flex items-center gap-2 mt-0.5">
                      <code className="text-xs font-mono text-[#00d4ff] break-all">{selectedAttestation.fingerprint}</code>
                      <button onClick={() => handleCopy(selectedAttestation.fingerprint!, 'fp')} className="text-muted-foreground hover:text-foreground shrink-0">
                        {copiedField === 'fp' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>
                )}
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Public ID</span>
                  <div className="flex items-center gap-2 mt-0.5">
                    <code className="text-xs font-mono">{selectedAttestation.public_id}</code>
                    <button onClick={() => handleCopy(selectedAttestation.public_id, 'pid')} className="text-muted-foreground hover:text-foreground shrink-0">
                      {copiedField === 'pid' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
              </div>

              {selectedAttestation.chain_tx_id && (
                <div className="border-t border-border/50 pt-3">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Network Receipt</span>
                  <div className="flex items-center gap-2 mt-0.5">
                    <a
                      href={`https://mempool.space/signet/tx/${selectedAttestation.chain_tx_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-mono text-[#00d4ff] hover:text-[#00d4ff]/80 flex items-center gap-1"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {selectedAttestation.chain_tx_id.slice(0, 20)}...
                    </a>
                  </div>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex items-center gap-2 border-t border-border/50 pt-3">
                <Link to={`/verify/attestation/${selectedAttestation.public_id}`} target="_blank">
                  <Button variant="outline" size="sm" className="border-[#00d4ff]/20 text-xs">
                    <Link2 className="h-3.5 w-3.5 mr-1.5" />
                    Public Verification Link
                  </Button>
                </Link>
                {selectedAttestation.status !== 'REVOKED' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-red-500/20 text-red-400 hover:bg-red-500/10 text-xs"
                    onClick={() => { setRevokeTarget(selectedAttestation); setRevokeError(null); }}
                  >
                    <Ban className="h-3.5 w-3.5 mr-1.5" />
                    Revoke
                  </Button>
                )}
              </div>

              <div className="text-xs text-muted-foreground pt-2">
                Issued: {new Date(selectedAttestation.issued_at).toLocaleString()}
                {selectedAttestation.expires_at && ` · Expires: ${new Date(selectedAttestation.expires_at).toLocaleString()}`}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Revoke Dialog */}
        <AlertDialog open={!!revokeTarget} onOpenChange={(open) => { if (!open && !revoking) { setRevokeTarget(null); setRevokeReason(''); setRevokeConfirm(''); setRevokeError(null); } }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                </div>
                <AlertDialogTitle>Revoke Attestation</AlertDialogTitle>
              </div>
              <AlertDialogDescription className="space-y-3">
                <p>
                  You are about to revoke attestation{' '}
                  <span className="font-medium text-foreground font-mono">{revokeTarget?.public_id}</span>.
                </p>
                <p>
                  This action is permanent. The attestation will be marked as revoked and its verification status will reflect this change.
                </p>
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="space-y-4 py-2">
              {revokeError && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                  {revokeError}
                </div>
              )}
              <div className="space-y-2">
                <Label>Reason for Revocation *</Label>
                <p className="text-xs text-muted-foreground">Minimum 3 characters required</p>
                <Textarea
                  value={revokeReason}
                  onChange={(e) => setRevokeReason(e.target.value)}
                  placeholder="Describe why this attestation is being revoked"
                  disabled={revoking}
                  maxLength={2000}
                  rows={3}
                />
              </div>
              <div className="space-y-2">
                <Label>
                  Type <span className="font-mono font-semibold">revoke</span> to confirm
                </Label>
                <Input
                  value={revokeConfirm}
                  onChange={(e) => setRevokeConfirm(e.target.value)}
                  placeholder="revoke"
                  disabled={revoking}
                />
              </div>
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleRevoke}
                disabled={revokeConfirm.toLowerCase() !== 'revoke' || revokeReason.trim().length < 3 || revoking}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {revoking ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Revoking...</>
                ) : (
                  'Revoke Attestation'
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Attestations List */}
        <Card className="border-[#00d4ff]/10 bg-transparent">
          <CardHeader>
            <CardTitle className="text-base">Your Attestations</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : attestations.length === 0 ? (
              <div className="text-center py-12">
                <FileCheck className="mx-auto h-10 w-10 text-muted-foreground mb-3" />
                <p className="text-sm text-muted-foreground">No attestations yet</p>
                <p className="text-xs text-muted-foreground mt-1">Create your first attestation to anchor a verifiable claim</p>
                <Button variant="outline" className="mt-4" onClick={() => setShowForm(true)}>
                  <Plus className="mr-2 h-4 w-4" /> Create Attestation
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border/50">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border/50 hover:bg-transparent">
                      <TableHead className="text-xs font-semibold">ID</TableHead>
                      <TableHead className="text-xs font-semibold">Subject</TableHead>
                      <TableHead className="text-xs font-semibold hidden md:table-cell">Attester</TableHead>
                      <TableHead className="text-xs font-semibold">Status</TableHead>
                      <TableHead className="text-xs font-semibold hidden md:table-cell">Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {attestations.map((att) => (
                      <TableRow
                        key={att.id}
                        className={`border-border/50 cursor-pointer transition-colors ${selectedAttestation?.id === att.id ? 'bg-[#00d4ff]/5' : 'hover:bg-[#00d4ff]/5'}`}
                        onClick={() => setSelectedAttestation(att)}
                      >
                        <TableCell className="py-2">
                          <code className="text-[11px] font-mono text-[#00d4ff]">
                            {att.public_id}
                          </code>
                          <Badge variant="secondary" className="text-[9px] font-mono ml-1.5">
                            {att.attestation_type.replace(/_/g, ' ')}
                          </Badge>
                        </TableCell>
                        <TableCell className="py-2 max-w-[280px]">
                          <span className="text-sm truncate block">{att.subject_identifier}</span>
                          <span className="text-[10px] text-muted-foreground">{att.subject_type}</span>
                        </TableCell>
                        <TableCell className="py-2 hidden md:table-cell">
                          <span className="text-sm">{att.attester_name}</span>
                        </TableCell>
                        <TableCell className="py-2">
                          <Badge className={STATUS_COLORS[att.status] ?? ''}>
                            {att.status === 'ACTIVE' && <CheckCircle className="h-3 w-3 mr-1" />}
                            {att.status === 'PENDING' && <Clock className="h-3 w-3 mr-1" />}
                            {att.status === 'REVOKED' && <XCircle className="h-3 w-3 mr-1" />}
                            {att.status === 'CHALLENGED' && <AlertTriangle className="h-3 w-3 mr-1" />}
                            {att.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="py-2 hidden md:table-cell">
                          <span className="text-xs text-muted-foreground">
                            {new Date(att.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
