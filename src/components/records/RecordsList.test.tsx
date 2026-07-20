/**
 * RecordsList — "Network Observed Time" honesty regression (BUG-2026-06-24-008).
 *
 * The "Network Observed Time" field must NEVER render the local upload/creation
 * time. The network has only "observed" a record once it is SECURED (securedAt
 * is set). For unconfirmed records (PENDING / SUBMITTED / BROADCASTING) the
 * field must fall back to a different, honest label — never `createdAt` under
 * the network label (§1.5).
 */
import { describe, it, expect } from 'vitest';
import { render, within } from '@testing-library/react';
import { RecordsList, type Record } from './RecordsList';
import { RECORDS_LIST_LABELS } from '@/lib/copy';

const baseRecord: Record = {
  id: 'rec-1',
  filename: 'diploma.pdf',
  fingerprint: 'a'.repeat(64),
  status: 'SECURED',
  createdAt: '2026-04-01T10:30:00Z',
  securedAt: '2026-04-01T12:00:00Z',
  fileSize: 102400,
  publicId: 'ARK-DOC-1',
};

describe('RecordsList — Network Observed Time honesty (BUG-2026-06-24-008)', () => {
  it('shows the Network Observed Time for SECURED records', () => {
    const { container } = render(<RecordsList records={[baseRecord]} />);
    const scope = within(container);

    // The network label is present for a secured record.
    expect(scope.getByText(RECORDS_LIST_LABELS.NETWORK_OBSERVED_TIME)).toBeInTheDocument();
    // The honest "created"-only fallback label must NOT be used here.
    expect(scope.queryByText(RECORDS_LIST_LABELS.CREATED_TIME)).not.toBeInTheDocument();
  });

  it('does NOT show Network Observed Time for PENDING records (no securedAt)', () => {
    const pending: Record = {
      ...baseRecord,
      id: 'rec-pending',
      status: 'PENDING',
      securedAt: undefined,
    };
    const { container } = render(<RecordsList records={[pending]} />);
    const scope = within(container);

    // The network observed-time label must NOT appear when the record is
    // unconfirmed — the network has not observed anything yet.
    expect(scope.queryByText(RECORDS_LIST_LABELS.NETWORK_OBSERVED_TIME)).not.toBeInTheDocument();
    // Instead an honest "Created" label is shown.
    expect(scope.getByText(RECORDS_LIST_LABELS.CREATED_TIME)).toBeInTheDocument();
  });

  it('does NOT show Network Observed Time for SUBMITTED records (no securedAt)', () => {
    const submitted: Record = {
      ...baseRecord,
      id: 'rec-submitted',
      status: 'SUBMITTED',
      securedAt: undefined,
    };
    const { container } = render(<RecordsList records={[submitted]} />);
    const scope = within(container);

    expect(scope.queryByText(RECORDS_LIST_LABELS.NETWORK_OBSERVED_TIME)).not.toBeInTheDocument();
    expect(scope.getByText(RECORDS_LIST_LABELS.CREATED_TIME)).toBeInTheDocument();
  });
});

// BUG-2026-07-17-010 (SCRUM-2910, P0): historical fraud_* metadata keys must
// never render in the owner records list rows.
describe('RecordsList — fraud metadata never renders (BUG-2026-07-17-010)', () => {
  it('filters fraud_* keys from the row metadata display', () => {
    const withFraudMeta: Record = {
      ...baseRecord,
      metadata: {
        field_of_study: 'Computer Science',
        fraud_score: 0.87,
        fraud_risk_level: 'high',
        fraud_signals: [{ signal_type: 'future_date', score: 0.35 }],
        fraudSignals: '["Font inconsistency detected"]',
      },
    };
    const { container } = render(<RecordsList records={[withFraudMeta]} />);
    const scope = within(container);

    expect(scope.queryByText(/fraud/i)).not.toBeInTheDocument();
    expect(scope.queryByText(/0\.87/)).not.toBeInTheDocument();
    expect(container.textContent?.toLowerCase()).not.toContain('fraud');
  });
});
