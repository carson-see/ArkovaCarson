/**
 * WebhookEventCatalog tests (WH-01 / SCRUM-2396).
 *
 * The catalog must:
 *  - list exactly the worker allowlist event types (drift-guarded against
 *    AVAILABLE_EVENTS, which is itself pinned to VALID_WEBHOOK_EVENTS),
 *  - clearly DISTINGUISH live events from deferred ones (launch-claims
 *    discipline — `live` must track real worker emit points, not the event
 *    family prefix: `credential.issued` / `credential.status_changed` emit
 *    today, `credential.verified` is flag-gated dark in prod),
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

  it('renders the Active badge for live events and the deferred badge + note for dark ones', () => {
    render(<WebhookEventCatalog />);

    const anchorRow = screen.getByTestId('catalog-event-anchor.secured');
    expect(within(anchorRow).getByText(WEBHOOK_LABELS.CATALOG_LIVE_BADGE)).toBeInTheDocument();

    // credential.issued emits from the worker today (credential-sources.ts,
    // SCRUM-1798 Phase 2a) — it must NOT tell subscribers "not yet active".
    const issuedRow = screen.getByTestId('catalog-event-credential.issued');
    expect(within(issuedRow).getByText(WEBHOOK_LABELS.CATALOG_LIVE_BADGE)).toBeInTheDocument();
    expect(within(issuedRow).queryByText(WEBHOOK_LABELS.CATALOG_DEFERRED_NOTE)).not.toBeInTheDocument();

    // credential.verified is wired but flag-gated dark in prod
    // (ENABLE_CREDENTIAL_VERIFIED_WEBHOOK default false, unset in prod).
    const verifiedRow = screen.getByTestId('catalog-event-credential.verified');
    expect(within(verifiedRow).getByText(WEBHOOK_LABELS.CATALOG_DEFERRED_BADGE)).toBeInTheDocument();
    expect(within(verifiedRow).getByText(WEBHOOK_LABELS.CATALOG_DEFERRED_NOTE)).toBeInTheDocument();
  });

  /**
   * `live: true` may be asserted ONLY for an event the worker actually emits
   * (§1.13 R-7 — never claim a capability we do not have; a subscriber must not
   * be led to expect deliveries that will never come).
   *
   * This used to be spelled "anchor.* is live, everything else is deferred",
   * which was true only while every live event happened to be an `anchor.*`
   * one. BUG-002 registered `compliance.document_expiring`, whose emit point
   * (`POST /cron/check-credential-expiry`, behind `ENABLE_EXPIRY_ALERTS`) is
   * real, and the prefix proxy started contradicting the rule it stood for.
   *
   * The set is explicit now, so the ratchet still bites in the direction that
   * matters: a newly added event is deferred unless someone deliberately lists
   * it here, and listing it means claiming a verified emit point.
   *
   * credential.issued + credential.status_changed were added 2026-08-29: both
   * had live, unflagged producers on main (and in the prod-deployed SHA) while
   * the catalog still badged them "Not yet active" — the honesty rule cuts in
   * BOTH directions, and understating liveness misleads subscribers who are
   * already receiving deliveries. credential.verified stays out deliberately:
   * its two dispatch sites (verify.ts, oracle.ts) are both gated on
   * ENABLE_CREDENTIAL_VERIFIED_WEBHOOK, default false and unset in prod.
   */
  const LIVE_EVENT_IDS = new Set([
    'anchor.submitted',
    'anchor.secured',
    'anchor.revoked',
    'anchor.expired',
    'anchor.batch_secured',
    'credential.issued',
    'credential.status_changed',
    'compliance.document_expiring',
  ]);

  it('claims live only for events with a real emit point', () => {
    for (const entry of WEBHOOK_EVENT_CATALOG) {
      expect(entry.live, entry.id).toBe(LIVE_EVENT_IDS.has(entry.id));
    }
  });

  it('keeps credential.verified deferred while its emit flag is dark in prod (SCRUM-1799)', () => {
    // Flip this only after verifying ENABLE_CREDENTIAL_VERIFIED_WEBHOOK is
    // actually on in prod (prod-state-check skill) — the flag, not the code
    // path, is what makes the badge truthful.
    const verified = WEBHOOK_EVENT_CATALOG.find((e) => e.id === 'credential.verified');
    expect(verified).toBeDefined();
    expect(verified?.live).toBe(false);
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
