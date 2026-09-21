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
    // Set when the object is not signable for this viewer at all, or after
    // SIGNED_URL_MAX_FAILURES in a row: we stay on the fallback until the
    // inputs change (which remounts this effect) rather than polling forever.
    let stopped = false;

    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      // A hidden tab renders nothing; `visibilitychange` resumes immediately.
      if (!active || stopped || hidden()) return;
      timer = setTimeout(() => { void sign(); }, delay);
    };

    const sign = async () => {
      // Re-checked here, not only at schedule time: a timer armed while visible
      // still fires after the tab is hidden.
      if (!active || stopped || hidden()) return;
      try {
        const { data, error } = await supabase.storage.from('profile-media')
          .createSignedUrl(storagePath, SIGNED_URL_SECONDS);
        if (!active) return;
        if (!error && data?.signedUrl) {
          failures = 0;
          setSigned({ path: storagePath, url: data.signedUrl });
          schedule(SIGNED_URL_REFRESH_MS);
          return;
        }
        setSigned(null);
        if (isTerminalSigningError(error)) { stopped = true; return; }
      } catch {
        // A thrown error is transport-level (offline, DNS) — retryable.
        if (!active) return;
        setSigned(null);
      }
      failures += 1;
      if (failures >= SIGNED_URL_MAX_FAILURES) { stopped = true; return; }
      schedule(Math.min(SIGNED_URL_RETRY_BASE_MS * 2 ** (failures - 1), SIGNED_URL_RETRY_MAX_MS));
    };

    const onVisibility = () => { if (!hidden()) void sign(); };
    document.addEventListener('visibilitychange', onVisibility);

    if (!hidden()) void sign();
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      if (timer) clearTimeout(timer);
    };
  }, [storagePath]);

  return signed && signed.path === storagePath ? signed.url : safeProfileMediaFallbackUrl(fallbackUrl);
}
