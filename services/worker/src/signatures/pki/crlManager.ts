/**
 * CRL Manager — Certificate Revocation List fetching and caching.
 *
 * Fetches CRLs from distribution points, caches them per CRL_CACHE_TTL_SECONDS,
 * and provides them for LTV data embedding in B-LT/B-LTA signatures.
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

import * as crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import type { CrlEntry } from '../types.js';
import { DEFAULTS } from '../constants.js';

// ─── Interface ─────────────────────────────────────────────────────────

export interface CrlManager {
  /** Fetch a CRL from a distribution point URL, with caching. */
  fetchCrl(url: string, issuerCn: string): Promise<CrlEntry>;

  /** Fetch CRLs for all distribution points in a certificate. */
  fetchCrlsForCert(crlUrls: string[], issuerCn: string): Promise<CrlEntry[]>;

  /** Clear the CRL cache. */
  clearCache(): void;
}

// ─── Cache Entry ───────────────────────────────────────────────────────

interface CachedCrl {
  entry: CrlEntry;
  cachedAt: number;
}

// ─── Implementation ────────────────────────────────────────────────────

export class HttpCrlManager implements CrlManager {
  private cache = new Map<string, CachedCrl>();
  private readonly cacheTtlMs: number;

  constructor(cacheTtlSeconds: number = DEFAULTS.CRL_CACHE_TTL_SECONDS) {
    this.cacheTtlMs = cacheTtlSeconds * 1000;
  }

  async fetchCrl(url: string, issuerCn: string): Promise<CrlEntry> {
    // Check cache
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
      logger.debug('CRL cache hit', { url });
      return cached.entry;
    }

    logger.info('Fetching CRL', { url, issuerCn });

    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/pkix-crl' },
        signal: AbortSignal.timeout(DEFAULTS.TSA_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`CRL fetch returned HTTP ${response.status}`);
      }

      const raw = Buffer.from(await response.arrayBuffer());
      const now = new Date();

      // Parse nextUpdate from CRL structure if possible.
      // For now, use cache TTL as an approximation.
      const nextUpdate = new Date(now.getTime() + this.cacheTtlMs);

      const entry: CrlEntry = {
        issuerCn,
        crlUrl: url,
        lastUpdate: now,
        nextUpdate,
        raw,
      };

      // Cache
      this.cache.set(url, { entry, cachedAt: Date.now() });

      logger.info('CRL fetched', {
        url,
        issuerCn,
        sizeBytes: raw.length,
      });

      return entry;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('CRL fetch failed', { url, issuerCn, error: message });
      throw new Error(`CRL fetch failed for ${url}: ${message}`);
    }
  }

  async fetchCrlsForCert(crlUrls: string[], issuerCn: string): Promise<CrlEntry[]> {
    const results: CrlEntry[] = [];

    for (const url of crlUrls) {
      try {
        const entry = await this.fetchCrl(url, issuerCn);
        results.push(entry);
      } catch (err) {
        // Log but continue — some CRL URLs may be unreachable
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('CRL fetch skipped', { url, error: message });
      }
    }

    return results;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

// ─── Mock CRL Manager (testing) ────────────────────────────────────────

export class MockCrlManager implements CrlManager {
  public fetchCalls: Array<{ url: string; issuerCn: string }> = [];

  async fetchCrl(url: string, issuerCn: string): Promise<CrlEntry> {
    this.fetchCalls.push({ url, issuerCn });
    return {
      issuerCn,
      crlUrl: url,
      lastUpdate: new Date(),
      nextUpdate: new Date(Date.now() + 86400_000),
      raw: Buffer.from('mock-crl-data'),
    };
  }

  async fetchCrlsForCert(crlUrls: string[], issuerCn: string): Promise<CrlEntry[]> {
    return Promise.all(crlUrls.map(url => this.fetchCrl(url, issuerCn)));
  }

  clearCache(): void {
    // no-op
  }
}

// ─── Factory ───────────────────────────────────────────────────────────

export function createCrlManager(cacheTtlSeconds?: number): CrlManager {
  return new HttpCrlManager(cacheTtlSeconds);
}

export function createMockCrlManager(): MockCrlManager {
  return new MockCrlManager();
}
