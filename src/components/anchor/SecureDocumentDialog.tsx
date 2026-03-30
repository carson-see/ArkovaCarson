/**
 * Secure Document Dialog
 *
 * Modal for securing a new document with step-by-step flow.
 * Uses real Supabase insert (following IssueCredentialForm pattern).
 *
 * Enhanced with AI extraction (P8-S5): upload → AI extraction → template → confirm → anchor.
 * Enhanced success screen (UF-04): shows verification URL, copy link,
 * and "anchoring in progress" messaging.
 *
 * @see CRIT-1, UF-04, P8-S5
 */

import { useState, useCallback, useEffect } from 'react';
import type { Json } from '@/types/database.types';
import { useAuditorMode } from '@/hooks/useAuditorMode';
import {
  Shield,
  CheckCircle,
  AlertCircle,
  Loader2,
  Copy,
  Check,
  ExternalLink,
  Sparkles,
  SkipForward,
  RefreshCw,
  PenLine,
  Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FileUpload, type AttestationUpload } from './FileUpload';
import { BulkUploadWizard } from '@/components/upload';
import { WORKER_URL } from '@/lib/workerClient';
import { TemplateSelector } from './TemplateSelector';
import type { TemplateOption } from './TemplateSelector';
import { AIFieldSuggestions } from './AIFieldSuggestions';
import { supabase } from '@/lib/supabase';
import { validateAnchorCreate } from '@/lib/validators';
import { logAuditEvent } from '@/lib/auditLog';
import { runExtraction, fetchTemplateReconstruction, type ExtractionField, type ExtractionProgress, type TemplateReconstructionResult } from '@/lib/aiExtraction';
import { applyTemplate } from '@/lib/templateMapper';
import { isAIExtractionEnabled } from '@/lib/switchboard';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { toast } from 'sonner';
import { TOAST, ANCHORING_STATUS_LABELS, SECURE_DIALOG_LABELS, DESCRIPTION_LABELS, AI_EXTRACTION_LABELS, EXTRACTION_RECOVERY_LABELS, CONFIRMATION_PROGRESS_LABELS } from '@/lib/copy';
import { verifyUrl, recordDetailPath } from '@/lib/routes';
import { useNavigate } from 'react-router-dom';

interface SecureDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type Step = 'upload' | 'extracting' | 'extraction-failed' | 'template' | 'confirm' | 'processing' | 'success' | 'error' | 'bulk' | 'attestation-review' | 'attestation-submitting';

interface FileData {
  file: File;
  fingerprint: string;
}

interface CreatedAnchor {
  id: string;
  publicId: string;
}

export function SecureDocumentDialog({
  open,
  onOpenChange,
  onSuccess,
}: Readonly<SecureDocumentDialogProps>) {
  const { user } = useAuth();
  const { profile } = useProfile();

  // VAI-04: Auditor mode — suppress dialog entirely
  const { isAuditorMode } = useAuditorMode();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('upload');
  const [fileData, setFileData] = useState<FileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateOption | null>(null);
  const [createdAnchor, setCreatedAnchor] = useState<CreatedAnchor | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [description, setDescription] = useState('');

  // AI extraction state
  const [aiEnabled, setAiEnabled] = useState(false);
  const [extractionProgress, setExtractionProgress] = useState<ExtractionProgress | null>(null);
  const [extractedFields, setExtractedFields] = useState<ExtractionField[]>([]);
  const [overallConfidence, setOverallConfidence] = useState(0);
  const [creditsRemaining, setCreditsRemaining] = useState(0);

  // Template reconstruction state (populated async after extraction)
  const [templateResult, setTemplateResult] = useState<TemplateReconstructionResult | null>(null);

  // Check AI extraction flag on mount
  useEffect(() => {
    if (open) {
      isAIExtractionEnabled().then(setAiEnabled).catch(() => setAiEnabled(false));
    }
  }, [open]);

  const handleFileSelect = useCallback((file: File, fingerprint: string) => {
    setFileData({ file, fingerprint });
  }, []);

  const handleBulkDetected = useCallback((_files: File[]) => {
    setStep('bulk');
  }, []);

  // Attestation upload state
  const [attestationData, setAttestationData] = useState<AttestationUpload | null>(null);

  const handleAttestationDetected = useCallback((data: AttestationUpload) => {
    setAttestationData(data);
    setStep('attestation-review');
  }, []);

  const handleAttestationSubmit = useCallback(async () => {
    if (!attestationData || !user) return;
    setStep('attestation-submitting');
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setError('Authentication required'); setStep('error'); return; }

      const workerUrl = WORKER_URL;
      const response = await fetch(`${workerUrl}/api/v1/attestations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          attestation_type: attestationData.attestation_type,
          attester_name: attestationData.attester_name,
          attester_type: attestationData.attester_type,
          attester_title: attestationData.attester_title || undefined,
          subject_type: attestationData.subject_type,
          subject_identifier: attestationData.subject_identifier,
          claims: attestationData.claims.filter(c => c.claim.trim()),
          summary: attestationData.summary || undefined,
          jurisdiction: attestationData.jurisdiction || undefined,
          expires_at: attestationData.expires_at || undefined,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Failed to create attestation' }));
        setError(err.error || 'Failed to create attestation');
        setStep('error');
        return;
      }

      const result = await response.json();
      setCreatedAnchor({ id: result.attestation_id, publicId: result.public_id });
      toast.success('Attestation created successfully');
      setStep('success');
      onSuccess?.();
    } catch {
      setError('Network error — please try again');
      setStep('error');
    }
  }, [attestationData, user, onSuccess]);

  // Auto-select template based on AI-detected credential type
  const autoSelectTemplate = useCallback(async (detectedType: string) => {
    const normalized = detectedType.toUpperCase().trim();

    // Fuzzy mapping: AI output → credential_type enum
    const typeMap: Record<string, string> = {
      'DEGREE': 'DEGREE', 'DIPLOMA': 'DEGREE', 'BACHELOR': 'DEGREE', 'MASTER': 'DEGREE', 'PHD': 'DEGREE', 'DOCTORATE': 'DEGREE',
      'LICENSE': 'LICENSE', 'MEDICAL_LICENSE': 'LICENSE', 'NURSING_LICENSE': 'LICENSE', 'PE_LICENSE': 'LICENSE',
      'CERTIFICATE': 'CERTIFICATE', 'CERTIFICATION': 'CERTIFICATE', 'PMP': 'CERTIFICATE',
      'INSURANCE': 'INSURANCE', 'INSURANCE_CERTIFICATE': 'INSURANCE', 'BOND': 'INSURANCE',
      'TRANSCRIPT': 'TRANSCRIPT', 'GRADE_REPORT': 'TRANSCRIPT',
      'PROFESSIONAL': 'PROFESSIONAL', 'PROFESSIONAL_CREDENTIAL': 'PROFESSIONAL',
      'CLE': 'CLE', 'CLE_CREDIT': 'CLE', 'CLE_ETHICS': 'CLE', 'CONTINUING_EDUCATION': 'CLE',
      'ATTESTATION': 'ATTESTATION', 'EMPLOYMENT_VERIFICATION': 'ATTESTATION', 'VERIFICATION_LETTER': 'ATTESTATION', 'LETTER_OF_RECOMMENDATION': 'ATTESTATION',
      'BADGE': 'BADGE', 'DIGITAL_BADGE': 'BADGE', 'MICRO_CREDENTIAL': 'BADGE',
      'FINANCIAL': 'FINANCIAL', 'FINANCIAL_STATEMENT': 'FINANCIAL', 'AUDIT_REPORT': 'FINANCIAL', 'TAX_DOCUMENT': 'FINANCIAL',
      'LEGAL': 'LEGAL', 'CONTRACT': 'LEGAL', 'NDA': 'LEGAL', 'AGREEMENT': 'LEGAL', 'COURT_ORDER': 'LEGAL',
      'SEC_FILING': 'SEC_FILING', '10_K': 'SEC_FILING', '8_K': 'SEC_FILING',
      'PATENT': 'PATENT', 'INTELLECTUAL_PROPERTY': 'PATENT',
      'REGULATION': 'REGULATION', 'FEDERAL_REGISTER': 'REGULATION',
      'PUBLICATION': 'PUBLICATION', 'RESEARCH_PAPER': 'PUBLICATION', 'ACADEMIC_PUBLICATION': 'PUBLICATION',
      'CHARITY': 'CHARITY', 'NONPROFIT': 'CHARITY', 'NGO': 'CHARITY',
      'FINANCIAL_ADVISOR': 'FINANCIAL_ADVISOR', 'ADVISOR': 'FINANCIAL_ADVISOR',
      'BUSINESS_ENTITY': 'BUSINESS_ENTITY', 'BUSINESS_REGISTRATION': 'BUSINESS_ENTITY', 'ABN': 'BUSINESS_ENTITY',
      'OTHER': 'OTHER', 'GENERAL': 'OTHER', 'GENERAL_DOCUMENT': 'OTHER',
    };
    const matchedType = typeMap[normalized] ?? (
      // Partial match fallback
      Object.entries(typeMap).find(([k]) => normalized.includes(k))?.[1] ?? 'OTHER'
    );

    // Fetch system templates to find a match
    const { data: templates } = await supabase
      .from('credential_templates')
      .select('id, name, description, credential_type, is_system, org_id')
      .eq('is_system', true)
      // CLE added in migration 0088 — cast until types regenerated
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .eq('credential_type', matchedType as any)
      .limit(1);

    if (templates && templates.length > 0) {
      const match = templates[0] as unknown as TemplateOption;
      setSelectedTemplate(match);
      return match;
    }
    return null;
  }, []);
  // Run AI extraction after file upload
  const handleStartExtraction = useCallback(async () => {
    if (!fileData) return;

    setStep('extracting');
    setExtractedFields([]);
    setExtractionProgress({ stage: 'ocr', progress: 0, message: 'Starting AI analysis...' });

    const result = await runExtraction(
      fileData.file,
      fileData.fingerprint,
      selectedTemplate?.credential_type ?? 'OTHER',
      (progress) => setExtractionProgress(progress),
    );

    if (result) {
      setOverallConfidence(result.overallConfidence);
      setCreditsRemaining(result.creditsRemaining);
      setExtractionProgress({ stage: 'complete', progress: 100, message: 'Extraction complete' });

      // Auto-detect document type and auto-select template
      const typeField = result.fields.find(f => f.key === 'credentialType');
      const detectedType = (typeField && typeField.confidence >= 0.5) ? typeField.value : 'OTHER';
      await autoSelectTemplate(detectedType);

      // Fire off template reconstruction in parallel (non-blocking)
      const fieldsObj = result.fields.reduce<Record<string, unknown>>((acc, f) => {
        acc[f.key] = f.value;
        return acc;
      }, {});
      fetchTemplateReconstruction(fieldsObj, result.overallConfidence)
        .then(tr => { if (tr) setTemplateResult(tr); })
        .catch(() => { /* template reconstruction is best-effort */ });

      // Apply template field schema: reorder, label, validate
      const tmplResult = await applyTemplate(
        result.fields,
        detectedType,
        profile?.org_id,
      );

      // Merge mapped + unmapped fields (template-ordered first, extras after)
      const orderedFields = [...tmplResult.mappedFields, ...tmplResult.unmappedFields];

      // Auto-accept all high-confidence fields
      const autoAccepted = orderedFields.map(f =>
        f.confidence >= 0.5 ? { ...f, status: 'accepted' as const } : f
      );
      setExtractedFields(autoAccepted);

      // One-click flow: skip confirm, go straight to anchoring
      // Pass fields directly to avoid stale closure (React state not yet updated)
      handleConfirm(autoAccepted);
      return;
    } else {
      // Extraction failed — show recovery screen with retry/manual/skip options
      toast.warning(AI_EXTRACTION_LABELS.EXTRACTION_FAILED_TOAST);
      setExtractionProgress(null);
      setStep('extraction-failed');
      return;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- handleConfirm defined after this callback; circular dep is intentional
  }, [fileData, selectedTemplate, autoSelectTemplate]);

  // Handle proceeding from upload step — always run AI extraction
  const handleUploadContinue = useCallback(async () => {
    if (!fileData) return;

    if (aiEnabled) {
      await handleStartExtraction();
    } else {
      // No AI — auto-select General Document and anchor immediately
      await autoSelectTemplate('OTHER');
      handleConfirm([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- handleConfirm/autoSelectTemplate defined after; circular dep is intentional
  }, [fileData, aiEnabled, handleStartExtraction]);

  // AI field callbacks
  const handleFieldAccept = useCallback((key: string, value: string) => {
    setExtractedFields(prev =>
      prev.map(f => f.key === key ? { ...f, value, status: 'accepted' as const } : f)
    );
  }, []);

  const handleFieldReject = useCallback((key: string) => {
    setExtractedFields(prev =>
      prev.map(f => f.key === key ? { ...f, status: 'rejected' as const } : f)
    );
  }, []);

  const handleFieldEdit = useCallback((key: string, value: string) => {
    setExtractedFields(prev =>
      prev.map(f => f.key === key ? { ...f, value, status: 'edited' as const } : f)
    );
  }, []);

  const handleAcceptAll = useCallback((fields: ExtractionField[]) => {
    setExtractedFields(prev =>
      prev.map(f => {
        const matched = fields.find(sf => sf.key === f.key);
        return matched ? { ...f, status: 'accepted' as const } : f;
      })
    );
  }, []);

  const handleConfirm = useCallback(async (fieldsOverride?: ExtractionField[]) => {
    if (!fileData || !user) return;

    setStep('processing');
    setError(null);

    try {
      // Build metadata from AI-extracted fields (all non-rejected fields)
      // Use fieldsOverride when called directly from extraction (avoids stale state)
      const fieldsToUse = fieldsOverride ?? extractedFields;
      const acceptedFields = fieldsToUse
        .filter(f => f.status !== 'rejected')
        .reduce<Record<string, string>>((acc, f) => {
          acc[f.key] = f.value;
          return acc;
        }, {});

      const validated = validateAnchorCreate({
        fingerprint: fileData.fingerprint,
        filename: fileData.file.name,
        file_size: fileData.file.size,
        file_mime: fileData.file.type || null,
        org_id: profile?.org_id || null,
        ...(selectedTemplate ? { credential_type: selectedTemplate.credential_type } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });

      // Merge AI tags from template reconstruction into metadata
      const metadata: Record<string, Json | undefined> = { ...acceptedFields } as Record<string, Json | undefined>;
      if (templateResult?.tags && templateResult.tags.length > 0) {
        metadata.ai_tags = templateResult.tags;
      }
      if (templateResult?.summary) {
        metadata.ai_summary = templateResult.summary;
      }
      if (templateResult?.documentType) {
        metadata.ai_document_type = templateResult.documentType;
      }

      const { data: inserted, error: insertError } = await supabase
        .from('anchors')
        .insert({
          ...validated,
          user_id: user.id,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        })
        .select('id, public_id')
        .single();

      if (insertError) throw insertError;

      setCreatedAnchor({
        id: inserted.id,
        // public_id is auto-generated by trigger (migration 0037) — always non-null after insert
        publicId: inserted.public_id!,
      });

      logAuditEvent({
        eventType: 'ANCHOR_CREATED',
        eventCategory: 'ANCHOR',
        targetType: 'anchor',
        targetId: inserted.id,
        orgId: profile?.org_id,
        details: `Secured document "${fileData.file.name}"`,
      });

      toast.success(TOAST.ANCHOR_SUBMITTED);
      setStep('success');
      onSuccess?.();
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        const zodErr = err as import('zod').ZodError;
        setError(zodErr.issues.map((i) => i.message).join('; '));
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        // Detect duplicate fingerprint constraint violation
        if (msg.includes('idx_anchors_user_fingerprint_unique') || msg.includes('duplicate key')) {
          setError('This document has already been secured. Each document can only be anchored once.');
        } else {
          setError(msg || 'Failed to secure document. Please try again.');
        }
      }
      toast.error(TOAST.ANCHOR_FAILED);
      setStep('error');
    }
  }, [fileData, user, profile, selectedTemplate, description, extractedFields, templateResult, onSuccess]);

  const handleClose = useCallback(() => {
    setStep('upload');
    setFileData(null);
    setSelectedTemplate(null);
    setDescription('');
    setError(null);
    setCreatedAnchor(null);
    setLinkCopied(false);
    setExtractedFields([]);
    setExtractionProgress(null);
    setTemplateResult(null);
    setAttestationData(null);
    onOpenChange(false);
  }, [onOpenChange]);

  const handleRetry = useCallback(() => {
    setStep('upload');
    setFileData(null);
    setSelectedTemplate(null);
    setDescription('');
    setError(null);
    setCreatedAnchor(null);
    setExtractedFields([]);
    setExtractionProgress(null);
    setTemplateResult(null);
  }, []);

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

  // VAI-04: In auditor mode, don't render the dialog
  if (isAuditorMode) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className={step === 'bulk' ? 'max-w-3xl max-h-[90vh] overflow-y-auto' : 'sm:max-w-lg max-h-[90vh] overflow-y-auto'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            {step === 'bulk' ? 'Bulk Upload' : SECURE_DIALOG_LABELS.TITLE}
          </DialogTitle>
          <DialogDescription>
            {step === 'bulk'
              ? 'Upload a CSV or XLSX file to secure multiple documents at once'
              : SECURE_DIALOG_LABELS.DESCRIPTION}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {step === 'upload' && (
            <FileUpload
              onFileSelect={handleFileSelect}
              onBulkDetected={handleBulkDetected}
              onAttestationDetected={handleAttestationDetected}
              disabled={false}
            />
          )}

          {step === 'attestation-review' && attestationData && (
            <div className="space-y-4">
              <div className="rounded-lg border border-[#00d4ff]/20 bg-[#00d4ff]/5 px-4 py-3">
                <p className="text-sm font-medium flex items-center gap-2">
                  <Shield className="h-4 w-4 text-[#00d4ff]" />
                  Attestation detected
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  This file contains an attestation that will be anchored to the network.
                </p>
              </div>
              <div className="rounded-lg border p-4 space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Type</span>
                  <span className="font-medium">{attestationData.attestation_type.replace(/_/g, ' ')}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Subject</span>
                  <span className="font-medium truncate max-w-[250px]">{attestationData.subject_identifier}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Attester</span>
                  <span className="font-medium">{attestationData.attester_name}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Claims</span>
                  <span className="font-medium">{attestationData.claims.length}</span>
                </div>
                {attestationData.jurisdiction && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Jurisdiction</span>
                    <span className="font-medium">{attestationData.jurisdiction}</span>
                  </div>
                )}
                {attestationData.summary && (
                  <div className="border-t pt-2 mt-2">
                    <p className="text-xs text-muted-foreground">{attestationData.summary}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 'attestation-submitting' && (
            <div className="flex flex-col items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
              <p className="text-sm text-muted-foreground">Creating attestation and anchoring to network...</p>
            </div>
          )}

          {step === 'bulk' && (
            <BulkUploadWizard
              onComplete={() => {
                handleClose();
                onSuccess?.();
              }}
              onCancel={() => {
                setStep('upload');
              }}
            />
          )}

          {step === 'extracting' && (
            <div className="space-y-4">
              {extractionProgress && extractionProgress.stage !== 'complete' && (
                <AIFieldSuggestions
                  fields={[]}
                  overallConfidence={0}
                  creditsRemaining={0}
                  progress={extractionProgress}
                  onFieldAccept={handleFieldAccept}
                  onFieldReject={handleFieldReject}
                  onFieldEdit={handleFieldEdit}
                  onAcceptAll={handleAcceptAll}
                />
              )}

              {extractionProgress?.stage === 'complete' && extractedFields.length > 0 && (
                <>
                  {/* Show auto-detected document type */}
                  {selectedTemplate && (
                    <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
                      <Sparkles className="h-4 w-4 text-primary shrink-0" />
                      <span>
                        Auto-detected as <strong>{selectedTemplate.name}</strong>
                      </span>
                    </div>
                  )}
                  <AIFieldSuggestions
                    fields={extractedFields}
                    overallConfidence={overallConfidence}
                    creditsRemaining={creditsRemaining}
                    onFieldAccept={handleFieldAccept}
                    onFieldReject={handleFieldReject}
                    onFieldEdit={handleFieldEdit}
                    onAcceptAll={handleAcceptAll}
                  />
                </>
              )}
            </div>
          )}

          {step === 'extraction-failed' && (
            <div className="space-y-4 py-2">
              <Alert className="border-amber-500/30 bg-amber-500/10">
                <AlertCircle className="h-4 w-4 text-amber-600" />
                <AlertDescription className="text-sm">
                  <p className="font-medium mb-1">{EXTRACTION_RECOVERY_LABELS.TITLE}</p>
                  <p className="text-muted-foreground">{EXTRACTION_RECOVERY_LABELS.DESCRIPTION}</p>
                </AlertDescription>
              </Alert>
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => handleStartExtraction()}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {EXTRACTION_RECOVERY_LABELS.RETRY}
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={async () => {
                    await autoSelectTemplate('OTHER');
                    setStep('template');
                  }}
                >
                  <PenLine className="mr-2 h-4 w-4" />
                  {EXTRACTION_RECOVERY_LABELS.ENTER_MANUALLY}
                </Button>
                <Button
                  variant="ghost"
                  className="w-full justify-start text-muted-foreground"
                  onClick={async () => {
                    await autoSelectTemplate('OTHER');
                    handleConfirm([]);
                  }}
                >
                  <SkipForward className="mr-2 h-4 w-4" />
                  {EXTRACTION_RECOVERY_LABELS.SKIP}
                </Button>
              </div>
            </div>
          )}

          {step === 'template' && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Choose a template for this credential
              </p>
              <div className="max-h-[50vh] overflow-y-auto -mx-1 px-1">
                <TemplateSelector
                  orgId={profile?.org_id}
                  onSelect={setSelectedTemplate}
                  selectedId={selectedTemplate?.id}
                />
              </div>
            </div>
          )}

          {step === 'confirm' && fileData && (
            <div className="space-y-4">
              <div className="rounded-lg border p-4">
                <h4 className="text-sm font-medium mb-2">{SECURE_DIALOG_LABELS.READY_TO_SECURE}</h4>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">{SECURE_DIALOG_LABELS.DOCUMENT_LABEL}</dt>
                    <dd className="font-medium truncate max-w-[200px]">
                      {fileData.file.name}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">{SECURE_DIALOG_LABELS.SIZE_LABEL}</dt>
                    <dd className="font-medium">
                      {(fileData.file.size / 1024).toFixed(1)} KB
                    </dd>
                  </div>
                  {selectedTemplate && (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Template</dt>
                      <dd className="font-medium">{selectedTemplate.name}</dd>
                    </div>
                  )}
                  {extractedFields.some(f => f.status === 'accepted' || f.status === 'edited') && (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">{SECURE_DIALOG_LABELS.AI_FIELDS}</dt>
                      <dd className="font-medium text-primary">
                        {extractedFields.filter(f => f.status === 'accepted' || f.status === 'edited').length} accepted
                      </dd>
                    </div>
                  )}
                </dl>
              </div>

              {/* Description field (BETA-12) */}
              <div className="space-y-2">
                <label htmlFor="anchor-description" className="text-sm font-medium">
                  {DESCRIPTION_LABELS.FIELD_LABEL}
                </label>
                <textarea
                  id="anchor-description"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  placeholder={DESCRIPTION_LABELS.FIELD_PLACEHOLDER}
                  maxLength={500}
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {DESCRIPTION_LABELS.FIELD_HELP}
                </p>
              </div>
              <Alert>
                <Shield className="h-4 w-4" />
                <AlertDescription>
                  {SECURE_DIALOG_LABELS.SECURITY_NOTICE}
                </AlertDescription>
              </Alert>
            </div>
          )}

          {step === 'processing' && (
            <div className="space-y-4 text-center py-4">
              <div className="flex justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">{SECURE_DIALOG_LABELS.SECURING_LOADING}</p>
              </div>
            </div>
          )}

          {step === 'success' && (
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

              {/* AI-generated tags */}
              {templateResult?.tags && templateResult.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 justify-center">
                  {templateResult.tags.map(tag => (
                    <span
                      key={tag}
                      className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {/* AI summary */}
              {templateResult?.summary && (
                <p className="text-xs text-muted-foreground text-center px-4">
                  {templateResult.summary}
                </p>
              )}

              {/* Confirmation progress notice */}
              <div className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                <Clock className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                <div className="space-y-1">
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    {CONFIRMATION_PROGRESS_LABELS.IN_PROGRESS}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {CONFIRMATION_PROGRESS_LABELS.NOTIFICATION_NOTE}
                  </p>
                </div>
              </div>

              {/* Verification link */}
              {createdAnchor && (
                <div className="rounded-lg border bg-muted/50 p-3 space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {SECURE_DIALOG_LABELS.VERIFICATION_LINK}
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
                      aria-label={SECURE_DIALOG_LABELS.COPY_LINK_ARIA}
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
          )}

          {step === 'error' && (
            <div className="space-y-4 text-center py-4">
              <div className="flex justify-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
                  <AlertCircle className="h-8 w-8 text-destructive" />
                </div>
              </div>
              <div className="space-y-1">
                <h4 className="text-lg font-semibold">{SECURE_DIALOG_LABELS.SECURING_FAILED}</h4>
                <p className="text-sm text-muted-foreground">
                  {error || 'An unexpected error occurred. Please try again.'}
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {step === 'upload' && (
            <>
              <Button variant="outline" onClick={handleClose}>
                {SECURE_DIALOG_LABELS.CANCEL}
              </Button>
              <Button
                onClick={handleUploadContinue}
                disabled={!fileData}
              >
                {aiEnabled && fileData?.file.type === 'application/pdf' && (
                  <Sparkles className="mr-2 h-4 w-4" />
                )}
                {SECURE_DIALOG_LABELS.CONTINUE}
              </Button>
            </>
          )}

          {step === 'extracting' && (
            <>
              {extractionProgress?.stage === 'complete' ? (
                <>
                  <Button variant="outline" onClick={() => setStep('upload')}>
                    {SECURE_DIALOG_LABELS.BACK}
                  </Button>
                  {/* Skip template selection if AI auto-detected a type */}
                  <Button onClick={() => setStep(selectedTemplate ? 'confirm' : 'template')}>
                    {SECURE_DIALOG_LABELS.CONTINUE}
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => {
                    setExtractionProgress(null);
                    setStep('template');
                  }}
                >
                  <SkipForward className="mr-2 h-4 w-4" />
                  {SECURE_DIALOG_LABELS.SKIP_AI_ANALYSIS}
                </Button>
              )}
            </>
          )}

          {step === 'template' && (
            <>
              <Button variant="outline" onClick={() => setStep(extractedFields.length > 0 ? 'extracting' : 'upload')}>
                {SECURE_DIALOG_LABELS.BACK}
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSelectedTemplate(null);
                    setStep('confirm');
                  }}
                >
                  Skip
                </Button>
                <Button
                  onClick={() => setStep('confirm')}
                  disabled={!selectedTemplate}
                >
                  {SECURE_DIALOG_LABELS.CONTINUE}
                </Button>
              </div>
            </>
          )}

          {step === 'confirm' && (
            <>
              <Button variant="outline" onClick={() => setStep('template')}>
                {SECURE_DIALOG_LABELS.BACK}
              </Button>
              <Button onClick={() => handleConfirm()}>
                <Shield className="mr-2 h-4 w-4" />
                {SECURE_DIALOG_LABELS.SECURE_BUTTON}
              </Button>
            </>
          )}

          {step === 'success' && (
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
              <Button onClick={handleClose}>
                {ANCHORING_STATUS_LABELS.DONE}
              </Button>
            </div>
          )}

          {step === 'error' && (
            <>
              <Button variant="outline" onClick={handleClose}>
                {SECURE_DIALOG_LABELS.CANCEL}
              </Button>
              <Button onClick={handleRetry}>
                {SECURE_DIALOG_LABELS.TRY_AGAIN}
              </Button>
            </>
          )}
          {step === 'attestation-review' && (
            <>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={handleAttestationSubmit}>
                <Shield className="mr-2 h-4 w-4" />
                Create Attestation
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
