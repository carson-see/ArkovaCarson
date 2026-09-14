/**
 * Shared Arkova email layout helpers.
 *
 * Extracted from grace-warning.ts and parent-delinquent-split.ts to keep
 * the branded wrapper, escaping, and date formatting in one place.
 * Per-template colored callouts stay in the calling file.
 */

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * SCRUM-5023 — sanitise user-controlled text destined for a SUBJECT LINE.
 *
 * `esc()` is the wrong tool here: a subject is not HTML, so escaping would
 * ship a literal `&quot;` to the reader's inbox. What a subject cannot carry
 * is control characters — CR/LF in particular, the classic header-injection
 * primitive. Arkova sends through Resend's JSON API, which builds the message
 * itself, so injection is not reachable today; this is defence that does not
 * depend on a third party's parser staying the way it is.
 *
 * The reachable problem is quieter: an API key's name is caller-supplied and
 * lands inside quotes in the subject, so a name containing its own quotes and
 * clauses lets one ORG_ADMIN forge the shape of a system notice to their
 * colleagues. Collapsing whitespace and bounding the length removes the room
 * to build one.
 */
export function subjectSafe(value: string, maxLength = 120): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point.
  const flattened = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (flattened.length <= maxLength) return flattened;
  return `${flattened.slice(0, maxLength - 1).trimEnd()}\u2026`;
}

/**
 * "today" / "in 1 day" / "in N days" — never "in 0 days" or "in 1 days".
 * `null` means the caller could not compute a remaining count.
 */
export function relativeDaysLabel(days: number | null): string {
  if (days === null) return 'soon';
  if (days <= 0) return 'today';
  if (days === 1) return 'in 1 day';
  return `in ${days} days`;
}

export const SHARED_STYLES = {
  container: 'font-family: "Helvetica Neue", Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background-color: #ffffff;',
  header: 'text-align: center; margin-bottom: 32px;',
  logo: 'font-size: 24px; font-weight: 700; color: #0f172a;',
  body: 'font-size: 16px; line-height: 1.6; color: #334155;',
  button: 'display: inline-block; padding: 12px 32px; background-color: #0f172a; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;',
  footer: 'margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center;',
  muted: 'color: #64748b; font-size: 14px;',
} as const;

export function wrapTemplate(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f8fafc;">
  <div style="${SHARED_STYLES.container}">
    <div style="${SHARED_STYLES.header}">
      <span style="${SHARED_STYLES.logo}">Arkova</span>
    </div>
    <div style="${SHARED_STYLES.body}">
      ${content}
    </div>
    <div style="${SHARED_STYLES.footer}">
      <p>Arkova &mdash; Trusted Credential Infrastructure</p>
      <p style="margin-top: 8px;">This is an automated message. Please do not reply directly.</p>
    </div>
  </div>
</body>
</html>`;
}

export function formatUtc(value: string | Date, fallback: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}
