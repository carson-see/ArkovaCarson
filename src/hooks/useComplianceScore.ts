/**
 * Compliance Score Hook (NCE-10)
 *
 * Fetches compliance score, gap analysis, and score history
 * from the worker API for the current user's org.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

interface PresentDocument {
  type: string;
  anchor_id: string;
  status: string;
  title: string | null;
  integrity_score: number | null;
  expiry_date: string | null;
}

interface MissingDocument {
  type: string;
  requirement: string;
  regulatory_reference: string | null;
  score_impact: number;
}

interface ExpiringDocument {
  type: string;
  anchor_id: string;
  title: string | null;
  expiry_date: string;
  days_remaining: number;
}

export interface ComplianceScoreData {
  score: number;
  grade: string;
  jurisdiction: string;
  industry: string;
  present_documents: PresentDocument[];
  missing_documents: MissingDocument[];
  expiring_documents: ExpiringDocument[];
  total_required: number;
  total_present: number;
  recommendations: unknown[];
  last_calculated: string;
  cached: boolean;
}

interface GapItem {
  type: string;
  requirement: string;
  regulatory_reference: string | null;
  score_impact: number;
  peer_adoption_pct: number | null;
}

export interface GapAnalysisData {
  jurisdiction: string;
  industry: string;
  missing_required: GapItem[];
  missing_recommended: GapItem[];
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
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setError('Not authenticated');
        return;
      }

      const workerUrl = import.meta.env.VITE_WORKER_URL || 'http://localhost:3001';
      const headers = {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      };

      // Fetch score and gap analysis in parallel
      const [scoreRes, gapRes] = await Promise.all([
        fetch(`${workerUrl}/api/v1/compliance/score?jurisdiction=${encodeURIComponent(jurisdiction)}&industry=${encodeURIComponent(industry)}`, { headers }),
        fetch(`${workerUrl}/api/v1/compliance/gap-analysis`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jurisdiction, industry }),
        }),
      ]);

      if (scoreRes.ok) {
        const data = await scoreRes.json();
        setScoreData(data);
      } else if (scoreRes.status === 404) {
        setScoreData(null);
      } else {
        const err = await scoreRes.json().catch(() => ({}));
        setError(err.error || 'Failed to fetch score');
      }

      if (gapRes.ok) {
        const data = await gapRes.json();
        setGapData(data);
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
    async function fetch() {
      try {
        const workerUrl = import.meta.env.VITE_WORKER_URL || 'http://localhost:3001';
        const res = await globalThis.fetch(`${workerUrl}/api/v1/compliance/rules`);
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
    fetch();
  }, []);

  // Derive available jurisdictions and industries
  const jurisdictions = [...new Set(rules.map(r => r.jurisdiction_code))].sort();
  const industries = [...new Set(rules.map(r => r.industry_code))].sort();

  return { rules, jurisdictions, industries, loading };
}
