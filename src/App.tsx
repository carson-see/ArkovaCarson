/**
 * Arkova MVP - Main Application
 *
 * Uses react-router-dom for client-side routing.
 * AuthGuard protects authenticated routes (checks login).
 * RouteGuard enforces profile-based routing (onboarding flow).
 * Public routes (login, signup, verify) are accessible without auth.
 */

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Shield, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { AuthGuard } from '@/components/auth/AuthGuard';
import { RouteGuard } from '@/components/auth/RouteGuard';
import { LoginPage } from '@/pages/LoginPage';
import { SignUpPage } from '@/pages/SignUpPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { MyRecordsPage } from '@/pages/MyRecordsPage';
import { OrganizationPage } from '@/pages/OrganizationPage';
import { RecordDetailPage } from '@/pages/RecordDetailPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { HelpPage } from '@/pages/HelpPage';
import { PublicVerifyPage } from '@/components/public/PublicVerifyPage';
import { WebhookSettingsPage } from '@/pages/WebhookSettingsPage';
import { CredentialTemplatesPage } from '@/pages/CredentialTemplatesPage';
import { ROUTES, MAIN_APP_DESTINATIONS, destinationToRoute } from '@/lib/routes';

/**
 * Redirect authenticated users away from login/signup.
 * Uses profile destination so users go to onboarding if needed,
 * not always to dashboard.
 */
function PublicOnly({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const { destination, loading: profileLoading } = useProfile();

  if (authLoading || (user && profileLoading)) {
    return <LoadingScreen />;
  }

  if (user) {
    return <Navigate to={destinationToRoute(destination)} replace />;
  }

  return <>{children}</>;
}

function LoadingScreen() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background">
      <div className="flex flex-col items-center space-y-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10">
          <Shield className="h-8 w-8 text-primary" />
        </div>
        <div className="flex items-center space-x-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading Arkova...</span>
        </div>
      </div>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public routes — no auth required */}
        <Route
          path={ROUTES.LOGIN}
          element={
            <PublicOnly>
              <LoginPage />
            </PublicOnly>
          }
        />
        <Route
          path={ROUTES.SIGNUP}
          element={
            <PublicOnly>
              <SignUpPage />
            </PublicOnly>
          }
        />
        <Route
          path="/verify"
          element={<PublicVerifyPage />}
        />
        <Route
          path={ROUTES.VERIFY}
          element={<PublicVerifyPage />}
        />

        {/* Onboarding routes — auth required, only for users needing setup */}
        <Route
          path={ROUTES.ONBOARDING_ROLE}
          element={
            <AuthGuard>
              <RouteGuard allow={['/onboarding/role']}>
                {/* TODO: Wire OnboardingRolePage when implemented */}
                <DashboardPage />
              </RouteGuard>
            </AuthGuard>
          }
        />
        <Route
          path={ROUTES.ONBOARDING_ORG}
          element={
            <AuthGuard>
              <RouteGuard allow={['/onboarding/org']}>
                {/* TODO: Wire OnboardingOrgPage when implemented */}
                <DashboardPage />
              </RouteGuard>
            </AuthGuard>
          }
        />

        {/* Review pending — auth required, only for users under review */}
        <Route
          path={ROUTES.REVIEW_PENDING}
          element={
            <AuthGuard>
              <RouteGuard allow={['/review-pending']}>
                {/* TODO: Wire ReviewPendingPage when implemented */}
                <DashboardPage />
              </RouteGuard>
            </AuthGuard>
          }
        />

        {/* Main app routes — auth required, onboarding must be complete */}
        <Route
          path={ROUTES.DASHBOARD}
          element={
            <AuthGuard>
              <RouteGuard allow={MAIN_APP_DESTINATIONS}>
                <DashboardPage />
              </RouteGuard>
            </AuthGuard>
          }
        />
        <Route
          path={ROUTES.RECORDS}
          element={
            <AuthGuard>
              <RouteGuard allow={MAIN_APP_DESTINATIONS}>
                <MyRecordsPage />
              </RouteGuard>
            </AuthGuard>
          }
        />
        <Route
          path={ROUTES.RECORD_DETAIL}
          element={
            <AuthGuard>
              <RouteGuard allow={MAIN_APP_DESTINATIONS}>
                <RecordDetailPage />
              </RouteGuard>
            </AuthGuard>
          }
        />
        <Route
          path={ROUTES.ORGANIZATION}
          element={
            <AuthGuard>
              <RouteGuard allow={MAIN_APP_DESTINATIONS}>
                <OrganizationPage />
              </RouteGuard>
            </AuthGuard>
          }
        />
        <Route
          path={ROUTES.SETTINGS}
          element={
            <AuthGuard>
              <RouteGuard allow={MAIN_APP_DESTINATIONS}>
                <SettingsPage />
              </RouteGuard>
            </AuthGuard>
          }
        />
        <Route
          path={ROUTES.SETTINGS_API_KEYS}
          element={
            <AuthGuard>
              <RouteGuard allow={MAIN_APP_DESTINATIONS}>
                <DashboardPage />
              </RouteGuard>
            </AuthGuard>
          }
        />
        <Route
          path={ROUTES.SETTINGS_WEBHOOKS}
          element={
            <AuthGuard>
              <RouteGuard allow={MAIN_APP_DESTINATIONS}>
                <WebhookSettingsPage />
              </RouteGuard>
            </AuthGuard>
          }
        />
        <Route
          path={ROUTES.CREDENTIAL_TEMPLATES}
          element={
            <AuthGuard>
              <RouteGuard allow={MAIN_APP_DESTINATIONS}>
                <CredentialTemplatesPage />
              </RouteGuard>
            </AuthGuard>
          }
        />
        <Route
          path={ROUTES.HELP}
          element={
            <AuthGuard>
              <RouteGuard allow={MAIN_APP_DESTINATIONS}>
                <HelpPage />
              </RouteGuard>
            </AuthGuard>
          }
        />

        {/* Root redirects to dashboard (guards will bounce to correct destination) */}
        <Route path={ROUTES.HOME} element={<Navigate to={ROUTES.DASHBOARD} replace />} />

        {/* Catch-all — redirect to dashboard */}
        <Route path="*" element={<Navigate to={ROUTES.DASHBOARD} replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
