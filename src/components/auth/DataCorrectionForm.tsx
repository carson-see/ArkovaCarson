/**
 * Data Correction Request Form — REG-19 / APP 13 (SCRUM-580)
 *
 * Allows users to request correction of personal information per APP 13.
 * Submits to data_subject_requests table with type 'correction'.
 * 30-day response timeline tracked.
 */

import { useState, useEffect, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { DATA_CORRECTION_LABELS } from '@/lib/copy';

interface CorrectionRequest {
  id: string;
  status: string;
  requested_at: string;
  completed_at: string | null;
  details: { description?: string } | null;
}

export function DataCorrectionForm() {
  const { user } = useAuth();
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [requests, setRequests] = useState<CorrectionRequest[]>([]);

  const fetchRequests = useCallback(async () => {
    const { data } = await supabase
      .from('data_subject_requests')
      .select('id, status, requested_at, completed_at, details')
      .eq('request_type', 'correction')
      .order('requested_at', { ascending: false })
      .limit(10);

    if (data) setRequests(data as CorrectionRequest[]);
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    fetchRequests();
  }, [user?.id, fetchRequests]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !description.trim() || submitting) return;

    setSubmitting(true);
    const trimmed = description.trim();
    try {
      const { error } = await supabase
        .from('data_subject_requests')
        .insert({
          user_id: user.id,
          request_type: 'correction',
          details: { description: trimmed },
        });

      if (error) throw error;

      toast.success(DATA_CORRECTION_LABELS.SUCCESS);
      setDescription('');

      // Optimistic update — prepend new request to local state
      setRequests(prev => [{
        id: crypto.randomUUID(),
        status: 'processing',
        requested_at: new Date().toISOString(),
        completed_at: null,
        details: { description: trimmed },
      }, ...prev.slice(0, 9)]);
    } catch {
      toast.error(DATA_CORRECTION_LABELS.ERROR);
    } finally {
      setSubmitting(false);
    }
  }

  function statusBadge(status: string) {
    switch (status) {
      case 'processing':
        return <Badge variant="outline">{DATA_CORRECTION_LABELS.STATUS_PROCESSING}</Badge>;
      case 'completed':
        return <Badge variant="secondary">{DATA_CORRECTION_LABELS.STATUS_COMPLETED}</Badge>;
      case 'rejected':
        return <Badge variant="destructive">{DATA_CORRECTION_LABELS.STATUS_REJECTED}</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  }

  function daysRemaining(requestedAt: string): number {
    const requested = new Date(requestedAt);
    const deadline = new Date(requested.getTime() + 30 * 24 * 60 * 60 * 1000);
    return Math.max(0, Math.ceil((deadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="correction-description">{DATA_CORRECTION_LABELS.FIELD_LABEL}</Label>
          <Textarea
            id="correction-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={DATA_CORRECTION_LABELS.FIELD_PLACEHOLDER}
            rows={3}
            maxLength={2000}
            required
          />
        </div>
        <Button type="submit" size="sm" disabled={submitting || !description.trim()}>
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
              {DATA_CORRECTION_LABELS.SUBMITTING}
            </>
          ) : (
            DATA_CORRECTION_LABELS.SUBMIT
          )}
        </Button>
      </form>

      {requests.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {DATA_CORRECTION_LABELS.PENDING_LABEL}
          </p>
          <div className="space-y-2">
            {requests.map((req) => (
              <div key={req.id} className="flex items-center justify-between text-sm border rounded-md px-3 py-2">
                <div className="flex-1 min-w-0">
                  <p className="truncate text-muted-foreground">
                    {(req.details as { description?: string })?.description ?? 'Correction request'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(req.requested_at).toLocaleDateString()}
                    {req.status === 'processing' && ` — ${daysRemaining(req.requested_at)} days remaining`}
                  </p>
                </div>
                {statusBadge(req.status)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
