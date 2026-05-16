import { describe, it, expect } from 'vitest';
import { extractConstraintCategories, check } from './check-audit-category-sync.js';

describe('check-audit-category-sync', () => {
  it('extracts categories from the latest constraint migration', () => {
    const categories = extractConstraintCategories();
    expect(categories.length).toBeGreaterThan(0);
    expect(categories).toContain('AUTH');
    expect(categories).toContain('ANCHOR');
  });

  it('constraint includes worker-only categories added in 0307', () => {
    const categories = extractConstraintCategories();
    expect(categories).toContain('COMPLIANCE');
    expect(categories).toContain('NOTIFICATION');
    expect(categories).toContain('PLATFORM');
    expect(categories).toContain('SECURITY');
  });

  it('all codebase event_category values are in the constraint', () => {
    const { pass, violations } = check();
    if (!pass) {
      const msg = violations
        .map(v => `  ${v.file}:${v.line} — '${v.category}'`)
        .join('\n');
      expect.fail(`Categories not in CHECK constraint:\n${msg}`);
    }
    expect(pass).toBe(true);
  });
});
