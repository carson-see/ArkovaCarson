/**
 * Organization Page — Redirect
 *
 * Previously duplicated OrgProfilePage functionality. Now redirects to
 * the organizations list (or the user's org profile if they have one).
 *
 * Session 10: Consolidated with OrgProfilePage to eliminate redundancy.
 */

import { Navigate } from 'react-router-dom';
import { useProfile } from '@/hooks/useProfile';
import { ROUTES, orgProfilePath } from '@/lib/routes';

export function OrganizationPage() {
  const { profile, loading } = useProfile();

  if (loading) return null;

  // If user has an org, go directly to that org's profile page
  if (profile?.org_id) {
    return <Navigate to={orgProfilePath(profile.org_id)} replace />;
  }

  // Otherwise go to the organizations list
  return <Navigate to={ROUTES.ORGANIZATIONS} replace />;
}
