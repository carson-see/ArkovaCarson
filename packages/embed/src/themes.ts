/**
 * Theme support for the Arkova embed widget (MVP-14).
 *
 * Themes are applied post-render by mutating inline styles on the rendered
 * DOM tree. This avoids any CSP issues with injected <style> tags.
 */

/** Dark theme color overrides — applied in a single pass to avoid cascading. */
const DARK_PAIRS: Array<[string, string]> = [
  // Card background + text (ordered long→short to avoid substring collisions)
  ['#ffffff', '#1f2937'],
  ['#111827', '#f9fafb'],
  // Status backgrounds
  ['#f0fdf4', '#064e3b'],
  // Borders + neutral backgrounds (order matters: #f9fafb before #f3f4f6)
  ['#f3f4f6', '#374151'],
  ['#e5e7eb', '#374151'],
  // Secondary text
  ['#9ca3af', '#d1d5db'],
  ['#6b7280', '#9ca3af_TEMP'],
  // Error
  ['#ef4444', '#f87171'],
];

/** Second pass: resolve temp markers. */
const TEMP_RESOLVE: Array<[string, string]> = [
  ['#9ca3af_TEMP', '#9ca3af'],
];

/** Apply all overrides to a single style string. */
function transformStyle(style: string): string {
  let result = style;
  for (const [light, dark] of DARK_PAIRS) {
    result = result.replaceAll(light, dark);
  }
  for (const [temp, final] of TEMP_RESOLVE) {
    result = result.replaceAll(temp, final);
  }
  // Adjust box-shadow opacity for dark mode
  result = result.replace('rgba(0,0,0,0.05)', 'rgba(0,0,0,0.3)');
  return result;
}

/**
 * Walk a DOM subtree and swap light-theme colors for dark-theme equivalents
 * in any inline `style` attributes.
 */
export function applyDarkTheme(root: HTMLElement): void {
  // Process root element
  if (root.hasAttribute('style')) {
    root.setAttribute('style', transformStyle(root.getAttribute('style')!));
  }
  // Process all descendants with style attributes
  const styled = root.querySelectorAll<HTMLElement>('[style]');
  for (const el of styled) {
    el.setAttribute('style', transformStyle(el.getAttribute('style')!));
  }
}

/**
 * Apply light theme — this is a no-op since light is the default.
 * Exported for API symmetry.
 */
export function applyLightTheme(_root: HTMLElement): void {
  // Light is the default — no overrides needed.
}
