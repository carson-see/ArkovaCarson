/**
 * Clio Webhook Handler (INT-06)
 *
 * Listens for Clio webhook events (document.created, document.updated)
 * and optionally auto-anchors new documents to Bitcoin.
 */

import type { ClioConfig, ClioWebhookEvent } from './types';
import { ClioSidebarWidget } from './sidebar-widget';

export class ClioWebhookHandler {
  private readonly widget: ClioSidebarWidget;
  private readonly autoAnchor: boolean;
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
    this.onAnchor = options?.onAnchor;
    this.onError = options?.onError;
  }

  /**
   * Process a Clio webhook event.
   *
   * If autoAnchor is enabled and event is document.created,
   * automatically anchors the document to Bitcoin.
   */
  async handleEvent(event: ClioWebhookEvent): Promise<{
    processed: boolean;
    action: string;
    result?: Record<string, unknown>;
  }> {
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
   * Validate a Clio webhook signature (HMAC-SHA256).
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
    const computedBytes = new Uint8Array(sig);
    const expectedBytes = new Uint8Array(
      (signature.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)),
    );
    if (computedBytes.length !== expectedBytes.length) return false;
    // Constant-time comparison to prevent timing attacks
    let diff = 0;
    for (let i = 0; i < computedBytes.length; i++) {
      diff |= computedBytes[i] ^ expectedBytes[i];
    }
    return diff === 0;
  }
}
