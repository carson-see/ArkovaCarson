import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import { ROUTES } from '@/lib/routes';
import { OAUTH_EMAIL_CONFIRMATION_LABELS as LABELS } from '@/lib/copy';
import { clearEmailConfirmationToken, isEmailConfirmationPending } from '@/lib/oauthConfirmation';
import { getConfirmationStatus, sendConfirmationEmail, completeEmailConfirmation, ConfirmationError } from '@/lib/emailConfirmationApi';

function confirmationDescription(hasProof: boolean, sent: boolean, busy: boolean) {
  if (hasProof) return LABELS.LINK_DESCRIPTION;
  if (sent) return LABELS.SENT;
  return busy ? LABELS.PREPARING : LABELS.UNSENT;
}

export function OAuthEmailConfirmation({ mailboxProof }: Readonly<{ mailboxProof: string | null }>) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(!mailboxProof);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const [completeWithoutSession, setCompleteWithoutSession] = useState(false);
  const setCooldown = useCallback((duration: number) => {
    const timestamp = Date.now();
    setNow(timestamp);
    setRetryAt(timestamp + duration * 1000);
  }, []);
  const showError = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : LABELS.RETRY);
    if (cause instanceof ConfirmationError) setCooldown(cause.retryAfterSeconds);
  }, [setCooldown]);
  const resume = useCallback(async () => {
    const { data, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !data.session || isEmailConfirmationPending(data.session)) throw new Error(LABELS.REFRESH_FAILED);
    navigate(ROUTES.DASHBOARD, { replace: true });
  }, [navigate]);
  const send = useCallback(async () => {
    const result = await sendConfirmationEmail();
    if (!result.required) { await resume(); return; }
    setSent(Boolean(result.sent));
    setCooldown(result.retryAfterSeconds ?? 0);
  }, [resume, setCooldown]);

  useEffect(() => {
    if (mailboxProof) return;
    let cancelled = false;
    void getConfirmationStatus().then(async (state) => {
      if (cancelled) return;
      if (!state.required) { await resume(); return; }
      setSent(Boolean(state.sent));
      setCooldown(state.retryAfterSeconds ?? 0);
      if (!state.sent && !state.retryAfterSeconds) await send();
    }).catch((cause: unknown) => { if (!cancelled) showError(cause); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [mailboxProof, resume, send, showError, setCooldown]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const act = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await operation(); } catch (cause) { showError(cause); } finally { setBusy(false); }
  };
  const leaveAccount = async () => {
    sessionStorage.setItem('arkova_signed_out', '1');
    try {
      if (user) {
        const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
        if (signOutError) throw new Error(LABELS.RETRY);
      }
    } catch {
      sessionStorage.removeItem('arkova_signed_out');
      throw new Error(LABELS.RETRY);
    }
    clearEmailConfirmationToken();
    // Same hard-navigation convention as useAuth: avoid profile teardown races.
    window.location.href = ROUTES.LOGIN;
  };
  const confirm = async () => {
    if (!mailboxProof) return;
    const result = await completeEmailConfirmation(mailboxProof);
    if (!result.complete) throw new Error(LABELS.RETRY);
    if (!result.session) { setCompleteWithoutSession(true); return; }
    const { data, error: sessionError } = await supabase.auth.setSession(result.session);
    if (sessionError || !data.session || isEmailConfirmationPending(data.session)) {
      setCompleteWithoutSession(true); return;
    }
    clearEmailConfirmationToken();
    navigate(ROUTES.DASHBOARD, { replace: true });
  };

  return <div className="space-y-5 text-center">
    <Mail className="mx-auto h-10 w-10 text-primary" aria-hidden="true" />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {completeWithoutSession ? <>
      <output className="block">{LABELS.COMPLETE_SIGN_IN}</output>
      <Button className="w-full" disabled={busy} onClick={() => void act(leaveAccount)}>{LABELS.SIGN_IN}</Button>
    </> : <>
      <output className="block text-sm text-muted-foreground">
        {confirmationDescription(Boolean(mailboxProof), sent, busy)}
      </output>
      {mailboxProof && user && <p className="text-sm text-muted-foreground">{LABELS.SWITCH_NOTE}</p>}
      {mailboxProof ? <Button className="w-full" disabled={busy} onClick={() => void act(confirm)}>
        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{busy ? LABELS.WORKING : LABELS.CONFIRM}
      </Button> : <>
        <Button className="w-full" disabled={busy} onClick={() => void act(async () => {
          const state = await getConfirmationStatus();
          if (state.required) throw new Error(LABELS.UNSENT);
          await resume();
        })}>{LABELS.CHECK}</Button>
        <Button variant="outline" className="w-full" disabled={busy || seconds > 0} onClick={() => void act(send)}>
          {seconds > 0 ? `${LABELS.RESEND_WAIT} ${seconds}s` : LABELS.RESEND}
        </Button>
      </>}
      <Button variant="ghost" className="w-full" disabled={busy} onClick={() => void act(leaveAccount)}>{LABELS.SIGN_OUT}</Button>
    </>}
  </div>;
}
