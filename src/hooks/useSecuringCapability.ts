import { useQuery, type QueryObserverResult } from '@tanstack/react-query';
import { z } from 'zod';
import type { SecuringCapability } from '@/lib/queueContract';
import { workerFetch } from '@/lib/workerClient';
import { useAuth } from './useAuth';

export interface AnchorCreditCapability extends SecuringCapability {
  scope: 'user' | 'organization';
  canPurchase: boolean;
  purchaseGuidance: string | null;
}

interface UseSecuringCapabilityReturn {
  capability: AnchorCreditCapability;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<QueryObserverResult<AnchorCreditCapability, Error>>;
}

async function fetchCapability(orgId: string | null): Promise<AnchorCreditCapability> {
  const scope = orgId ? `org_id=${encodeURIComponent(orgId)}` : 'scope=user';
  const response = await workerFetch(`/api/v1/anchor-credits/status?${scope}`);
  if (!response.ok) throw new Error('Could not load instant secure availability');
  const parsed = z.object({
    canSecureInstantly: z.boolean(),
    creditBalance: z.number().int().nonnegative(),
    instantSecureCost: z.number().int().positive(),
    scope: z.enum(['user', 'organization']),
    canPurchase: z.boolean(),
    purchaseGuidance: z.string().nullable(),
  }).strict().safeParse(await response.json());
  if (!parsed.success) throw new Error('Could not load instant secure availability');
  return parsed.data;
}

const CLOSED: AnchorCreditCapability = {
  canSecureInstantly: false,
  creditBalance: 0,
  instantSecureCost: 1,
  scope: 'user',
  canPurchase: false,
  purchaseGuidance: null,
};

export function useSecuringCapability(orgId: string | null = null): UseSecuringCapabilityReturn {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['anchor-credit-capability', user?.id ?? 'none', orgId ?? 'user'],
    queryFn: () => fetchCapability(orgId),
    enabled: Boolean(user),
    staleTime: 30_000,
    refetchOnWindowFocus: 'always',
  });
  return {
    // A failed refresh must fail closed rather than retaining React Query's
    // last successful (and potentially funded) capability snapshot.
    capability: query.error ? CLOSED : query.data ?? CLOSED,
    loading: Boolean(user) && query.isLoading,
    error: query.error ? (query.error as Error).message : null,
    refresh: query.refetch,
  };
}
