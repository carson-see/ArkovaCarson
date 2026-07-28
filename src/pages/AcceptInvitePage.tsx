/**
 * Accept Invite Page (SCRUM-3012)
 *
 * Route: /accept-invite?token=...
 *
 * Fixes the org-invite flow end-to-end: the emailed link now carries the
 * real invitation token (see services/worker/src/routes/anchor.ts), and this
 * page is the missing consumer of it — preview the invitation, then either
 * join directly (already signed in with the matching email) or create a new
 * account (worker-provisioned, never via a client-side supabase.auth.signUp
 * call — see services/worker/src/api/invitations.ts).
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { CheckCircle, Loader2, Lock, Mail, User, XCircle } from 'lucide-react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmailConfirmation } from '@/components/onboarding/EmailConfirmation';
import { useAuth } from '@/hooks/useAuth';
import { useAcceptInvite, type AcceptInvitationResponse } from '@/hooks/useAcceptInvite';
import { AcceptInvitationSchema } from '@/lib/validators';
import { ACCEPT_INVITE_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';

type PageState = 'loading' | 'invalid' | 'ready' | 'submitting' | 'success' | 'error';

function ErrorCard({ title, description }: Readonly<{ title: string; description: string }>) {
  return (
    <Card className="w-full max-w-md shadow-lg">
      <CardContent className="flex flex-col items-center py-10 text-center gap-3">
        <XCircle className="h-12 w-12 text-destructive" />
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

export function AcceptInvitePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { preview, previewLoading, previewError, loadPreview, accepting, acceptError, acceptInvitation } =
    useAcceptInvite();

  const token = searchParams.get('token') ?? '';
  // Lazy initializer, not an effect-body setState: a missing token is known
  // synchronously from the URL, so 'invalid' is the correct FIRST render —
  // no effect ever needs to run for that case.
  const [pageState, setPageState] = useState<PageState>(() => (token ? 'loading' : 'invalid'));
  const [result, setResult] = useState<AcceptInvitationResponse | null>(null);
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return; // nothing to load; initial state already 'invalid'
    loadPreview(token)
      .then(() => setPageState('ready'))
      .catch(() => setPageState('invalid'));
  }, [token, loadPreview]);

  const callerEmailMatches =
    !!user?.email && !!preview?.email && user.email.toLowerCase() === preview.email.toLowerCase();

  const handleJoin = async () => {
    setFormError(null);
    setPageState('submitting');
    try {
      const accepted = await acceptInvitation({ token });
      setResult(accepted);
      setPageState('success');
    } catch {
      setPageState('ready');
    }
  };

  const handleCreateAndJoin = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const parsed = AcceptInvitationSchema.safeParse({ token, password, fullName });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? ACCEPT_INVITE_LABELS.ERROR_GENERIC);
      return;
    }

    setPageState('submitting');
    try {
      const accepted = await acceptInvitation(parsed.data);
      setResult(accepted);
      setPageState('success');
    } catch {
      setPageState('ready');
    }
  };

  if (pageState === 'loading' || previewLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{ACCEPT_INVITE_LABELS.LOADING}</p>
        </div>
      </div>
    );
  }

  if (pageState === 'invalid' || !preview) {
    const code = previewError?.code;
    const variant =
      code === 'expired'
        ? { title: ACCEPT_INVITE_LABELS.EXPIRED_TITLE, description: ACCEPT_INVITE_LABELS.EXPIRED_DESCRIPTION }
        : code === 'already_used'
          ? {
              title: ACCEPT_INVITE_LABELS.ALREADY_USED_TITLE,
              description: ACCEPT_INVITE_LABELS.ALREADY_USED_DESCRIPTION,
            }
          : { title: ACCEPT_INVITE_LABELS.INVALID_TITLE, description: ACCEPT_INVITE_LABELS.INVALID_DESCRIPTION };

    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <ErrorCard title={variant.title} description={variant.description} />
      </div>
    );
  }

  if (pageState === 'success' && result) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-slate-50 via-white to-blue-50 p-4">
        {result.verificationRequired ? (
          <div className="w-full max-w-md space-y-4">
            <EmailConfirmation email={preview.email} />
            {!result.verificationEmailSent && (
              <Alert variant="destructive">
                <AlertDescription>{ACCEPT_INVITE_LABELS.VERIFICATION_EMAIL_FAILED}</AlertDescription>
              </Alert>
            )}
          </div>
        ) : (
          <Card className="w-full max-w-md shadow-lg">
            <CardContent className="flex flex-col items-center py-10 text-center gap-3">
              <CheckCircle className="h-12 w-12 text-success" />
              <h2 className="text-lg font-semibold">{ACCEPT_INVITE_LABELS.SUCCESS_JOINED_TITLE}</h2>
              <p className="text-sm text-muted-foreground">{ACCEPT_INVITE_LABELS.SUCCESS_JOINED_DESCRIPTION}</p>
              <Button className="w-full" onClick={() => navigate(ROUTES.DASHBOARD)}>
                {ACCEPT_INVITE_LABELS.GO_TO_DASHBOARD}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  const submitting = pageState === 'submitting' || accepting;
  const displayError = formError || acceptError?.message;
  const roleLabel =
    preview.role === 'ORG_ADMIN' ? ACCEPT_INVITE_LABELS.AS_AN_ADMINISTRATOR : ACCEPT_INVITE_LABELS.AS_A_MEMBER;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-slate-50 via-white to-blue-50 p-4">
      <div className="flex items-center gap-2 mb-8">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
          <ArkovaIcon className="h-5 w-5 text-primary-foreground" />
        </div>
        <span className="text-xl font-semibold">Arkova</span>
      </div>

      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{ACCEPT_INVITE_LABELS.PAGE_TITLE}</CardTitle>
          <CardDescription>
            {ACCEPT_INVITE_LABELS.INVITED_TO_JOIN} <strong>{preview.orgName}</strong> {roleLabel}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {displayError && (
            <Alert variant="destructive">
              <AlertDescription>{displayError}</AlertDescription>
            </Alert>
          )}

          {acceptError?.code === 'account_exists' && (
            <Alert>
              <AlertDescription>
                {ACCEPT_INVITE_LABELS.ACCOUNT_EXISTS_DESCRIPTION}{' '}
                <Link to={ROUTES.LOGIN} className="font-medium text-primary hover:text-primary/80">
                  {ACCEPT_INVITE_LABELS.SIGN_IN_TO_ACCEPT}
                </Link>
              </AlertDescription>
            </Alert>
          )}

          {callerEmailMatches ? (
            <Button className="w-full" size="lg" disabled={submitting} onClick={handleJoin}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {ACCEPT_INVITE_LABELS.JOINING}
                </>
              ) : (
                ACCEPT_INVITE_LABELS.CREATE_AND_JOIN
              )}
            </Button>
          ) : (
            <form onSubmit={handleCreateAndJoin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="inviteFullName">{ACCEPT_INVITE_LABELS.FULL_NAME_LABEL}</Label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="inviteFullName"
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    disabled={submitting}
                    className="pl-10"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="inviteEmail">{ACCEPT_INVITE_LABELS.EMAIL_LABEL}</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input id="inviteEmail" type="email" value={preview.email} disabled className="pl-10" />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="invitePassword">{ACCEPT_INVITE_LABELS.PASSWORD_LABEL}</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="invitePassword"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={ACCEPT_INVITE_LABELS.PASSWORD_PLACEHOLDER}
                    minLength={8}
                    required
                    disabled={submitting}
                    className="pl-10"
                  />
                </div>
              </div>

              <Button type="submit" className="w-full" size="lg" disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {ACCEPT_INVITE_LABELS.JOINING}
                  </>
                ) : (
                  ACCEPT_INVITE_LABELS.CREATE_AND_JOIN
                )}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
