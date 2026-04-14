/**
 * Shared pipeline utilities for public record fetchers.
 *
 * Extracted from duplicate implementations across 20+ fetcher files.
 * New fetchers should import from here instead of re-declaring.
 */

import { createHash } from 'node:crypto';

/** SHA-256 content hash for deduplication and fingerprinting. */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** Rate-limiting delay between API requests. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
