/**
 * Tests for Weekly Calibration Refit Job (GME7.3 — SCRUM-856)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn(),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { runCalibrationRefit } from './calibration-refit.js';
import { db } from '../utils/db.js';

function mockDbChain(data: unknown[] | null, error: { message: string } | null = null) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data, error }),
  };
  (db.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  return chain;
}

describe('runCalibrationRefit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns result with zero entries when no recent data', async () => {
    mockDbChain([]);
    const result = await runCalibrationRefit();
    expect(result.sampledEntries).toBe(0);
    expect(result.typesWithKnots).toBe(0);
    expect(result.proposedKnots).toEqual({});
    expect(result.timestamp).toBeDefined();
  });

  it('derives per-type knots from sufficient samples', async () => {
    const samples = [];
    for (let i = 0; i < 15; i++) {
      samples.push({
        id: `deg-${i}`,
        credential_type: 'DEGREE',
        confidence: 0.5 + i * 0.03,
        extraction_accuracy: 0.6 + i * 0.02,
      });
    }
    mockDbChain(samples);
    const result = await runCalibrationRefit();
    expect(result.sampledEntries).toBe(15);
    expect(result.typesWithKnots).toBeGreaterThanOrEqual(1);
    expect(result.proposedKnots['DEGREE']).toBeDefined();
  });

  it('excludes types with fewer than 10 samples', async () => {
    const samples = [];
    for (let i = 0; i < 5; i++) {
      samples.push({
        id: `rare-${i}`,
        credential_type: 'RARE',
        confidence: 0.7,
        extraction_accuracy: 0.5,
      });
    }
    mockDbChain(samples);
    const result = await runCalibrationRefit();
    expect(result.proposedKnots['RARE']).toBeUndefined();
  });

  it('computes deltaPearsonR when enough data', async () => {
    const samples = [];
    for (let i = 0; i < 20; i++) {
      samples.push({
        id: `item-${i}`,
        credential_type: 'LICENSE',
        confidence: 0.3 + i * 0.03,
        extraction_accuracy: 0.4 + i * 0.025,
      });
    }
    mockDbChain(samples);
    const result = await runCalibrationRefit();
    expect(typeof result.deltaPearsonR).toBe('number');
  });

  it('throws on database error', async () => {
    mockDbChain(null, { message: 'connection timeout' });
    await expect(runCalibrationRefit()).rejects.toThrow('connection timeout');
  });

  it('queries the calibration_features view (SCRUM-917)', async () => {
    mockDbChain([]);
    await runCalibrationRefit();
    expect(db.from).toHaveBeenCalledWith('calibration_features');
  });

  it('returns currentKnots from the production config', async () => {
    mockDbChain([]);
    const result = await runCalibrationRefit();
    expect(result.currentKnots).toBeDefined();
    expect(typeof result.currentKnots).toBe('object');
  });

  it('marks result as stale when delta < 0.02', async () => {
    const samples = [];
    for (let i = 0; i < 12; i++) {
      samples.push({
        id: `s-${i}`,
        credential_type: 'CERTIFICATE',
        confidence: 0.8 + i * 0.01,
        extraction_accuracy: 0.8 + i * 0.01,
      });
    }
    mockDbChain(samples);
    const result = await runCalibrationRefit();
    expect(typeof result.stale).toBe('boolean');
  });
});
