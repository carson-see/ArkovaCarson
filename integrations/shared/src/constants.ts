/**
 * Default Arkova API base URL — the public API gateway, not the raw Cloud
 * Run revision host. The raw host has no Cloudflare origin guard in front
 * of it; SCRUM-3888 enforces that guard and 403s direct requests to it
 * going forward. See packages/sdk/src/client.ts and
 * packages/embed/src/index.ts for the sibling fixes (2026-09-21).
 */
export const ARKOVA_DEFAULT_URL = 'https://api.arkova.ai';
