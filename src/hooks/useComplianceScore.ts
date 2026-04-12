/**
 * Compliance Score Hook (NCE-10)
 *
 * Fetches compliance score, gap analysis, and score history
 * from the worker API for the current user's org.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { workerFetch, WORKER_URL } from '@/lib/workerClient';

export interface ComplianceScoreData {
  score: number;
  grade: string;
  jurisdiction: string;
  industry: string;
  present_documents: Array<{
    type: string;
    anchor_id: string;
    status: string;
    title: string | null;
    integrity_score: number | null;
    expiry_date: string | null;
  }>;
  missing_documents: Array<{
    type: string;
    requirement: string;
    regulatory_reference: string | null;
    score_impact: number;
  }>;
  expiring_documents: Array<{
    type: string;
    anchor_id: string;
    title: string | null;
    expiry_date: string;
    days_remaining: number;
  }>;
  total_required: number;
  total_present: number;
  recommendations: unknown[];
  last_calculated: string;
  cached: boolean;
}

export interface GapAnalysisData {
  jurisdiction: string;
  industry: string;
  missing_required: Array<{
    type: string;
    requirement: string;
    regulatory_reference: string | null;
    score_impact: number;
    peer_adoption_pct: number | null;
  }>;
  missing_recommended: Array<{
    type: string;
    requirement: string;
    regulatory_reference: string | null;
    score_impact: number;
    peer_adoption_pct: number | null;
  }>;
  priority_order: string[];
  summary: string;
}

export interface JurisdictionRule {
  id: string;
  jurisdiction_code: string;
  industry_code: string;
  rule_name: string;
  required_credential_types: string[];
  optional_credential_types: string[];
  regulatory_reference: string | null;
  details: Record<string, unknown>;
}

export function useComplianceScore(jurisdiction: string, industry: string) {
  const [scoreData, setScoreData] = useState<ComplianceScoreData | null>(null);
  const [gapData, setGapData] = useState<GapAnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchScore = useCallback(async () => {
    if (!jurisdiction || !industry) return;
    setLoading(true);
    setError(null);

    try {
      const [scoreRes, gapRes] = await Promise.all([
        workerFetch(`/api/v1/compliance/score?jurisdiction=${encodeURIComponent(jurisdiction)}&industry=${encodeURIComponent(industry)}`),
        workerFetch('/api/v1/compliance/gap-analysis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jurisdiction, industry }),
        }),
      ]);

      if (scoreRes.ok) {
        setScoreData(await scoreRes.json());
      } else if (scoreRes.status === 404) {
        setScoreData(null);
      } else {
        const err = await scoreRes.json().catch(() => ({}));
        setError((err as Record<string, string>).error || 'Failed to fetch score');
      }

      if (gapRes.ok) {
        setGapData(await gapRes.json());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [jurisdiction, industry]);

  useEffect(() => {
    fetchScore();
  }, [fetchScore]);

  return { scoreData, gapData, loading, error, refetch: fetchScore };
}

export function useJurisdictionRules() {
  const [rules, setRules] = useState<JurisdictionRule[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchRules() {
      try {
        // Rules endpoint is public — no auth needed, use raw fetch
        const res = await globalThis.fetch(`${WORKER_URL}/api/v1/compliance/rules`);
        if (res.ok) {
          const data = await res.json();
          setRules(data.rules ?? []);
        }
      } catch {
        // Non-fatal
      } finally {
        setLoading(false);
      }
    }
    fetchRules();
  }, []);

  const jurisdictions = useMemo(() => [...new Set(rules.map(r => r.jurisdiction_code))].sort(), [rules]);
  const industries = useMemo(() => [...new Set(rules.map(r => r.industry_code))].sort(), [rules]);

  return { rules, jurisdictions, industries, loading };
}
