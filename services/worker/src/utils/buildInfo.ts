/**
 * Build-time identity helpers (SCRUM-1247 / R0-1).
 *
 * Centralizes the BUILD_SHA env read so /health, admin-health, smoke
 * test, and any future caller share the same source of truth + sentinel.
 *
 * BUILD_SHA is baked at Docker build via `--build-arg BUILD_SHA=$github.sha`
 * (services/worker/Dockerfile + .github/workflows/deploy-worker.yml).
 */

const BUILD_SHA_RE = /^[0-9a-f]{40}$/i;

export function getBuildSha(): string {
  return process.env.BUILD_SHA ?? 'unknown';
}

export function isValidBuildSha(sha: string | undefined): boolean {
  return Boolean(sha) && sha !== 'unknown' && BUILD_SHA_RE.test(sha ?? '');
}
