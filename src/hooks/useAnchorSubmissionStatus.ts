import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { workerFetch } from '@/lib/workerClient';
import { useAuth } from './useAuth';

const submissionStatusSchema = z.object({
  public_id: z.string().min(1),
  action: z.enum(['queue', 'instant']),
  anchor_status: z.string().min(1),
  credit_state: z.enum(['pending', 'spent', 'refunded']).nullable(),
  instant_status: z.enum(['QUEUED', 'PROCESSING', 'NEEDS_CREDIT', 'RETRYABLE', 'HELD', 'SUBMITTED', 'FAILED']).nullable(),
  retryable: z.boolean(),
  updated_at: z.string().min(1),
}).strict();

export interface AnchorSubmissionStatus {
  publicId: string;
  action: 'queue' | 'instant';
  anchorStatus: string;
  creditState: 'pending' | 'spent' | 'refunded' | null;
  instantStatus: 'QUEUED' | 'PROCESSING' | 'NEEDS_CREDIT' | 'RETRYABLE' | 'HELD' | 'SUBMITTED' | 'FAILED' | null;
  retryable: boolean;
  updatedAt: string;
}

async function fetchSubmissionStatus(publicId: string, orgId: string | null): Promise<AnchorSubmissionStatus> {
  const scope = orgId ? `org_id=${encodeURIComponent(orgId)}` : 'scope=user';
  const response = await workerFetch(`/api/v1/anchor-self-service/${encodeURIComponent(publicId)}/submission-status?${scope}`);
  if (!response.ok) throw new Error('Could not load securing status');
  const parsed = submissionStatusSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Could not load securing status');
  return {
    publicId: parsed.data.public_id,
    action: parsed.data.action,
    anchorStatus: parsed.data.anchor_status,
    creditState: parsed.data.credit_state,
    instantStatus: parsed.data.instant_status,
    retryable: parsed.data.retryable,
    updatedAt: parsed.data.updated_at,
  };
}

function shouldPoll(status: AnchorSubmissionStatus | undefined): number | false {
  // A transient first-read failure must recover without requiring the user to
  // refocus the tab. Once data exists, only live instant states keep polling.
  if (!status) return 3_000;
  if (status.action !== 'instant') return false;
  return ['QUEUED', 'PROCESSING', 'RETRYABLE'].includes(status.instantStatus ?? '') ? 3_000 : false;
}

export function useAnchorSubmissionStatus(publicId: string | null, orgId: string | null) {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['anchor-submission-status', user?.id ?? 'none', orgId ?? 'personal', publicId ?? 'none'],
    queryFn: () => fetchSubmissionStatus(publicId!, orgId),
    enabled: Boolean(user && publicId),
    refetchInterval: (state) => shouldPoll(state.state.data),
    refetchOnWindowFocus: 'always',
  });
  return {
    status: query.data ?? null,
    loading: Boolean(publicId) && query.isLoading,
    error: query.error ? 'Could not load securing status' : null,
    refresh: query.refetch,
  };
}
