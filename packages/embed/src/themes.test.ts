import { describe, it, expect } from 'vitest';
import { applyDarkTheme, applyLightTheme } from './themes';

describe('themes', () => {
  it('applyDarkTheme swaps light background to dark', () => {
    const el = document.createElement('div');
    el.setAttribute('style', 'background: #ffffff; color: #111827;');
    applyDarkTheme(el);
    expect(el.getAttribute('style')).toContain('#1f2937');
    expect(el.getAttribute('style')).toContain('#f9fafb');
  });

  it('applyDarkTheme swaps border colors', () => {
    const el = document.createElement('div');
    el.setAttribute('style', 'border: 1px solid #e5e7eb;');
    applyDarkTheme(el);
    expect(el.getAttribute('style')).toContain('#374151');
  });

  it('applyDarkTheme swaps secondary text colors', () => {
    const el = document.createElement('div');
    el.setAttribute('style', 'color: #6b7280;');
    applyDarkTheme(el);
    expect(el.getAttribute('style')).toContain('#9ca3af');
  });

  it('applyDarkTheme swaps verified status background', () => {
    const el = document.createElement('div');
    el.setAttribute('style', 'background: #f0fdf4;');
    applyDarkTheme(el);
    expect(el.getAttribute('style')).toContain('#064e3b');
  });

  it('applyDarkTheme walks child elements', () => {
    const parent = document.createElement('div');
    parent.setAttribute('style', 'background: #ffffff;');
    const child = document.createElement('span');
    child.setAttribute('style', 'color: #111827;');
    parent.appendChild(child);

    applyDarkTheme(parent);

    expect(parent.getAttribute('style')).toContain('#1f2937');
    expect(child.getAttribute('style')).toContain('#f9fafb');
  });

  it('applyDarkTheme adjusts box-shadow opacity', () => {
    const el = document.createElement('div');
    el.setAttribute('style', 'box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05);');
    applyDarkTheme(el);
    expect(el.getAttribute('style')).toContain('rgba(0,0,0,0.3)');
  });

  it('applyLightTheme is a no-op', () => {
    const el = document.createElement('div');
    el.setAttribute('style', 'background: #ffffff;');
    applyLightTheme(el);
    expect(el.getAttribute('style')).toBe('background: #ffffff;');
  });

  it('applyDarkTheme handles elements without style attribute', () => {
    const el = document.createElement('div');
    const child = document.createElement('span');
    el.appendChild(child);
    // Should not throw
    applyDarkTheme(el);
    expect(el.hasAttribute('style')).toBe(false);
  });
});
