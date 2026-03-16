/**
 * Template Schema Builder
 *
 * Allows org admins to define custom field definitions for credential templates.
 * Supports field types: text, date, number, select, url, email.
 * Each field has a name, type, required flag, and optional select options.
 *
 * @see MVP-17
 */

import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';

export interface TemplateFieldDefinition {
  id: string;
  name: string;
  type: 'text' | 'date' | 'number' | 'select' | 'url' | 'email';
  required: boolean;
  options?: string[];
}

const FIELD_TYPES: TemplateFieldDefinition['type'][] = [
  'text',
  'date',
  'number',
  'select',
  'url',
  'email',
];

const FIELD_TYPE_LABELS: Record<TemplateFieldDefinition['type'], string> = {
  text: 'Text',
  date: 'Date',
  number: 'Number',
  select: 'Select',
  url: 'URL',
  email: 'Email',
};

interface TemplateSchemaBuilderProps {
  value: TemplateFieldDefinition[];
  onChange: (fields: TemplateFieldDefinition[]) => void;
}

function generateFieldId(): string {
  return `field_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function TemplateSchemaBuilder({
  value,
  onChange,
}: Readonly<TemplateSchemaBuilderProps>) {
  const addField = () => {
    const newField: TemplateFieldDefinition = {
      id: generateFieldId(),
      name: '',
      type: 'text',
      required: false,
    };
    onChange([...value, newField]);
  };

  const removeField = (id: string) => {
    onChange(value.filter((f) => f.id !== id));
  };

  const updateField = (id: string, updates: Partial<TemplateFieldDefinition>) => {
    onChange(
      value.map((f) => {
        if (f.id !== id) return f;
        const updated = { ...f, ...updates };
        // Clear options when switching away from select type
        if (updates.type && updates.type !== 'select') {
          delete updated.options;
        }
        // Initialize options when switching to select type
        if (updates.type === 'select' && !updated.options) {
          updated.options = [];
        }
        return updated;
      })
    );
  };

  const updateOptions = (id: string, optionsStr: string) => {
    const options = optionsStr
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    updateField(id, { options });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Field Definitions
        </p>
      </div>

      {value.length === 0 ? (
        <div className="rounded-lg border border-dashed border-muted-foreground/25 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            No fields defined yet. Add a field to get started.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={addField}
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Add Field
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {value.map((field, index) => (
            <div
              key={field.id}
              className="rounded-lg border bg-card p-3 shadow-card-rest space-y-3"
            >
              <div className="flex items-start gap-3">
                {/* Field number */}
                <span className="mt-2 text-xs font-mono text-muted-foreground min-w-[1.5rem] text-right">
                  {index + 1}.
                </span>

                {/* Field name */}
                <div className="flex-1 space-y-1">
                  <Label htmlFor={`field-name-${field.id}`} className="sr-only">
                    Field name
                  </Label>
                  <Input
                    id={`field-name-${field.id}`}
                    placeholder="Field name"
                    value={field.name}
                    onChange={(e) =>
                      updateField(field.id, { name: e.target.value })
                    }
                    className="h-9"
                    aria-label="Field name"
                  />
                </div>

                {/* Field type */}
                <div className="w-32">
                  <Label htmlFor={`field-type-${field.id}`} className="sr-only">
                    Field type
                  </Label>
                  <Select
                    value={field.type}
                    onValueChange={(v) =>
                      updateField(field.id, {
                        type: v as TemplateFieldDefinition['type'],
                      })
                    }
                  >
                    <SelectTrigger
                      id={`field-type-${field.id}`}
                      className="h-9"
                      aria-label="Field type"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {FIELD_TYPE_LABELS[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Required toggle */}
                <div className="flex items-center gap-1.5 pt-1.5">
                  <Switch
                    checked={field.required}
                    onCheckedChange={(checked) =>
                      updateField(field.id, { required: checked })
                    }
                    aria-label="Required"
                  />
                  <span className="text-xs text-muted-foreground">Req</span>
                </div>

                {/* Remove button */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 w-9 p-0 text-destructive hover:text-destructive"
                  onClick={() => removeField(field.id)}
                  aria-label="Remove field"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              {/* Options input for select type */}
              {field.type === 'select' && (
                <div className="ml-8">
                  <Label
                    htmlFor={`field-options-${field.id}`}
                    className="text-xs text-muted-foreground"
                  >
                    Options (comma-separated)
                  </Label>
                  <Input
                    id={`field-options-${field.id}`}
                    placeholder="Option 1, Option 2, Option 3"
                    value={field.options?.join(', ') ?? ''}
                    onChange={(e) => updateOptions(field.id, e.target.value)}
                    className="h-8 mt-1 text-sm"
                    aria-label="Select options"
                  />
                </div>
              )}
            </div>
          ))}

          <Button
            variant="outline"
            size="sm"
            onClick={addField}
            className="w-full"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Add Field
          </Button>
        </div>
      )}
    </div>
  );
}
