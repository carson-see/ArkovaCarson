/**
 * Tests for Nessie v6 Intelligence Fine-Tune (NMT-12 / SCRUM-675)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { V6_TRAINING_CONFIG, validateTrainingFile } from './nessie-v6-intelligence-finetune.js';

const TEMP_DIR = resolve(import.meta.dirname ?? '.', '../.test-tmp-nmt12');

describe('nessie-v6-intelligence-finetune (NMT-12)', () => {
  describe('V6_TRAINING_CONFIG', () => {
    it('should use Llama 3.1 8B Instruct base model', () => {
      expect(V6_TRAINING_CONFIG.model).toBe('meta-llama/Meta-Llama-3.1-8B-Instruct-Reference');
    });

    it('should use 2 epochs (prevents overfitting)', () => {
      expect(V6_TRAINING_CONFIG.n_epochs).toBe(2);
    });

    it('should use LoRA-appropriate learning rate', () => {
      expect(V6_TRAINING_CONFIG.learning_rate).toBe(2e-4);
    });

    it('should enable LoRA', () => {
      expect(V6_TRAINING_CONFIG.lora).toBe(true);
    });

    it('should have alpha = 2x rank', () => {
      expect(V6_TRAINING_CONFIG.lora_alpha).toBe(V6_TRAINING_CONFIG.lora_r * 2);
    });

    it('should have intelligence-specific suffix', () => {
      expect(V6_TRAINING_CONFIG.suffix).toBe('arkova-nessie-intelligence-v2');
    });
  });

  describe('validateTrainingFile', () => {
    beforeAll(() => {
      mkdirSync(TEMP_DIR, { recursive: true });
    });

    afterAll(() => {
      rmSync(TEMP_DIR, { recursive: true, force: true });
    });

    it('should return error for missing file', () => {
      const result = validateTrainingFile('/nonexistent/file.jsonl');
      expect(result.total).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should validate correct JSONL', () => {
      const filePath = resolve(TEMP_DIR, 'valid.jsonl');
      const line = JSON.stringify({
        messages: [
          { role: 'system', content: 'System prompt' },
          { role: 'user', content: 'Question' },
          { role: 'assistant', content: 'Answer' },
        ],
      });
      writeFileSync(filePath, [line, line, line].join('\n'));

      const result = validateTrainingFile(filePath);
      expect(result.valid).toBe(3);
      expect(result.invalid).toBe(0);
      expect(result.total).toBe(3);
    });

    it('should reject invalid JSON lines', () => {
      const filePath = resolve(TEMP_DIR, 'invalid-json.jsonl');
      writeFileSync(filePath, 'not json\n{"also":"bad"}\n');

      const result = validateTrainingFile(filePath);
      expect(result.invalid).toBe(2);
    });

    it('should reject messages with wrong structure', () => {
      const filePath = resolve(TEMP_DIR, 'bad-structure.jsonl');
      const line = JSON.stringify({
        messages: [
          { role: 'user', content: 'Wrong order' },
          { role: 'system', content: 'System should be first' },
          { role: 'assistant', content: 'Answer' },
        ],
      });
      writeFileSync(filePath, line);

      const result = validateTrainingFile(filePath);
      expect(result.invalid).toBe(1);
    });

    it('should reject messages with wrong count', () => {
      const filePath = resolve(TEMP_DIR, 'wrong-count.jsonl');
      const line = JSON.stringify({
        messages: [
          { role: 'system', content: 'Prompt' },
          { role: 'user', content: 'Question' },
        ],
      });
      writeFileSync(filePath, line);

      const result = validateTrainingFile(filePath);
      expect(result.invalid).toBe(1);
    });

    it('should count both valid and invalid lines', () => {
      const filePath = resolve(TEMP_DIR, 'mixed.jsonl');
      const validLine = JSON.stringify({
        messages: [
          { role: 'system', content: 'Prompt' },
          { role: 'user', content: 'Q' },
          { role: 'assistant', content: 'A' },
        ],
      });
      writeFileSync(filePath, `${validLine}\nnot json\n${validLine}`);

      const result = validateTrainingFile(filePath);
      expect(result.valid).toBe(2);
      expect(result.invalid).toBe(1);
      expect(result.total).toBe(3);
    });
  });
});
