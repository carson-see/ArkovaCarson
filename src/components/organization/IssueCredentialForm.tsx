/**
 * Issue Credential Form
 *
 * Dialog for ORG_ADMIN users to issue credentials with
 * credential_type, label, metadata (dynamic fields from template), and
 * optional recipient email. Reuses FileUpload for document fingerprinting.
 *
 * Enhanced success screen (UF-04): shows verification URL, copy link,
 * and "anchoring in progress" messaging instead of closing immediately.
 *
 * Dynamic metadata fields (UF-05): when user selects a credential_type,
 * loads matching template and renders form fields for structured metadata.
 *
 * @see P5-TS-05, UF-04, UF-05
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Loader2, Award, CheckCircle, Copy, Check, ExternalLink, Plus, FileText, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { FileUpload } from '@/components/anchor/FileUpload';
import { AIFieldSuggestions } from '@/components/anchor/AIFieldSuggestions';
import { MetadataFieldRenderer } from '@/components/credentials/MetadataFieldRenderer';
import { runExtraction, type ExtractionField, type ExtractionProgress } from '@/lib/aiExtraction';
import { isAIExtractionEnabled, isIssueCredentialSplitEnabled } from '@/lib/switchboard';
import { useCanIssueCredential } from '@/hooks/useCanIssueCredential';
import { supabase } from '@/lib/supabase';
import { validateAnchorCreate, CREDENTIAL_TYPES } from '@/lib/validators';
import { logAuditEvent } from '@/lib/auditLog';
import { hashEmail } from '@/lib/fileHasher';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useCredentialTemplate } from '@/hooks/useCredentialTemplate';
import {
  FORM_LABELS,
  CREDENTIAL_TYPE_LABELS,
  TOAST,
  ANCHORING_STATUS_LABELS,
  ISSUE_CREDENTIAL_LABELS,
  METADATA_FIELD_LABELS,
  AI_EXTRACTION_LABELS,
} from '@/lib/copy';
import { toast } from 'sonner';
import { verifyUrl, recordDetailPath } from '@/lib/routes';
import { useNavigate } from 'react-router-dom';
import type { CredentialType } from '@/lib/validators';

interface IssueCredentialFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type Step = 'form' | 'success';

interface CreatedAnchor {
  id: string;
  publicId: string;
}

/** Format file size for display */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function IssueCredentialForm({
  open,
  onOpenChange,
  onSuccess,
}: Readonly<IssueCredentialFormProps>) {
  const { user } = useAuth();
  const { profile } = useProfile();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('form');
  const [file, setFile] = useState<File | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [credentialType, setCredentialType] = useState<CredentialType | ''>('');
  const [label, setLabel] = useState('');
  const [issuedAt, setIssuedAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  // SCRUM-1755 — public proof URL (Udemy / Accredible / LinkedIn / own site).
  // Optional; persisted into anchors.metadata.proof_url. Validated as https:// when present.
  const [proofUrl, setProofUrl] = useState('');
  const [proofUrlError, setProofUrlError] = useState<string | null>(null);
  const [metadataValues, setMetadataValues] = useState<Record<string, string>>({});
  const [metadataErrors, setMetadataErrors] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdAnchor, setCreatedAnchor] = useState<CreatedAnchor | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  // AI extraction state
  const [aiEnabled, setAiEnabled] = useState(false);
  const [extractionFields, setExtractionFields] = useState<ExtractionField[]>([]);
  const [extractionProgress, setExtractionProgress] = useState<ExtractionProgress | undefined>();
  const [overallConfidence, setOverallConfidence] = useState(0);
  const [creditsRemaining, setCreditsRemaining] = useState(0);
  const [extracting, setExtracting] = useState(false);

  // Check AI extraction feature flag on mount
  useEffect(() => {
    let cancelled = false;
    isAIExtractionEnabled().then((enabled) => {
      if (!cancelled) setAiEnabled(enabled);
    });
    return () => { cancelled = true; };
  }, []);

  // SCRUM-1755 — when ENABLE_ISSUE_CREDENTIAL_SPLIT is on, only verified orgs
  // (and APPROVED sub-orgs of verified parents) may submit. Until then we
  // preserve pre-1755 behavior: any org admin can use the form.
  const [splitEnabled, setSplitEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    isIssueCredentialSplitEnabled().then((enabled) => {
      if (!cancelled) setSplitEnabled(enabled);
    }).catch(() => { if (!cancelled) setSplitEnabled(false); });
    return () => { cancelled = true; };
  }, []);
  const issueGate = useCanIssueCredential();
  const gateBlocked = splitEnabled && !issueGate.allowed && !issueGate.loading;
  const gateBlockedMessage = (() => {
    if (!gateBlocked) return null;
    switch (issueGate.reason) {
      case 'org_unverified':    return ISSUE_CREDENTIAL_LABELS.GATE_NOT_VERIFIED;
      case 'org_suspended':     return ISSUE_CREDENTIAL_LABELS.GATE_SUSPENDED;
      case 'parent_unapproved': return ISSUE_CREDENTIAL_LABELS.GATE_PARENT_UNVERIFIED;
      case 'parent_unverified': return ISSUE_CREDENTIAL_LABELS.GATE_PARENT_UNVERIFIED;
      case 'parent_suspended':  return ISSUE_CREDENTIAL_LABELS.GATE_PARENT_SUSPENDED;
      default:                  return ISSUE_CREDENTIAL_LABELS.GATE_NOT_VERIFIED;
    }
  })();

  // Fetch template when credential type is selected (UF-05)
  const { template, loading: templateLoading } = useCredentialTemplate(
    credentialType || null,
    profile?.org_id || null,
  );

  const templateFields = useMemo(() => template?.fields ?? [], [template]);

  const handleFileSelect = useCallback((f: File, fp: string) => {
    setFile(f);
    setFingerprint(fp);
    setError(null);
  }, []);

  const handleCredentialTypeChange = useCallback((value: CredentialType) => {
    setCredentialType(value);
    // Reset metadata and extraction state when type changes
    setMetadataValues({});
    setMetadataErrors({});
    setExtractionFields([]);
    setExtractionProgress(undefined);
  }, []);

  const handleMetadataChange = useCallback((key: string, value: string) => {
    setMetadataValues((prev) => ({ ...prev, [key]: value }));
    // Clear error for this field
    setMetadataErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const handleRunExtraction = useCallback(async () => {
    if (!file || !fingerprint || !credentialType) return;
    setExtracting(true);
    setExtractionFields([]);

    const result = await runExtraction(
      file,
      fingerprint,
      credentialType,
      (progress) => setExtractionProgress(progress),
      { recipientNames: recipientEmail ? [recipientEmail] : undefined },
    );

    if (result) {
      setExtractionFields(result.fields);
      setOverallConfidence(result.overallConfidence);
      setCreditsRemaining(result.creditsRemaining);
    }
    setExtracting(false);
  }, [file, fingerprint, credentialType, recipientEmail]);

  const handleFieldAccept = useCallback((key: string, value: string) => {
    setExtractionFields((prev) =>
      prev.map((f) => (f.key === key ? { ...f, status: 'accepted' as const } : f))
    );
    handleMetadataChange(key, value);
  }, [handleMetadataChange]);

  const handleFieldReject = useCallback((key: string) => {
    setExtractionFields((prev) =>
      prev.map((f) => (f.key === key ? { ...f, status: 'rejected' as const } : f))
    );
  }, []);

  const handleFieldEdit = useCallback((key: string, value: string) => {
    setExtractionFields((prev) =>
      prev.map((f) => (f.key === key ? { ...f, value, status: 'edited' as const } : f))
    );
    handleMetadataChange(key, value);
  }, [handleMetadataChange]);

  const handleAcceptAll = useCallback((fields: ExtractionField[]) => {
    setExtractionFields((prev) =>
      prev.map((f) => {
        const match = fields.find((sf) => sf.key === f.key);
        return match ? { ...f, status: 'accepted' as const } : f;
      })
    );
    for (const field of fields) {
      handleMetadataChange(field.key, field.value);
    }
  }, [handleMetadataChange]);

  const resetForm = useCallback(() => {
    setStep('form');
    setFile(null);
    setFingerprint(null);
    setCredentialType('');
    setLabel('');
    setIssuedAt('');
    setExpiresAt('');
    setRecipientEmail('');
    setProofUrl('');
    setProofUrlError(null);
    setMetadataValues({});
    setMetadataErrors({});
    setCreating(false);
    setError(null);
    setCreatedAnchor(null);
    setLinkCopied(false);
    setExtractionFields([]);
    setExtractionProgress(undefined);
    setOverallConfidence(0);
    setCreditsRemaining(0);
    setExtracting(false);
  }, []);

  const handleClose = useCallback(() => {
    if (!creating) {
      resetForm();
      onOpenChange(false);
    }
  }, [creating, resetForm, onOpenChange]);

  const validateMetadata = useCallback((): boolean => {
    const errors: Record<string, string> = {};
    for (const field of templateFields) {
      if (field.required && !metadataValues[field.key]?.trim()) {
        errors[field.key] = `${field.label} is required`;
      }
    }
    // Validate email format if provided
    const emailTrimmed = recipientEmail.trim();
    if (emailTrimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrimmed)) {
      errors._recipient_email = 'Invalid email format';
    }
    setMetadataErrors(errors);
    // SCRUM-1755 — proof_url is optional but must be a valid https:// URL when present.
    setProofUrlError(null);
    const proofTrimmed = proofUrl.trim();
    let proofValid = true;
    if (proofTrimmed) {
      try {
        const parsed = new URL(proofTrimmed);
        if (parsed.protocol !== 'https:') {
          proofValid = false;
        }
      } catch {
        proofValid = false;
      }
      if (!proofValid) {
        setProofUrlError(ISSUE_CREDENTIAL_LABELS.HINT_PROOF_URL_INVALID);
      }
    }
    return Object.keys(errors).length === 0 && proofValid;
  }, [templateFields, metadataValues, recipientEmail, proofUrl]);

  const buildMetadata = useCallback((): Record<string, unknown> | null => {
    const entries: Record<string, unknown> = {};

    // Add issued_at if provided
    if (issuedAt) {
      entries.issued_at = `${issuedAt}T00:00:00Z`;
    }

    // Add template-driven metadata values
    for (const field of templateFields) {
      const value = metadataValues[field.key]?.trim();
      if (value) {
        if (field.type === 'number') {
          const num = Number(value);
          if (!Number.isNaN(num)) entries[field.key] = num;
        } else {
          entries[field.key] = value;
        }
      }
    }

    // Add recipient email if provided (for UF-03 future linking)
    if (recipientEmail.trim()) {
      entries._recipient_email = recipientEmail.trim();
    }

    // SCRUM-1755 — public proof URL (Udemy / Accredible / LinkedIn / own site).
    // Validation happens in validateMetadata; this stores the trimmed value.
    if (proofUrl.trim()) {
      entries.proof_url = proofUrl.trim();
    }

    return Object.keys(entries).length > 0 ? entries : null;
  }, [issuedAt, templateFields, metadataValues, recipientEmail, proofUrl]);

  const handleSubmit = useCallback(async () => {
    if (!file || !fingerprint || !user || !credentialType) return;

    // SCRUM-1755 — refuse submit when the org is not authorized to issue.
    // Worker-side enforcement still runs via RLS / suspension checks; this
    // is the UI guardrail so the user sees the reason instead of a 403.
    if (gateBlocked) {
      setError(gateBlockedMessage ?? ISSUE_CREDENTIAL_LABELS.GATE_BLOCKED_TITLE);
      return;
    }

    // Validate required metadata fields
    if (!validateMetadata()) return;

    setCreating(true);
    setError(null);

    try {
      const metadata = buildMetadata();

      const validated = validateAnchorCreate({
        fingerprint,
        filename: file.name,
        file_size: file.size,
        file_mime: file.type || null,
        org_id: profile?.org_id || null,
        credential_type: credentialType,
        label: label.trim() || null,
        metadata,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- validated spread includes credential types that narrow type rejects
      const { data: inserted, error: insertError } = await (supabase as any)
        .from('anchors')
        .insert({
          ...validated,
          user_id: user.id,
          ...(expiresAt ? { expires_at: `${expiresAt}T23:59:59Z` } : {}),
        })
        .select('id, public_id')
        .single();

      if (insertError) throw insertError;

      setCreatedAnchor({
        id: inserted.id,
        // public_id is auto-generated by trigger (migration 0037) — always non-null after insert
        publicId: inserted.public_id!,
      });

      // Insert recipient record if email provided (UF-03)
      const emailTrimmed = recipientEmail.trim();
      if (emailTrimmed) {
        const emailHash = await hashEmail(emailTrimmed);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- type narrowing mismatch on insert payload
        await (supabase as any).from('anchor_recipients')
          .insert({
            anchor_id: inserted.id,
            recipient_email_hash: emailHash,
          });
      }

      logAuditEvent({
        eventType: 'CREDENTIAL_ISSUED',
        eventCategory: 'ANCHOR',
        targetType: 'anchor',
        targetId: inserted.id,
        orgId: profile?.org_id,
        details: `Issued ${credentialType} credential for "${file.name}"`,
      });

      toast.success(TOAST.CREDENTIAL_ISSUED);
      setStep('success');
      onSuccess?.();
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        const zodErr = err as import('zod').ZodError;
        setError(zodErr.issues.map((i) => i.message).join('; '));
      } else {
        setError(
          err instanceof Error ? err.message : 'Failed to secure document'
        );
      }
      toast.error(TOAST.CREDENTIAL_ISSUE_FAILED);
    } finally {
      setCreating(false);
    }
  }, [
    file,
    fingerprint,
    user,
    profile,
    credentialType,
    label,
    expiresAt,
    recipientEmail,
    onSuccess,
    gateBlocked,
    gateBlockedMessage,
    validateMetadata,
    buildMetadata,
  ]);

  const handleCopyLink = useCallback(async () => {
    if (!createdAnchor) return;
    const url = verifyUrl(createdAnchor.publicId);
    await navigator.clipboard.writeText(url);
    setLinkCopied(true);
    toast.success(ANCHORING_STATUS_LABELS.LINK_COPIED);
    setTimeout(() => setLinkCopied(false), 2000);
  }, [createdAnchor]);

  const handleViewRecord = useCallback(() => {
    if (!createdAnchor) return;
    handleClose();
    navigate(recordDetailPath(createdAnchor.id));
  }, [createdAnchor, handleClose, navigate]);

  const handleIssueAnother = useCallback(() => {
    resetForm();
  }, [resetForm]);

  const canSubmit = !!file && !!fingerprint && !!credentialType && !creating && !templateLoading;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Award className="h-5 w-5 text-primary" />
            {ISSUE_CREDENTIAL_LABELS.TITLE}
          </DialogTitle>
          <DialogDescription>
            {step === 'form'
              ? ISSUE_CREDENTIAL_LABELS.DESCRIPTION
              : ANCHORING_STATUS_LABELS.SUCCESS_SUBTITLE}
          </DialogDescription>
        </DialogHeader>

        {step === 'form' && (
          <>
            <div className="space-y-4 py-2">
              {/* SCRUM-1755 — gate-blocked banner: shown when ENABLE_ISSUE_CREDENTIAL_SPLIT
                  is on AND the org is not authorized to issue (unverified, suspended, or
                  sub-org without parent approval). */}
              {gateBlocked && gateBlockedMessage && (
                <Alert variant="destructive" role="alert" data-testid="issue-credential-gate-blocked">
                  <AlertDescription className="space-y-1">
                    <p className="font-medium">{ISSUE_CREDENTIAL_LABELS.GATE_BLOCKED_TITLE}</p>
                    <p className="text-sm">{gateBlockedMessage}</p>
                  </AlertDescription>
                </Alert>
              )}

              {/* File upload */}
              <FileUpload onFileSelect={handleFileSelect} disabled={creating || gateBlocked} />

              {/* File preview (UF-05) */}
              {file && fingerprint && (
                <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {METADATA_FIELD_LABELS.FILE_PREVIEW_TITLE}
                  </p>
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-sm truncate">{file.name}</span>
                    <span className="text-xs text-muted-foreground ml-auto shrink-0">
                      {formatFileSize(file.size)}
                    </span>
                  </div>
                  <div className="font-mono text-xs text-muted-foreground truncate">
                    {fingerprint.slice(0, 16)}...
                  </div>
                </div>
              )}

              {/* AI extraction button (gated by feature flag) */}
              {aiEnabled && file && fingerprint && credentialType && !extracting && extractionFields.length === 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleRunExtraction}
                  className="w-full gap-2"
                  disabled={creating}
                >
                  <Sparkles className="h-4 w-4" />
                  {AI_EXTRACTION_LABELS.EXTRACT_BUTTON}
                </Button>
              )}

              {/* AI extraction progress + suggestions */}
              {(extracting || extractionFields.length > 0) && (
                <AIFieldSuggestions
                  fields={extractionFields}
                  overallConfidence={overallConfidence}
                  creditsRemaining={creditsRemaining}
                  progress={extractionProgress}
                  onFieldAccept={handleFieldAccept}
                  onFieldReject={handleFieldReject}
                  onFieldEdit={handleFieldEdit}
                  onAcceptAll={handleAcceptAll}
                />
              )}

              {/* Credential type */}
              <div className="space-y-2">
                <Label htmlFor="credential-type">
                  {FORM_LABELS.CREDENTIAL_TYPE}
                </Label>
                <Select
                  value={credentialType}
                  onValueChange={(v) => handleCredentialTypeChange(v as CredentialType)}
                  disabled={creating}
                >
                  <SelectTrigger id="credential-type">
                    <SelectValue
                      placeholder={FORM_LABELS.CREDENTIAL_TYPE_PLACEHOLDER}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {CREDENTIAL_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {CREDENTIAL_TYPE_LABELS[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Dynamic metadata fields from template (UF-05) */}
              {credentialType && templateLoading && (
                <div className="text-sm text-muted-foreground py-2">
                  {METADATA_FIELD_LABELS.LOADING_TEMPLATE}
                </div>
              )}
              {credentialType && !templateLoading && templateFields.length > 0 && (
                <>
                  <Separator />
                  <MetadataFieldRenderer
                    fields={templateFields}
                    values={metadataValues}
                    onChange={handleMetadataChange}
                    disabled={creating}
                    errors={metadataErrors}
                  />
                </>
              )}

              {/* Label */}
              <div className="space-y-2">
                <Label htmlFor="credential-label">{FORM_LABELS.LABEL}</Label>
                <Input
                  id="credential-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={FORM_LABELS.LABEL_PLACEHOLDER}
                  disabled={creating}
                  maxLength={500}
                />
              </div>

              {/* Issued date (optional) */}
              <div className="space-y-2">
                <Label htmlFor="issued-at">{FORM_LABELS.ISSUED_AT}</Label>
                <Input
                  id="issued-at"
                  type="date"
                  value={issuedAt}
                  onChange={(e) => setIssuedAt(e.target.value)}
                  disabled={creating}
                />
              </div>

              {/* Expiration date (optional) */}
              <div className="space-y-2">
                <Label htmlFor="expires-at">{FORM_LABELS.EXPIRES_AT}
                  <span className="text-muted-foreground text-xs ml-1">(optional)</span>
                </Label>
                <Input
                  id="expires-at"
                  type="date"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  disabled={creating}
                />
                {expiresAt && new Date(expiresAt) < new Date(new Date().toISOString().split('T')[0]) && (
                  <p className="text-xs text-warning-foreground bg-warning/10 rounded px-2 py-1">
                    This expiration date is in the past. The credential will be immediately expired.
                  </p>
                )}
              </div>

              {/* Recipient email (UF-05 → feeds into UF-03) */}
              <div className="space-y-2">
                <Label htmlFor="recipient-email">
                  {METADATA_FIELD_LABELS.RECIPIENT_EMAIL}
                  <span className="text-muted-foreground text-xs ml-1">
                    {METADATA_FIELD_LABELS.OPTIONAL}
                  </span>
                </Label>
                <Input
                  id="recipient-email"
                  type="email"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  placeholder={METADATA_FIELD_LABELS.RECIPIENT_EMAIL_PLACEHOLDER}
                  disabled={creating}
                />
                <p className="text-xs text-muted-foreground">
                  {METADATA_FIELD_LABELS.RECIPIENT_EMAIL_DESCRIPTION}
                </p>
              </div>

              {/* SCRUM-1755 — Public Proof URL (Udemy / Accredible / LinkedIn / own site).
                  Optional but strongly recommended. Persisted into anchors.metadata.proof_url. */}
              <div className="space-y-2">
                <Label htmlFor="proof-url">
                  {ISSUE_CREDENTIAL_LABELS.PROOF_URL_LABEL}
                  <span className="text-muted-foreground text-xs ml-1">
                    {METADATA_FIELD_LABELS.OPTIONAL}
                  </span>
                </Label>
                <Input
                  id="proof-url"
                  type="url"
                  inputMode="url"
                  value={proofUrl}
                  onChange={(e) => {
                    setProofUrl(e.target.value);
                    if (proofUrlError) setProofUrlError(null);
                  }}
                  placeholder={ISSUE_CREDENTIAL_LABELS.PROOF_URL_PLACEHOLDER}
                  disabled={creating}
                  aria-invalid={!!proofUrlError}
                  aria-describedby="proof-url-help"
                />
                <p id="proof-url-help" className="text-xs text-muted-foreground">
                  {ISSUE_CREDENTIAL_LABELS.PROOF_URL_HELP}
                </p>
                {proofUrlError && (
                  <p className="text-xs text-destructive" role="alert">{proofUrlError}</p>
                )}
              </div>

              {/* Status notice */}
              {file && fingerprint && (
                <Alert>
                  <ArkovaIcon className="h-4 w-4" />
                  <AlertDescription>
                    {ISSUE_CREDENTIAL_LABELS.PENDING_NOTICE}
                  </AlertDescription>
                </Alert>
              )}

              {/* Error display */}
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>

            {/* BUG-UAT-09: Validation hints when form is incomplete */}
            {!canSubmit && !creating && (file || credentialType) && (
              <p className="text-xs text-muted-foreground px-1">
                {!file ? ISSUE_CREDENTIAL_LABELS.HINT_UPLOAD_DOCUMENT :
                 !credentialType ? ISSUE_CREDENTIAL_LABELS.HINT_SELECT_TYPE :
                 ''}
              </p>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={handleClose} disabled={creating}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  if (!canSubmit && !creating) {
                    if (!file) {
                      toast.error(ISSUE_CREDENTIAL_LABELS.HINT_UPLOAD_DOCUMENT);
                    } else if (!credentialType) {
                      toast.error(ISSUE_CREDENTIAL_LABELS.HINT_SELECT_TYPE);
                    }
                    return;
                  }
                  void handleSubmit();
                }}
                disabled={creating}
                aria-disabled={!canSubmit}
              >
                {creating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {ISSUE_CREDENTIAL_LABELS.ISSUING_LOADING}
                  </>
                ) : (
                  <>
                    <Award className="mr-2 h-4 w-4" />
                    {ISSUE_CREDENTIAL_LABELS.ISSUE_BUTTON}
                  </>
                )}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'success' && (
          <>
            <div className="space-y-4 py-4">
              <div className="flex flex-col items-center text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10 mb-3">
                  <CheckCircle className="h-8 w-8 text-green-500" />
                </div>
                <h4 className="text-lg font-semibold">
                  {ANCHORING_STATUS_LABELS.SUCCESS_TITLE}
                </h4>
                <p className="text-sm text-muted-foreground mt-1">
                  {ANCHORING_STATUS_LABELS.SUCCESS_PROCESSING}
                </p>
              </div>

              {/* Verification link */}
              {createdAnchor && (
                <div className="rounded-lg border bg-muted/50 p-3 space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {ISSUE_CREDENTIAL_LABELS.VERIFICATION_LINK}
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono truncate">
                      {verifyUrl(createdAnchor.publicId)}
                    </code>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 shrink-0"
                      onClick={handleCopyLink}
                      aria-label={ISSUE_CREDENTIAL_LABELS.COPY_LINK_ARIA}
                    >
                      {linkCopied ? (
                        <Check className="h-3.5 w-3.5 text-green-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {ANCHORING_STATUS_LABELS.SHARE_LINK_NOTE}
                  </p>
                </div>
              )}
            </div>

            <DialogFooter>
              <div className="flex w-full gap-2">
                <Button
                  variant="outline"
                  onClick={handleCopyLink}
                  className="flex-1"
                >
                  {linkCopied ? (
                    <Check className="mr-2 h-4 w-4" />
                  ) : (
                    <Copy className="mr-2 h-4 w-4" />
                  )}
                  {ANCHORING_STATUS_LABELS.COPY_LINK}
                </Button>
                {createdAnchor && (
                  <Button
                    variant="outline"
                    onClick={handleViewRecord}
                    className="flex-1"
                  >
                    <ExternalLink className="mr-2 h-4 w-4" />
                    {ANCHORING_STATUS_LABELS.VIEW_RECORD}
                  </Button>
                )}
                <Button onClick={handleIssueAnother}>
                  <Plus className="mr-2 h-4 w-4" />
                  {ANCHORING_STATUS_LABELS.ISSUE_ANOTHER}
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
