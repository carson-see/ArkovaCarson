/**
 * SCRUM-4989 — profile social links: one validator on the write path, one
 * href resolver on every render path.
 *
 * `profiles.social_links` used to be written from SettingsPage with no
 * validation and rendered by the dashboard ProfileCard straight into `href`.
 * A `javascript:` value was therefore stored and rendered as a clickable
 * link. Today the card only shows the viewer's own profile (self-XSS); the
 * moment it renders someone else's profile that is stored XSS. Constitution
 * §1.1 also requires Zod on every write path.
 *
 * Accepted input per key: an http(s) URL, a bare domain (we prefix https://),
 * or, for X (Twitter), an `@handle`. Anything else — any other scheme, an
 * empty host, control characters — is rejected on write and rendered as no
 * link at all on read, so a value that slipped in before this validator
 * cannot become an executable href.
 */
import { z } from 'zod';

export const SOCIAL_LINK_KEYS = ['linkedin', 'twitter', 'github', 'website'] as const;
export type SocialLinkKey = (typeof SOCIAL_LINK_KEYS)[number];
export type SocialLinks = Partial<Record<SocialLinkKey, string>>;

const MAX_LEN = 200;
const HANDLE_RE = /^@[A-Za-z0-9_]{1,30}$/;
const BARE_DOMAIN_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(\/\S*)?$/;
// Control characters and whitespace anywhere in the value: browsers strip
// some of these when parsing a URL, which is exactly how "java<LF>script:"
// becomes a live scheme.
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE_RE = /[\u0000-\u001f\u007f\s]/;

/** Resolve a stored value to a safe https href, or null if it must not be a link. */
export function safeSocialHref(key: SocialLinkKey, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_LEN) return null;
  if (CONTROL_OR_SPACE_RE.test(value)) return null;

  if (key === 'twitter' && HANDLE_RE.test(value)) {
    return `https://x.com/${value.slice(1)}`;
  }

  let candidate: string | null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    candidate = value;
  } else if (BARE_DOMAIN_RE.test(value)) {
    candidate = `https://${value}`;
  } else {
    candidate = null;
  }
  if (!candidate) return null;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!parsed.hostname || !parsed.hostname.includes('.')) return null;
  return parsed.toString();
}

/**
 * Narrow any stored `profiles.social_links` value to the four keys we render,
 * string values only. The column was an unvalidated jsonb for its whole
 * history, so a row can carry legacy keys; they are dropped on read so they
 * never reach the settings form or the write-path schema.
 */
export function pickSocialLinks(raw: unknown): SocialLinks {
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as Record<string, unknown>;
  const picked: SocialLinks = {};
  for (const key of SOCIAL_LINK_KEYS) {
    const value = record[key];
    if (typeof value === 'string') picked[key] = value;
  }
  return picked;
}

/** Every known key resolved to a safe href; keys that must not be links are absent. */
export function resolveSocialLinks(raw: unknown): Partial<Record<SocialLinkKey, string>> {
  const resolved: Partial<Record<SocialLinkKey, string>> = {};
  for (const [key, value] of Object.entries(pickSocialLinks(raw)) as [SocialLinkKey, string][]) {
    const href = safeSocialHref(key, value);
    if (href) resolved[key] = href;
  }
  return resolved;
}

const linkField = (key: SocialLinkKey) =>
  z
    .string()
    .trim()
    .max(MAX_LEN)
    .refine((v) => v === '' || safeSocialHref(key, v) !== null, { message: key })
    .optional();

/**
 * Write-path schema: every present key must resolve to a safe href (or be
 * empty). Unknown keys are STRIPPED, not rejected — a legacy key that a user
 * never touched must not make the form un-saveable (review on PR #2840).
 */
export const SocialLinksInputSchema = z
  .object({
    linkedin: linkField('linkedin'),
    twitter: linkField('twitter'),
    github: linkField('github'),
    website: linkField('website'),
  })
  .strip();

export function parseSocialLinksForWrite(
  input: Record<string, string | undefined>,
): { ok: true; value: SocialLinks | null } | { ok: false; key: SocialLinkKey } {
  const result = SocialLinksInputSchema.safeParse(input);
  if (!result.success) {
    // Every issue is field-level now (unknown keys are stripped, so no
    // root-level unrecognized_keys issue can occur); the fallback only guards
    // a future schema-level refine.
    const issue = result.error.issues[0];
    const path = issue?.path?.[0];
    const key = (SOCIAL_LINK_KEYS as readonly string[]).includes(String(path))
      ? (path as SocialLinkKey)
      : 'website';
    return { ok: false, key };
  }
  const cleaned = Object.fromEntries(
    Object.entries(result.data).filter(([, v]) => typeof v === 'string' && v.trim().length > 0),
  ) as SocialLinks;
  return { ok: true, value: Object.keys(cleaned).length > 0 ? cleaned : null };
}
