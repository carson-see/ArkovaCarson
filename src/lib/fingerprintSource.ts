/**
 * Fingerprint Source Utilities (R19, CTO ruling 2026-07-28, advances SCRUM-2481)
 *
 * Parses and describes the `fingerprint_source` evidence class — whether an
 * anchor's fingerprint was computed from a real document's bytes
 * (`document_bytes`) or from an issuer's asserted record content with no
 * source document supplied (`issuer_record_attestation`). Mirrors the
 * pattern in src/lib/sourceProvenance.ts, but is an orthogonal axis (see
 * comment block in src/lib/copy.ts above FINGERPRINT_SOURCE_LABELS).
 */

import { z } from 'zod';
import {
  FINGERPRINT_SOURCE_LABELS,
  FINGERPRINT_SOURCE_DESCRIPTIONS,
  FINGERPRINT_SOURCE_TRIAD,
  type FingerprintSource,
} from '@/lib/copy';

export const FINGERPRINT_SOURCE_VALUES = [
  'document_bytes',
  'issuer_record_attestation',
] as const satisfies readonly FingerprintSource[];

export const fingerprintSourceSchema = z.enum(FINGERPRINT_SOURCE_VALUES);

/** Returns null for anchors created before this column existed (unclassified — never guessed, §1.5). */
export function parseFingerprintSource(value: unknown): FingerprintSource | null {
  const parsed = fingerprintSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function getFingerprintSourceLabel(value: FingerprintSource | string | null | undefined): string | null {
  const parsed = parseFingerprintSource(value);
  if (!parsed) return null;
  return FINGERPRINT_SOURCE_LABELS[parsed] ?? null;
}

export function getFingerprintSourceDescription(value: FingerprintSource | string | null | undefined): string | null {
  const parsed = parseFingerprintSource(value);
  if (!parsed) return null;
  return FINGERPRINT_SOURCE_DESCRIPTIONS[parsed] ?? null;
}

export function getFingerprintSourceTriad(value: FingerprintSource | string | null | undefined) {
  const parsed = parseFingerprintSource(value);
  if (!parsed) return null;
  return FINGERPRINT_SOURCE_TRIAD[parsed];
}

/** True only for `issuer_record_attestation` — the tier that must never imply document custody (R-7). */
export function isRecordDerived(value: FingerprintSource | string | null | undefined): boolean {
  return parseFingerprintSource(value) === 'issuer_record_attestation';
}

/** True only for `document_bytes`. */
export function isDocumentDerived(value: FingerprintSource | string | null | undefined): boolean {
  return parseFingerprintSource(value) === 'document_bytes';
}

export type { FingerprintSource };
