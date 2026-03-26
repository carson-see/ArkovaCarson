/**
 * Risk Assessment Report Component Tests (Phase 5)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RiskAssessmentReport, type RiskAssessmentData } from './RiskAssessmentReport';

const CLEAN_RESULT: RiskAssessmentData = {
  riskLevel: 'LOW',
  riskScore: 8,
  signals: [],
  summary: 'No visual tampering indicators detected.',
  recommendations: [],
};

const FLAGGED_RESULT: RiskAssessmentData = {
  riskLevel: 'HIGH',
  riskScore: 65,
  signals: [
    {
      id: 'font_mismatch',
      description: 'Font differs in name field vs rest of document',
      severity: 'warning',
      confidence: 0.85,
      category: 'font',
    },
    {
      id: 'missing_watermark',
      description: 'Expected watermark not detected',
      severity: 'critical',
      confidence: 0.92,
      category: 'security_feature',
    },
  ],
  summary: 'Multiple fraud indicators detected. Manual review recommended.',
  recommendations: [
    'Verify document directly with issuing institution',
    'Request original document for physical inspection',
  ],
};

describe('RiskAssessmentReport', () => {
  it('renders empty state with analyze button', () => {
    const onAnalyze = vi.fn();
    render(<RiskAssessmentReport data={null} onAnalyze={onAnalyze} />);
    expect(screen.getByText('No risk assessment available')).toBeInTheDocument();
    const button = screen.getByText('Analyze Document');
    fireEvent.click(button);
    expect(onAnalyze).toHaveBeenCalledOnce();
  });

  it('renders loading state', () => {
    const { container } = render(<RiskAssessmentReport data={null} loading />);
    expect(container.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders clean result with LOW risk', () => {
    render(<RiskAssessmentReport data={CLEAN_RESULT} />);
    expect(screen.getByText('Low Risk')).toBeInTheDocument();
    expect(screen.getByText('(8/100)')).toBeInTheDocument();
    expect(screen.getByText('No visual tampering indicators detected.')).toBeInTheDocument();
  });

  it('renders flagged result with signals', () => {
    render(<RiskAssessmentReport data={FLAGGED_RESULT} />);
    expect(screen.getByText('High Risk')).toBeInTheDocument();
    expect(screen.getByText('(65/100)')).toBeInTheDocument();
    expect(screen.getByText('Font differs in name field vs rest of document')).toBeInTheDocument();
    expect(screen.getByText('Expected watermark not detected')).toBeInTheDocument();
  });

  it('groups signals by category', () => {
    render(<RiskAssessmentReport data={FLAGGED_RESULT} />);
    expect(screen.getByText('Font Analysis')).toBeInTheDocument();
    expect(screen.getByText('Security Features')).toBeInTheDocument();
  });

  it('displays severity badges', () => {
    render(<RiskAssessmentReport data={FLAGGED_RESULT} />);
    expect(screen.getByText('Warning')).toBeInTheDocument();
    expect(screen.getByText('Critical')).toBeInTheDocument();
  });

  it('displays confidence percentages', () => {
    render(<RiskAssessmentReport data={FLAGGED_RESULT} />);
    expect(screen.getByText('85%')).toBeInTheDocument();
    expect(screen.getByText('92%')).toBeInTheDocument();
  });

  it('displays recommendations', () => {
    render(<RiskAssessmentReport data={FLAGGED_RESULT} />);
    expect(screen.getByText('Verify document directly with issuing institution')).toBeInTheDocument();
    expect(screen.getByText('Request original document for physical inspection')).toBeInTheDocument();
  });

  it('does not show analyze button when data is present', () => {
    const onAnalyze = vi.fn();
    render(<RiskAssessmentReport data={CLEAN_RESULT} onAnalyze={onAnalyze} />);
    expect(screen.queryByText('Analyze Document')).not.toBeInTheDocument();
  });

  it('does not show signals section for clean result', () => {
    render(<RiskAssessmentReport data={CLEAN_RESULT} />);
    expect(screen.queryByText('Detection Signals')).not.toBeInTheDocument();
  });

  it('does not show recommendations for clean result', () => {
    render(<RiskAssessmentReport data={CLEAN_RESULT} />);
    expect(screen.queryByText('Recommendations')).not.toBeInTheDocument();
  });
});
