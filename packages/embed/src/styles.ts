/**
 * Inline CSS for the embed widget. No Tailwind, no external font, no
 * external icons — everything is inlined to keep the bundle CSP-safe and
 * to avoid any cross-origin font loads.
 *
 * The brand color (#82b8d0) is the same Arkova accent used in the React
 * VerificationWidget. Font stack matches Apple/Roboto system defaults so
 * the widget visually inherits the host page's design language.
 */

export const ARKOVA_BRAND = '#82b8d0';

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/**
 * Build a single root style attribute for the outer card. Inline styles
 * sidestep CSP `style-src` issues that arise with injected <style> tags.
 */
export function rootCardStyle(mode: 'compact' | 'full'): string {
  const maxWidth = mode === 'compact' ? '320px' : '384px';
  return [
    `font-family: ${FONT_STACK}`,
    'box-sizing: border-box',
    'background: #ffffff',
    'border: 1px solid #e5e7eb',
    'border-radius: 8px',
    'box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05)',
    'overflow: hidden',
    `max-width: ${maxWidth}`,
    'color: #111827',
    'line-height: 1.4',
  ].join('; ');
}

export const STYLES = {
  loading: 'display: flex; align-items: center; justify-content: center; padding: 32px 0; color: #82b8d0;',
  errorBox: 'display: flex; flex-direction: column; align-items: center; padding: 24px 16px; text-align: center;',
  errorIcon: 'width: 32px; height: 32px; color: #ef4444; margin-bottom: 8px;',
  errorTitle: 'font-size: 14px; font-weight: 500; color: #111827; margin: 0;',
  errorSub: 'font-size: 12px; color: #6b7280; margin: 4px 0 0 0;',
  compactWrap: 'display: flex; align-items: center; gap: 12px; padding: 12px 16px;',
  compactIconOk: 'width: 20px; height: 20px; color: #22c55e; flex-shrink: 0;',
  compactIconRevoked: 'width: 20px; height: 20px; color: #6b7280; flex-shrink: 0;',
  compactTextWrap: 'min-width: 0; flex: 1;',
  compactTitle: 'font-size: 14px; font-weight: 500; color: #111827; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
  compactSub: 'font-size: 12px; color: #6b7280; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
  fullStatusOk: 'padding: 16px; text-align: center; background: #f0fdf4;',
  fullStatusRevoked: 'padding: 16px; text-align: center; background: #f9fafb;',
  fullStatusIconOk: 'width: 40px; height: 40px; color: #22c55e; margin: 0 auto 8px;',
  fullStatusIconRevoked: 'width: 40px; height: 40px; color: #6b7280; margin: 0 auto 8px;',
  fullStatusTitle: 'font-size: 18px; font-weight: 600; color: #111827; margin: 0;',
  detailsWrap: 'padding: 12px 16px;',
  detailRow: 'display: flex; justify-content: space-between; font-size: 13px; padding: 4px 0;',
  detailLabel: 'color: #6b7280;',
  detailValue: 'color: #111827; font-weight: 500; text-align: right; max-width: 60%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-left: 12px;',
  fingerprintRow: 'padding-top: 4px; font-size: 10px; color: #9ca3af;',
  footer: 'display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; border-top: 1px solid #f3f4f6;',
  footerLink: `font-size: 10px; color: ${ARKOVA_BRAND}; text-decoration: none;`,
  brandWrap: 'display: flex; align-items: center; gap: 4px;',
  brandText: 'font-size: 10px; color: #9ca3af; font-weight: 500;',
  brandDot: `display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${ARKOVA_BRAND};`,
};
