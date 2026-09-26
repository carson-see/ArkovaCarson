import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

const SIGNED_URL_SECONDS = 30;
/** Healthy lease refresh, comfortably inside the 30 s signature lifetime. */
const SIGNED_URL_REFRESH_MS = 25_000;
const SIGNED_URL_RETRY_BASE_MS = 5_000;
const SIGNED_URL_RETRY_MAX_MS = 60_000;
/** Consecutive failures after which we stop and stay on the fallback. */
const SIGNED_URL_MAX_FAILURES = 6;

/**
 * Statuses that will not become signable by waiting. The common one is a
 * private object the viewer is not allowed to read — another user's avatar
 * while their profile is not public, or one's own media on an AAL1 session.
 * Retrying those is pure noise against Storage.
 */
const TERMINAL_SIGNING_STATUS = new Set([400, 401, 403, 404]);

function isTerminalSigningError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const code = typeof status === 'number' ? status : Number(statusCode);
  return Number.isFinite(code) && TERMINAL_SIGNING_STATUS.has(code);
}

export function safeProfileMediaFallbackUrl(value?: string | null): string | undefined {
  if (!value) return undefined;
  // Browsers normalize slash-backslash forms (for example `/\\host/path`) as
  // network-path URLs. Reject controls and every backslash before parsing so a
  // value described as same-origin cannot escape to another host.
  if (value.includes('\\') || [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  })) return undefined;
  if (value.startsWith('/') && !value.startsWith('//')) {
    const parsed = new URL(value, 'https://arkova.invalid');
    return parsed.origin === 'https://arkova.invalid' ? `${parsed.pathname}${parsed.search}${parsed.hash}` : undefined;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

interface Props extends React.ImgHTMLAttributes<HTMLImageElement> {
  storagePath?: string | null;
  fallbackUrl?: string | null;
}

export function ProfileMediaImage({ storagePath, fallbackUrl, ...props }: Readonly<Props>) {
  const src = useProfileMediaUrl(storagePath, fallbackUrl);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (!src || failedSrc === src) return null;
  return <img {...props} src={src} referrerPolicy={props.referrerPolicy ?? 'no-referrer'} onError={(event) => {
    setFailedSrc(src);
    props.onError?.(event);
  }} />;
}

export function useProfileMediaUrl(storagePath?: string | null, fallbackUrl?: string | null) {
  const [signed, setSigned] = useState<{ path: string; url: string } | null>(null);

  useEffect(() => {
    let active = true;
    if (!storagePath) return () => { active = false; };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    // Why signing is currently stopped, so a recovery signal can decide
    // whether retrying is safe:
    //   'exhausted' — bounded transport/server retries ran out (SCRUM
    //     UAT-14 P2 review). A network/visibility recovery signal is exactly
    //     what should resume it — the outage that exhausted retries may
    //     simply be over.
    //   'terminal'  — the viewer isn't allowed to read this object right now
    //     (private media, wrong org, AAL1 session). Retrying on the same
    //     online/visibility signals would just be continuous unauthorized
    //     polling against Storage, so only a session/AAL change (sign-in,
    //     MFA step-up, token refresh) is a legitimate reason to reconsider.
    let stopReason: 'exhausted' | 'terminal' | null = null;

    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      // A hidden tab renders nothing; `visibilitychange` resumes immediately.
      if (!active || stopReason !== null || hidden()) return;
      timer = setTimeout(() => { void sign(); }, delay);
    };

    const sign = async () => {
      // Re-checked here, not only at schedule time: a timer armed while visible
      // still fires after the tab is hidden.
      if (!active || hidden()) return;
      try {
        const { data, error } = await supabase.storage.from('profile-media')
          .createSignedUrl(storagePath, SIGNED_URL_SECONDS);
        if (!active) return;
        if (!error && data?.signedUrl) {
          failures = 0;
          stopReason = null;
          setSigned({ path: storagePath, url: data.signedUrl });
          schedule(SIGNED_URL_REFRESH_MS);
          return;
        }
        setSigned(null);
        if (isTerminalSigningError(error)) { stopReason = 'terminal'; return; }
      } catch {
        // A thrown error is transport-level (offline, DNS) — retryable.
        if (!active) return;
        setSigned(null);
      }
      failures += 1;
      if (failures >= SIGNED_URL_MAX_FAILURES) { stopReason = 'exhausted'; return; }
      schedule(Math.min(SIGNED_URL_RETRY_BASE_MS * 2 ** (failures - 1), SIGNED_URL_RETRY_MAX_MS));
    };

    /**
     * A recovery signal fired. Only acts if signing is either not currently
     * stopped, or stopped for one of `allowedReasons` — e.g. a plain
     * online/visibility event must NOT resume a `'terminal'` stop (that would
     * be continuous unauthorized polling), only a session/AAL change should.
     */
    const recover = (allowedReasons: ReadonlyArray<'exhausted' | 'terminal'>) => {
      if (!active || hidden()) return;
      if (stopReason !== null && !allowedReasons.includes(stopReason)) return;
      failures = 0;
      stopReason = null;
      void sign();
    };

    const onVisibility = () => { if (!hidden()) recover(['exhausted']); };
    const onOnline = () => recover(['exhausted']);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);

    // Session/AAL change (sign-in, MFA step-up, token refresh) is the only
    // legitimate reason to reconsider a 'terminal' (permission) stop —
    // guarded with optional chaining so a test harness's minimal `supabase`
    // mock (storage-only, no `auth`) degrades to "no auth-driven recovery"
    // rather than throwing.
    const authSubscription = supabase.auth?.onAuthStateChange?.(() => {
      recover(['exhausted', 'terminal']);
    })?.data?.subscription;

    if (!hidden()) void sign();
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      authSubscription?.unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [storagePath]);

  return signed && signed.path === storagePath ? signed.url : safeProfileMediaFallbackUrl(fallbackUrl);
}
