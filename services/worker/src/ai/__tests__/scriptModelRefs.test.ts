/**
 * GME-09: Verify all training & eval scripts use centralized model config
 *
 * No script should hardcode model names as inline fallback strings.
 * All model references should come from gemini-config.ts imports or env vars.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPTS_DIR = resolve(import.meta.dirname ?? '.', '../../../scripts');

// Scripts that are training/eval related and must use centralized config
const TRAINING_SCRIPTS = [
  'gemini-golden-finetune.ts',
  'gemini-train-pipeline.ts',
  'nessie-v4-pipeline.ts',
  'nessie-multi-lora-pipeline.ts',
  'nessie-intelligence-distill.ts',
  'nessie-reasoning-pipeline.ts',
  'eval-intelligence.ts',
  'eval-gemini-golden-v2-full.ts',
];

describe('GME-09: Training & Eval Script Model References', () => {
  it('all training scripts exist', () => {
    const allFiles = readdirSync(SCRIPTS_DIR);
    for (const script of TRAINING_SCRIPTS) {
      expect(allFiles, `Missing script: ${script}`).toContain(script);
    }
  });

  for (const script of TRAINING_SCRIPTS) {
    it(`${script} imports from gemini-config.ts (no hardcoded model fallbacks)`, () => {
      const filePath = resolve(SCRIPTS_DIR, script);
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        // Skip if file doesn't exist (handled by existence test)
        return;
      }

      // Should import from gemini-config
      const hasConfigImport = /from\s+['"]\.\.\/src\/ai\/gemini-config/.test(content)
        || /from\s+['"].*gemini-config/.test(content);
      expect(
        hasConfigImport,
        `${script} should import model constants from gemini-config.ts`,
      ).toBe(true);

      // Should NOT have inline 'gemini-3-flash-preview' fallback strings
      // (env var reads like process.env.GEMINI_MODEL are fine, but
      //  ?? 'gemini-3-flash-preview' is a hardcoded fallback)
      const inlineFallbacks = content.match(/\?\?\s*['"]gemini-[^'"]+['"]/g) ?? [];
      expect(
        inlineFallbacks,
        `${script} has hardcoded model fallbacks: ${inlineFallbacks.join(', ')}`,
      ).toHaveLength(0);
    });
  }

  it('help text in gemini-train-pipeline.ts references Gemini 3 (not 2.x)', () => {
    const content = readFileSync(resolve(SCRIPTS_DIR, 'gemini-train-pipeline.ts'), 'utf-8');
    expect(content).not.toMatch(/gemini-2\.\d/);
  });
});
