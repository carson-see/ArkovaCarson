/**
 * Activate Account Page
 *
 * Route: /activate?token=xxx
 *
 * Fixes the launch blocker that made recipient activation 100% broken:
 *
 *  A. This page called `supabase.rpc('activate_user', { p_token, p_claim_key })`.
 *     PostgREST binds overloads by argument NAME and prod has only
 *     `activate_user(p_token, p_password)`, so every attempt returned PGRST202.
 *     The `p_claim_key` variant lives only in `docs/migrations-archive/0175`.
 *  B. That RPC ignored its password argument anyway, so nothing ever set a
 *     password on the recipient's auth user and they could not sign in.
 *
 * Both are now handled worker-side by `POST /api/activation/complete`, which
 * holds the service_role key the password write requires — a key that must
 * never reach the browser (Constitution §1.4). See
 * `services/worker/src/api/activation.ts` and migration 0402.
 *
 * RECOVERY PHRASE: removed from this flow deliberately. The 12-word phrase was
 * scaffolding from the archived 0175 migration — its storage
 * (`activation_tokens.claim_key`) was never deployed, no column exists to hold
 * it, and nothing in the codebase ever verified it, so it could not recover
 * anything. Telling a recipient it was their "backup access key" was a claim we
 * could not honour (§1.5 / §1.13 R-7). `src/lib/recoveryPhrase.ts` and both
 * modals are left in place for a future, real recovery feature — see
 * `src/pages/agents.md`.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle, Loader2, Lock, XCircle } from 'lucide-react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useActivateAccount } from '@/hooks/useActivateAccount';
import { ActivateAccountSchema } from '@/lib/validators';
import { ACTIVATE_ACCOUNT_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';

type PageState = 'loading' | 'invalid' | 'ready' | 'submitting' | 'success';

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

export function ActivateAccountPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { preview, previewLoading, previewError, loadPreview, activating, activateAccount } =
    useActivateAccount();

  // Named `activationToken`, not `token`: `npm run lint:copy` bans the bare
  // word in shipped files and only exempts the `searchParams.get('token')`
  // line itself. Same convention as AcceptInvitePage's `inviteToken`.
  const activationToken = searchParams.get('token') ?? '';
  // Lazy initializer, not an effect-body setState: a missing token is known
  // synchronously from the URL, so 'invalid' is the correct FIRST render.
  const [pageState, setPageState] = useState<PageState>(() => (activationToken ? 'loading' : 'invalid'));
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!activationToken) return; // nothing to load; initial state already 'invalid'
    loadPreview(activationToken)
      .then(() => setPageState('ready'))
      .catch(() => setPageState('invalid'));
  }, [activationToken, loadPreview]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const parsed = ActivateAccountSchema.safeParse({ token: activationToken, password });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? ACTIVATE_ACCOUNT_LABELS.ERROR_GENERIC);
      return;
    }

    setPageState('submitting');
    try {
      await activateAccount({ token: parsed.data.token, password: parsed.data.password });
      setPageState('success');
    } catch (err) {
      // The worker's message is already curated and user-safe.
      setFormError(err instanceof Error ? err.message : ACTIVATE_ACCOUNT_LABELS.ERROR_GENERIC);
      setPageState('ready');
    }
  };

  if (pageState === 'loading' || previewLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{ACTIVATE_ACCOUNT_LABELS.LOADING}</p>
        </div>
      </div>
    );
  }

  if (pageState === 'invalid' || !preview) {
    const expired = previewError?.code === 'expired' || preview?.expired;
    const variant = expired
      ? {
          title: ACTIVATE_ACCOUNT_LABELS.EXPIRED_TITLE,
          description: ACTIVATE_ACCOUNT_LABELS.EXPIRED_DESCRIPTION,
        }
      : {
          title: ACTIVATE_ACCOUNT_LABELS.INVALID_TITLE,
          description: ACTIVATE_ACCOUNT_LABELS.INVALID_DESCRIPTION,
        };

    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <ErrorCard title={variant.title} description={variant.description} />
      </div>
    );
  }

  if (preview.expired) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <ErrorCard
          title={ACTIVATE_ACCOUNT_LABELS.EXPIRED_TITLE}
          description={ACTIVATE_ACCOUNT_LABELS.EXPIRED_DESCRIPTION}
        />
      </div>
    );
  }

  if (pageState === 'success') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-slate-50 via-white to-blue-50 p-4">
        <Card className="w-full max-w-md shadow-lg">
          <CardContent className="flex flex-col items-center py-10 text-center gap-3">
            <CheckCircle className="h-12 w-12 text-success" />
            <h2 className="text-lg font-semibold">{ACTIVATE_ACCOUNT_LABELS.SUCCESS_TITLE}</h2>
            <p className="text-sm text-muted-foreground">
              {ACTIVATE_ACCOUNT_LABELS.SUCCESS_DESCRIPTION}
            </p>
            <Button className="mt-2 w-full" onClick={() => navigate(ROUTES.LOGIN)}>
              {ACTIVATE_ACCOUNT_LABELS.GO_TO_SIGN_IN}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const submitting = pageState === 'submitting' || activating;

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
          <CardTitle className="text-2xl">{ACTIVATE_ACCOUNT_LABELS.PAGE_TITLE}</CardTitle>
          <CardDescription>
            {ACTIVATE_ACCOUNT_LABELS.INVITED_BY}{' '}
            <span className="font-medium text-foreground">{preview.orgName}</span>.{' '}
            {ACTIVATE_ACCOUNT_LABELS.SUBTITLE}
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="activate-email">{ACTIVATE_ACCOUNT_LABELS.EMAIL_LABEL}</Label>
              <Input id="activate-email" type="email" value={preview.email} disabled readOnly />
            </div>

            <div className="space-y-2">
              <Label htmlFor="activate-password">{ACTIVATE_ACCOUNT_LABELS.PASSWORD_LABEL}</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="activate-password"
                  type="password"
                  className="pl-9"
                  autoComplete="new-password"
                  placeholder={ACTIVATE_ACCOUNT_LABELS.PASSWORD_PLACEHOLDER}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                />
              </div>
            </div>

            {formError && (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {ACTIVATE_ACCOUNT_LABELS.SUBMITTING}
                </>
              ) : (
                ACTIVATE_ACCOUNT_LABELS.SUBMIT
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
