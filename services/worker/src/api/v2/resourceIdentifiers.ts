export const PUBLIC_ORG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;
export const PUBLIC_ANCHOR_ID_RE = /^ARK-[A-Z0-9-]{3,60}$/;
export const SHA256_HEX_RE = /^[a-fA-F0-9]{64}$/;
const POSTGREST_FILTER_GRAMMAR_CHARS = /[%_\\,().]/g;
const POSTGREST_ESCAPE_PREFIX = '\\';

// Escape characters that have special meaning in PostgREST filter grammar.
export function sanitizeFilterValue(v: string): string {
  return v.replaceAll(
    POSTGREST_FILTER_GRAMMAR_CHARS,
    c => `${POSTGREST_ESCAPE_PREFIX}${c}`,
  );
}

export function visibleAnchorScope(orgId: string | null | undefined): string {
  return orgId
    ? `status.eq.SECURED,org_id.eq.${sanitizeFilterValue(orgId)}`
    : 'status.eq.SECURED';
}
