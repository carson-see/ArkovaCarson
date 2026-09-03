/**
 * Bullhorn Webhook/Subscription Handler (INT-07)
 *
 * Processes Bullhorn subscription events for automatic record
 * verification when new files are added to candidate records.
 *
 * Inbound auth (SCRUM-3901, 2026-09-02): Bullhorn subscription POSTs carry
 * no signature of their own, so the relay must present the shared secret in
 * `x-arkova-webhook-secret`. `handleEvents` REJECTS every event when the
 * secret is unset or does not match — fail closed, constant-time compare.
 */

import type { BullhornConfig, BullhornSubscriptionEvent } from './types';
import { CandidateVerificationTab } from './candidate-tab';

export const BULLHORN_WEBHOOK_SECRET_HEADER = 'x-arkova-webhook-secret';

/** Constant-time string equality (length leak only, same as timingSafeEqual). */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export class BullhornWebhookHandler {
  private readonly tab: CandidateVerificationTab;
  private readonly autoVerify: boolean;
  private readonly webhookSecret: string | undefined;

  constructor(config: BullhornConfig) {
    this.tab = new CandidateVerificationTab(config);
    this.autoVerify = config.autoVerify ?? false;
    this.webhookSecret = config.webhookSecret;
  }

  /**
   * True only when a secret is configured AND the presented value matches it.
   * Unset secret → false (fail closed), so a misconfigured deploy cannot be
   * driven by anyone who can reach the endpoint.
   */
  verifyInboundSecret(presented: string | undefined | null): boolean {
    if (!this.webhookSecret || !presented) return false;
    return constantTimeEqual(this.webhookSecret, presented);
  }

  /**
   * Process Bullhorn subscription events.
   *
   * Handles FILE events on Candidate entities — when a new file is
   * attached to a candidate, optionally auto-anchors it.
   */
  async handleEvents(
    subscriptionEvent: BullhornSubscriptionEvent,
    presentedSecret: string | undefined | null,
  ): Promise<Array<{ eventId: string; action: string; result?: Record<string, unknown> }>> {
    if (!this.verifyInboundSecret(presentedSecret)) {
      return subscriptionEvent.events.map((event) => ({
        eventId: event.eventId,
        action: 'rejected_unauthenticated',
      }));
    }
    const results = [];

    for (const event of subscriptionEvent.events) {
      // Only process file events on Candidate entities
      if (event.entityName !== 'Candidate') {
        results.push({ eventId: event.eventId, action: 'skipped_non_candidate' });
        continue;
      }

      if (event.eventType === 'FILE' && this.autoVerify) {
        try {
          // Get fresh verification summary (will also check new files)
          const summary = await this.tab.getVerificationSummary(event.entityId);

          // Sync to Bullhorn custom fields
          await this.tab.syncStatusToCandidate(event.entityId, summary);

          results.push({
            eventId: event.eventId,
            action: 'synced_verification_status',
            result: {
              candidateId: event.entityId,
              verifiedCount: summary.verifiedCount,
              totalCredentials: summary.totalCredentials,
            },
          });
        } catch (error) {
          results.push({
            eventId: event.eventId,
            action: 'sync_failed',
            result: { error: (error as Error).message },
          });
        }
      } else if (event.eventType === 'ENTITY') {
        results.push({ eventId: event.eventId, action: 'entity_update_noted' });
      } else {
        results.push({ eventId: event.eventId, action: 'no_action' });
      }
    }

    return results;
  }
}
