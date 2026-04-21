/**
 * BETA-08: Template Selector
 *
 * Displays available credential templates (system + org) for selection
 * during the anchor flow. System templates are available to all users;
 * org templates are shown only to org members.
 */

import { useState, useEffect, useCallback } from 'react';
import { FileText, Loader2, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { supabase } from '@/lib/supabase';
import { CREDENTIAL_TYPE_LABELS } from '@/lib/copy';
import { cn } from '@/lib/utils';

export interface TemplateOption {
  id: string;
  name: string;
  description: string | null;
  credential_type: string;
  is_system: boolean;
  org_id: string | null;
}

interface TemplateSelectorProps {
  orgId: string | null | undefined;
  onSelect: (template: TemplateOption) => void;
  selectedId?: string;
}

export function TemplateSelector({ orgId, onSelect, selectedId }: Readonly<TemplateSelectorProps>) {
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);

    let query = supabase
      .from('credential_templates')
      .select('id, name, description, credential_type, is_system, org_id');

    if (orgId) {
      query = query.or(`is_system.eq.true,org_id.eq.${orgId}`);
    } else {
      query = query.is('is_system', true);
    }

    const { data, error: fetchError } = await query.order('name');

    if (fetchError) {
      setError(fetchError.message);
    } else {
      setTemplates((data as unknown as TemplateOption[]) ?? []);
    }

    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    async function run() { await fetchTemplates(); }
    void run();
  }, [fetchTemplates]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading templates...
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  const systemTemplates = templates.filter((t) => t.is_system);
  const orgTemplates = templates.filter((t) => !t.is_system);

  return (
    <div className="space-y-4">
      {orgTemplates.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Organization Templates
          </p>
          <div className="grid gap-2">
            {orgTemplates.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                selected={selectedId === t.id}
                onClick={() => onSelect(t)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {orgTemplates.length > 0 && (
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Standard Templates
          </p>
        )}
        <div className="grid gap-2">
          {systemTemplates.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              selected={selectedId === t.id}
              onClick={() => onSelect(t)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  selected,
  onClick,
}: Readonly<{
  template: TemplateOption;
  selected: boolean;
  onClick: () => void;
}>) {
  const typeLabel =
    CREDENTIAL_TYPE_LABELS[template.credential_type as keyof typeof CREDENTIAL_TYPE_LABELS] ??
    template.credential_type;

  return (
    <button
      type="button"
      data-selected={selected}
      onClick={onClick}
      className={cn(
        'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50',
        selected && 'border-primary bg-primary/5 ring-1 ring-primary'
      )}
    >
      <div className="mt-0.5 rounded-md bg-muted p-1.5">
        <FileText className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{template.name}</p>
        {template.description && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {template.description}
          </p>
        )}
        <span className="inline-block mt-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          {typeLabel}
        </span>
      </div>
    </button>
  );
}
