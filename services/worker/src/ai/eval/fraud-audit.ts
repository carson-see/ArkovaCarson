/**
 * Fraud Detection False Positive Audit (AI-FRAUD-01)
 *
 * Queries FLAGGED integrity scores, samples them, and provides
 * a framework for manual classification of true vs false positives.
 *
 * Usage:
 *   npx tsx services/worker/src/ai/eval/fraud-audit.ts
 *
 * Requires: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env
 */

import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';
import type { WebSocketLikeConstructor } from '@supabase/realtime-js';
import ws from 'ws';

interface FlaggedItem {
  id: string;
  anchorId: string;
  overallScore: number;
  level: string;
  metadataCompleteness: number;
  extractionConfidence: number;
  issuerVerification: number;
  duplicateCheck: number;
  temporalConsistency: number;
  credentialType: string;
  issuerName: string;
  flags: string[];
}

interface AuditResult {
  timestamp: string;
  totalFlagged: number;
  sampleSize: number;
  items: FlaggedItem[];
  distribution: {
    byLevel: Record<string, number>;
    byFlag: Record<string, number>;
    byCredentialType: Record<string, number>;
  };
  recommendation: string;
}

/**
 * Run the fraud audit against production data.
 * Returns structured results for manual review.
 */
export async function runFraudAudit(
  supabaseUrl: string,
  serviceRoleKey: string,
  sampleSize = 100,
): Promise<AuditResult> {

  const db = createClient(supabaseUrl, serviceRoleKey, {
    realtime: { transport: ws as unknown as WebSocketLikeConstructor },
  });

  // Count all integrity scores by level
  const { data: levelCounts } = await db
    .from('integrity_scores')
    .select('level')
    .then(({ data }) => {
      const counts: Record<string, number> = {};
      for (const row of data ?? []) {
        counts[row.level] = (counts[row.level] || 0) + 1;
      }
      return { data: counts };
    });

  // Fetch FLAGGED items
  const { data: flaggedItems, error } = await db
    .from('integrity_scores')
    .select(`
      id,
      anchor_id,
      overall_score,
      level,
      metadata_completeness,
      extraction_confidence,
      issuer_verification,
      duplicate_check,
      temporal_consistency,
      breakdown
    `)
    .eq('level', 'FLAGGED')
    .order('overall_score', { ascending: true })
    .limit(sampleSize);

  if (error) {
    console.error('Failed to fetch flagged items:', error);
    return {
      timestamp: new Date().toISOString(),
      totalFlagged: 0,
      sampleSize: 0,
      items: [],
      distribution: { byLevel: levelCounts ?? {}, byFlag: {}, byCredentialType: {} },
      recommendation: 'ERROR: Failed to query integrity_scores table',
    };
  }

  if (!flaggedItems || flaggedItems.length === 0) {
    return {
      timestamp: new Date().toISOString(),
      totalFlagged: 0,
      sampleSize: 0,
      items: [],
      distribution: { byLevel: levelCounts ?? {}, byFlag: {}, byCredentialType: {} },
      recommendation: 'No FLAGGED items found. Fraud detection has not flagged any records yet. This is expected if integrity scoring has not been run on production data.',
    };
  }

  // Enrich with anchor metadata
  const anchorIds = flaggedItems.map(f => f.anchor_id);
  const { data: anchors } = await db
    .from('anchors')
    .select('id, credential_type, metadata')
    .in('id', anchorIds);

  const anchorMap = new Map(
    (anchors ?? []).map(a => [a.id, a]),
  );

  // Build structured items
  const items: FlaggedItem[] = flaggedItems.map(f => {
    const anchor = anchorMap.get(f.anchor_id);
    const metadata = (anchor?.metadata ?? {}) as Record<string, unknown>;
    const breakdown = (f.breakdown ?? {}) as Record<string, unknown>;
    const flags: string[] = [];

    // Extract flags from breakdown
    if (breakdown.temporal_flags && Array.isArray(breakdown.temporal_flags)) {
      flags.push(...(breakdown.temporal_flags as string[]));
    }
    if (breakdown.fraud_signals && Array.isArray(breakdown.fraud_signals)) {
      flags.push(...(breakdown.fraud_signals as string[]));
    }

    return {
      id: f.id,
      anchorId: f.anchor_id,
      overallScore: f.overall_score,
      level: f.level,
      metadataCompleteness: f.metadata_completeness ?? 0,
      extractionConfidence: f.extraction_confidence ?? 0,
      issuerVerification: f.issuer_verification ?? 0,
      duplicateCheck: f.duplicate_check ?? 0,
      temporalConsistency: f.temporal_consistency ?? 0,
      credentialType: (anchor?.credential_type as string) ?? 'UNKNOWN',
      issuerName: (metadata.issuerName as string) ?? 'Unknown',
      flags,
    };
  });

  // Compute distributions
  const byFlag: Record<string, number> = {};
  const byCredentialType: Record<string, number> = {};
  for (const item of items) {
    byCredentialType[item.credentialType] = (byCredentialType[item.credentialType] || 0) + 1;
    for (const flag of item.flags) {
      byFlag[flag] = (byFlag[flag] || 0) + 1;
    }
  }

  // Generate recommendation
  let recommendation: string;
  if (items.length < 10) {
    recommendation = `Only ${items.length} FLAGGED items found. Sample too small for statistical analysis. Monitor as more data flows through integrity scoring.`;
  } else {
    const avgScore = items.reduce((s, i) => s + i.overallScore, 0) / items.length;
    recommendation = `${items.length} FLAGGED items sampled (avg score: ${avgScore.toFixed(1)}). `;
    recommendation += `Top flags: ${Object.entries(byFlag).sort(([, a], [, b]) => b - a).slice(0, 3).map(([k, v]) => `${k} (${v})`).join(', ')}. `;
    recommendation += `Manual review needed: classify each as TRUE_POSITIVE (genuine concern) or FALSE_POSITIVE (incorrectly flagged). `;
    recommendation += `Target: <20% false positive rate.`;
  }

  return {
    timestamp: new Date().toISOString(),
    totalFlagged: items.length,
    sampleSize: Math.min(sampleSize, items.length),
    items,
    distribution: {
      byLevel: levelCounts ?? {},
      byFlag,
      byCredentialType,
    },
    recommendation,
  };
}

/**
 * Format fraud audit as markdown.
 */
export function formatFraudAuditReport(result: AuditResult): string {
  const lines: string[] = [];
  lines.push('# Fraud Detection Audit Report (AI-FRAUD-01)');
  lines.push('');
  lines.push(`- **Date:** ${result.timestamp}`);
  lines.push(`- **Total FLAGGED:** ${result.totalFlagged}`);
  lines.push(`- **Sample Size:** ${result.sampleSize}`);
  lines.push('');

  lines.push('## Level Distribution');
  lines.push('');
  lines.push('| Level | Count |');
  lines.push('|-------|-------|');
  for (const [level, count] of Object.entries(result.distribution.byLevel)) {
    lines.push(`| ${level} | ${count} |`);
  }
  lines.push('');

  if (result.items.length > 0) {
    lines.push('## Flag Distribution');
    lines.push('');
    lines.push('| Flag | Count |');
    lines.push('|------|-------|');
    for (const [flag, count] of Object.entries(result.distribution.byFlag).sort(([, a], [, b]) => b - a)) {
      lines.push(`| ${flag} | ${count} |`);
    }
    lines.push('');

    lines.push('## Credential Type Distribution');
    lines.push('');
    lines.push('| Type | Count |');
    lines.push('|------|-------|');
    for (const [type, count] of Object.entries(result.distribution.byCredentialType).sort(([, a], [, b]) => b - a)) {
      lines.push(`| ${type} | ${count} |`);
    }
    lines.push('');

    lines.push('## Flagged Items (for manual classification)');
    lines.push('');
    lines.push('| # | Anchor ID | Score | Type | Issuer | Flags | Classification |');
    lines.push('|---|-----------|-------|------|--------|-------|----------------|');
    for (let i = 0; i < result.items.length; i++) {
      const item = result.items[i];
      lines.push(
        `| ${i + 1} | ${item.anchorId.substring(0, 8)}... | ${item.overallScore} | ${item.credentialType} | ${item.issuerName.substring(0, 30)} | ${item.flags.join(', ') || 'none'} | _TODO_ |`,
      );
    }
  }

  lines.push('');
  lines.push('## Recommendation');
  lines.push('');
  lines.push(result.recommendation);

  return lines.join('\n');
}

// CLI entry point
async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
    console.error('Source your .env file first: source services/worker/.env');
    process.exit(1);
  }

  console.log('Running fraud detection audit...');
  const result = await runFraudAudit(supabaseUrl, serviceRoleKey);

  const outputDir = resolve(process.cwd(), 'docs/eval');
  mkdirSync(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const reportPath = resolve(outputDir, `fraud-audit-${timestamp}.md`);
  writeFileSync(reportPath, formatFraudAuditReport(result), 'utf-8');

  const jsonPath = resolve(outputDir, `fraud-audit-${timestamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf-8');

  console.log(`\nReport: ${reportPath}`);
  console.log(`Raw data: ${jsonPath}`);
  console.log(`\n${result.recommendation}`);
}

// Only run as CLI, not when imported
if (process.argv[1]?.includes('fraud-audit')) {
  main().catch(err => {
    console.error('Audit failed:', err);
    process.exit(1);
  });
}
