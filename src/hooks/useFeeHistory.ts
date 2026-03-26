/**
 * Fee History Hook
 *
 * Tracks mempool fee rate samples over time to compute
 * average, min, and max fee rates for the treasury dashboard.
 *
 * Keeps the last 60 samples in memory (no persistence needed —
 * this is a live operational metric).
 */

import { useCallback, useRef, useState } from 'react';

export interface FeeHistoryStats {
  /** Average fee rate across all samples (sat/vB) */
  avg: number;
  /** Minimum fee rate seen (sat/vB) */
  min: number;
  /** Maximum fee rate seen (sat/vB) */
  max: number;
  /** Number of samples collected */
  sampleCount: number;
}

const MAX_SAMPLES = 60;

export function useFeeHistory() {
  const samplesRef = useRef<number[]>([]);
  const [stats, setStats] = useState<FeeHistoryStats | null>(null);

  const addSample = useCallback((feeRate: number) => {
    if (feeRate <= 0 || !Number.isFinite(feeRate)) return;

    const samples = samplesRef.current;
    samples.push(feeRate);
    if (samples.length > MAX_SAMPLES) {
      samples.shift();
    }

    const sum = samples.reduce((a, b) => a + b, 0);
    setStats({
      avg: Math.round((sum / samples.length) * 10) / 10,
      min: Math.min(...samples),
      max: Math.max(...samples),
      sampleCount: samples.length,
    });
  }, []);

  return { stats, addSample };
}
