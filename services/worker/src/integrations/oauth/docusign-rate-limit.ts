const DOCUSIGN_DEFAULT_ACCOUNT_RATE_LIMIT_PER_HOUR = 3_000;
const DOCUSIGN_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

interface DocusignAccountRateLimitEntry {
  count: number;
  resetAtMs: number;
}

interface DocusignRateLimitedFetchOptions {
  accountId?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const docusignAccountRateLimitStore = new Map<string, DocusignAccountRateLimitEntry>();

export class DocusignRateLimitError extends Error {
  readonly accountId: string;
  readonly retryAfterSeconds: number;

  constructor(accountId: string, retryAfterSeconds: number) {
    super(`DocuSign account API rate limit exceeded; retry after ${retryAfterSeconds}s`);
    this.name = 'DocusignRateLimitError';
    this.accountId = accountId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function accountIdFromFetchInput(input: Parameters<typeof fetch>[0]): string | undefined {
  const rawUrl = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    const accountIndex = segments.indexOf('accounts');
    const accountId = accountIndex >= 0 ? segments[accountIndex + 1] : undefined;
    return accountId ? decodeURIComponent(accountId) : undefined;
  } catch {
    return undefined;
  }
}

function retryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs);
  return undefined;
}

export function claimDocusignAccountApiSlot(args: {
  accountId: string;
  now?: () => Date;
}): void {
  const nowMs = (args.now ?? (() => new Date()))().getTime();
  const existing = docusignAccountRateLimitStore.get(args.accountId);
  const entry = existing && existing.resetAtMs > nowMs
    ? existing
    : { count: 0, resetAtMs: nowMs + DOCUSIGN_RATE_LIMIT_WINDOW_MS };

  if (entry.count >= DOCUSIGN_DEFAULT_ACCOUNT_RATE_LIMIT_PER_HOUR) {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAtMs - nowMs) / 1000));
    throw new DocusignRateLimitError(args.accountId, retryAfterSeconds);
  }

  entry.count += 1;
  docusignAccountRateLimitStore.set(args.accountId, entry);
}

export function createDocusignRateLimitedFetch(
  options: DocusignRateLimitedFetchOptions,
): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (input, init) => {
    const accountId = accountIdFromFetchInput(input) ?? options.accountId;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (accountId) {
        claimDocusignAccountApiSlot({
          accountId,
          now: options.now,
        });
      }
      const response = await fetchImpl(input, init);
      if (response.status !== 429 || attempt === 1) return response;

      const nowMs = (options.now ?? (() => new Date()))().getTime();
      const delayMs = retryAfterMs(response.headers.get('Retry-After'), nowMs) ?? 1000;
      await sleep(delayMs);
    }
    return fetchImpl(input, init);
  };
}

export function resetDocusignAccountRateLimitStoreForTests(): void {
  docusignAccountRateLimitStore.clear();
}
