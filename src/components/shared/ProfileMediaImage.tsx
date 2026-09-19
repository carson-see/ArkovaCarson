import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

const SIGNED_URL_SECONDS = 30;
const SIGNED_URL_REFRESH_MS = 25_000;
const SIGNED_URL_RETRY_MS = 5_000;

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
    const sign = async () => {
      let retryIn = SIGNED_URL_RETRY_MS;
      try {
        const { data, error } = await supabase.storage.from('profile-media')
          .createSignedUrl(storagePath, SIGNED_URL_SECONDS);
        if (!active) return;
        if (!error && data?.signedUrl) {
          setSigned({ path: storagePath, url: data.signedUrl });
          retryIn = SIGNED_URL_REFRESH_MS;
        } else {
          setSigned(null);
        }
      } catch {
        if (!active) return;
        setSigned(null);
      }
      if (active) timer = setTimeout(() => { void sign(); }, retryIn);
    };
    void sign();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [storagePath]);

  return signed && signed.path === storagePath ? signed.url : safeProfileMediaFallbackUrl(fallbackUrl);
}
