/**
 * One parser for `COMPUTEID_WEBHOOK_SECRET`, used by BOTH the boot-time
 * config check and the request-time verifier so they cannot disagree
 * (a value like "," must fail at boot, not 503 every delivery).
 */
export function parseSecretList(value: string | undefined | null): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
