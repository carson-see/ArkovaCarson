/**
 * WebhookEventCatalog tests (WH-01 / SCRUM-2396).
 *
 * The catalog must:
 *  - list exactly the worker allowlist event types (drift-guarded against
 *    AVAILABLE_EVENTS, which is itself pinned to VALID_WEBHOOK_EVENTS),
 *  - clearly DISTINGUISH live anchor events from deferred credential events
 *    (launch-claims discipline — credential.* have no emit points yet),
 *  - show each event's payload field names + the redaction rules note,
 *  - never render document contents / fingerprints (static catalog data).
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { WebhookEventCatalog, WEBHOOK_EVENT_CATALOG } from './WebhookEventCatalog';
import { AVAILABLE_EVENTS } from './WebhookSettings';
import { WEBHOOK_LABELS, WEBHOOK_EVENT_DESCRIPTIONS } from '@/lib/copy';

describe('WebhookEventCatalog', () => {
  it('lists every subscribable event type exactly once', () => {
    render(<WebhookEventCatalog />);

    for (const event of AVAILABLE_EVENTS) {
      expect(screen.getAllByText(event.id)).toHaveLength(1);
    }
  });

  it('catalog data stays in lockstep with AVAILABLE_EVENTS (drift guard)', () => {
    expect(WEBHOOK_EVENT_CATALOG.map((e) => e.id)).toEqual(AVAILABLE_EVENTS.map((e) => e.id));
    // Every catalog entry has a copy.ts description.
    for (const entry of WEBHOOK_EVENT_CATALOG) {
      expect(WEBHOOK_EVENT_DESCRIPTIONS[entry.id]).toBeTruthy();
    }
  });

  it('marks anchor events as active and credential events as not yet active', () => {
    render(<WebhookEventCatalog />);

    const anchorRow = screen.getByTestId('catalog-event-anchor.secured');
    expect(within(anchorRow).getByText(WEBHOOK_LABELS.CATALOG_LIVE_BADGE)).toBeInTheDocument();

    const credRow = screen.getByTestId('catalog-event-credential.issued');
    expect(within(credRow).getByText(WEBHOOK_LABELS.CATALOG_DEFERRED_BADGE)).toBeInTheDocument();
    expect(within(credRow).getByText(WEBHOOK_LABELS.CATALOG_DEFERRED_NOTE)).toBeInTheDocument();
  });

  it('only credential.* events are deferred — all anchor events have live emit points', () => {
    for (const entry of WEBHOOK_EVENT_CATALOG) {
      if (entry.id.startsWith('anchor.')) {
        expect(entry.live).toBe(true);
      } else {
        expect(entry.live).toBe(false);
      }
    }
  });

  it('shows payload fields for each event', () => {
    render(<WebhookEventCatalog />);

    const securedRow = screen.getByTestId('catalog-event-anchor.secured');
    expect(within(securedRow).getByText(/public_id/)).toBeInTheDocument();
    expect(within(securedRow).getByText(/chain_timestamp/)).toBeInTheDocument();

    const batchRow = screen.getByTestId('catalog-event-anchor.batch_secured');
    expect(within(batchRow).getByText(/anchor_count/)).toBeInTheDocument();
  });

  it('renders the redaction rules note', () => {
    render(<WebhookEventCatalog />);
    expect(screen.getByText(WEBHOOK_LABELS.CATALOG_REDACTION_NOTE)).toBeInTheDocument();
  });

  it('payload field catalogs never claim banned fields (no fingerprint / internal UUID fields)', () => {
    for (const entry of WEBHOOK_EVENT_CATALOG) {
      for (const field of entry.fields) {
        expect(field).not.toMatch(/fingerprint/i);
        expect(field).not.toMatch(/^anchor_id$|^user_id$|^org_id$/);
      }
    }
  });
});
