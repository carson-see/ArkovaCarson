import { CONNECTIONS_LABELS } from '@/lib/copy';

interface OAuthStartBody {
  authorizationUrl?: string;
  url?: string;
  error?: string;
  code?: string;
}

/** Provider-specific denials stay with each card; the successful URL contract is shared. */
export async function followSignatureOAuthStart(
  response: Response,
  denialCopy: (body: OAuthStartBody, status: number) => string,
): Promise<string | null> {
  const body = await response.json().catch(() => ({})) as OAuthStartBody;
  if (!response.ok) return denialCopy(body, response.status);
  const nextUrl = body.authorizationUrl ?? body.url;
  if (!nextUrl) return CONNECTIONS_LABELS.CONNECT_FAILED;
  window.location.assign(nextUrl);
  return null;
}
