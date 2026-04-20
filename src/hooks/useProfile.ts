/**
 * Profile Hook + Provider
 *
 * Fetches and manages the current user's profile from the database.
 * Uses React Context so the profile is fetched ONCE and shared across
 * all components that call useProfile().
 *
 * Backed by React Query for caching, deduplication, and stale-while-revalidate.
 *
 * Usage:
 *   Wrap your app in <ProfileProvider> (done in App.tsx).
 *   Then call useProfile() in any component to get profile state.
 */

import { createElement, createContext, useContext, useCallback, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '../lib/supabase';
import { logAuditEvent } from '../lib/auditLog';
import { TOAST } from '../lib/copy';
import { queryKeys } from '../lib/queryClient';
import { useAuth } from './useAuth';
import type { Database } from '../types/database.types';

type Profile = Database['public']['Tables']['profiles']['Row'];

/**
 * Route destinations based on user state:
 * - /auth: Not authenticated
 * - /onboarding/role: Authenticated but no role
 * - /onboarding/org: ORG_ADMIN with incomplete org setup
 * - /review-pending: Requires manual review
 * - /vault: INDIVIDUAL user, ready
 * - /dashboard: ORG_ADMIN, ready
 */
export type RouteDestination =
  | '/auth'
  | '/onboarding/role'
  | '/onboarding/org'
  | '/review-pending'
  | '/vault'
  | '/dashboard';

interface ProfileState {
  profile: Profile | null;
  loading: boolean;
  updating: boolean;
  error: string | null;
  destination: RouteDestination;
}

interface ProfileActions {
  refreshProfile: () => Promise<void>;
  updateProfile: (updates: Partial<Pick<Profile, 'full_name' | 'avatar_url' | 'is_public_profile' | 'disclaimer_accepted_at' | 'bio' | 'social_links'>>) => Promise<boolean>;
}

type ProfileContextValue = ProfileState & ProfileActions;

const ProfileContext = createContext<ProfileContextValue | null>(null);

/**
 * Provider component — wrap your app in this. Fetches profile once
 * and shares state with all useProfile() consumers.
 */
export function ProfileProvider({ children }: Readonly<{ children: ReactNode }>) {
  const value = useProfileInternal();
  return createElement(ProfileContext.Provider, { value }, children);
}

/**
 * Hook to access profile state. Must be used inside <ProfileProvider>.
 * Throws if used outside provider — wrap your app in <ProfileProvider>.
 */
export function useProfile(): ProfileState & ProfileActions {
  const context = useContext(ProfileContext);
  if (!context) {
    throw new Error('useProfile must be used within a ProfileProvider');
  }
  return context;
}

/** Fetch profile from Supabase — extracted for React Query */
async function fetchProfileData(userId: string): Promise<Profile> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Internal implementation — the actual profile fetching logic.
 * Only called once by ProfileProvider; shared via context.
 * Uses React Query for caching and stale-while-revalidate.
 */
function useProfileInternal(): ProfileState & ProfileActions {
  const { user, loading: authLoading } = useAuth();
  const qc = useQueryClient();

  const {
    data: profile = null,
    isLoading: queryLoading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.profile(user?.id ?? ''),
    queryFn: () => fetchProfileData(user!.id),
    enabled: !!user,
    staleTime: 60_000, // Profile rarely changes — 1 min stale time
  });

  const loading = authLoading || (!!user && queryLoading);
  const error = queryError ? (queryError as Error).message : null;

  // Compute destination based on auth and profile state
  const destination = useMemo((): RouteDestination => {
    if (authLoading || loading) return '/auth';
    if (!user) return '/auth';

    // Fixes SCRUM-350: auth resolves before profile fetch completes,
    // so we must treat null profile as "still loading" to avoid
    // flash-redirecting to /onboarding/role for users who have a role.
    if (!profile) return '/auth';

    if (profile.requires_manual_review) return '/review-pending';
    if (!profile.role) return '/onboarding/role';
    if (profile.role === 'ORG_ADMIN' && !profile.org_id) return '/onboarding/org';
    if (profile.role === 'INDIVIDUAL') return '/vault';
    if (profile.role === 'ORG_ADMIN' && profile.org_id) return '/dashboard';

    return '/vault';
  }, [authLoading, loading, user, profile]);

  const refreshProfile = useCallback(async () => {
    if (user) {
      await qc.invalidateQueries({ queryKey: queryKeys.profile(user.id) });
    }
  }, [user, qc]);

  const updateProfile = useCallback(
    async (updates: Partial<Pick<Profile, 'full_name' | 'avatar_url' | 'is_public_profile' | 'disclaimer_accepted_at' | 'bio' | 'social_links'>>): Promise<boolean> => {
      if (!user) return false;

      const { error: updateError } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', user.id);

      if (updateError) {
        toast.error(TOAST.PROFILE_UPDATE_FAILED);
        return false;
      }

      logAuditEvent({
        eventType: 'PROFILE_UPDATED',
        eventCategory: 'PROFILE',
        targetType: 'profile',
        targetId: user.id,
        details: `Updated fields: ${Object.keys(updates).join(', ')}`,
      });

      // Invalidate cache to refetch — React Query handles the loading state
      await qc.invalidateQueries({ queryKey: queryKeys.profile(user.id) });

      toast.success(TOAST.PROFILE_UPDATED);
      return true;
    },
    [user, qc]
  );

  return {
    profile,
    loading,
    // updating state not needed with React Query — invalidation handles it
    updating: false,
    error,
    destination,
    refreshProfile,
    updateProfile,
  };
}
