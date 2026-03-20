/**
 * Nordic Vault Design System — CSS Class Existence Tests
 *
 * Validates that all atmospheric CSS classes documented in BRAND.md
 * are actually defined in src/index.css and tailwind.config.ts.
 * Prevents silent regressions where components reference undefined classes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const indexCss = readFileSync(resolve(__dirname, '../index.css'), 'utf-8');
const tailwindConfig = readFileSync(resolve(__dirname, '../../tailwind.config.ts'), 'utf-8');

describe('Nordic Vault CSS classes are defined in src/index.css', () => {
  const requiredClasses = [
    'bg-mesh-gradient',
    'bg-dot-pattern',
    'glass-card',
    'glass-header',
    'gradient-border',
    'glow-primary',
    'glow-success',
    'nav-glow',
    'sidebar-gradient',
    'shimmer',
    'animate-in-view',
    'animate-float',
    'animate-float-delayed',
    'animate-float-slow',
    'stagger-1',
    'stagger-2',
    'stagger-3',
    'stagger-4',
    'stagger-5',
    'stagger-6',
    'stagger-7',
    'stagger-8',
  ];

  for (const cls of requiredClasses) {
    it(`defines .${cls}`, () => {
      expect(indexCss).toContain(`.${cls}`);
    });
  }
});

describe('Nordic Vault shadow tokens are defined in tailwind.config.ts', () => {
  const requiredShadows = [
    'glow-sm',
    'glow-md',
    'glow-lg',
    'card-rest',
    'card-hover',
  ];

  for (const shadow of requiredShadows) {
    it(`defines shadow '${shadow}'`, () => {
      expect(tailwindConfig).toContain(`'${shadow}'`);
    });
  }
});

describe('Nordic Vault keyframes are defined', () => {
  it('defines shimmer keyframe', () => {
    expect(indexCss).toContain('@keyframes shimmer');
  });

  it('defines float keyframe', () => {
    expect(indexCss).toContain('@keyframes float');
  });

  it('defines fade-up keyframe in tailwind config', () => {
    expect(tailwindConfig).toContain("'fade-up'");
  });
});
