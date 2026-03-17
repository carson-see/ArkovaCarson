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
import { CREDENTIAL_TYPE_LABELS } from '@/lib/copy';
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
              <h3 className="text-lg font-semibold mb-1">No templates yet</h3>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-4">
                Templates define the fields and layout for issued credentials.
                Create one for each credential type your organization issues.
              </p>
              <Button onClick={openCreate} size="sm">
                <Plus className="mr-2 h-4 w-4" />
                Create Your First Template
              </Button>
              <div className="mt-6 pt-6 border-t max-w-md mx-auto">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-3">
                  Popular templates to get started
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
