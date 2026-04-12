/**
 * Bullhorn Webhook/Subscription Handler (INT-07)
 *
 * Processes Bullhorn subscription events for automatic credential
 * verification when new files are added to candidate records.
 */

import type { BullhornConfig, BullhornSubscriptionEvent } from './types';
import { CandidateVerificationTab } from './candidate-tab';

export class BullhornWebhookHandler {
  private readonly tab: CandidateVerificationTab;
  private readonly autoVerify: boolean;

  constructor(config: BullhornConfig) {
    this.tab = new CandidateVerificationTab(config);
    this.autoVerify = config.autoVerify ?? false;
  }

  /**
   * Process Bullhorn subscription events.
   *
   * Handles FILE events on Candidate entities — when a new file is
   * attached to a candidate, optionally auto-anchors it.
   */
  async handleEvents(
    subscriptionEvent: BullhornSubscriptionEvent,
  ): Promise<Array<{ eventId: string; action: string; result?: Record<string, unknown> }>> {
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
