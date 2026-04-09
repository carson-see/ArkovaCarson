/**
 * Credential Templates Manager
 *
 * CRUD interface for managing credential templates within an organization.
 * ORG_ADMIN users can create, edit, toggle, and delete templates.
 *
 * @see P5-TS-07
 */

import { useState, useMemo } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  FileText,
  Loader2,
} from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { CREDENTIAL_TYPE_LABELS, SETTINGS_PAGE_LABELS } from '@/lib/copy';
import { TemplateSchemaBuilder, type TemplateFieldDefinition } from './TemplateSchemaBuilder';
import type { Database, Json } from '@/types/database.types';

type CredentialType = Database['public']['Enums']['credential_type'];
type CredentialTemplate = Database['public']['Tables']['credential_templates']['Row'];

interface CreateTemplateParams {
  name: string;
  description?: string | null;
  credential_type: CredentialType;
  default_metadata?: Record<string, Json | undefined> | null;
}

interface UpdateTemplateParams {
  name?: string;
  description?: string | null;
  credential_type?: CredentialType;
  default_metadata?: Record<string, Json | undefined> | null;
  is_active?: boolean;
}

interface CredentialTemplatesManagerProps {
  templates: CredentialTemplate[];
  loading: boolean;
  error: string | null;
  onCreate: (params: CreateTemplateParams) => Promise<CredentialTemplate | null>;
  onUpdate: (id: string, params: UpdateTemplateParams) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}

const CREDENTIAL_TYPES = Object.keys(CREDENTIAL_TYPE_LABELS) as CredentialType[];

/** Pre-built starter templates for common credential types */
const STARTER_TEMPLATES: { name: string; description: string; type: CredentialType; fields: TemplateFieldDefinition[] }[] = [
  {
    name: 'Diploma',
    description: 'Academic degree credential',
    type: 'DEGREE',
    fields: [
      { id: 'f_degree', name: 'Degree Title', type: 'text', required: true },
      { id: 'f_major', name: 'Major', type: 'text', required: true },
      { id: 'f_grad_date', name: 'Graduation Date', type: 'date', required: true },
      { id: 'f_honors', name: 'Honors', type: 'select', required: false, options: ['Summa Cum Laude', 'Magna Cum Laude', 'Cum Laude', 'None'] },
    ],
  },
  {
    name: 'Professional Certificate',
    description: 'Certificate of completion or achievement',
    type: 'CERTIFICATE',
    fields: [
      { id: 'f_program', name: 'Program Name', type: 'text', required: true },
      { id: 'f_hours', name: 'Credit Hours', type: 'number', required: false },
      { id: 'f_completion', name: 'Completion Date', type: 'date', required: true },
    ],
  },
  {
    name: 'Professional License',
    description: 'Professional or occupational license',
    type: 'LICENSE',
    fields: [
      { id: 'f_license_type', name: 'License Type', type: 'text', required: true },
      { id: 'f_license_num', name: 'License Number', type: 'text', required: true },
      { id: 'f_issued', name: 'Issue Date', type: 'date', required: true },
      { id: 'f_expiry', name: 'Expiration Date', type: 'date', required: false },
    ],
  },
  {
    name: 'Academic Transcript',
    description: 'Official academic transcript or grade report',
    type: 'TRANSCRIPT',
    fields: [
      { id: 'f_institution', name: 'Institution', type: 'text', required: true },
      { id: 'f_program', name: 'Program / Degree', type: 'text', required: true },
      { id: 'f_date_issued', name: 'Date Issued', type: 'date', required: true },
      { id: 'f_gpa', name: 'GPA', type: 'text', required: false },
    ],
  },
  {
    name: 'SEC Filing',
    description: 'SEC filing or financial disclosure',
    type: 'SEC_FILING',
    fields: [
      { id: 'f_filing_type', name: 'Filing Type', type: 'select', required: true, options: ['10-K', '10-Q', '8-K', 'S-1', 'DEF 14A', '20-F', 'Form 4', 'Other'] },
      { id: 'f_company', name: 'Company Name', type: 'text', required: true },
      { id: 'f_filing_date', name: 'Filing Date', type: 'date', required: true },
      { id: 'f_cik', name: 'CIK Number', type: 'text', required: false },
      { id: 'f_period', name: 'Report Period', type: 'text', required: false },
    ],
  },
  {
    name: 'Legal Document',
    description: 'Contract, court order, or legal filing',
    type: 'LEGAL',
    fields: [
      { id: 'f_doc_type', name: 'Document Type', type: 'select', required: true, options: ['Contract', 'Court Order', 'NDA', 'Settlement', 'Power of Attorney', 'Deed', 'Other'] },
      { id: 'f_parties', name: 'Issuing Party / Court', type: 'text', required: true },
      { id: 'f_effective_date', name: 'Effective Date', type: 'date', required: true },
      { id: 'f_case_number', name: 'Case / Docket Number', type: 'text', required: false },
      { id: 'f_jurisdiction', name: 'Jurisdiction', type: 'text', required: false },
    ],
  },
  {
    name: 'Patent',
    description: 'Intellectual property patent',
    type: 'PATENT',
    fields: [
      { id: 'f_patent_num', name: 'Patent Number', type: 'text', required: true },
      { id: 'f_title', name: 'Patent Title', type: 'text', required: true },
      { id: 'f_inventors', name: 'Inventor(s)', type: 'text', required: true },
      { id: 'f_filing_date', name: 'Filing Date', type: 'date', required: true },
      { id: 'f_grant_date', name: 'Grant Date', type: 'date', required: false },
    ],
  },
  {
    name: 'CLE Credit',
    description: 'Continuing Legal Education credit',
    type: 'CLE',
    fields: [
      { id: 'f_course', name: 'Course Name', type: 'text', required: true },
      { id: 'f_provider', name: 'Provider', type: 'text', required: true },
      { id: 'f_credits', name: 'Credit Hours', type: 'number', required: true },
      { id: 'f_credit_type', name: 'Credit Type', type: 'select', required: false, options: ['General', 'Ethics', 'Professional Responsibility', 'Elimination of Bias', 'Technology'] },
      { id: 'f_completion', name: 'Completion Date', type: 'date', required: true },
      { id: 'f_approved_by', name: 'Approved By', type: 'text', required: false },
    ],
  },
  {
    name: 'Publication',
    description: 'Academic or scientific publication',
    type: 'PUBLICATION',
    fields: [
      { id: 'f_title', name: 'Title', type: 'text', required: true },
      { id: 'f_journal', name: 'Journal / Conference', type: 'text', required: true },
      { id: 'f_pub_date', name: 'Publication Date', type: 'date', required: true },
      { id: 'f_doi', name: 'DOI', type: 'text', required: false },
    ],
  },
  {
    name: 'Medical Record',
    description: 'Medical license, vaccination, or health record',
    type: 'MEDICAL',
    fields: [
      { id: 'f_record_type', name: 'Record Type', type: 'select', required: true, options: ['License', 'Vaccination', 'Lab Result', 'Medical Clearance', 'Health Certificate', 'Other'] },
      { id: 'f_provider', name: 'Provider / Issuer', type: 'text', required: true },
      { id: 'f_date', name: 'Date', type: 'date', required: true },
      { id: 'f_license_num', name: 'License / NPI Number', type: 'text', required: false },
    ],
  },
  {
    name: 'Military Record',
    description: 'DD-214, service record, or military document',
    type: 'MILITARY',
    fields: [
      { id: 'f_branch', name: 'Branch', type: 'select', required: true, options: ['Army', 'Navy', 'Air Force', 'Marines', 'Coast Guard', 'Space Force', 'Other'] },
      { id: 'f_doc_type', name: 'Document Type', type: 'select', required: true, options: ['DD-214', 'Service Record', 'Award', 'Deployment Record', 'Veteran Status Letter', 'Other'] },
      { id: 'f_service_start', name: 'Service Start Date', type: 'date', required: false },
      { id: 'f_service_end', name: 'Service End Date', type: 'date', required: false },
    ],
  },
  {
    name: 'Identity Document',
    description: 'Birth certificate, passport, or vital record',
    type: 'IDENTITY',
    fields: [
      { id: 'f_doc_type', name: 'Document Type', type: 'select', required: true, options: ['Birth Certificate', 'Marriage Certificate', 'Naturalization Certificate', 'Passport', 'Name Change Order', 'Other'] },
      { id: 'f_issuer', name: 'Issuing Authority', type: 'text', required: true },
      { id: 'f_date_issued', name: 'Date Issued', type: 'date', required: true },
      { id: 'f_doc_number', name: 'Document Number', type: 'text', required: false },
    ],
  },
  {
    name: 'Regulation',
    description: 'Government regulation or compliance directive',
    type: 'REGULATION',
    fields: [
      { id: 'f_reg_number', name: 'Regulation Number / CFR', type: 'text', required: true },
      { id: 'f_title', name: 'Title', type: 'text', required: true },
      { id: 'f_agency', name: 'Issuing Agency', type: 'text', required: true },
      { id: 'f_effective_date', name: 'Effective Date', type: 'date', required: true },
    ],
  },
  {
    name: 'Insurance Document',
    description: 'Certificate of insurance, policy, or bond',
    type: 'INSURANCE',
    fields: [
      { id: 'f_insurer', name: 'Insurance Company', type: 'text', required: true },
      { id: 'f_policy_type', name: 'Policy Type', type: 'select', required: true, options: ['General Liability', 'Professional Liability', 'Workers Compensation', 'Cyber Liability', 'Property', 'Bond', 'Other'] },
      { id: 'f_effective', name: 'Effective Date', type: 'date', required: true },
      { id: 'f_expiry', name: 'Expiration Date', type: 'date', required: false },
      { id: 'f_policy_num', name: 'Policy Number', type: 'text', required: false },
    ],
  },
  {
    name: 'Professional Credential',
    description: 'Board certification, fellowship, or membership',
    type: 'PROFESSIONAL',
    fields: [
      { id: 'f_credential', name: 'Credential Name', type: 'text', required: true },
      { id: 'f_issuer', name: 'Issuing Body', type: 'text', required: true },
      { id: 'f_date', name: 'Date Awarded', type: 'date', required: true },
      { id: 'f_expiry', name: 'Expiration Date', type: 'date', required: false },
    ],
  },
  {
    name: 'Digital Badge',
    description: 'Micro-credential or skill badge',
    type: 'BADGE',
    fields: [
      { id: 'f_badge_name', name: 'Badge Name', type: 'text', required: true },
      { id: 'f_issuer', name: 'Issuer', type: 'text', required: true },
      { id: 'f_date', name: 'Date Earned', type: 'date', required: true },
      { id: 'f_skill', name: 'Skill / Topic', type: 'text', required: false },
    ],
  },
  {
    name: 'Attestation',
    description: 'Verification letter, reference, or sworn statement',
    type: 'ATTESTATION',
    fields: [
      { id: 'f_type', name: 'Attestation Type', type: 'select', required: true, options: ['Employment Verification', 'Education Verification', 'Reference Letter', 'Affidavit', 'Good Standing', 'Other'] },
      { id: 'f_issuer', name: 'Issuing Organization', type: 'text', required: true },
      { id: 'f_date', name: 'Date', type: 'date', required: true },
    ],
  },
  {
    name: 'Resume / CV',
    description: 'Resume, CV, or career summary',
    type: 'RESUME',
    fields: [
      { id: 'f_title', name: 'Current Title', type: 'text', required: true },
      { id: 'f_field', name: 'Field / Industry', type: 'text', required: true },
      { id: 'f_date', name: 'Date', type: 'date', required: false },
    ],
  },
  {
    name: 'Financial Document',
    description: 'Tax form, bank statement, or financial record',
    type: 'FINANCIAL',
    fields: [
      { id: 'f_doc_type', name: 'Document Type', type: 'select', required: true, options: ['W-2', '1099', 'Tax Return', 'Bank Statement', 'Pay Stub', 'Audit Report', 'Other'] },
      { id: 'f_issuer', name: 'Issuer', type: 'text', required: true },
      { id: 'f_period', name: 'Period / Date', type: 'date', required: true },
    ],
  },
  {
    name: 'Charitable Organization',
    description: 'Nonprofit or tax-exempt entity registration',
    type: 'CHARITY',
    fields: [
      { id: 'f_org_name', name: 'Organization Name', type: 'text', required: true },
      { id: 'f_status', name: 'Tax-Exempt Status', type: 'select', required: true, options: ['501(c)(3)', '501(c)(4)', '501(c)(6)', 'Other'] },
      { id: 'f_ein', name: 'EIN', type: 'text', required: false },
      { id: 'f_date', name: 'Effective Date', type: 'date', required: true },
      { id: 'f_jurisdiction', name: 'Jurisdiction', type: 'text', required: false },
    ],
  },
  {
    name: 'Financial Advisor',
    description: 'FINRA registration, Series license, or advisor credential',
    type: 'FINANCIAL_ADVISOR',
    fields: [
      { id: 'f_registrar', name: 'Registering Body', type: 'text', required: true },
      { id: 'f_crd', name: 'CRD Number', type: 'text', required: false },
      { id: 'f_firm', name: 'Firm', type: 'text', required: true },
      { id: 'f_licenses', name: 'Series Licenses', type: 'text', required: false },
      { id: 'f_date', name: 'Registration Date', type: 'date', required: true },
    ],
  },
  {
    name: 'Business Entity',
    description: 'Certificate of formation, good standing, or entity filing',
    type: 'BUSINESS_ENTITY',
    fields: [
      { id: 'f_entity_name', name: 'Entity Name', type: 'text', required: true },
      { id: 'f_entity_type', name: 'Entity Type', type: 'select', required: true, options: ['LLC', 'Corporation', 'S-Corp', 'Limited Partnership', 'Sole Proprietorship', 'Other'] },
      { id: 'f_state', name: 'State of Formation', type: 'text', required: true },
      { id: 'f_formation_date', name: 'Formation Date', type: 'date', required: true },
      { id: 'f_status', name: 'Status', type: 'select', required: false, options: ['Active', 'Good Standing', 'Dissolved', 'Revoked', 'Suspended'] },
      { id: 'f_ein', name: 'EIN', type: 'text', required: false },
    ],
  },
  {
    name: 'Other Document',
    description: 'Document that does not fit other categories',
    type: 'OTHER',
    fields: [
      { id: 'f_title', name: 'Document Title', type: 'text', required: true },
      { id: 'f_issuer', name: 'Issuer', type: 'text', required: false },
      { id: 'f_date', name: 'Date', type: 'date', required: false },
      { id: 'f_description', name: 'Description', type: 'text', required: false },
    ],
  },
];

interface FormState {
  name: string;
  description: string;
  credential_type: CredentialType;
  fields: TemplateFieldDefinition[];
}

const emptyForm: FormState = {
  name: '',
  description: '',
  credential_type: 'CERTIFICATE',
  fields: [],
};

/** Convert TemplateFieldDefinition[] to the DB format: { fields: [...] } */
function fieldsToMetadata(fields: TemplateFieldDefinition[]): Record<string, Json | undefined> | null {
  if (fields.length === 0) return null;
  return {
    fields: fields.map((f) => ({
      key: f.name.toLowerCase().replace(/\s+/g, '_'),
      label: f.name,
      type: f.type,
      ...(f.required && { required: true }),
      ...(f.options && f.options.length > 0 && { options: f.options }),
    })),
  };
}

/** Convert DB metadata { fields: [...] } back to TemplateFieldDefinition[] */
function metadataToFields(metadata: Record<string, Json | undefined> | null): TemplateFieldDefinition[] {
  if (!metadata) return [];
  const fields = (metadata as Record<string, unknown>).fields;
  if (!Array.isArray(fields)) return [];
  return fields
    .filter((f): f is Record<string, unknown> => f != null && typeof f === 'object')
    .map((f, idx) => ({
      id: `field_${idx}_${(f.key as string) ?? idx}`,
      name: (f.label as string) ?? (f.key as string) ?? '',
      type: (f.type as TemplateFieldDefinition['type']) ?? 'text',
      required: (f.required as boolean) ?? false,
      ...(Array.isArray(f.options) && { options: f.options as string[] }),
    }));
}

export function CredentialTemplatesManager({
  templates,
  loading,
  error,
  onCreate,
  onUpdate,
  onDelete,
}: Readonly<CredentialTemplatesManagerProps>) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setFormError(null);
    setDialogOpen(true);
  };

  const openEdit = (template: CredentialTemplate) => {
    setEditingId(template.id);
    setForm({
      name: template.name,
      description: template.description ?? '',
      credential_type: template.credential_type,
      fields: metadataToFields(template.default_metadata as Record<string, Json | undefined> | null),
    });
    setFormError(null);
    setDialogOpen(true);
  };

  const openDelete = (id: string) => {
    setDeletingId(id);
    setDeleteDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      setFormError('Name is required');
      return;
    }

    // Validate that all fields have names
    const emptyFields = form.fields.filter((f) => !f.name.trim());
    if (emptyFields.length > 0) {
      setFormError('All fields must have a name');
      return;
    }

    const parsedMetadata = fieldsToMetadata(form.fields);

    setSubmitting(true);
    setFormError(null);

    if (editingId) {
      const ok = await onUpdate(editingId, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        credential_type: form.credential_type,
        default_metadata: parsedMetadata,
      });
      if (!ok) {
        setFormError('Failed to update template');
        setSubmitting(false);
        return;
      }
    } else {
      const result = await onCreate({
        name: form.name.trim(),
        description: form.description.trim() || null,
        credential_type: form.credential_type,
        default_metadata: parsedMetadata,
      });
      if (!result) {
        setFormError('Failed to create template');
        setSubmitting(false);
        return;
      }
    }

    setSubmitting(false);
    setDialogOpen(false);
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    await onDelete(deletingId);
    setDeleteDialogOpen(false);
    setDeletingId(null);
  };

  const handleToggle = async (template: CredentialTemplate) => {
    await onUpdate(template.id, { is_active: !template.is_active });
  };

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString('en-US', { dateStyle: 'medium' });

  return (
    <div className="max-w-4xl mx-auto space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <FileText className="h-6 w-6 text-primary" />
            Credential Templates
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Define reusable templates for issuing credentials
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" />
          Add Template
        </Button>
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-4">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Templates</CardTitle>
          <CardDescription>
            Templates define default settings for new credentials
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (templates.length === 0 ? (
            <div className="text-center py-12">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mx-auto mb-4">
                <FileText className="h-7 w-7 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-semibold mb-1">{SETTINGS_PAGE_LABELS.TEMPLATES_EMPTY_TITLE}</h3>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-4">
                {SETTINGS_PAGE_LABELS.TEMPLATES_EMPTY_DESC}
              </p>
              <Button onClick={openCreate} size="sm">
                <Plus className="mr-2 h-4 w-4" />
                {SETTINGS_PAGE_LABELS.TEMPLATES_EMPTY_CTA}
              </Button>
              <div className="mt-6 pt-6 border-t max-w-md mx-auto">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-3">
                  {SETTINGS_PAGE_LABELS.TEMPLATES_STARTER_HEADING}
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {STARTER_TEMPLATES.map((starter) => (
                    <Button
                      key={starter.type}
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() => {
                        setEditingId(null);
                        setForm({
                          name: starter.name,
                          description: starter.description,
                          credential_type: starter.type,
                          fields: starter.fields,
                        });
                        setFormError(null);
                        setDialogOpen(true);
                      }}
                    >
                      <Plus className="mr-1 h-3 w-3" />
                      {starter.name}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((template) => (
                  <TableRow key={template.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{template.name}</p>
                        {template.description && (
                          <p className="text-xs text-muted-foreground line-clamp-1">
                            {template.description}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">
                          {CREDENTIAL_TYPE_LABELS[template.credential_type] ?? template.credential_type}
                        </Badge>
                        <FieldCountBadge metadata={template.default_metadata as Record<string, Json | undefined> | null} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={template.is_active}
                        onCheckedChange={() => handleToggle(template)}
                      />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(template.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(template)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openDelete(template.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ))}
        </CardContent>
      </Card>

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingId ? 'Edit Template' : 'Create Template'}
            </DialogTitle>
            <DialogDescription>
              {editingId
                ? 'Update the template settings'
                : 'Define a new credential template for your organization'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="template-name">Name</Label>
              <Input
                id="template-name"
                placeholder="e.g., Bachelor's Degree"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                maxLength={255}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="template-type">Credential Type</Label>
              <Select
                value={form.credential_type}
                onValueChange={(v) =>
                  setForm({ ...form, credential_type: v as CredentialType })
                }
              >
                <SelectTrigger id="template-type">
                  <SelectValue />
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

            <div className="space-y-2">
              <Label htmlFor="template-description">Description</Label>
              <Textarea
                id="template-description"
                placeholder="Optional description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                maxLength={2000}
                rows={2}
              />
            </div>

            <div className="space-y-2">
              <TemplateSchemaBuilder
                value={form.fields}
                onChange={(fields) => setForm({ ...form, fields })}
              />
            </div>

            {formError && (
              <p className="text-sm text-destructive">{formError}</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingId ? 'Save Changes' : 'Create Template'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Template</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this template. Existing credentials
              that used this template will not be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FieldCountBadge({ metadata }: { metadata: Record<string, Json | undefined> | null }) {
  const count = useMemo(() => metadataToFields(metadata).length, [metadata]);
  if (count === 0) return null;
  return (
    <Badge variant="outline" className="text-xs font-mono">
      {count} {count === 1 ? 'field' : 'fields'}
    </Badge>
  );
}
