/**
 * Profile Hook
 *
 * Fetches and manages the current user's profile from the database.
 * Also computes the routing destination based on auth and profile state.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { logAuditEvent } from '../lib/auditLog';
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
  updateProfile: (updates: Partial<Pick<Profile, 'full_name' | 'avatar_url' | 'is_public_profile'>>) => Promise<boolean>;
}

export function useProfile(): ProfileState & ProfileActions {
  const { user, loading: authLoading } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Compute destination based on auth and profile state
  const destination = useMemo((): RouteDestination => {
    // Still loading
    if (authLoading || loading) {
      return '/auth'; // Default while loading
    }

    // Not authenticated
    if (!user) {
      return '/auth';
    }

    // No profile yet (shouldn't happen with auth triggers, but handle it)
    if (!profile) {
      return '/onboarding/role';
    }

    // Check manual review gate
    if (profile.requires_manual_review) {
      return '/review-pending';
    }

    // No role set - needs role selection
    if (!profile.role) {
      return '/onboarding/role';
    }

    // ORG_ADMIN without org - needs org setup
    if (profile.role === 'ORG_ADMIN' && !profile.org_id) {
      return '/onboarding/org';
    }

    // INDIVIDUAL user - go to vault
    if (profile.role === 'INDIVIDUAL') {
      return '/vault';
    }

    // ORG_ADMIN with org - go to dashboard
    if (profile.role === 'ORG_ADMIN' && profile.org_id) {
      return '/dashboard';
    }

    // Fallback
    return '/vault';
  }, [authLoading, loading, user, profile]);

  const fetchProfile = useCallback(async () => {
    if (!user) {
      setProfile(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const { data, error: fetchError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (fetchError) {
      setError(fetchError.message);
    } else {
      setProfile(data);
    }

    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const refreshProfile = useCallback(async () => {
    await fetchProfile();
  }, [fetchProfile]);

  const updateProfile = useCallback(
    async (updates: Partial<Pick<Profile, 'full_name' | 'avatar_url' | 'is_public_profile'>>): Promise<boolean> => {
      if (!user) {
        setError('Not authenticated');
        return false;
      }

      setUpdating(true);
      setError(null);

      const { error: updateError } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', user.id);

      if (updateError) {
        setError(updateError.message);
        setUpdating(false);
        return false;
      }

      logAuditEvent({
        eventType: 'PROFILE_UPDATED',
        eventCategory: 'PROFILE',
        targetType: 'profile',
        targetId: user.id,
        details: `Updated fields: ${Object.keys(updates).join(', ')}`,
      });

      // Silently refresh without triggering full loading state
      const { data } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();
      if (data) setProfile(data);

      setUpdating(false);
      return true;
    },
    [user]
  );

  return {
    profile,
    loading: authLoading || loading,
    updating,
    error,
    destination,
    refreshProfile,
    updateProfile,
  };
}
