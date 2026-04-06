/**
 * Tests for ProvenanceTimeline component (COMP-02)
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProvenanceTimeline } from './ProvenanceTimeline';
import { PROVENANCE_LABELS } from '@/lib/copy';

async function expandTimeline() {
  const toggle = screen.getByText(PROVENANCE_LABELS.SECTION_TITLE);
  await userEvent.click(toggle);
}

describe('ProvenanceTimeline', () => {
  const mockEvents = [
    { event_type: 'credential_uploaded', timestamp: '2026-03-01T10:00:00Z' },
    { event_type: 'fingerprint_computed', timestamp: '2026-03-01T10:00:00Z', evidence_reference: 'abc123' },
    { event_type: 'network_confirmed', timestamp: '2026-03-01T10:12:00Z', evidence_reference: 'deadbeef01', time_delta_seconds: 720 },
  ];

  it('renders section title', () => {
    render(<ProvenanceTimeline events={mockEvents} loading={false} />);
    expect(screen.getByText(PROVENANCE_LABELS.SECTION_TITLE)).toBeInTheDocument();
  });

  it('renders all events when expanded', async () => {
    render(<ProvenanceTimeline events={mockEvents} loading={false} />);
    await expandTimeline();
    expect(screen.getByText(PROVENANCE_LABELS.EVENT_UPLOADED)).toBeInTheDocument();
    expect(screen.getByText(PROVENANCE_LABELS.EVENT_FINGERPRINT)).toBeInTheDocument();
    expect(screen.getByText(PROVENANCE_LABELS.EVENT_NETWORK_CONFIRMED)).toBeInTheDocument();
  });

  it('shows loading state when expanded', async () => {
    render(<ProvenanceTimeline events={[]} loading={true} />);
    await expandTimeline();
    expect(screen.getByText(PROVENANCE_LABELS.LOADING)).toBeInTheDocument();
  });

  it('shows empty state when no events', async () => {
    render(<ProvenanceTimeline events={[]} loading={false} />);
    await expandTimeline();
    expect(screen.getByText(PROVENANCE_LABELS.NO_EVENTS)).toBeInTheDocument();
  });

  it('shows error state', async () => {
    render(<ProvenanceTimeline events={[]} loading={false} error="Something went wrong" />);
    await expandTimeline();
    expect(screen.getByText(PROVENANCE_LABELS.ERROR)).toBeInTheDocument();
  });

  it('shows anomaly indicator for flagged events', async () => {
    const anomalyEvents = [
      { event_type: 'credential_uploaded', timestamp: '2026-03-01T10:00:00Z' },
      { event_type: 'network_confirmed', timestamp: '2026-03-03T10:00:00Z', anomaly: true, time_delta_seconds: 172800 },
    ];
    render(<ProvenanceTimeline events={anomalyEvents} loading={false} />);
    await expandTimeline();
    expect(screen.getByText(PROVENANCE_LABELS.ANOMALY_LABEL)).toBeInTheDocument();
  });

  it('shows time deltas between events', async () => {
    render(<ProvenanceTimeline events={mockEvents} loading={false} />);
    await expandTimeline();
    expect(screen.getByText('12 minutes later')).toBeInTheDocument();
  });

  it('renders export button when expanded', async () => {
    render(<ProvenanceTimeline events={mockEvents} loading={false} />);
    await expandTimeline();
    expect(screen.getByText(PROVENANCE_LABELS.EXPORT_JSON)).toBeInTheDocument();
  });
});
