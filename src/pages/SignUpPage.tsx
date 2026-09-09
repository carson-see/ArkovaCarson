/**
 * Sign Up Page
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SignUpForm } from '@/components/auth';
import { AuthLayout } from '@/components/layout';
import { ROUTES } from '@/lib/routes';
import { OAuthEmailConfirmation } from '@/components/auth/OAuthEmailConfirmation';
import { useAuth } from '@/hooks/useAuth';
import { getEmailConfirmationToken, isEmailConfirmationPending } from '@/lib/oauthConfirmation';
import { AUTH_FORM_LABELS, OAUTH_EMAIL_CONFIRMATION_LABELS } from '@/lib/copy';

export function SignUpPage() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const [mailboxProof] = useState(getEmailConfirmationToken);
  const confirming = Boolean(mailboxProof) || isEmailConfirmationPending(session);

  return (
    <AuthLayout
      title={confirming ? OAUTH_EMAIL_CONFIRMATION_LABELS.TITLE : AUTH_FORM_LABELS.SIGNUP_TITLE}
      description={confirming ? OAUTH_EMAIL_CONFIRMATION_LABELS.DESCRIPTION : AUTH_FORM_LABELS.SIGNUP_DESCRIPTION}
    >
      {confirming ? <OAuthEmailConfirmation mailboxProof={mailboxProof} /> : <SignUpForm
        onSuccess={() => navigate(ROUTES.DASHBOARD)}
        onLoginClick={() => navigate(ROUTES.LOGIN)}
      />}
    </AuthLayout>
  );
}
