/**
 * DPO Generator Tests (NCE-13)
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

describe('nessie-dpo-generate', () => {
  it('runs in dry-run mode without errors', () => {
    const result = execSync(
      'npx tsx scripts/nessie-dpo-generate.ts --dry-run --count 10',
      { cwd: path.resolve(__dirname, '..'), encoding: 'utf-8' }
    );
    expect(result).toContain('DRY RUN');
    expect(result).toContain('10 preference pairs');
  });

  it('generates valid JSONL output', () => {
    const outputPath = path.resolve(__dirname, '..', 'test-dpo-output.jsonl');
    try {
      execSync(
        `npx tsx scripts/nessie-dpo-generate.ts --output ${outputPath} --count 5`,
        { cwd: path.resolve(__dirname, '..'), encoding: 'utf-8' }
      );

      expect(fs.existsSync(outputPath)).toBe(true);
      const content = fs.readFileSync(outputPath, 'utf-8').trim();
      const lines = content.split('\n');
      expect(lines).toHaveLength(5);

      // Each line should be valid JSON with required fields
      for (const line of lines) {
        const pair = JSON.parse(line);
        expect(pair).toHaveProperty('prompt');
        expect(pair).toHaveProperty('chosen');
        expect(pair).toHaveProperty('rejected');
        expect(pair).toHaveProperty('metadata');
        expect(pair.metadata).toHaveProperty('task_type');
        expect(pair.metadata).toHaveProperty('domain');

        // Chosen should have citations, rejected should not
        const chosen = JSON.parse(pair.chosen);
        const rejected = JSON.parse(pair.rejected);
        expect(chosen.citations.length).toBeGreaterThan(0);
        expect(rejected.citations.length).toBe(0);
      }
    } finally {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
  });
});
