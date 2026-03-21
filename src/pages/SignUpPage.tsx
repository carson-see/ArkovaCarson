/**
 * Sign Up Page
 */

import { useNavigate } from 'react-router-dom';
import { SignUpForm } from '@/components/auth';
import { AuthLayout } from '@/components/layout';
import { ROUTES } from '@/lib/routes';
import { AUTH_FORM_LABELS } from '@/lib/copy';

export function SignUpPage() {
  const navigate = useNavigate();

  return (
    <AuthLayout
      title={AUTH_FORM_LABELS.SIGNUP_TITLE}
      description={AUTH_FORM_LABELS.SIGNUP_DESCRIPTION}
    >
      <SignUpForm
        onSuccess={() => navigate(ROUTES.DASHBOARD)}
        onLoginClick={() => navigate(ROUTES.LOGIN)}
      />
    </AuthLayout>
  );
}
