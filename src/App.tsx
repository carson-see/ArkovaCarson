/**
 * Arkova MVP - Main Application
 *
 * Uses react-router-dom for client-side routing.
 * AuthGuard protects authenticated routes (checks login).
 * RouteGuard enforces profile-based routing (onboarding flow).
 * Public routes (login, signup, verify) are accessible without auth.
 */

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { ArkovaLogo } from '@/components/layout/ArkovaLogo';
import { Toaster } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useProfile, ProfileProvider } from '@/hooks/useProfile';
import { AuthGuard } from '@/components/auth/AuthGuard';
import { RouteGuard } from '@/components/auth/RouteGuard';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { LoginPage } from '@/pages/LoginPage';
import { SignUpPage } from '@/pages/SignUpPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { OnboardingRolePage } from '@/pages/OnboardingRolePage';
import { OnboardingOrgPage } from '@/pages/OnboardingOrgPage';
import { ReviewPendingPage } from '@/pages/ReviewPendingPage';
import { MyRecordsPage } from '@/pages/MyRecordsPage';
import { OrganizationPage } from '@/pages/OrganizationPage';
import { RecordDetailPage } from '@/pages/RecordDetailPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { HelpPage } from '@/pages/HelpPage';
import { PublicVerifyPage } from '@/components/public/PublicVerifyPage';
import { WebhookSettingsPage } from '@/pages/WebhookSettingsPage';
import { CredentialTemplatesPage } from '@/pages/CredentialTemplatesPage';
import { PricingPage } from '@/pages/PricingPage';
import { CheckoutSuccessPage } from '@/pages/CheckoutSuccessPage';
import { CheckoutCancelPage } from '@/pages/CheckoutCancelPage';
import { VerifyMyRecordPage } from '@/pages/VerifyMyRecordPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { PrivacyPage } from '@/pages/PrivacyPage';
import { TermsPage } from '@/pages/TermsPage';
import { ContactPage } from '@/pages/ContactPage';
import { ROUTES, MAIN_APP_DESTINATIONS, destinationToRoute } from '@/lib/routes';

/**
 * Redirect authenticated users away from login/signup.
 * Uses profile destination so users go to onboarding if needed,
 * not always to dashboard.
 */
function PublicOnly({ children }: Readonly<{ children: React.ReactNode }>) {
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
        <ArkovaLogo size={56} />
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
    <ErrorBoundary>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ProfileProvider>
        <Toaster position="top-right" richColors closeButton />
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
            path={ROUTES.VERIFY}
            element={<PublicVerifyPage />}
          />
          <Route
            path={ROUTES.VERIFY_FORM}
            element={<PublicVerifyPage />}
          />
          <Route path={ROUTES.PRIVACY} element={<PrivacyPage />} />
          <Route path={ROUTES.TERMS} element={<TermsPage />} />
          <Route path={ROUTES.CONTACT} element={<ContactPage />} />

          {/* Onboarding routes — auth required, only for users needing setup */}
          <Route
            path={ROUTES.ONBOARDING_ROLE}
            element={
              <AuthGuard>
                <RouteGuard allow={['/onboarding/role']}>
                  <OnboardingRolePage />
                </RouteGuard>
              </AuthGuard>
            }
          />
          <Route
            path={ROUTES.ONBOARDING_ORG}
            element={
              <AuthGuard>
                <RouteGuard allow={['/onboarding/org']}>
                  <OnboardingOrgPage />
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
                  <ReviewPendingPage />
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
            path={ROUTES.VERIFY_MY_RECORD}
            element={
              <AuthGuard>
                <RouteGuard allow={MAIN_APP_DESTINATIONS}>
                  <VerifyMyRecordPage />
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

          {/* Billing routes — auth required, onboarding must be complete */}
          <Route
            path={ROUTES.BILLING}
            element={
              <AuthGuard>
                <RouteGuard allow={MAIN_APP_DESTINATIONS}>
                  <PricingPage />
                </RouteGuard>
              </AuthGuard>
            }
          />
          <Route
            path={ROUTES.BILLING_SUCCESS}
            element={
              <AuthGuard>
                <RouteGuard allow={MAIN_APP_DESTINATIONS}>
                  <CheckoutSuccessPage />
                </RouteGuard>
              </AuthGuard>
            }
          />
          <Route
            path={ROUTES.BILLING_CANCEL}
            element={
              <AuthGuard>
                <RouteGuard allow={MAIN_APP_DESTINATIONS}>
                  <CheckoutCancelPage />
                </RouteGuard>
              </AuthGuard>
            }
          />

          {/* Root redirects to dashboard (guards will bounce to correct destination) */}
          <Route path={ROUTES.HOME} element={<Navigate to={ROUTES.DASHBOARD} replace />} />

          {/* 404 — catch-all for unknown routes */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        </ProfileProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
