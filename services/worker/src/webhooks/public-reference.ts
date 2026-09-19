import { createHash } from 'node:crypto';

/** Stable, domain-separated, non-reversible reference for an internal UUID. */
export function webhookPublicReference(domain: 'job' | 'cert', internalId: string): string {
  const digest = createHash('sha256').update(`arkova:webhook:${domain}\0${internalId}`, 'utf8').digest('hex');
  return `${domain}_${digest.slice(0, 32)}`;
}
