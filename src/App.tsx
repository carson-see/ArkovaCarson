/**
 * Arkova MVP - Main Application
 *
 * Uses react-router-dom for client-side routing.
 * AuthGuard protects authenticated routes (checks login).
 * RouteGuard enforces profile-based routing (onboarding flow).
 * Public routes (login, signup, verify) are accessible without auth.
 *
 * AUDIT-13: Route-level code splitting via React.lazy() reduces initial bundle.
 * AUDIT-07: RouteErrorBoundary wraps route sections for graceful sub-route errors.
 */

import React, { Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { ArkovaLogo } from '@/components/layout/ArkovaLogo';
import { Toaster } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useProfile, ProfileProvider } from '@/hooks/useProfile';
import { AuthGuard } from '@/components/auth/AuthGuard';
import { RouteGuard } from '@/components/auth/RouteGuard';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { RouteErrorBoundary } from '@/components/layout/RouteErrorBoundary';
import { ROUTES, MAIN_APP_DESTINATIONS, destinationToRoute } from '@/lib/routes';

// ── Lazy-loaded page components (AUDIT-13: route-level code splitting) ──────
const LoginPage = React.lazy(() => import('@/pages/LoginPage').then(m => ({ default: m.LoginPage })));
const SignUpPage = React.lazy(() => import('@/pages/SignUpPage').then(m => ({ default: m.SignUpPage })));
const DashboardPage = React.lazy(() => import('@/pages/DashboardPage').then(m => ({ default: m.DashboardPage })));
const OnboardingRolePage = React.lazy(() => import('@/pages/OnboardingRolePage').then(m => ({ default: m.OnboardingRolePage })));
const OnboardingOrgPage = React.lazy(() => import('@/pages/OnboardingOrgPage').then(m => ({ default: m.OnboardingOrgPage })));
const ReviewPendingPage = React.lazy(() => import('@/pages/ReviewPendingPage').then(m => ({ default: m.ReviewPendingPage })));
const MyRecordsPage = React.lazy(() => import('@/pages/MyRecordsPage').then(m => ({ default: m.MyRecordsPage })));
const OrganizationPage = React.lazy(() => import('@/pages/OrganizationPage').then(m => ({ default: m.OrganizationPage })));
const RecordDetailPage = React.lazy(() => import('@/pages/RecordDetailPage').then(m => ({ default: m.RecordDetailPage })));
const SettingsPage = React.lazy(() => import('@/pages/SettingsPage').then(m => ({ default: m.SettingsPage })));
const HelpPage = React.lazy(() => import('@/pages/HelpPage').then(m => ({ default: m.HelpPage })));
const PublicVerifyPage = React.lazy(() => import('@/components/public/PublicVerifyPage').then(m => ({ default: m.PublicVerifyPage })));
const WebhookSettingsPage = React.lazy(() => import('@/pages/WebhookSettingsPage').then(m => ({ default: m.WebhookSettingsPage })));
const CredentialTemplatesPage = React.lazy(() => import('@/pages/CredentialTemplatesPage').then(m => ({ default: m.CredentialTemplatesPage })));
const PricingPage = React.lazy(() => import('@/pages/PricingPage').then(m => ({ default: m.PricingPage })));
const CheckoutSuccessPage = React.lazy(() => import('@/pages/CheckoutSuccessPage').then(m => ({ default: m.CheckoutSuccessPage })));
const CheckoutCancelPage = React.lazy(() => import('@/pages/CheckoutCancelPage').then(m => ({ default: m.CheckoutCancelPage })));
const VerifyMyRecordPage = React.lazy(() => import('@/pages/VerifyMyRecordPage').then(m => ({ default: m.VerifyMyRecordPage })));
const NotFoundPage = React.lazy(() => import('@/pages/NotFoundPage').then(m => ({ default: m.NotFoundPage })));
const PrivacyPage = React.lazy(() => import('@/pages/PrivacyPage').then(m => ({ default: m.PrivacyPage })));
const TermsPage = React.lazy(() => import('@/pages/TermsPage').then(m => ({ default: m.TermsPage })));
const ContactPage = React.lazy(() => import('@/pages/ContactPage').then(m => ({ default: m.ContactPage })));
const ApiKeySettingsPage = React.lazy(() => import('@/pages/ApiKeySettingsPage').then(m => ({ default: m.ApiKeySettingsPage })));
const EmbedVerifyPage = React.lazy(() => import('@/pages/EmbedVerifyPage').then(m => ({ default: m.EmbedVerifyPage })));
const SearchPage = React.lazy(() => import('@/pages/SearchPage').then(m => ({ default: m.SearchPage })));
const IssuerRegistryPage = React.lazy(() => import('@/pages/IssuerRegistryPage').then(m => ({ default: m.IssuerRegistryPage })));
const MyCredentialsPage = React.lazy(() => import('@/pages/MyCredentialsPage').then(m => ({ default: m.MyCredentialsPage })));
const TreasuryAdminPage = React.lazy(() => import('@/pages/TreasuryAdminPage').then(m => ({ default: m.TreasuryAdminPage })));
const MemberDetailPage = React.lazy(() => import('@/pages/MemberDetailPage').then(m => ({ default: m.MemberDetailPage })));
const ReviewQueuePage = React.lazy(() => import('@/pages/ReviewQueuePage').then(m => ({ default: m.ReviewQueuePage })));
const AIReportsPage = React.lazy(() => import('@/pages/AIReportsPage').then(m => ({ default: m.AIReportsPage })));

/**
 * Redirect authenticated users away from login/signup.
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

/** Suspense fallback for lazy-loaded routes */
function RouteFallback() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="flex items-center space-x-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading...</span>
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
        <Suspense fallback={<RouteFallback />}>
        <Routes>
          {/* Public routes — no auth required */}
          <Route path={ROUTES.LOGIN} element={<PublicOnly><LoginPage /></PublicOnly>} />
          <Route path={ROUTES.SIGNUP} element={<PublicOnly><SignUpPage /></PublicOnly>} />
          <Route path={ROUTES.VERIFY} element={<RouteErrorBoundary section="PublicVerify"><PublicVerifyPage /></RouteErrorBoundary>} />
          <Route path={ROUTES.VERIFY_FORM} element={<RouteErrorBoundary section="PublicVerify"><PublicVerifyPage /></RouteErrorBoundary>} />
          <Route path={ROUTES.PRIVACY} element={<PrivacyPage />} />
          <Route path={ROUTES.TERMS} element={<TermsPage />} />
          <Route path={ROUTES.CONTACT} element={<ContactPage />} />
          <Route path={ROUTES.EMBED_VERIFY} element={<RouteErrorBoundary section="EmbedVerify"><EmbedVerifyPage /></RouteErrorBoundary>} />
          <Route path={ROUTES.SEARCH} element={<RouteErrorBoundary section="Search"><SearchPage /></RouteErrorBoundary>} />
          <Route path={ROUTES.ISSUER_REGISTRY} element={<RouteErrorBoundary section="IssuerRegistry"><IssuerRegistryPage /></RouteErrorBoundary>} />

          {/* OAuth callback — Supabase redirects here after Google sign-in */}
          <Route path={ROUTES.AUTH_CALLBACK} element={<Navigate to={ROUTES.DASHBOARD} replace />} />

          {/* Onboarding routes */}
          <Route path={ROUTES.ONBOARDING_ROLE} element={<AuthGuard><RouteGuard allow={['/onboarding/role']}><OnboardingRolePage /></RouteGuard></AuthGuard>} />
          <Route path={ROUTES.ONBOARDING_ORG} element={<AuthGuard><RouteGuard allow={['/onboarding/org']}><OnboardingOrgPage /></RouteGuard></AuthGuard>} />
          <Route path={ROUTES.REVIEW_PENDING} element={<AuthGuard><RouteGuard allow={['/review-pending']}><ReviewPendingPage /></RouteGuard></AuthGuard>} />

          {/* Main app routes — auth required, onboarding must be complete */}
          <Route path={ROUTES.DASHBOARD} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><RouteErrorBoundary section="Dashboard"><DashboardPage /></RouteErrorBoundary></RouteGuard></AuthGuard>} />
          <Route path={ROUTES.RECORDS} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><RouteErrorBoundary section="Records"><MyRecordsPage /></RouteErrorBoundary></RouteGuard></AuthGuard>} />
          <Route path={ROUTES.MY_CREDENTIALS} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><RouteErrorBoundary section="MyCredentials"><MyCredentialsPage /></RouteErrorBoundary></RouteGuard></AuthGuard>} />
          <Route path={ROUTES.RECORD_DETAIL} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><RouteErrorBoundary section="RecordDetail"><RecordDetailPage /></RouteErrorBoundary></RouteGuard></AuthGuard>} />
          <Route path={ROUTES.VERIFY_MY_RECORD} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><RouteErrorBoundary section="VerifyMyRecord"><VerifyMyRecordPage /></RouteErrorBoundary></RouteGuard></AuthGuard>} />
          <Route path={ROUTES.ORGANIZATION} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><RouteErrorBoundary section="Organization"><OrganizationPage /></RouteErrorBoundary></RouteGuard></AuthGuard>} />
          <Route path={ROUTES.MEMBER_DETAIL} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><RouteErrorBoundary section="MemberDetail"><MemberDetailPage /></RouteErrorBoundary></RouteGuard></AuthGuard>} />
          <Route path={ROUTES.SETTINGS} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><RouteErrorBoundary section="Settings"><SettingsPage /></RouteErrorBoundary></RouteGuard></AuthGuard>} />
          <Route path={ROUTES.SETTINGS_API_KEYS} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><RouteErrorBoundary section="ApiKeys"><ApiKeySettingsPage /></RouteErrorBoundary></RouteGuard></AuthGuard>} />
          <Route path={ROUTES.SETTINGS_WEBHOOKS} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><RouteErrorBoundary section="Webhooks"><WebhookSettingsPage /></RouteErrorBoundary></RouteGuard></AuthGuard>} />
          <Route path={ROUTES.CREDENTIAL_TEMPLATES} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><RouteErrorBoundary section="CredentialTemplates"><CredentialTemplatesPage /></RouteErrorBoundary></RouteGuard></AuthGuard>} />
          <Route path={ROUTES.HELP} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><HelpPage /></RouteGuard></AuthGuard>} />

          {/* AI Intelligence routes */}
          <Route path={ROUTES.REVIEW_QUEUE} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><RouteErrorBoundary section="ReviewQueue"><ReviewQueuePage /></RouteErrorBoundary></RouteGuard></AuthGuard>} />
          <Route path={ROUTES.AI_REPORTS} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><RouteErrorBoundary section="AIReports"><AIReportsPage /></RouteErrorBoundary></RouteGuard></AuthGuard>} />

          {/* Admin routes */}
          <Route path={ROUTES.ADMIN_TREASURY} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><RouteErrorBoundary section="Treasury"><TreasuryAdminPage /></RouteErrorBoundary></RouteGuard></AuthGuard>} />

          {/* Billing routes */}
          <Route path={ROUTES.BILLING} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><RouteErrorBoundary section="Billing"><PricingPage /></RouteErrorBoundary></RouteGuard></AuthGuard>} />
          <Route path={ROUTES.BILLING_SUCCESS} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><CheckoutSuccessPage /></RouteGuard></AuthGuard>} />
          <Route path={ROUTES.BILLING_CANCEL} element={<AuthGuard><RouteGuard allow={MAIN_APP_DESTINATIONS}><CheckoutCancelPage /></RouteGuard></AuthGuard>} />

          {/* Root redirects to dashboard */}
          <Route path={ROUTES.HOME} element={<Navigate to={ROUTES.DASHBOARD} replace />} />

          {/* 404 */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        </Suspense>
        </ProfileProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
