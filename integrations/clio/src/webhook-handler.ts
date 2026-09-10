/**
 * Clio Webhook Handler (INT-06)
 *
 * Listens for Clio webhook events (document.created, document.updated)
 * and optionally auto-anchors new documents.
 *
 * Inbound auth (SCRUM-3901, wired 2026-09-05): Clio signs each webhook body
 * with HMAC-SHA256 over the raw bytes. `handleWebhook` is the only entry
 * point and REJECTS the request when the shared secret is unset, the
 * signature is absent, or the digest does not match — fail closed,
 * constant-time compare via `integrations/shared/src/constant-time.ts`.
 *
 * `validateSignature` previously existed with zero callers and compared with
 * `===`; both defects are fixed here. See src/agents.md.
 */

import type { ClioConfig, ClioWebhookEvent } from './types';
import { ClioSidebarWidget } from './sidebar-widget';
import { constantTimeEqual } from '../../shared/src/constant-time';

/** Header Clio presents the body signature in. */
export const CLIO_WEBHOOK_SIGNATURE_HEADER = 'x-hook-signature';

/** Outcome of processing one inbound webhook. */
export interface ClioWebhookResult {
  processed: boolean;
  action: string;
  result?: Record<string, unknown>;
}

export class ClioWebhookHandler {
  private readonly widget: ClioSidebarWidget;
  private readonly autoAnchor: boolean;
  private readonly webhookSecret: string | undefined;
  private readonly onAnchor?: (result: {
    clio_document_id: number;
    arkova_public_id: string;
    fingerprint: string;
  }) => void | Promise<void>;
  private readonly onError?: (error: Error, event: ClioWebhookEvent) => void | Promise<void>;

  constructor(
    config: ClioConfig,
    options?: {
      onAnchor?: (result: {
        clio_document_id: number;
        arkova_public_id: string;
        fingerprint: string;
      }) => void | Promise<void>;
      onError?: (error: Error, event: ClioWebhookEvent) => void | Promise<void>;
    },
  ) {
    this.widget = new ClioSidebarWidget(config);
    this.autoAnchor = config.autoAnchor ?? false;
    this.webhookSecret = config.webhookSecret;
    this.onAnchor = options?.onAnchor;
    this.onError = options?.onError;

    // Failing closed on an unset secret is correct, and silent: a deploy that
    // simply forgot the secret rejects 100% of genuine Clio webhooks, which
    // on the wire is indistinguishable from an attacker being turned away.
    // Say it once, at construction. The secret's VALUE is never printed —
    // only the fact that it is absent.
    if (!this.webhookSecret) {
      console.warn(
        '[arkova/clio] No webhookSecret configured: every inbound webhook will be answered ' +
        'with rejected_unauthenticated. Set ClioConfig.webhookSecret to the shared secret ' +
        `Clio signs bodies with (presented in the ${CLIO_WEBHOOK_SIGNATURE_HEADER} header).`,
      );
    }
  }

  /**
   * Authenticate and process one inbound Clio webhook.
   *
   * `rawBody` MUST be the exact bytes Clio POSTed, as received — the HMAC is
   * over those bytes. Re-serializing a parsed object (key order, whitespace,
   * number formatting) produces a different digest and a valid request will
   * be rejected. Parse only after the signature verifies.
   *
   * Fails closed: an unset secret, an absent signature, and a digest mismatch
   * are all `rejected_unauthenticated` with `processed: false`. Callers can
   * tell them apart via `result.reason`, but MUST NOT return that distinction
   * to the remote caller — it tells an attacker whether the endpoint is
   * merely misconfigured.
   */
  async handleWebhook(
    rawBody: string,
    signature: string | undefined | null,
  ): Promise<ClioWebhookResult> {
    if (!this.webhookSecret) {
      return {
        processed: false,
        action: 'rejected_unauthenticated',
        result: { reason: 'no_webhook_secret_configured' },
      };
    }
    if (!signature) {
      return {
        processed: false,
        action: 'rejected_unauthenticated',
        result: { reason: 'missing_signature' },
      };
    }
    const valid = await ClioWebhookHandler.validateSignature(rawBody, signature, this.webhookSecret);
    if (!valid) {
      return {
        processed: false,
        action: 'rejected_unauthenticated',
        result: { reason: 'invalid_signature' },
      };
    }

    let event: ClioWebhookEvent;
    try {
      event = JSON.parse(rawBody) as ClioWebhookEvent;
    } catch {
      return {
        processed: false,
        action: 'rejected_malformed_payload',
        result: { reason: 'body_is_not_json' },
      };
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      return {
        processed: false,
        action: 'rejected_malformed_payload',
        result: { reason: 'body_is_not_a_clio_webhook_event' },
      };
    }

    return this.processEvent(event);
  }

  /**
   * Process an already-authenticated Clio webhook event.
   *
   * Deliberately private: it is the unauthenticated path, and a public
   * version of it is what let the signature check sit unused. `handleWebhook`
   * is the only way in.
   */
  private async processEvent(event: ClioWebhookEvent): Promise<ClioWebhookResult> {
    if (event.type === 'document.deleted') {
      return { processed: true, action: 'ignored_deletion' };
    }

    if (event.type === 'document.created' && this.autoAnchor) {
      try {
        const anchorResult = await this.widget.anchorDocument(event.data.id, {
          credentialType: 'LEGAL',
          description: `Auto-anchored from Clio (document ${event.data.id})`,
        });

        if (this.onAnchor) {
          await this.onAnchor({
            clio_document_id: anchorResult.clio_document_id,
            arkova_public_id: anchorResult.arkova_public_id,
            fingerprint: anchorResult.fingerprint,
          });
        }

        return {
          processed: true,
          action: 'auto_anchored',
          result: anchorResult as unknown as Record<string, unknown>,
        };
      } catch (error) {
        if (this.onError) {
          await this.onError(error as Error, event);
        }
        return {
          processed: false,
          action: 'anchor_failed',
          result: { error: (error as Error).message },
        };
      }
    }

    if (event.type === 'document.updated') {
      return { processed: true, action: 'document_updated_noted' };
    }

    return { processed: true, action: 'no_action' };
  }

  /**
   * Validate a Clio webhook signature (HMAC-SHA256 hex digest over `payload`).
   *
   * The compare is constant-time: `===` on a secret-derived value returns as
   * soon as two bytes differ, so its runtime encodes how many leading
   * characters of the digest the attacker guessed correctly — enough, over
   * many requests, to forge a signature byte by byte without knowing the
   * secret. A length mismatch returns false rather than throwing.
   */
  static async validateSignature(
    payload: string,
    signature: string,
    secret: string,
  ): Promise<boolean> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    const computed = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return constantTimeEqual(computed, signature);
  }
}
