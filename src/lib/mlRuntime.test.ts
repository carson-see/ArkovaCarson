/**
 * ML Runtime Detection Tests (Phase 4)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  detectMLRuntime,
  resetMLRuntimeCache,
  fitsInVramBudget,
  VRAM_BUDGET_MB,
  VRAM_BUDGET_BYTES,
} from './mlRuntime';

describe('mlRuntime', () => {
  beforeEach(() => {
    resetMLRuntimeCache();
  });

  describe('constants', () => {
    it('VRAM budget is 2GB', () => {
      expect(VRAM_BUDGET_MB).toBe(2048);
      expect(VRAM_BUDGET_BYTES).toBe(2 * 1024 * 1024 * 1024);
    });
  });

  describe('fitsInVramBudget', () => {
    it('returns true for models under 2GB', () => {
      expect(fitsInVramBudget(130)).toBe(true); // q8 BERT
      expect(fitsInVramBudget(420)).toBe(true); // fp32 BERT
      expect(fitsInVramBudget(1500)).toBe(true); // 1.5GB model
      expect(fitsInVramBudget(2048)).toBe(true); // exactly 2GB
    });

    it('returns false for models over 2GB', () => {
      expect(fitsInVramBudget(2049)).toBe(false);
      expect(fitsInVramBudget(4096)).toBe(false);
    });
  });

  describe('detectMLRuntime', () => {
    it('detects WASM/CPU in Node.js environment (no WebGPU)', async () => {
      const info = await detectMLRuntime();
      // In Node.js test environment, WebGPU is not available
      expect(info.webgpuAvailable).toBe(false);
      expect(['wasm', 'cpu']).toContain(info.backend);
      expect(info.withinBudget).toBe(true);
    });

    it('caches result on repeated calls', async () => {
      const first = await detectMLRuntime();
      const second = await detectMLRuntime();
      expect(first).toBe(second); // Same reference — cached
    });

    it('resets cache on resetMLRuntimeCache', async () => {
      const first = await detectMLRuntime();
      resetMLRuntimeCache();
      const second = await detectMLRuntime();
      expect(first).not.toBe(second); // Different reference
      expect(first.backend).toBe(second.backend); // Same result though
    });

    it('returns correct shape', async () => {
      const info = await detectMLRuntime();
      expect(info).toHaveProperty('backend');
      expect(info).toHaveProperty('webgpuAvailable');
      expect(info).toHaveProperty('wasmSimdAvailable');
      expect(info).toHaveProperty('estimatedVramMb');
      expect(info).toHaveProperty('withinBudget');
      expect(typeof info.backend).toBe('string');
      expect(typeof info.webgpuAvailable).toBe('boolean');
      expect(typeof info.wasmSimdAvailable).toBe('boolean');
      expect(typeof info.withinBudget).toBe('boolean');
    });
  });
});
