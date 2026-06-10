const SHARED_STAGING_HOSTS = new Set([
  'arkova-worker-staging-kvojbeutfa-uc.a.run.app',
  'arkova-worker-staging-270018525501.us-central1.run.app',
]);

function formatEnvError(message: string): Error {
  return new Error(`${message} Set STAGING_API_BASE to the per-PR Cloud Run tag URL printed by scripts/staging/deploy.sh.`);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function isPrTagHostname(hostname: string): boolean {
  const prefix = 'pr-';
  const separator = '---';
  if (!hostname.startsWith(prefix)) return false;
  const separatorIndex = hostname.indexOf(separator, prefix.length);
  if (separatorIndex <= prefix.length) return false;
  const prNumber = hostname.slice(prefix.length, separatorIndex);
  return [...prNumber].every((char) => char >= '0' && char <= '9');
}

export function resolveStagingApiBase(env: { STAGING_API_BASE?: string }): string {
  const raw = env.STAGING_API_BASE?.trim();
  if (!raw) {
    throw formatEnvError('STAGING_API_BASE is required for load-harness runs.');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw formatEnvError(`STAGING_API_BASE must be an absolute URL; received \`${raw}\`.`);
  }

  if (url.protocol !== 'https:') {
    throw formatEnvError(`STAGING_API_BASE must use https; received \`${url.protocol}\`.`);
  }

  if (SHARED_STAGING_HOSTS.has(url.hostname)) {
    throw formatEnvError(`STAGING_API_BASE points at shared/main staging (${url.hostname}), which would contaminate parallel soaks.`);
  }

  if (!isPrTagHostname(url.hostname)) {
    throw formatEnvError(`STAGING_API_BASE must be a tag-routed per-PR Cloud Run URL; received host \`${url.hostname}\`.`);
  }

  url.pathname = trimTrailingSlashes(url.pathname);
  url.search = '';
  url.hash = '';
  return trimTrailingSlashes(url.toString());
}
