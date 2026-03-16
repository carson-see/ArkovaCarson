/**
 * useIntegrityScore Hook (P8-S8)
 *
 * Fetches and computes integrity scores for anchors.
 */

import { useState, useCallback } from 'react';
import { workerFetch } from '@/lib/workerClient';

export type IntegrityLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'FLAGGED';

export interface IntegrityBreakdown {
  metadataCompleteness: number;
  extractionConfidence: number;
  issuerVerification: number;
  duplicateCheck: number;
  temporalConsistency: number;
}

export interface IntegrityScore {
  id: string;
  anchorId: string;
  orgId: string | null;
  overallScore: number;
  level: IntegrityLevel;
  metadataCompleteness: number;
  extractionConfidence: number;
  issuerVerification: number;
  duplicateCheck: number;
  temporalConsistency: number;
  flags: string[];
  details: Record<string, unknown>;
  computedAt: string;
}

export function useIntegrityScore() {
  const [score, setScore] = useState<IntegrityScore | null>(null);
  const [loading, setLoading] = useState(false);
  const [computing, setComputing] = useState(false);

  const fetchScore = useCallback(async (anchorId: string) => {
    setLoading(true);
    try {
      const res = await workerFetch(`/api/v1/ai/integrity/${anchorId}`);
      if (!res.ok) {
        if (res.status === 404) {
          setScore(null);
          return null;
        }
        return null;
      }
      const data = await res.json() as IntegrityScore;
      setScore(data);
      return data;
    } finally {
      setLoading(false);
    }
  }, []);

  const computeScore = useCallback(async (anchorId: string) => {
    setComputing(true);
    try {
      const res = await workerFetch('/api/v1/ai/integrity/compute', {
        method: 'POST',
        body: JSON.stringify({ anchorId }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as Record<string, string>).error ?? 'Failed to compute score');
      }

      const data = await res.json() as {
        anchorId: string;
        score: number;
        level: IntegrityLevel;
        breakdown: IntegrityBreakdown;
        flags: string[];
      };

      // Refetch to get full record
      await fetchScore(anchorId);
      return data;
    } finally {
      setComputing(false);
    }
  }, [fetchScore]);

  return { score, loading, computing, fetchScore, computeScore };
}
