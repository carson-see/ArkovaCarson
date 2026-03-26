/**
 * Risk Assessment Report Component (Phase 5)
 *
 * Displays visual fraud detection results for a document.
 * Shows risk level, individual signals by category, and recommendations.
 */

import React from 'react';
import { AlertTriangle, CheckCircle, Info, ShieldAlert, XCircle } from 'lucide-react';
import { FRAUD_DETECTION_LABELS } from '../../lib/copy';

// Types matching the server-side VisualFraudResult
type FraudRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
type SignalSeverity = 'info' | 'warning' | 'critical';
type SignalCategory = 'font' | 'layout' | 'manipulation' | 'metadata' | 'security_feature';

interface VisualFraudSignal {
  id: string;
  description: string;
  severity: SignalSeverity;
  confidence: number;
  category: SignalCategory;
}

export interface RiskAssessmentData {
  riskLevel: FraudRiskLevel;
  riskScore: number;
  signals: VisualFraudSignal[];
  summary: string;
  recommendations: string[];
}

interface RiskAssessmentReportProps {
  data: RiskAssessmentData | null;
  loading?: boolean;
  onAnalyze?: () => void;
}

const RISK_COLORS: Record<FraudRiskLevel, string> = {
  LOW: 'text-green-600 bg-green-50 border-green-200',
  MEDIUM: 'text-yellow-600 bg-yellow-50 border-yellow-200',
  HIGH: 'text-orange-600 bg-orange-50 border-orange-200',
  CRITICAL: 'text-red-600 bg-red-50 border-red-200',
};

const RISK_LABELS: Record<FraudRiskLevel, string> = {
  LOW: FRAUD_DETECTION_LABELS.RISK_LOW,
  MEDIUM: FRAUD_DETECTION_LABELS.RISK_MEDIUM,
  HIGH: FRAUD_DETECTION_LABELS.RISK_HIGH,
  CRITICAL: FRAUD_DETECTION_LABELS.RISK_CRITICAL,
};

const CATEGORY_LABELS: Record<SignalCategory, string> = {
  font: FRAUD_DETECTION_LABELS.CATEGORY_FONT,
  layout: FRAUD_DETECTION_LABELS.CATEGORY_LAYOUT,
  manipulation: FRAUD_DETECTION_LABELS.CATEGORY_MANIPULATION,
  metadata: FRAUD_DETECTION_LABELS.CATEGORY_METADATA,
  security_feature: FRAUD_DETECTION_LABELS.CATEGORY_SECURITY,
};

function RiskIcon({ level }: { level: FraudRiskLevel }) {
  switch (level) {
    case 'LOW': return <CheckCircle className="h-5 w-5 text-green-600" />;
    case 'MEDIUM': return <Info className="h-5 w-5 text-yellow-600" />;
    case 'HIGH': return <AlertTriangle className="h-5 w-5 text-orange-600" />;
    case 'CRITICAL': return <XCircle className="h-5 w-5 text-red-600" />;
  }
}

function SeverityBadge({ severity }: { severity: SignalSeverity }) {
  const styles: Record<SignalSeverity, string> = {
    info: 'bg-blue-100 text-blue-700',
    warning: 'bg-yellow-100 text-yellow-700',
    critical: 'bg-red-100 text-red-700',
  };
  const labels: Record<SignalSeverity, string> = {
    info: FRAUD_DETECTION_LABELS.SEVERITY_INFO,
    warning: FRAUD_DETECTION_LABELS.SEVERITY_WARNING,
    critical: FRAUD_DETECTION_LABELS.SEVERITY_CRITICAL,
  };

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[severity]}`}>
      {labels[severity]}
    </span>
  );
}

export function RiskAssessmentReport({ data, loading, onAnalyze }: RiskAssessmentReportProps) {
  if (loading) {
    return (
      <div className="rounded-lg border p-4 animate-pulse">
        <div className="h-4 w-48 bg-gray-200 rounded mb-3" />
        <div className="h-3 w-64 bg-gray-200 rounded mb-2" />
        <div className="h-3 w-56 bg-gray-200 rounded" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-lg border p-4">
        <div className="flex items-center gap-2 mb-2">
          <ShieldAlert className="h-5 w-5 text-gray-400" />
          <h3 className="font-medium text-gray-900">{FRAUD_DETECTION_LABELS.TITLE}</h3>
        </div>
        <p className="text-sm text-gray-500 mb-3">{FRAUD_DETECTION_LABELS.NO_ANALYSIS}</p>
        {onAnalyze && (
          <button
            onClick={onAnalyze}
            className="text-sm font-medium text-brand-600 hover:text-brand-700"
          >
            {FRAUD_DETECTION_LABELS.ANALYZE_BUTTON}
          </button>
        )}
      </div>
    );
  }

  // Group signals by category
  const signalsByCategory = data.signals.reduce((acc, signal) => {
    const cat = signal.category;
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(signal);
    return acc;
  }, {} as Record<SignalCategory, VisualFraudSignal[]>);

  return (
    <div className="rounded-lg border p-4 space-y-4">
      {/* Header with risk level */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-gray-700" />
          <h3 className="font-medium text-gray-900">{FRAUD_DETECTION_LABELS.TITLE}</h3>
        </div>
        <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full border ${RISK_COLORS[data.riskLevel]}`}>
          <RiskIcon level={data.riskLevel} />
          <span className="text-sm font-medium">{RISK_LABELS[data.riskLevel]}</span>
          <span className="text-xs opacity-70">({data.riskScore}/100)</span>
        </div>
      </div>

      {/* Summary */}
      <p className="text-sm text-gray-600">{data.summary}</p>

      {/* Signals by category */}
      {data.signals.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-700 mb-2">{FRAUD_DETECTION_LABELS.SIGNALS_TITLE}</h4>
          <div className="space-y-3">
            {(Object.entries(signalsByCategory) as [SignalCategory, VisualFraudSignal[]][]).map(([category, signals]) => (
              <div key={category} className="space-y-1">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {CATEGORY_LABELS[category]}
                </p>
                {signals.map((signal) => (
                  <div key={signal.id} className="flex items-start gap-2 pl-2">
                    <SeverityBadge severity={signal.severity} />
                    <span className="text-sm text-gray-700">{signal.description}</span>
                    <span className="text-xs text-gray-400 ml-auto whitespace-nowrap">
                      {Math.round(signal.confidence * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recommendations */}
      {data.recommendations.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-700 mb-2">{FRAUD_DETECTION_LABELS.RECOMMENDATIONS_TITLE}</h4>
          <ul className="list-disc list-inside space-y-1">
            {data.recommendations.map((rec, i) => (
              <li key={i} className="text-sm text-gray-600">{rec}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default RiskAssessmentReport;
