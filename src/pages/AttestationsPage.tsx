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
import { WORKER_URL } from '@/lib/workerClient';
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
import { EmploymentVerificationForm } from '@/components/attestation/EmploymentVerificationForm';
import { EducationVerificationForm } from '@/components/attestation/EducationVerificationForm';
import { EvidenceUpload } from '@/components/attestation/EvidenceUpload';
import type { EvidenceItem } from '@/components/attestation/EvidenceUpload';
import { BulkIssuanceWizard } from '@/components/attestation/BulkIssuanceWizard';
import { AttestationStatusCard } from '@/components/attestation/AttestationStatusCard';
import { VerificationResultDisplay } from '@/components/attestation/VerificationResultDisplay';
import { NotarizationBadge } from '@/components/attestation/NotarizationBadge';
import { Briefcase, GraduationCap, FileSpreadsheet } from 'lucide-react';
import { CreatePortfolioDialog } from '@/components/portfolio';
import { AttestationEvidencePayloadSchema } from '@/lib/validators';
import { EVIDENCE_PAYLOAD_ERROR, ATTESTATION_LABELS, PUBLIC_ATTESTATION_VERIFY_LABELS } from '@/lib/copy';
import { getStatusLabel } from '@/lib/statusDisplay';

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
  notarized_at?: string | null;
  notary_name?: string | null;
  notary_commission_state?: string | null;
  docusign_envelope_id?: string | null;
}

interface ClaimInput {
  claim: string;
  evidence: string;
}

function serializeEvidenceItems(items: EvidenceItem[]) {
  const payload = items.map((item) => ({
    evidence_type: item.evidenceType,
    fingerprint: item.fingerprint,
    mime: item.file.type || null,
    size: item.file.size,
    filename: item.filename,
    description: item.description || null,
  }));
  const parsed = AttestationEvidencePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(EVIDENCE_PAYLOAD_ERROR);
  }
  return parsed.data;
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

  // Form template state
  const [formMode, setFormMode] = useState<'template' | 'custom' | 'employment' | 'education'>('template');
  const [evidenceItems, setEvidenceItems] = useState<EvidenceItem[]>([]);

  // Detail state
  const [selectedAttestation, setSelectedAttestation] = useState<Attestation | null>(null);

  // Portfolio dialog state
  const [showPortfolioDialog, setShowPortfolioDialog] = useState(false);

  // Bulk issuance wizard state
  const [showBulkWizard, setShowBulkWizard] = useState(false);

  // Revoke state
  const [revokeTarget, setRevokeTarget] = useState<Attestation | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeConfirm, setRevokeConfirm] = useState('');
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const profileOrgId = profile?.org_id;
  const userId = user?.id;

  const fetchAttestations = useCallback(async () => {
    if (!userId || profileLoading) {
      setLoading(profileLoading);
      return;
    }

    setLoading(true);
    try {
      const scopedQuery = profileOrgId
        ? dbAny
            .from('attestations')
            .select('*')
            .eq('attester_org_id', profileOrgId)
        : dbAny
            .from('attestations')
            .select('*')
            .eq('attester_user_id', userId);
      const { data, error } = await scopedQuery
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
  }, [profileOrgId, profileLoading, userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data fetch; setState is post-await
    fetchAttestations();
  }, [fetchAttestations]);

  const handleRevoke = useCallback(async () => {
    if (!revokeTarget || revokeConfirm.toLowerCase() !== 'revoke') return;
    setRevoking(true);
    setRevokeError(null);
    try {
      const workerUrl = WORKER_URL;
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
    setFormMode('template');
    setEvidenceItems([]);
  };

  const handleTemplateSubmit = async (data: {
    attestation_type: string;
    attester_name: string;
    attester_type: string;
    subject_type: string;
    subject_identifier: string;
    claims: Array<{ claim: string; evidence?: string }>;
    summary: string;
    metadata: Record<string, unknown>;
  }) => {
    setFormError(null);
    setSubmitting(true);
    try {
      const workerUrl = WORKER_URL;
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setFormError('Authentication required'); setSubmitting(false); return; }
      const evidencePayload = serializeEvidenceItems(evidenceItems);

      const response = await fetch(`${workerUrl}/api/v1/attestations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          attestation_type: data.attestation_type,
          attester_name: data.attester_name,
          attester_type: data.attester_type,
          subject_type: data.subject_type,
          subject_identifier: data.subject_identifier,
          claims: data.claims,
          summary: data.summary,
          evidence_fingerprint: evidenceItems.length > 0 ? evidenceItems[0].fingerprint : undefined,
          evidence: evidencePayload,
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
    } catch (error) {
      setFormError(error instanceof Error && error.message === EVIDENCE_PAYLOAD_ERROR ? EVIDENCE_PAYLOAD_ERROR : 'Network error');
    } finally {
      setSubmitting(false);
    }
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
      const workerUrl = WORKER_URL;
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setFormError('Authentication required'); setSubmitting(false); return; }
      const evidencePayload = serializeEvidenceItems(evidenceItems);

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
          evidence_fingerprint: evidenceItems.length > 0 ? evidenceItems[0].fingerprint : undefined,
          evidence: evidencePayload,
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
    } catch (error) {
      setFormError(error instanceof Error && error.message === EVIDENCE_PAYLOAD_ERROR ? EVIDENCE_PAYLOAD_ERROR : 'Network error — please try again');
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
            <h1 className="text-2xl font-bold font-display tracking-tight">{ATTESTATION_LABELS.PAGE_TITLE}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {ATTESTATION_LABELS.PAGE_SUBTITLE}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="border-[#00d4ff]/20"
              onClick={() => setShowPortfolioDialog(true)}
            >
              <Briefcase className="mr-2 h-4 w-4" /> {ATTESTATION_LABELS.CREATE_PORTFOLIO}
            </Button>
            <Button
              variant="outline"
              className="border-[#00d4ff]/20"
              onClick={() => setShowBulkWizard(true)}
            >
              <FileSpreadsheet className="mr-2 h-4 w-4" /> {ATTESTATION_LABELS.BULK_ISSUE}
            </Button>
            <Button
              onClick={() => { setShowForm(!showForm); if (!showForm) resetForm(); }}
              className={showForm ? 'bg-muted text-muted-foreground hover:bg-muted/80' : ''}
            >
              {showForm ? (
                <><X className="mr-2 h-4 w-4" /> Cancel</>
              ) : (
                <><Plus className="mr-2 h-4 w-4" /> {ATTESTATION_LABELS.NEW_ATTESTATION}</>
              )}
            </Button>
          </div>
        </div>

        {/* Create Form */}
        {showForm && (
          <Card className="border-[#00d4ff]/20 bg-[#0d141b]/80 animate-in fade-in slide-in-from-top-2 duration-200">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileCheck className="h-5 w-5 text-[#00d4ff]" />
                {ATTESTATION_LABELS.CREATE_NEW_ATTESTATION}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {formError && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                  {formError}
                </div>
              )}

              {/* Template Selection */}
              {formMode === 'template' && (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">{ATTESTATION_LABELS.TEMPLATE_PROMPT}</p>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <button
                      className="rounded-lg border border-[#00d4ff]/20 p-4 text-left hover:border-[#00d4ff]/40 hover:bg-[#00d4ff]/5 transition-colors"
                      onClick={() => setFormMode('employment')}
                    >
                      <Briefcase className="h-5 w-5 text-[#00d4ff] mb-2" />
                      <div className="font-medium text-sm">{ATTESTATION_LABELS.TEMPLATE_EMPLOYMENT}</div>
                      <p className="text-xs text-muted-foreground mt-1">{ATTESTATION_LABELS.TEMPLATE_EMPLOYMENT_DESC}</p>
                    </button>
                    <button
                      className="rounded-lg border border-[#00d4ff]/20 p-4 text-left hover:border-[#00d4ff]/40 hover:bg-[#00d4ff]/5 transition-colors"
                      onClick={() => setFormMode('education')}
                    >
                      <GraduationCap className="h-5 w-5 text-[#00d4ff] mb-2" />
                      <div className="font-medium text-sm">{ATTESTATION_LABELS.TEMPLATE_EDUCATION}</div>
                      <p className="text-xs text-muted-foreground mt-1">{ATTESTATION_LABELS.TEMPLATE_EDUCATION_DESC}</p>
                    </button>
                    <button
                      className="rounded-lg border border-border/50 p-4 text-left hover:border-[#00d4ff]/20 hover:bg-[#00d4ff]/5 transition-colors"
                      onClick={() => setFormMode('custom')}
                    >
                      <FileCheck className="h-5 w-5 text-muted-foreground mb-2" />
                      <div className="font-medium text-sm">{ATTESTATION_LABELS.TEMPLATE_CUSTOM}</div>
                      <p className="text-xs text-muted-foreground mt-1">{ATTESTATION_LABELS.TEMPLATE_CUSTOM_DESC}</p>
                    </button>
                  </div>
                </div>
              )}

              {/* Employment Template */}
              {formMode === 'employment' && (
                <EmploymentVerificationForm
                  orgName={profile?.full_name ?? ''}
                  onSubmit={handleTemplateSubmit}
                  onCancel={() => setFormMode('template')}
                  submitting={submitting}
                />
              )}

              {/* Education Template */}
              {formMode === 'education' && (
                <EducationVerificationForm
                  orgName={profile?.full_name ?? ''}
                  onSubmit={handleTemplateSubmit}
                  onCancel={() => setFormMode('template')}
                  submitting={submitting}
                />
              )}

              {/* Custom Form (original) */}
              {formMode === 'custom' && (
                <>
                  {/* Attestation Type */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label>{ATTESTATION_LABELS.ATTESTATION_TYPE}</Label>
                      <Select value={attestationType} onValueChange={setAttestationType}>
                        <SelectTrigger className="bg-transparent border-[#00d4ff]/20">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ATTESTATION_TYPES.map((t) => (
                            <SelectItem key={t.value} value={t.value}>
                              <span className="font-medium">{t.label}</span>
                              <span className="text-xs text-muted-foreground ml-2">{t.desc}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>{ATTESTATION_LABELS.SUBJECT_TYPE}</Label>
                      <Select value={subjectType} onValueChange={setSubjectType}>
                        <SelectTrigger className="bg-transparent border-[#00d4ff]/20">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="credential">{ATTESTATION_LABELS.SUBJECT_CREDENTIAL}</SelectItem>
                          <SelectItem value="entity">{ATTESTATION_LABELS.SUBJECT_ENTITY}</SelectItem>
                          <SelectItem value="process">{ATTESTATION_LABELS.SUBJECT_PROCESS}</SelectItem>
                          <SelectItem value="asset">{ATTESTATION_LABELS.SUBJECT_ASSET}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Subject */}
                  <div className="space-y-2">
                    <Label>{ATTESTATION_LABELS.SUBJECT_REQUIRED}</Label>
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
                      {ATTESTATION_LABELS.SUBJECT_HINT}
                    </p>
                  </div>

                  {/* Attester Info */}
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="space-y-2">
                      <Label>{ATTESTATION_LABELS.ATTESTER_NAME_REQUIRED}</Label>
                      <Input
                        placeholder={ATTESTATION_LABELS.PLACEHOLDER_ATTESTER_NAME}
                        value={attesterName}
                        onChange={(e) => setAttesterName(e.target.value)}
                        className="bg-transparent border-[#00d4ff]/20"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>{ATTESTATION_LABELS.ATTESTER_TYPE}</Label>
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
                      <Label>{ATTESTATION_LABELS.TITLE_ROLE}</Label>
                      <Input
                        placeholder={ATTESTATION_LABELS.PLACEHOLDER_TITLE}
                        value={attesterTitle}
                        onChange={(e) => setAttesterTitle(e.target.value)}
                        className="bg-transparent border-[#00d4ff]/20"
                      />
                    </div>
                  </div>

                  {/* Claims */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>{ATTESTATION_LABELS.CLAIMS_REQUIRED}</Label>
                      <Button variant="outline" size="sm" onClick={addClaim} className="border-[#00d4ff]/20 text-xs">
                        <Plus className="h-3 w-3 mr-1" /> {ATTESTATION_LABELS.ADD_CLAIM}
                      </Button>
                    </div>
                    {claims.map((claim, i) => (
                      <div key={i} className="flex gap-2">
                        <div className="flex-1 space-y-1">
                          <Input
                            placeholder={ATTESTATION_LABELS.PLACEHOLDER_CLAIM}
                            value={claim.claim}
                            onChange={(e) => updateClaim(i, 'claim', e.target.value)}
                            className="bg-transparent border-[#00d4ff]/20"
                          />
                          <Input
                            placeholder={ATTESTATION_LABELS.PLACEHOLDER_EVIDENCE}
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
                      <Label>{ATTESTATION_LABELS.SUMMARY}</Label>
                      <Input
                        placeholder={ATTESTATION_LABELS.PLACEHOLDER_SUMMARY}
                        value={summary}
                        onChange={(e) => setSummary(e.target.value)}
                        className="bg-transparent border-[#00d4ff]/20"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>{ATTESTATION_LABELS.JURISDICTION}</Label>
                      <Input
                        placeholder={ATTESTATION_LABELS.PLACEHOLDER_JURISDICTION}
                        value={jurisdiction}
                        onChange={(e) => setJurisdiction(e.target.value)}
                        className="bg-transparent border-[#00d4ff]/20"
                      />
                    </div>
                  </div>

                  {/* Expiry */}
                  <div className="w-full sm:w-1/3">
                    <div className="space-y-2">
                      <Label>{ATTESTATION_LABELS.EXPIRES_AT_OPTIONAL}</Label>
                      <Input
                        type="datetime-local"
                        value={expiresAt}
                        onChange={(e) => setExpiresAt(e.target.value)}
                        className="bg-transparent border-[#00d4ff]/20"
                      />
                    </div>
                  </div>

                  {/* Evidence Upload */}
                  <EvidenceUpload
                    items={evidenceItems}
                    onChange={setEvidenceItems}
                    disabled={submitting}
                  />

                  {/* Submit */}
                  <div className="flex justify-end gap-3 pt-2">
                    <Button variant="outline" onClick={() => setFormMode('template')} className="border-[#00d4ff]/20">
                      Back
                    </Button>
                    <Button onClick={handleSubmit} disabled={submitting}>
                      {submitting ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> {ATTESTATION_LABELS.CREATING}</>
                      ) : (
                        <><Shield className="mr-2 h-4 w-4" /> {ATTESTATION_LABELS.CREATE_ATTESTATION}</>
                      )}
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Detail Panel */}
        {selectedAttestation && (
          <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
            {/* Close button row */}
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold truncate">{selectedAttestation.subject_identifier}</h2>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => setSelectedAttestation(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Status Card */}
            <AttestationStatusCard
              status={selectedAttestation.status}
              publicId={selectedAttestation.public_id}
              attestationType={selectedAttestation.attestation_type.replace(/_/g, ' ')}
            />

            {/* Verification Result */}
            <VerificationResultDisplay
              status={selectedAttestation.status}
              fingerprint={selectedAttestation.fingerprint}
              chainProof={selectedAttestation.chain_tx_id ? {
                tx_id: selectedAttestation.chain_tx_id,
                block_height: null,
                timestamp: null,
                explorer_url: `https://mempool.space/signet/tx/${selectedAttestation.chain_tx_id}`,
              } : null}
            />

            {/* Notarization Badge */}
            <NotarizationBadge
              notarizationCompletedAt={selectedAttestation.notarized_at}
              notaryName={selectedAttestation.notary_name}
              notaryCommissionState={selectedAttestation.notary_commission_state}
              docusignEnvelopeId={selectedAttestation.docusign_envelope_id}
            />

            {/* Attester + Claims detail card */}
            <Card className="border-[#00d4ff]/20 bg-[#0d141b]/80">
              <CardContent className="space-y-4 pt-5">
                {/* Attester */}
                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{ATTESTATION_LABELS.ATTESTER}</span>
                    <p className="text-sm font-medium mt-0.5">{selectedAttestation.attester_name}</p>
                    {selectedAttestation.attester_title && (
                      <p className="text-xs text-muted-foreground">{selectedAttestation.attester_title}</p>
                    )}
                  </div>
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{ATTESTATION_LABELS.ATTESTER_TYPE}</span>
                    <p className="text-sm mt-0.5">{selectedAttestation.attester_type}</p>
                  </div>
                  {selectedAttestation.jurisdiction && (
                    <div>
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{ATTESTATION_LABELS.JURISDICTION}</span>
                      <p className="text-sm mt-0.5">{selectedAttestation.jurisdiction}</p>
                    </div>
                  )}
                </div>

                {/* Claims */}
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{ATTESTATION_LABELS.CLAIMS}</span>
                  <div className="mt-2 space-y-2">
                    {(selectedAttestation.claims ?? []).map((c, i) => (
                      <div key={i} className="rounded-sm border border-border/50 px-3 py-2">
                        <p className="text-sm">{c.claim}</p>
                        {c.evidence && <p className="text-xs text-muted-foreground mt-1">{PUBLIC_ATTESTATION_VERIFY_LABELS.EVIDENCE_PREFIX} {c.evidence}</p>}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Summary */}
                {selectedAttestation.summary && (
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{ATTESTATION_LABELS.SUMMARY}</span>
                    <p className="text-sm text-muted-foreground mt-1">{selectedAttestation.summary}</p>
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex items-center gap-2 border-t border-border/50 pt-3">
                  <Link to={`/verify/attestation/${selectedAttestation.public_id}`} target="_blank">
                    <Button variant="outline" size="sm" className="border-[#00d4ff]/20 text-xs">
                      <Link2 className="h-3.5 w-3.5 mr-1.5" />
                      {ATTESTATION_LABELS.VIEW_VERIFICATION}
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
                      {ATTESTATION_LABELS.REVOKE}
                    </Button>
                  )}
                </div>

                <div className="text-xs text-muted-foreground pt-2">
                  {ATTESTATION_LABELS.ISSUED}: {new Date(selectedAttestation.issued_at).toLocaleString()}
                  {selectedAttestation.expires_at && ` · ${ATTESTATION_LABELS.EXPIRES}: ${new Date(selectedAttestation.expires_at).toLocaleString()}`}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Revoke Dialog */}
        <AlertDialog open={!!revokeTarget} onOpenChange={(open) => { if (!open && !revoking) { setRevokeTarget(null); setRevokeReason(''); setRevokeConfirm(''); setRevokeError(null); } }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                </div>
                <AlertDialogTitle>{ATTESTATION_LABELS.REVOKE_TITLE}</AlertDialogTitle>
              </div>
              <AlertDialogDescription className="space-y-3">
                <p>
                  You are about to revoke attestation{' '}
                  <span className="font-medium text-foreground font-mono">{revokeTarget?.public_id}</span>.
                </p>
                <p>
                  {ATTESTATION_LABELS.REVOKE_WARNING}
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
                <Label>{ATTESTATION_LABELS.REVOKE_REASON_LABEL}</Label>
                <p className="text-xs text-muted-foreground">{ATTESTATION_LABELS.REVOKE_REASON_HINT}</p>
                <Textarea
                  value={revokeReason}
                  onChange={(e) => setRevokeReason(e.target.value)}
                  placeholder={ATTESTATION_LABELS.REVOKE_REASON_PLACEHOLDER}
                  disabled={revoking}
                  maxLength={2000}
                  rows={3}
                />
              </div>
              <div className="space-y-2">
                <Label>
                  Type <span className="font-mono font-semibold">revoke</span> {ATTESTATION_LABELS.REVOKE_CONFIRM_LABEL}
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
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> {ATTESTATION_LABELS.REVOKING}</>
                ) : (
                  ATTESTATION_LABELS.REVOKE_TITLE
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Attestations List */}
        <Card className="border-[#00d4ff]/10 bg-transparent">
          <CardHeader>
            <CardTitle className="text-base">{ATTESTATION_LABELS.YOUR_ATTESTATIONS}</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : attestations.length === 0 ? (
              <div className="text-center py-12">
                <FileCheck className="mx-auto h-10 w-10 text-muted-foreground mb-3" />
                <p className="text-sm text-muted-foreground">{ATTESTATION_LABELS.NO_ATTESTATIONS}</p>
                <p className="text-xs text-muted-foreground mt-1">{ATTESTATION_LABELS.EMPTY_CTA}</p>
                <Button variant="outline" className="mt-4" onClick={() => setShowForm(true)}>
                  <Plus className="mr-2 h-4 w-4" /> {ATTESTATION_LABELS.CREATE_ATTESTATION}
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border/50">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border/50 hover:bg-transparent">
                      <TableHead className="text-xs font-semibold">{ATTESTATION_LABELS.TABLE_ID}</TableHead>
                      <TableHead className="text-xs font-semibold">{ATTESTATION_LABELS.TABLE_SUBJECT}</TableHead>
                      <TableHead className="text-xs font-semibold hidden md:table-cell">{ATTESTATION_LABELS.TABLE_ATTESTER}</TableHead>
                      <TableHead className="text-xs font-semibold">{ATTESTATION_LABELS.TABLE_STATUS}</TableHead>
                      <TableHead className="text-xs font-semibold hidden md:table-cell">{ATTESTATION_LABELS.TABLE_CREATED}</TableHead>
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
                            {getStatusLabel(att.status)}
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

      {/* Portfolio Creation Dialog */}
      <CreatePortfolioDialog
        open={showPortfolioDialog}
        onOpenChange={setShowPortfolioDialog}
        onCreated={() => {
          // Portfolio created — dialog handles its own success state
        }}
      />

      {/* Bulk Issuance Wizard */}
      <BulkIssuanceWizard
        open={showBulkWizard}
        onOpenChange={(open) => {
          setShowBulkWizard(open);
          if (!open) fetchAttestations();
        }}
        orgName={profile?.full_name ?? 'Arkova'}
      />
    </AppShell>
  );
}
