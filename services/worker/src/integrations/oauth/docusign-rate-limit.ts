const DOCUSIGN_DEFAULT_ACCOUNT_RATE_LIMIT_PER_HOUR = 3_000;
const DOCUSIGN_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const DOCUSIGN_MAX_RETRY_AFTER_MS = 30_000;
const DOCUSIGN_RATE_LIMIT_SWEEP_INTERVAL = 256;

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
let docusignAccountRateLimitClaimsSinceSweep = 0;

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
  // OAuth/token endpoints do not carry an account path segment; callers for those
  // routes must provide options.accountId so the guard stays active.
  let rawUrl: string;
  if (typeof input === 'string') {
    rawUrl = input;
  } else if (input instanceof URL) {
    rawUrl = input.toString();
  } else {
    rawUrl = input.url;
  }
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

function sweepExpiredDocusignAccountRateLimitEntries(nowMs: number): void {
  for (const [accountId, entry] of docusignAccountRateLimitStore) {
    if (entry.resetAtMs <= nowMs) {
      docusignAccountRateLimitStore.delete(accountId);
    }
  }
}

function assertReplayableFetchInput(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): void {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    throw new TypeError('DocuSign rate-limited fetch cannot retry Request inputs; pass a URL and replayable init body');
  }
  if (typeof ReadableStream !== 'undefined' && init?.body instanceof ReadableStream) {
    throw new TypeError('DocuSign rate-limited fetch cannot retry non-replayable ReadableStream bodies');
  }
}

export function claimDocusignAccountApiSlot(args: {
  accountId: string;
  now?: () => Date;
}): void {
  const nowMs = (args.now ?? (() => new Date()))().getTime();
  const existing = docusignAccountRateLimitStore.get(args.accountId);
  if (existing && existing.resetAtMs <= nowMs) {
    docusignAccountRateLimitStore.delete(args.accountId);
  }
  docusignAccountRateLimitClaimsSinceSweep += 1;
  if (docusignAccountRateLimitClaimsSinceSweep >= DOCUSIGN_RATE_LIMIT_SWEEP_INTERVAL) {
    docusignAccountRateLimitClaimsSinceSweep = 0;
    sweepExpiredDocusignAccountRateLimitEntries(nowMs);
  }

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
    assertReplayableFetchInput(input, init);
    const accountId = accountIdFromFetchInput(input) ?? options.accountId;
    if (accountId) {
      claimDocusignAccountApiSlot({
        accountId,
        now: options.now,
      });
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetchImpl(input, init);
      if (response.status !== 429 || attempt === 1) return response;

      const nowMs = (options.now ?? (() => new Date()))().getTime();
      const delayMs = retryAfterMs(response.headers.get('Retry-After'), nowMs) ?? 1000;
      await sleep(Math.min(delayMs, DOCUSIGN_MAX_RETRY_AFTER_MS));
    }
    throw new Error('unreachable_docusign_rate_limit_retry_state');
  };
}

export function resetDocusignAccountRateLimitStoreForTests(): void {
  docusignAccountRateLimitStore.clear();
  docusignAccountRateLimitClaimsSinceSweep = 0;
}

export function getDocusignAccountRateLimitStoreSizeForTests(): number {
  return docusignAccountRateLimitStore.size;
}
