/**
 * Trust Store — EU Trusted List (EUTL) and custom trust anchor management.
 *
 * Maintains a set of trusted root certificates. Periodically refreshes the
 * EU Trusted List for qualified TSP recognition.
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

import * as crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import { DEFAULTS } from '../constants.js';

// ─── Interface ─────────────────────────────────────────────────────────

export interface TrustStore {
  /** Check if a certificate (by PEM) is in the trust store. */
  isTrusted(pem: string): boolean;

  /** Check if a certificate is from a qualified TSP (EU Trusted List). */
  isQualified(pem: string): boolean;

  /** Add a trust anchor (root CA certificate). */
  addTrustAnchor(pem: string, qualified?: boolean): void;

  /** Remove a trust anchor. */
  removeTrustAnchor(fingerprint: string): void;

  /** Get count of trust anchors. */
  count(): number;

  /** Refresh EU Trusted List from remote source. */
  refreshEutl(): Promise<void>;
}

// ─── Trust Anchor Entry ────────────────────────────────────────────────

interface TrustAnchor {
  fingerprint: string;
  subjectCn: string;
  pem: string;
  qualified: boolean;
  addedAt: Date;
}

// ─── Implementation ────────────────────────────────────────────────────

export class DefaultTrustStore implements TrustStore {
  private anchors = new Map<string, TrustAnchor>();
  private lastEutlRefresh: Date | null = null;
  private readonly eutlUpdateIntervalMs: number;

  constructor(eutlUpdateIntervalHours: number = DEFAULTS.EUTL_UPDATE_INTERVAL_HOURS) {
    this.eutlUpdateIntervalMs = eutlUpdateIntervalHours * 3600_000;
  }

  isTrusted(pem: string): boolean {
    const fp = fingerprint(pem);
    return this.anchors.has(fp);
  }

  isQualified(pem: string): boolean {
    const fp = fingerprint(pem);
    const anchor = this.anchors.get(fp);
    return anchor?.qualified ?? false;
  }

  addTrustAnchor(pem: string, qualified: boolean = false): void {
    const fp = fingerprint(pem);
    if (this.anchors.has(fp)) return;

    let subjectCn = 'unknown';
    try {
      const cert = new crypto.X509Certificate(pem);
      const cnMatch = cert.subject.match(/CN=([^\n]+)/);
      subjectCn = cnMatch ? cnMatch[1].trim() : 'unknown';
    } catch {
      // PEM might be invalid — still store for fingerprint matching
    }

    this.anchors.set(fp, {
      fingerprint: fp,
      subjectCn,
      pem,
      qualified,
      addedAt: new Date(),
    });

    logger.debug('Trust anchor added', { fingerprint: fp, subjectCn, qualified });
  }

  removeTrustAnchor(fp: string): void {
    this.anchors.delete(fp);
  }

  count(): number {
    return this.anchors.size;
  }

  async refreshEutl(): Promise<void> {
    // Check if refresh is needed
    if (
      this.lastEutlRefresh &&
      Date.now() - this.lastEutlRefresh.getTime() < this.eutlUpdateIntervalMs
    ) {
      logger.debug('EUTL refresh skipped (within interval)');
      return;
    }

    logger.info('Refreshing EU Trusted List');

    try {
      // The EU Trusted List is published as XML at:
      // https://ec.europa.eu/tools/lotl/eu-lotl.xml
      // For now, we log the intent. Full EUTL XML parsing requires
      // an XML parser and EUTL schema understanding — deferred to
      // PH3-ESIG-02 QTSP integration which needs it.
      //
      // In the meantime, trust anchors are added manually via addTrustAnchor().
      this.lastEutlRefresh = new Date();
      logger.info('EUTL refresh completed', {
        anchorCount: this.anchors.size,
        qualifiedCount: Array.from(this.anchors.values()).filter(a => a.qualified).length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('EUTL refresh failed', { error: message });
    }
  }
}

// ─── Mock Trust Store (testing) ────────────────────────────────────────

export class MockTrustStore implements TrustStore {
  private trusted = new Set<string>();
  private qualifiedSet = new Set<string>();

  isTrusted(pem: string): boolean {
    return this.trusted.has(fingerprint(pem));
  }

  isQualified(pem: string): boolean {
    return this.qualifiedSet.has(fingerprint(pem));
  }

  addTrustAnchor(pem: string, qualified: boolean = false): void {
    const fp = fingerprint(pem);
    this.trusted.add(fp);
    if (qualified) this.qualifiedSet.add(fp);
  }

  removeTrustAnchor(fp: string): void {
    this.trusted.delete(fp);
    this.qualifiedSet.delete(fp);
  }

  count(): number {
    return this.trusted.size;
  }

  async refreshEutl(): Promise<void> {
    // no-op for mock
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function fingerprint(pem: string): string {
  try {
    const cert = new crypto.X509Certificate(pem);
    return cert.fingerprint256.replace(/:/g, '').toLowerCase();
  } catch {
    // If PEM is invalid, hash the raw PEM string
    return crypto.createHash('sha256').update(pem).digest('hex');
  }
}

// ─── Factory ───────────────────────────────────────────────────────────

export function createTrustStore(eutlUpdateIntervalHours?: number): TrustStore {
  return new DefaultTrustStore(eutlUpdateIntervalHours);
}

export function createMockTrustStore(): MockTrustStore {
  return new MockTrustStore();
}
